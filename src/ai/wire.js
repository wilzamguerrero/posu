/**
 * ATOM · Cabeceras HTTP entre cliente y proxy /api/ai-*
 */
import { isBuiltin } from './providers.js';
import { browserKey, customProvider } from './config.js';

export function wireProvider(id) {
  if (isBuiltin(id)) return id;
  if (customProvider(id)) return 'custom';
  return id;
}

export function aiHeaders(provider) {
  const headers = {};
  const key = browserKey(provider);
  if (key) headers['X-Ai-Key'] = key;

  const custom = customProvider(provider);
  if (custom) {
    headers['X-Ai-Base'] = custom.baseUrl;
    if (custom.registry) headers['X-Ai-Registry'] = custom.registry;
    if (custom.keyHeader) headers['X-Ai-Key-Header'] = custom.keyHeader;
    if (custom.format === 'anthropic') headers['X-Ai-Format'] = 'anthropic';
    if (custom.headers && Object.keys(custom.headers).length > 0) {
      headers['X-Ai-Headers'] = JSON.stringify(custom.headers);
    }
  }
  return headers;
}

export async function readJson(response) {
  return await response.json().catch(() => null);
}

export async function readErrorDetail(response) {
  const payload = await readJson(response);
  if (payload && typeof payload === 'object') {
    const nested = typeof payload.error === 'object' && payload.error ? payload.error : null;
    const code = (typeof payload.error === 'string' && payload.error)
      || (nested && (typeof nested.type === 'string' ? nested.type : nested.code))
      || '';
    const msg = (typeof payload.message === 'string' && payload.message.trim())
      || (nested && typeof nested.message === 'string' && nested.message.trim());
    if (msg) return { message: msg, code, status: response.status };
  }
  const text = await response.text().catch(() => '');
  return { message: text.trim().slice(0, 240) || `HTTP ${response.status}`, code: '', status: response.status };
}

export async function readError(response) {
  const detail = await readErrorDetail(response);
  return detail.message;
}
