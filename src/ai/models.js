/**
 * ATOM · Catalogo de modelos por proveedor (con cache en memoria)
 */
import { aiHeaders, readError, readJson, wireProvider } from './wire.js';
import { customProvider } from './config.js';

const cache = new Map();

export function cacheKey(provider) {
  const hdrs = aiHeaders(provider);
  const custom = customProvider(provider);
  const base = custom ? custom.baseUrl : '';
  const fmt = custom?.format || '';
  const tail = `${hdrs['X-Ai-Key'] ? 'k' : 'n'}:${base}:${fmt}`;
  return `${provider}::${tail}`;
}

export function cachedCatalog(provider) {
  return cache.get(cacheKey(provider)) ?? null;
}

export function forgetCatalog(provider) {
  if (!provider) { cache.clear(); return; }
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${provider}::`)) cache.delete(key);
  }
}

export async function listModels(provider, { force = false, signal } = {}) {
  const key = cacheKey(provider);
  if (!force && cache.has(key)) return cache.get(key);

  const wire = wireProvider(provider);
  const response = await fetch(`/api/ai-models?provider=${encodeURIComponent(wire)}`, {
    method: 'GET',
    headers: aiHeaders(provider),
    cache: 'no-store',
    signal,
  });
  if (!response.ok) throw new Error(await readError(response));
  const data = await readJson(response);
  if (!data || !Array.isArray(data.models)) {
    throw new Error('Respuesta inesperada al leer los modelos.');
  }
  const catalog = {
    provider,
    source: data.source || 'provider',
    defaultModel: typeof data.defaultModel === 'string' ? data.defaultModel : '',
    notice: typeof data.notice === 'string' ? data.notice : '',
    models: data.models,
  };
  cache.set(key, catalog);
  return catalog;
}
