/**
 * ATOM · free-pi: cabeceras, catalogo de modelos y flujo con respaldo de razonamiento
 */
import { sseHeaders } from './common.mjs';

export const FREEPI_ROOT = 'https://api.freepi.ai';
const DEFAULT_CLIENT_VERSION = '0.2.1';
const CACHE_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 2 * 60 * 1000;
const NAMESPACE_SALT = 'atom:freepi-session:v1';

let catalogCache = null;
let failedAt = 0;
let inflight = null;

export function isFreePi(url) {
  return url.startsWith(FREEPI_ROOT);
}

/** Genera UUID determinista a partir de la clave sin depender de `node:crypto` (compatible con Workers). */
async function sessionUuid(key) {
  const data = new TextEncoder().encode(`${NAMESPACE_SALT}\0${key}`);
  if (typeof crypto !== 'undefined' && crypto.subtle?.digest) {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    const b = hash.slice(0, 16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  }
  let h1 = 0x811c9dc5;
  for (let i = 0; i < data.length; i += 1) {
    h1 ^= data[i];
    h1 = Math.imul(h1, 0x01000193);
  }
  const s = (h1 >>> 0).toString(16).padStart(8, '0');
  return `${s}-${s.slice(0, 4)}-4${s.slice(1, 4)}-8${s.slice(1, 4)}-${s}${s.slice(0, 4)}`;
}

function comparesLower(a, b) {
  if (!a || !b) return false;
  const left = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

async function downloadCatalog(token) {
  try {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${FREEPI_ROOT}/client-version`, {
      headers,
      signal: AbortSignal.timeout(8_000),
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json().catch(() => null);
    if (!data || typeof data !== 'object') throw new Error('catalogo ilegible');

    const min = typeof data.min === 'string' ? data.min.trim() : '';
    const latest = typeof data.latest === 'string' ? data.latest.trim() : '';
    const clientVersion = comparesLower(DEFAULT_CLIENT_VERSION, min)
      ? (latest || min || DEFAULT_CLIENT_VERSION)
      : DEFAULT_CLIENT_VERSION;

    const rawModels = Array.isArray(data.models) ? data.models : [];
    const models = rawModels.map((entry) => {
      const m = typeof entry === 'object' && entry !== null ? entry : {};
      const id = typeof m.id === 'string' ? m.id.trim() : '';
      const label = typeof m.label === 'string' ? m.label.trim() : (typeof m.name === 'string' ? m.name.trim() : id);
      const input = Array.isArray(m.input) ? m.input : [];
      return {
        id,
        name: label,
        free: m.free === true || m.usage === 0,
        vision: input.includes('image') || m.vision === true,
      };
    }).filter((m) => m.id);

    const next = { models, clientVersion };
    catalogCache = { at: Date.now(), data: next };
    failedAt = 0;
    return next;
  } catch (err) {
    failedAt = Date.now();
    console.warn('[freepi]', err instanceof Error ? err.message : 'no se pudo leer /client-version');
    return catalogCache?.data ?? null;
  }
}

export async function freepiCatalog(token) {
  const now = Date.now();
  if (catalogCache && now - catalogCache.at < CACHE_MS) return catalogCache.data;
  if (!catalogCache && failedAt && now - failedAt < RETRY_MS) return null;
  inflight ??= downloadCatalog(token).finally(() => { inflight = null; });
  return await inflight;
}

export async function freepiHeaders(token) {
  const key = (token ?? '').trim();
  const catalog = await freepiCatalog(key || null);
  const headers = {
    'X-Pi-Client-Version': catalog?.clientVersion ?? DEFAULT_CLIENT_VERSION,
  };
  if (key) headers['X-Session-Id'] = await sessionUuid(key);
  return headers;
}

export function replyText(message) {
  const content = message.content;
  if (typeof content === 'string' && content.trim()) return content;
  const reasoning = message.reasoning_content;
  if (typeof reasoning === 'string' && reasoning.trim()) return reasoning;
  return typeof content === 'string' ? content : '';
}

export function pipeFreePiResponse(upstream) {
  const body = upstream.body;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      if (!body) {
        controller.close();
        return;
      }
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let hasContent = false;
      let reasoning = '';
      let sawDone = false;

      const emit = (line) => controller.enqueue(encoder.encode(`${line}\n`));

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const raw of lines) {
            const line = raw.replace(/\r$/, '');
            if (line === 'data: [DONE]') { sawDone = true; continue; }
            if (!line.startsWith('data:')) { emit(line); continue; }
            let chunk;
            try {
              chunk = JSON.parse(line.slice(5).trim());
            } catch {
              emit(line);
              continue;
            }
            const choice = chunk?.choices?.[0];
            const delta = choice?.delta;
            if (!delta || typeof delta !== 'object') { emit(line); continue; }
            const piece = typeof delta.content === 'string' ? delta.content : '';
            const thought = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '';
            if (piece) hasContent = true;
            if (thought) reasoning += thought;
            if ('reasoning_content' in delta) {
              const { reasoning_content: _drop, ...clean } = delta;
              chunk.choices[0] = { ...choice, delta: clean };
              if (!piece && !choice.finish_reason) continue;
            }
            emit(`data: ${JSON.stringify(chunk)}`);
          }
        }
        if (buffer.trim() && buffer.trim() !== 'data: [DONE]') emit(buffer);
        if (!hasContent && reasoning.trim()) {
          const fallback = {
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { content: reasoning }, finish_reason: 'stop' }],
          };
          emit(`data: ${JSON.stringify(fallback)}`);
          emit('');
        }
        if (sawDone || (!hasContent && reasoning.trim())) {
          emit('data: [DONE]');
          emit('');
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { status: 200, headers: sseHeaders() });
}
