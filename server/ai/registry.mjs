/**
 * ATOM · Registro publico de modelos (models.dev/api.json) con cache en memoria
 */
import { envVar } from './common.mjs';

const DEFAULT_URL = 'https://models.dev/api.json';
const TTL_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 2 * 60 * 1000;
const TIMEOUT_MS = 10_000;

function str(v) { return typeof v === 'string' ? v : ''; }
function num(v) { return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0; }

function projectProvider(id, raw) {
  if (typeof raw !== 'object' || raw === null) return null;
  const models = {};
  const rawModels = raw.models;
  if (typeof rawModels === 'object' && rawModels !== null) {
    let priced = false;
    for (const value of Object.values(rawModels)) {
      const cost = value?.cost;
      if (num(cost?.input) > 0 || num(cost?.output) > 0) { priced = true; break; }
    }
    for (const [modelId, value] of Object.entries(rawModels)) {
      if (typeof value !== 'object' || value === null) continue;
      const realId = str(value.id) || modelId;
      models[realId] = {
        id: realId,
        name: str(value.name) || realId,
        ctx: num(value.limit?.context),
        free: priced && num(value.cost?.input) === 0 && num(value.cost?.output) === 0,
        reasoning: value.reasoning === true,
      };
    }
  }
  return {
    id: str(raw.id) || id,
    name: str(raw.name) || id,
    api: str(raw.api),
    doc: str(raw.doc),
    compatible: str(raw.npm) === '@ai-sdk/openai-compatible',
    models,
  };
}

function project(raw) {
  if (typeof raw !== 'object' || raw === null) return {};
  const out = {};
  for (const [id, value] of Object.entries(raw)) {
    const provider = projectProvider(id, value);
    if (provider) out[id] = provider;
  }
  return out;
}

let cache = null;
let failedAt = 0;
let inflight = null;

async function download(env) {
  const url = envVar('AI_MODELS_URL', env) || DEFAULT_URL;
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'follow',
    });
    if (!response.ok) throw new Error(`models.dev respondió ${response.status}`);
    const data = project(await response.json());
    if (Object.keys(data).length === 0) throw new Error('registro vacío');
    cache = { at: Date.now(), data };
    failedAt = 0;
    return data;
  } catch (err) {
    failedAt = Date.now();
    console.warn('[ai-registry]', err instanceof Error ? err.message : 'no se pudo leer');
    return cache?.data ?? null;
  }
}

export async function registry(env) {
  if (envVar('AI_MODELS_OFF', env) === '1') return null;
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.data;
  if (!cache && failedAt && now - failedAt < RETRY_MS) return null;
  inflight ??= download(env).finally(() => { inflight = null; });
  return await inflight;
}

export async function registryProvider(id, env) {
  const all = await registry(env);
  if (!all || !Object.hasOwn(all, id)) return null;
  return all[id] ?? null;
}

function sameApi(a, b) {
  const trim = (v) => v.toLowerCase().replace(/\/+$/, '').replace(/\/v\d+$/, '');
  return Boolean(a) && trim(a) === trim(b);
}

export async function registryByApi(base, env) {
  const all = await registry(env);
  if (!all) return null;
  for (const provider of Object.values(all)) {
    if (sameApi(provider.api, base)) return provider;
  }
  return null;
}

export async function registryDirectory(exclude, env) {
  const all = await registry(env);
  if (!all) return [];
  const skip = new Set(exclude);
  const out = [];
  for (const provider of Object.values(all)) {
    if (skip.has(provider.id) || !provider.compatible) continue;
    out.push({
      id: provider.id,
      name: provider.name,
      api: provider.api,
      doc: provider.doc,
      models: Object.keys(provider.models).length,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
