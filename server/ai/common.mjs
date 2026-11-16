/**
 * ATOM · Base comun del proxy multi-proveedor de IA
 * ---------------------------------------------------------------------------
 * Resuelve el proveedor de destino (de casa o personalizado), valida URLs y
 * cabeceras contra SSRF e inyecciones, y unifica lectura de cabeceras y entorno
 * entre Node (Vite dev/preview) y Cloudflare Pages Functions.
 */

export const BUILTIN_IDS = ['freepi', 'openai', 'anthropic', 'openrouter', 'github', 'nvidia'];

const ANTHROPIC_VERSION = '2023-06-01';

export const PROVIDERS = {
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    chatUrls: ['https://openrouter.ai/api/v1/chat/completions'],
    modelUrls: ['https://openrouter.ai/api/v1/models'],
    defaultModel: 'openai/gpt-4o-mini',
    envKey: 'OPENROUTER_API_KEY',
    headers: { 'X-Title': 'ATOM Studio' },
    publicCatalog: true,
    registry: 'openrouter',
    format: 'openai',
    keyHeader: '',
  },
  nvidia: {
    id: 'nvidia',
    label: 'NVIDIA',
    chatUrls: ['https://integrate.api.nvidia.com/v1/chat/completions'],
    modelUrls: ['https://integrate.api.nvidia.com/v1/models'],
    defaultModel: 'nvidia/llama-3.3-nemotron-super-49b-v1',
    envKey: 'NVIDIA_API_KEY',
    registry: 'nvidia',
    format: 'openai',
    keyHeader: '',
  },
  github: {
    id: 'github',
    label: 'GitHub Copilot',
    chatUrls: [
      'https://api.githubcopilot.com/chat/completions',
      'https://models.github.ai/inference/v1/chat/completions',
    ],
    modelUrls: [
      'https://api.githubcopilot.com/models',
      'https://models.github.ai/catalog/models',
      'https://models.github.ai/inference/v1/models',
    ],
    defaultModel: 'gpt-4o-mini',
    envKey: 'GITHUB_AI_TOKEN',
    headers: {
      'User-Agent': 'atom-studio/1.0',
      'X-GitHub-Api-Version': '2026-06-01',
      'x-initiator': 'user',
      'Openai-Intent': 'conversation-edits',
    },
    registry: 'github-copilot',
    format: 'openai',
    keyHeader: '',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    chatUrls: ['https://api.openai.com/v1/chat/completions'],
    modelUrls: ['https://api.openai.com/v1/models'],
    defaultModel: 'gpt-4o-mini',
    envKey: 'OPENAI_API_KEY',
    registry: 'openai',
    format: 'openai',
    keyHeader: '',
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    chatUrls: ['https://api.anthropic.com/v1/messages'],
    modelUrls: ['https://api.anthropic.com/v1/models'],
    defaultModel: 'claude-sonnet-4-5',
    envKey: 'ANTHROPIC_API_KEY',
    headers: { 'anthropic-version': ANTHROPIC_VERSION },
    registry: 'anthropic',
    format: 'anthropic',
    keyHeader: 'x-api-key',
  },
  freepi: {
    id: 'freepi',
    label: 'free-pi',
    chatUrls: ['https://api.freepi.ai/v1/chat/completions'],
    modelUrls: ['https://api.freepi.ai/client-version'],
    defaultModel: 'deepseek-v4.1-flash',
    envKey: 'FREEPI_TOKEN',
    registry: 'free-pi',
    format: 'openai',
    keyHeader: '',
  },
};

export function envVar(name, env) {
  if (env && typeof env[name] === 'string') return env[name].trim();
  if (typeof process !== 'undefined' && process.env && typeof process.env[name] === 'string') {
    return process.env[name].trim();
  }
  return '';
}

function deployed(env) {
  if (envVar('ATOM_DEV', env) === '1' || envVar('ZENCE_DEV', env) === '1' || envVar('PLATAFORMA_3I_DEV', env) === '1') {
    return false;
  }
  return Boolean(
    envVar('CF_PAGES', env)
    || envVar('VERCEL', env)
    || envVar('NODE_ENV', env) === 'production',
  );
}

export function basePolicy(env) {
  const raw = envVar('AI_CUSTOM_PROVIDERS', env).toLowerCase();
  if (raw === 'off' || raw === 'public' || raw === 'local') return raw;
  return deployed(env) ? 'public' : 'local';
}

const LOCAL_SUFFIX = /(^|\.)(localhost|local|internal|home\.arpa)$/i;

function isPrivateHost(host) {
  const name = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (!name || LOCAL_SUFFIX.test(name)) return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && (b === 168 || b === 0)) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    return false;
  }

  if (name.includes(':')) {
    if (name === '::1' || name === '::') return true;
    if (/^f[cd]/.test(name)) return true;
    if (/^fe[89ab]/.test(name)) return true;
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(name);
    if (mapped?.[1]) return isPrivateHost(mapped[1]);
    return false;
  }

  return false;
}

const MAX_BASE_LENGTH = 300;

export function safeBase(raw, policy) {
  if (policy === 'off') {
    return { error: 'Este servidor no admite proveedores propios (AI_CUSTOM_PROVIDERS).' };
  }
  if (typeof raw !== 'string' || !raw.trim()) return { error: 'Falta la URL base del proveedor.' };
  if (raw.length > MAX_BASE_LENGTH) return { error: 'La URL base es demasiado larga.' };

  const text = raw.trim()
    .replace(/\/+$/, '')
    .replace(/\/(?:chat\/completions|messages)$/i, '')
    .replace(/\/+$/, '');

  let url;
  try {
    url = new URL(text);
  } catch {
    return { error: 'La URL base no es una dirección válida.' };
  }

  if (url.protocol !== 'https:' && !(policy === 'local' && url.protocol === 'http:')) {
    return { error: 'La URL base tiene que empezar por https://' };
  }
  if (url.username || url.password) {
    return { error: 'La URL base no puede llevar usuario ni contraseña.' };
  }
  if (url.search || url.hash) {
    return { error: 'La URL base no puede llevar parámetros.' };
  }
  if (policy !== 'local' && isPrivateHost(url.hostname)) {
    return { error: 'Esa dirección es de una red interna y este servidor no la permite.' };
  }

  const path = url.pathname.replace(/\/+$/, '');
  return { base: url.origin + (path || '/v1') };
}

function baseLabel(base) {
  try {
    return new URL(base).host;
  } catch {
    return 'proveedor propio';
  }
}

export function getHeader(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return (headers.get(name) ?? '').trim();
  const raw = headers[name.toLowerCase()] ?? headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value.trim() : '';
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const FORBIDDEN_HEADERS = new Set([
  'host', 'connection', 'proxy-connection', 'proxy-authorization', 'content-length',
  'content-type', 'content-encoding', 'transfer-encoding', 'te', 'trailer', 'upgrade',
  'keep-alive', 'expect', 'cookie', 'cookie2', 'set-cookie',
]);
const MAX_HEADERS = 8;
const MAX_HEADER_VALUE = 1024;
const MAX_HEADERS_TOTAL = 3072;

function quote(raw) {
  return `«${raw.replace(/[^\x20-\x7e]/g, '').slice(0, 40)}»`;
}

export function safeHeaderName(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { name: '' };
  const name = raw.trim();
  if (!HEADER_NAME.test(name)) return { error: `${quote(name)} no es un nombre de cabecera válido.` };
  if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
    return { error: `La cabecera ${quote(name)} la pone este servidor y no se puede cambiar.` };
  }
  return { name };
}

export function safeHeaders(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { headers: {} };
  if (raw.length > MAX_HEADERS_TOTAL) return { error: 'Las cabeceras propias son demasiadas.' };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: 'No se entendieron las cabeceras propias.' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: 'Las cabeceras propias tienen que ser pares de nombre y valor.' };
  }

  const entries = Object.entries(parsed);
  if (entries.length > MAX_HEADERS) return { error: `Como máximo ${MAX_HEADERS} cabeceras propias.` };

  const headers = {};
  for (const [rawName, value] of entries) {
    const checked = safeHeaderName(rawName);
    if ('error' in checked) return checked;
    if (!checked.name) continue;
    if (typeof value !== 'string') return { error: `El valor de ${quote(rawName)} no es texto.` };
    if (value.length > MAX_HEADER_VALUE) return { error: `El valor de ${quote(rawName)} es demasiado largo.` };
    if (!/^[\t\x20-\x7e]*$/.test(value)) {
      return { error: `El valor de ${quote(rawName)} lleva caracteres que no caben en una cabecera.` };
    }
    headers[checked.name] = value;
  }
  return { headers };
}

export function authHeaders(key, target) {
  if (!key) return {};
  if (target.keyHeader) return { [target.keyHeader]: key };
  return { Authorization: `Bearer ${key}` };
}

const REGISTRY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function readTarget(headers, provider, env) {
  if (typeof provider !== 'string') {
    return { ok: false, code: 'unknown_provider', message: 'Proveedor no reconocido.' };
  }

  if (provider === 'custom') {
    const checked = safeBase(getHeader(headers, 'x-ai-base'), basePolicy(env));
    if ('error' in checked) return { ok: false, code: 'bad_base', message: checked.error };

    const named = safeHeaderName(getHeader(headers, 'x-ai-key-header'));
    if ('error' in named) return { ok: false, code: 'bad_headers', message: named.error };

    const extra = safeHeaders(getHeader(headers, 'x-ai-headers'));
    if ('error' in extra) return { ok: false, code: 'bad_headers', message: extra.error };

    const anthropic = getHeader(headers, 'x-ai-format').toLowerCase() === 'anthropic';
    const hint = getHeader(headers, 'x-ai-registry');
    return {
      ok: true,
      target: {
        id: 'custom',
        label: baseLabel(checked.base),
        chatUrls: [`${checked.base}/${anthropic ? 'messages' : 'chat/completions'}`],
        modelUrls: [`${checked.base}/models`],
        defaultModel: '',
        publicCatalog: false,
        registry: REGISTRY_ID.test(hint) ? hint : '',
        base: checked.base,
        custom: true,
        format: anthropic ? 'anthropic' : 'openai',
        keyHeader: named.name || (anthropic ? 'x-api-key' : ''),
        ...(anthropic ? { headers: { 'anthropic-version': ANTHROPIC_VERSION } } : {}),
        ...(Object.keys(extra.headers).length > 0 ? { extra: extra.headers } : {}),
      },
    };
  }

  if (!Object.hasOwn(PROVIDERS, provider)) {
    return { ok: false, code: 'unknown_provider', message: 'Proveedor no reconocido.' };
  }
  const spec = PROVIDERS[provider];
  return {
    ok: true,
    target: {
      id: spec.id,
      label: spec.label,
      chatUrls: spec.chatUrls,
      modelUrls: spec.modelUrls,
      defaultModel: spec.defaultModel,
      headers: spec.headers,
      publicCatalog: spec.publicCatalog === true,
      envKey: spec.envKey,
      registry: spec.registry,
      base: '',
      custom: false,
      format: spec.format ?? 'openai',
      keyHeader: spec.keyHeader ?? '',
    },
  };
}

export function resolveKey(headers, target, env) {
  const sent = getHeader(headers, 'x-ai-key');
  if (sent) return sent;
  const fromEnv = target.envKey ? envVar(target.envKey, env) : '';
  return fromEnv || null;
}

export function configuredProviders(env) {
  return {
    freepi: Boolean(envVar('FREEPI_TOKEN', env)),
    openai: Boolean(envVar('OPENAI_API_KEY', env)),
    anthropic: Boolean(envVar('ANTHROPIC_API_KEY', env)),
    openrouter: Boolean(envVar('OPENROUTER_API_KEY', env)),
    github: Boolean(envVar('GITHUB_AI_TOKEN', env)),
    nvidia: Boolean(envVar('NVIDIA_API_KEY', env)),
  };
}

export async function fetchWithFallback(urls, init, options = {}) {
  let last = null;
  for (const url of urls) {
    const response = await fetch(url, {
      ...init,
      ...(options.noRedirect ? { redirect: 'manual' } : {}),
      ...(options.timeoutMs ? { signal: AbortSignal.timeout(options.timeoutMs) } : {}),
    });
    if (options.noRedirect && response.status >= 300 && response.status < 400) {
      throw new Error('El proveedor redirige a otra dirección. Usa la URL final.');
    }
    if (response.status !== 401 && response.status !== 403) return response;
    last = response;
  }
  return last;
}

export function sseHeaders() {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  };
}

export function transformSseResponse(upstream, transform) {
  const body = upstream.body;
  if (!transform) {
    return new Response(body, { status: 200, headers: sseHeaders() });
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      if (!body) { controller.close(); return; }
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          const buffer = pending + text;
          const cut = buffer.lastIndexOf('\n');
          if (cut === -1) { pending = buffer; continue; }
          pending = buffer.slice(cut + 1);
          controller.enqueue(encoder.encode(transform(buffer.slice(0, cut + 1))));
        }
        if (pending) controller.enqueue(encoder.encode(transform(pending)));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { status: 200, headers: sseHeaders() });
}

export function describeError(error) {
  if (!(error instanceof Error)) return 'Error interno del servidor.';
  if (error.name === 'TimeoutError') {
    return 'El proveedor no respondió a tiempo. Comprueba la URL y que el servidor esté escuchando.';
  }
  if (error.message === 'fetch failed') {
    return 'No se pudo conectar con esa dirección. Comprueba la URL y que el servidor esté encendido.';
  }
  return error.message;
}

export function explainBody(status, label, contentType, text, offerAnthropic = false) {
  if ((contentType ?? '').includes('json')) return null;
  try {
    JSON.parse(text);
    return null;
  } catch { /* no era JSON */ }

  const blocked = /Attention Required|cf-error|Cloudflare Ray ID|have been blocked/i.test(text);
  if (blocked) {
    const salida = offerAnthropic
      ? 'Si su catálogo de modelos sí carga, prueba el formato Anthropic en los ajustes de ese proveedor.'
      : 'Si el catálogo de modelos sí carga, lo cerrado es sólo el camino del chat.';
    return `${label} devolvió ${status}: su cortafuegos bloqueó la petición antes de llegar a la API. ${salida}`;
  }

  const plain = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const quoted = plain && plain.length <= 200 && !/^</.test(text.trim()) ? ` Dijo: «${plain}»` : '';
  return `${label} devolvió ${status} y no una respuesta de la API.${quoted}`;
}

export function jsonRes(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}
