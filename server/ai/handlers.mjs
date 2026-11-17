/**
 * ATOM · Manejadores HTTP unificados para los endpoints /api/ai-* y /api/*-device
 * ---------------------------------------------------------------------------
 * Devuelven objetos Web `Response` estandar: sirven directamente tanto en
 * Cloudflare Pages Functions (`onRequest`) como en Vite (`adaptNodeMiddleware`).
 */
import {
  BUILTIN_IDS,
  PROVIDERS,
  authHeaders,
  basePolicy,
  configuredProviders,
  describeError,
  explainBody,
  fetchWithFallback,
  getHeader,
  jsonRes,
  readTarget,
  resolveKey,
  transformSseResponse,
} from './common.mjs';
import { fromAnthropicReply, pipeAnthropicResponse, toAnthropicBody } from './anthropic.mjs';
import {
  DEFAULT_COPILOT_HOST,
  autoOnlyModels,
  copilotAutoModel,
  copilotHeaders,
  copilotPlan,
  integratorFromError,
  resolveAutoModel,
  usableModels,
} from './copilot.mjs';
import { freepiCatalog, freepiHeaders, isFreePi, pipeFreePiResponse, replyText } from './freepi.mjs';
import { deviceConsent, devicePoll, deviceStart, freepiMe } from './freepiDevice.mjs';
import { registryByApi, registryDirectory, registryProvider } from './registry.mjs';
import { mismoOrigen } from '../imageSearch.mjs';

const VALID_ROLES = new Set(['system', 'user', 'assistant']);
const MAX_MESSAGES = 40;
const MAX_CHARS = 120_000;
const MAX_IMAGES = 4;
const MAX_IMAGE_CHARS = 6 * 1024 * 1024;
const MAX_CHAT_BODY_BYTES = 10 * 1024 * 1024;

const GITHUB_CLIENT_ID = 'Ov23li8tweQw6odWQebz';
const GITHUB_DEVICE_CODE = 'https://github.com/login/device/code';
const GITHUB_ACCESS_TOKEN = 'https://github.com/login/oauth/access_token';

/* ── /api/health ─────────────────────────────────────────────────────────── */

export async function handleHealth(request, env) {
  if (request.method !== 'GET') {
    return jsonRes({ error: 'method_not_allowed', message: 'Usa GET.' }, 405, { Allow: 'GET' });
  }
  return jsonRes({
    ok: true,
    ai: {
      providers: configuredProviders(env),
      customProviders: basePolicy(env),
    },
  });
}

/* ── /api/ai-chat (con soporte multimodal/vision) ────────────────────────── */

function isValidImageUrl(url) {
  if (typeof url !== 'string' || !url || url.length > MAX_IMAGE_CHARS) return false;
  if (/^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(url)) return true;
  return /^https:\/\/[^\s]+$/i.test(url);
}

function checkMessageContent(content) {
  if (typeof content === 'string') {
    if (content.length > MAX_CHARS) {
      return { ok: false, error: 'El mensaje es demasiado largo para esta conversación.' };
    }
    return { ok: true, value: content, hasImage: false, textLen: content.length, previewText: content };
  }
  if (!Array.isArray(content) || content.length === 0) {
    return { ok: false, error: 'El formato de uno de los mensajes no es válido.' };
  }
  const cleanParts = [];
  let imageCount = 0;
  let textLen = 0;
  let previewText = '';
  for (const part of content) {
    if (!part || typeof part !== 'object') {
      return { ok: false, error: 'El formato de un fragmento del mensaje no es válido.' };
    }
    if (part.type === 'text' && typeof part.text === 'string') {
      textLen += part.text.length;
      if (textLen > MAX_CHARS) {
        return { ok: false, error: 'El mensaje es demasiado largo para esta conversación.' };
      }
      if (!previewText && part.text.trim()) previewText = part.text;
      cleanParts.push({ type: 'text', text: part.text });
    } else if (part.type === 'image_url' && isValidImageUrl(part.image_url?.url)) {
      imageCount += 1;
      if (imageCount > MAX_IMAGES) {
        return { ok: false, error: `Máximo ${MAX_IMAGES} imágenes por mensaje.` };
      }
      cleanParts.push({
        type: 'image_url',
        image_url: {
          url: part.image_url.url,
          ...(typeof part.image_url.detail === 'string' ? { detail: part.image_url.detail } : {}),
        },
      });
    }
  }
  if (cleanParts.length === 0) {
    return { ok: false, error: 'El mensaje no contiene texto ni imagen válida.' };
  }
  return { ok: true, value: cleanParts, hasImage: imageCount > 0, textLen, previewText };
}

export function checkMessages(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'Falta la lista de mensajes.' };
  if (raw.length > MAX_MESSAGES) return { error: `Demasiados mensajes (máximo ${MAX_MESSAGES}).` };

  const out = [];
  let total = 0;
  let hasImage = false;
  let lastUserPrompt = '';
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return { error: 'Uno de los mensajes no es un objeto.' };
    const role = item.role;
    if (typeof role !== 'string' || !VALID_ROLES.has(role)) return { error: 'El papel del mensaje no es válido.' };
    const checked = checkMessageContent(item.content);
    if (!checked.ok) return { error: checked.error };
    total += checked.textLen;
    if (total > MAX_CHARS) return { error: 'La conversación supera el límite de texto por petición.' };
    if (checked.hasImage) hasImage = true;
    if (role === 'user' && checked.previewText) lastUserPrompt = checked.previewText;
    out.push({ role, content: checked.value });
  }
  return { messages: out, hasImage, lastUserPrompt };
}

function restoreModelName(text, chosen, returned) {
  if (!chosen || !returned || chosen === returned) return text;
  const escaped = returned.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`("model"\\s*:\\s*")${escaped}(")`, 'g'), `$1${chosen}$2`);
}

function summarizeError(status, label, contentType, text, customOpenAi) {
  if (status === 401 || status === 403) {
    if (/User not found|invalid api key|incorrect api key/i.test(text)) {
      return `${label} rechazó la credencial. Revisa o vuelve a guardar tu clave en Ajustes > Asistente IA.`;
    }
    const integrator = integratorFromError(text);
    if (integrator) {
      return `El integrador "${integrator}" no tiene este modelo en tu sesión de GitHub Copilot. Cambia de modelo en Ajustes.`;
    }
  }
  return explainBody(status, label, contentType, text, customOpenAi);
}

async function readJsonBody(request, maxBytes) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > maxBytes) return { error: 'La petición supera el tamaño máximo permitido.', status: 413 };
  const rawText = await request.text();
  if (rawText.length > maxBytes) return { error: 'La petición supera el tamaño máximo permitido.', status: 413 };
  try {
    return { data: JSON.parse(rawText) };
  } catch {
    return { error: 'El cuerpo de la petición no es JSON válido.', status: 400 };
  }
}

export async function handleAiChat(request, env) {
  if (request.method !== 'POST') {
    return jsonRes({ error: 'method_not_allowed', message: 'Usa POST.' }, 405, { Allow: 'POST' });
  }

  const parsed = await readJsonBody(request, MAX_CHAT_BODY_BYTES);
  if (parsed.error) return jsonRes({ error: 'bad_request', message: parsed.error }, parsed.status);
  const body = parsed.data ?? {};

  const providerId = typeof body.provider === 'string' && body.provider ? body.provider : 'freepi';
  const found = readTarget(request.headers, providerId, env);
  if (!found.ok) return jsonRes({ error: found.code, message: found.message }, 400);
  const target = found.target;

  const key = resolveKey(request.headers, target, env);
  if (!key && !target.custom) {
    return jsonRes({ error: 'missing_key', message: `Falta la credencial de ${target.label}.` }, 401);
  }

  const checked = checkMessages(body.messages);
  if ('error' in checked) return jsonRes({ error: 'bad_messages', message: checked.error }, 400);

  let model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : target.defaultModel;
  const stream = body.stream !== false;
  let chosenModel = '';

  let chatUrls = target.chatUrls;
  let extraHeaders = target.id === 'github' ? { ...target.headers, ...copilotHeaders() } : (target.headers ?? {});

  if (target.id === 'github' && key) {
    const plan = await copilotPlan(key);
    const host = plan?.host || DEFAULT_COPILOT_HOST;
    chatUrls = [...new Set([`${host}/chat/completions`, ...target.chatUrls])];
    if (model === 'auto') {
      chosenModel = 'auto';
      const auto = await copilotAutoModel(key, host, checked.lastUserPrompt || 'ping', checked.hasImage);
      if (auto) {
        model = auto;
      } else {
        const avail = await usableModels(key, host);
        model = resolveAutoModel(avail ?? []);
      }
    }
  }

  if (!model) {
    return jsonRes({ error: 'missing_model', message: `Elige un modelo para ${target.label}.` }, 400);
  }

  const freepi = isFreePi(chatUrls[0] ?? '');
  const anthropic = target.format === 'anthropic';
  const reqHeaders = {
    ...authHeaders(key, target),
    'Content-Type': 'application/json',
    Accept: stream ? 'text/event-stream, application/json' : 'application/json',
    ...extraHeaders,
    ...target.extra,
    ...(freepi ? await freepiHeaders(key) : {}),
  };

  const payload = anthropic
    ? toAnthropicBody(model, checked.messages, stream)
    : { model, messages: checked.messages, ...(stream ? { stream: true } : {}) };

  try {
    const upstream = await fetchWithFallback(chatUrls, {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify(payload),
    }, { noRedirect: target.custom });

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      const contentType = upstream.headers.get('content-type');
      const customOpenAi = target.custom && target.format === 'openai';
      const plain = summarizeError(upstream.status, target.label, contentType, errText, customOpenAi);
      if (plain) {
        return jsonRes({ error: 'provider_error', message: plain }, upstream.status);
      }
      return new Response(errText, {
        status: upstream.status,
        headers: {
          'Content-Type': contentType || 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }

    const upstreamType = (upstream.headers.get('content-type') || '').toLowerCase();
    if (stream && upstreamType.includes('text/event-stream')) {
      if (anthropic) return pipeAnthropicResponse(upstream);
      if (freepi) return pipeFreePiResponse(upstream);
      const transform = chosenModel
        ? (chunk) => restoreModelName(chunk, chosenModel, model)
        : undefined;
      return transformSseResponse(upstream, transform);
    }

    const replyData = await upstream.json().catch(() => null);
    if (!replyData) {
      return jsonRes({ error: 'provider_error', message: `${target.label} devolvió una respuesta vacía.` }, 502);
    }
    if (anthropic) return jsonRes(fromAnthropicReply(replyData));
    if (freepi && replyData.choices?.[0]?.message) {
      const m = replyData.choices[0].message;
      replyData.choices[0].message = { ...m, content: replyText(m) };
    }
    return jsonRes(replyData);
  } catch (err) {
    console.error('[ai-chat]', target.id, describeError(err));
    return jsonRes({ error: 'provider_unreachable', message: describeError(err) }, 502);
  }
}

/* ── /api/ai-models ──────────────────────────────────────────────────────── */

function listOf(payload) {
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== 'object' || payload === null) return [];
  if (Array.isArray(payload.data)) return payload.data;
  return Object.values(payload).filter((v) => typeof v === 'object' && v !== null);
}

function str(v) { return typeof v === 'string' ? v : ''; }
function beforeSlash(id, fallback) { const cut = id.indexOf('/'); return cut > 0 ? id.slice(0, cut) : fallback; }
function size(v) { const n = typeof v === 'number' ? v : Number(v); return Number.isFinite(n) && n > 0 ? n : undefined; }

function mapOpenRouter(entry) {
  const id = str(entry.id);
  if (!id) return null;
  const pricing = entry.pricing;
  const free = pricing?.prompt === '0' && pricing?.completion === '0';
  const model = { id, name: str(entry.name) || id, publisher: beforeSlash(id, 'OpenRouter') };
  const ctx = size(entry.context_length);
  if (ctx) model.ctx = ctx;
  if (free) model.free = true;
  return model;
}

function mapOpenAiLike(entry, fallbackPublisher) {
  const id = str(entry.id) || str(entry.name);
  if (!id) return null;
  const model = {
    id,
    name: str(entry.display_name) || str(entry.name) || id,
    publisher: str(entry.owned_by) || beforeSlash(id, fallbackPublisher),
  };
  const ctx = size(entry.context_length) ?? size(entry.max_model_len);
  if (ctx) model.ctx = ctx;
  return model;
}

function mapGithub(entry) {
  const id = str(entry.id) || str(entry.model) || str(entry.name);
  if (!id) return null;
  if ('model_picker_enabled' in entry || 'policy' in entry) {
    if (entry.model_picker_enabled === false || entry.policy?.state === 'disabled') return null;
    const endpoints = entry.supported_endpoints;
    if (Array.isArray(endpoints) && !endpoints.includes('/chat/completions')) return null;
    const model = {
      id,
      name: str(entry.name) || id,
      publisher: str(entry.capabilities?.family) || 'Copilot',
    };
    const ctx = size(entry.capabilities?.limits?.max_context_window_tokens);
    if (ctx) model.ctx = ctx;
    return model;
  }
  return {
    id,
    name: str(entry.friendly_name) || str(entry.name) || id,
    publisher: str(entry.publisher) || str(entry.provider) || 'GitHub Models',
  };
}

function mapperFor(target) {
  if (target.id === 'openrouter') return mapOpenRouter;
  if (target.id === 'github') return mapGithub;
  const fallback = target.id === 'nvidia' ? 'NVIDIA' : target.label;
  return (entry) => mapOpenAiLike(entry, fallback);
}

async function registryFor(target, env) {
  if (target.registry) {
    const found = await registryProvider(target.registry, env);
    if (found) return found;
  }
  if (target.custom && target.base) return await registryByApi(target.base, env);
  return null;
}

function enrich(model, reg) {
  if (!reg || !Object.hasOwn(reg.models, model.id)) return model;
  const meta = reg.models[model.id];
  if (!meta) return model;
  const merged = { ...model };
  if (merged.name === merged.id && meta.name) merged.name = meta.name;
  if (!merged.ctx && meta.ctx) merged.ctx = meta.ctx;
  if (merged.free === undefined && meta.free) merged.free = true;
  if (meta.reasoning) merged.reasoning = true;
  return merged;
}

function fromRegistry(reg) {
  return Object.values(reg.models).map((meta) => ({
    id: meta.id,
    name: meta.name,
    publisher: beforeSlash(meta.id, reg.name),
    ...(meta.ctx ? { ctx: meta.ctx } : {}),
    ...(meta.free ? { free: true } : {}),
    ...(meta.reasoning ? { reasoning: true } : {}),
  }));
}

function orderModels(models) {
  const seen = new Set();
  const unique = [];
  for (const m of models) {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      unique.push(m);
    }
  }
  unique.sort((a, b) => a.publisher.localeCompare(b.publisher) || a.name.localeCompare(b.name));
  return unique;
}

export async function handleAiModels(request, env) {
  if (request.method !== 'GET') {
    return jsonRes({ error: 'method_not_allowed', message: 'Usa GET.' }, 405, { Allow: 'GET' });
  }
  const url = new URL(request.url);
  const provider = url.searchParams.get('provider') ?? '';
  const found = readTarget(request.headers, provider, env);
  if (!found.ok) return jsonRes({ error: found.code, message: found.message }, 400);
  const target = found.target;

  const key = resolveKey(request.headers, target, env);
  if (!key && !target.publicCatalog && !target.custom) {
    return jsonRes({ error: 'missing_key', message: `Falta la credencial de ${target.label}.` }, 401);
  }

  const copilot = target.id === 'github' ? await copilotPlan(key ?? '') : null;
  const freepi = isFreePi(target.modelUrls[0] ?? '');
  const headers = {
    ...authHeaders(key, target),
    Accept: 'application/json',
    ...target.headers,
    ...target.extra,
    ...(freepi ? await freepiHeaders(key) : {}),
  };

  try {
    const upstream = await fetchWithFallback(target.modelUrls, { headers }, {
      noRedirect: target.custom,
      timeoutMs: 15_000,
    });
    const payload = upstream.ok ? await upstream.json().catch(() => null) : null;
    const map = mapperFor(target);
    const reg = await registryFor(target, env);

    let models = [];
    if (freepi) {
      const catalog = await freepiCatalog(key);
      if (catalog) {
        models = catalog.models.map((m) => ({
          id: m.id,
          name: m.name,
          publisher: '',
          ...(m.free ? { free: true } : {}),
          ...(m.vision ? { vision: true } : {}),
        }));
      }
    } else if (payload) {
      for (const entry of listOf(payload)) {
        const model = map(entry);
        if (model) models.push(enrich(model, reg));
      }
    }

    let dropped = 0;
    let probe = 'no se preguntó';
    if (copilot && key && models.length > 0) {
      const probed = await usableModels(key, copilot.host);
      if (probed) {
        const usable = new Set(probed);
        dropped = models.filter((m) => !usable.has(m.id)).length;
        models = models.filter((m) => usable.has(m.id));
        probe = `dijo ${probed.length}`;
      } else {
        probe = 'sin lista';
      }
    }

    if (copilot && key && models.length === 0) {
      const probed = await usableModels(key, copilot.host);
      probe = probed ? `rescató ${probed.length}` : 'sin lista';
      if (probed) {
        models = probed.map((id) => enrich({ id, name: id, publisher: 'Copilot' }, reg));
      }
    }

    let source = 'provider';
    let notice = dropped > 0
      ? `${dropped} modelo${dropped === 1 ? '' : 's'} no están disponibles para tu sesión de Copilot y se han ocultado.`
      : '';

    if (copilot && models.length === 0) {
      const only = autoOnlyModels();
      return jsonRes({
        provider: target.id,
        source: 'provider',
        defaultModel: only[0]?.id ?? 'auto',
        models: only,
        notice: `Tu sesión de Copilot elige el modelo por ti (plan=${copilot.plan || '?'}, sonda=${probe}).`,
      });
    }

    if (models.length === 0 && reg) {
      models = fromRegistry(reg);
      source = 'registry';
      notice = upstream.ok
        ? `${target.label} no devolvió ningún modelo; la lista viene del registro público.`
        : `${target.label} respondió ${upstream.status}; la lista viene del registro público.`;
    }

    if (models.length === 0) {
      if (!upstream.ok) {
        const body = await upstream.text().catch(() => '');
        const plain = explainBody(upstream.status, target.label, upstream.headers.get('content-type'), body);
        return jsonRes({
          error: 'provider_error',
          message: plain ?? `${target.label} respondió ${upstream.status}.`,
          ...(plain ? {} : { detail: body.slice(0, 600) }),
        }, upstream.status);
      }
      return jsonRes({ provider: target.id, source, defaultModel: '', models: [] });
    }

    models = orderModels(models);
    const fallback = models.some((m) => m.id === target.defaultModel)
      ? target.defaultModel
      : (models[0]?.id ?? '');

    return jsonRes({
      provider: target.id,
      source,
      ...(notice ? { notice } : {}),
      defaultModel: fallback,
      models,
    });
  } catch (err) {
    console.error('[ai-models]', target.id, describeError(err));
    return jsonRes({ error: 'provider_unreachable', message: describeError(err) }, 502);
  }
}

/* ── /api/ai-registry ────────────────────────────────────────────────────── */

export async function handleAiRegistry(request, env) {
  if (request.method !== 'GET') {
    return jsonRes({ error: 'method_not_allowed', message: 'Usa GET.' }, 405, { Allow: 'GET' });
  }
  const builtInRegistries = BUILTIN_IDS.map((id) => PROVIDERS[id]?.registry).filter(Boolean);
  const providers = await registryDirectory(builtInRegistries, env);
  return jsonRes({ providers }, 200, { 'Cache-Control': 'public, max-age=3600' });
}

/* ── /api/freepi-device ──────────────────────────────────────────────────── */

export async function handleFreePiDevice(request) {
  if (request.method !== 'POST') {
    return jsonRes({ error: 'method_not_allowed', message: 'Usa POST.' }, 405, { Allow: 'POST' });
  }
  const parsed = await readJsonBody(request, 64 * 1024);
  if (parsed.error) return jsonRes({ error: 'bad_request', message: parsed.error }, parsed.status);
  const body = parsed.data ?? {};
  const action = body.action || body.step;

  try {
    if (action === 'start') {
      const started = await deviceStart();
      return jsonRes({
        ok: true,
        session_id: started.sessionId,
        user_code: started.userCode,
        verification_uri: started.verificationUri,
        verification_uri_complete: started.verificationUriComplete,
        interval: started.interval,
        expires_in: started.expiresIn,
        consent_text: started.consentText,
      });
    }
    if (action === 'consent') {
      const sessionId = typeof body.session_id === 'string' ? body.session_id : '';
      await deviceConsent(sessionId);
      return jsonRes({ ok: true, status: 'consent' });
    }
    if (action === 'poll' || action === 'token') {
      const sessionId = typeof body.session_id === 'string' ? body.session_id : '';
      const result = await devicePoll(sessionId);
      if (result.kind === 'token') {
        return jsonRes({ ok: true, status: 'token', token: result.token, ...(result.days != null ? { days: result.days } : {}) });
      }
      if (result.kind === 'pending') {
        return jsonRes({ ok: true, status: 'pending', ...(result.retryAfter ? { retry_after: result.retryAfter } : {}) });
      }
      if (result.kind === 'consent') {
        return jsonRes({ ok: true, status: 'consent_required', message: result.message });
      }
      if (result.kind === 'expired') {
        return jsonRes({ error: 'expired_token', status: 'expired', message: result.message }, 410);
      }
      return jsonRes({ error: 'oauth_error', message: result.message }, 400);
    }
    if (action === 'me') {
      const token = getHeader(request.headers, 'x-ai-key') || (typeof body.token === 'string' ? body.token.trim() : '');
      if (!token) return jsonRes({ error: 'missing_key', message: 'Falta el token de free-pi.' }, 401);
      const me = await freepiMe(token);
      if (!me) return jsonRes({ error: 'provider_unreachable', message: 'free-pi no devolvió la cuenta.' }, 502);
      return jsonRes(me);
    }
    return jsonRes({ error: 'bad_action', message: 'Acción no reconocida.' }, 400);
  } catch (err) {
    console.error('[freepi-device]', describeError(err));
    return jsonRes({ error: 'provider_unreachable', message: describeError(err) }, 502);
  }
}

/* ── /api/github-device ──────────────────────────────────────────────────── */

export async function handleGithubDevice(request, env) {
  if (request.method !== 'POST') {
    return jsonRes({ error: 'method_not_allowed', message: 'Usa POST.' }, 405, { Allow: 'POST' });
  }
  const parsed = await readJsonBody(request, 64 * 1024);
  if (parsed.error) return jsonRes({ error: 'bad_request', message: parsed.error }, parsed.status);
  const body = parsed.data ?? {};
  const action = body.action;
  const clientId = (typeof body.clientId === 'string' && body.clientId.trim())
    || envVar('GITHUB_CLIENT_ID', env)
    || GITHUB_CLIENT_ID;

  try {
    if (action === 'start') {
      const upstream = await fetch(GITHUB_DEVICE_CODE, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, scope: 'read:user' }),
        signal: AbortSignal.timeout(12_000),
      });
      const data = await upstream.json();
      return jsonRes(data, upstream.status);
    }
    if (action === 'poll') {
      const deviceCode = typeof body.device_code === 'string' ? body.device_code : '';
      if (!deviceCode) return jsonRes({ error: 'missing_device_code', message: 'Falta el device_code.' }, 400);
      const upstream = await fetch(GITHUB_ACCESS_TOKEN, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
        signal: AbortSignal.timeout(12_000),
      });
      const data = await upstream.json();
      return jsonRes(data, upstream.status);
    }
    return jsonRes({ error: 'bad_action', message: 'Acción no reconocida.' }, 400);
  } catch (err) {
    console.error('[github-device]', describeError(err));
    return jsonRes({ error: 'provider_unreachable', message: describeError(err) }, 502);
  }
}

/* ── Adaptador Node (Vite dev & preview middleware) ──────────────────────── */

async function nodeToWebRequest(req) {
  const host = req.headers.host || 'localhost';
  const url = `http://${host}${req.url || '/'}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) headers.set(k, v.join(', '));
    else headers.set(k, String(v));
  }
  const method = (req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') {
    return new Request(url, { method, headers });
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  return new Request(url, { method, headers, body });
}

export async function runNodeHandler(webHandler, req, res, env) {
  const request = await nodeToWebRequest(req);
  if (!mismoOrigen(request.headers)) {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'forbidden', message: 'Petición externa rechazada.' }));
    return;
  }
  const response = await webHandler(request, env);
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
      if (typeof res.flush === 'function') {
        try { res.flush(); } catch { /* noop */ }
      }
    }
  } finally {
    res.end();
  }
}
