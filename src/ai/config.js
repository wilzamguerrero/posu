/**
 * ATOM · Estado persistido de proveedores, claves, modelo elegido y proveedores propios
 */
import { atom } from './store.js';
import { BUILTIN_IDS, BUILTINS, customId, customSlug, isBuiltin, isCustom } from './providers.js';

const STORAGE_KEY = 'posu.ai.config.v1';
const LEGACY_KEYS = ['zence.ai.config'];

const EMPTY_CONFIG = {
  provider: 'freepi',
  keys: {},
  models: {},
  custom: {},
};

function sanitizeStringMap(raw) {
  if (typeof raw !== 'object' || raw === null) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

function sanitizeHeaders(raw) {
  if (typeof raw !== 'object' || raw === null) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k === 'string' && k.trim() && typeof v === 'string') out[k.trim()] = v;
  }
  return out;
}

function sanitizeCustom(raw) {
  if (typeof raw !== 'object' || raw === null) return {};
  const out = {};
  for (const [slug, value] of Object.entries(raw)) {
    if (typeof value !== 'object' || value === null) continue;
    const baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl.trim() : '';
    if (!baseUrl) continue;
    const label = typeof value.label === 'string' && value.label.trim() ? value.label.trim() : baseUrl;
    const headers = sanitizeHeaders(value.headers);
    const entry = { label, baseUrl };
    if (typeof value.registry === 'string' && value.registry.trim()) entry.registry = value.registry.trim();
    if (typeof value.keyHeader === 'string' && value.keyHeader.trim()) entry.keyHeader = value.keyHeader.trim();
    if (value.format === 'anthropic') entry.format = 'anthropic';
    if (Object.keys(headers).length > 0) entry.headers = headers;
    out[slug] = entry;
  }
  return out;
}

function load() {
  if (typeof localStorage === 'undefined') return structuredClone(EMPTY_CONFIG);
  try {
    let raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      for (const oldKey of LEGACY_KEYS) {
        const legacy = localStorage.getItem(oldKey);
        if (legacy) { raw = legacy; break; }
      }
    }
    if (!raw) return structuredClone(EMPTY_CONFIG);
    const parsed = JSON.parse(raw);
    const custom = sanitizeCustom(parsed.custom);
    const prov = typeof parsed.provider === 'string' ? parsed.provider : 'freepi';
    const validProv = isBuiltin(prov) || (isCustom(prov) && Boolean(custom[customSlug(prov)]))
      ? prov
      : 'freepi';
    return {
      provider: validProv,
      keys: sanitizeStringMap(parsed.keys),
      models: sanitizeStringMap(parsed.models),
      custom,
    };
  } catch {
    return structuredClone(EMPTY_CONFIG);
  }
}

function persist(cfg) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    // Modo privado o cuota llena
  }
}

export const aiConfig = atom(load());
aiConfig.subscribe(persist);

export const serverKeys = atom(null);
export const customPolicy = atom(null);

let probeInflight = null;
export async function probeServerKeys() {
  if (typeof fetch !== 'function') return null;
  if (!probeInflight) {
    probeInflight = fetch('/api/health', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const flags = data?.ai?.providers;
        const next = flags
          ? {
            freepi: Boolean(flags.freepi),
            openai: Boolean(flags.openai),
            anthropic: Boolean(flags.anthropic),
            openrouter: Boolean(flags.openrouter),
            github: Boolean(flags.github),
            nvidia: Boolean(flags.nvidia),
          }
          : null;
        serverKeys.set(next);
        const pol = data?.ai?.customProviders;
        if (pol === 'off' || pol === 'public' || pol === 'local') customPolicy.set(pol);
        return next;
      })
      .catch(() => null)
      .finally(() => { probeInflight = null; });
  }
  return await probeInflight;
}

export function activeProvider() {
  return aiConfig.get().provider;
}

export function setProvider(id) {
  if (!isBuiltin(id) && !customProvider(id)) return;
  aiConfig.update((c) => ({ ...c, provider: id }));
}

export function browserKey(id) {
  return aiConfig.get().keys[id] ?? '';
}

export function setKey(id, value) {
  const trimmed = value.trim();
  aiConfig.update((c) => {
    const keys = { ...c.keys };
    if (trimmed) keys[id] = trimmed;
    else delete keys[id];
    return { ...c, keys };
  });
}

export function clearKey(id) {
  setKey(id, '');
}

export function hasCredential(id) {
  if (browserKey(id)) return true;
  if (!isBuiltin(id)) return false;
  return serverKeys.get()?.[id] === true;
}

export function chosenModel(id) {
  return aiConfig.get().models[id] ?? '';
}

export function setModel(id, model) {
  aiConfig.update((c) => {
    const models = { ...c.models };
    if (model.trim()) models[id] = model.trim();
    else delete models[id];
    return { ...c, models };
  });
}

export function customProviders() {
  return aiConfig.get().custom;
}

export function customProvider(id) {
  const slug = customSlug(id);
  return slug ? (aiConfig.get().custom[slug] ?? null) : null;
}

function makeSlug(label, existing) {
  const clean = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'api';
  if (!(clean in existing)) return clean;
  let i = 2;
  while (`${clean}-${i}` in existing) i += 1;
  return `${clean}-${i}`;
}

export function addCustomProvider(entry) {
  const current = aiConfig.get();
  const slug = makeSlug(entry.label || 'api', current.custom);
  const id = customId(slug);
  const clean = {
    label: (entry.label || '').trim() || 'API propia',
    baseUrl: (entry.baseUrl || '').trim(),
  };
  if (entry.registry?.trim()) clean.registry = entry.registry.trim();
  if (entry.keyHeader?.trim()) clean.keyHeader = entry.keyHeader.trim();
  if (entry.format === 'anthropic') clean.format = 'anthropic';
  const hdrs = sanitizeHeaders(entry.headers);
  if (Object.keys(hdrs).length > 0) clean.headers = hdrs;

  aiConfig.set({
    ...current,
    provider: id,
    custom: { ...current.custom, [slug]: clean },
  });
  return id;
}

export function removeCustomProvider(id) {
  const slug = customSlug(id);
  if (!slug) return;
  aiConfig.update((c) => {
    const custom = { ...c.custom };
    delete custom[slug];
    const keys = { ...c.keys };
    delete keys[id];
    const models = { ...c.models };
    delete models[id];
    const provider = c.provider === id ? 'freepi' : c.provider;
    return { ...c, provider, custom, keys, models };
  });
}

export function providerLabel(id) {
  if (isBuiltin(id)) return BUILTINS[id].label;
  return customProvider(id)?.label ?? 'API propia';
}

export function providerIds() {
  const slugs = Object.keys(aiConfig.get().custom);
  return [...BUILTIN_IDS, ...slugs.map((s) => customId(s))];
}
