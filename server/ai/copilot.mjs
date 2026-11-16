/**
 * ATOM · Ayudas para GitHub Copilot (modelos usables, plan y resolucion de "auto")
 */

export const DEFAULT_COPILOT_HOST = 'https://api.githubcopilot.com';
const USER_URL = 'https://api.github.com/copilot_internal/user';
const API_VERSION = '2026-08-01';
const USER_API_VERSION = '2025-04-01';
const GITHUB_USER_AGENT = 'atom-studio/1.0';
const PAID_PLANS = new Set(['pro', 'proplus', 'max', 'business', 'enterprise', 'team']);
const AUTO_PREFERENCE = ['gpt-4.1', 'gpt-5-mini', 'gpt-4o', 'gpt-4o-mini'];

export function copilotHeaders() {
  return {
    'User-Agent': GITHUB_USER_AGENT,
    'Openai-Intent': 'conversation-edits',
    'X-GitHub-Api-Version': API_VERSION,
    'x-initiator': 'user',
  };
}

function githubHeaders(key) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${key}`,
    'X-GitHub-Api-Version': USER_API_VERSION,
    'User-Agent': GITHUB_USER_AGENT,
  };
}

export function allowedModelsFromError(body) {
  const match = /Available models:\s*\[([^\]]*)\]/i.exec(body);
  if (!match?.[1]) return null;
  const ids = match[1].split(/[\s,]+/).map((id) => id.trim()).filter(Boolean);
  return ids.length > 0 ? ids : null;
}

export function integratorFromError(body) {
  const match = /integrator\s+"([^"]+)"/i.exec(body);
  return match?.[1] ?? null;
}

export async function usableModels(key, host) {
  const bases = [...new Set([host, DEFAULT_COPILOT_HOST])];
  for (const base of bases) {
    try {
      const response = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { ...githubHeaders(key), ...copilotHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: '__sondeo_de_modelos__',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
        cache: 'no-store',
      });
      const text = await response.text().catch(() => '');
      const allowed = allowedModelsFromError(text);
      if (allowed) return allowed;
    } catch { /* siguiente host */ }
  }
  return null;
}

function isAutoOnly(data) {
  const norm = (raw) => (typeof raw === 'string'
    ? raw.trim().toLowerCase().replace(/^copilot/, '').replace(/[\s_-]/g, '')
    : '');
  const plan = norm(data.copilot_plan);
  const sku = norm(data.access_type_sku);
  if (PAID_PLANS.has(plan) || PAID_PLANS.has(sku)) return false;
  if (data.limited_user_quotas && typeof data.limited_user_quotas === 'object') return true;
  return true;
}

export async function copilotPlan(key) {
  let response;
  try {
    response = await fetch(USER_URL, {
      headers: githubHeaders(key),
      cache: 'no-store',
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const data = await response.json().catch(() => null);
  if (!data) return null;
  const plan = typeof data.copilot_plan === 'string' ? data.copilot_plan.trim().toLowerCase() : '';
  const api = typeof data.endpoints?.api === 'string' ? data.endpoints.api.trim() : '';
  return {
    plan,
    host: (api || DEFAULT_COPILOT_HOST).replace(/\/+$/, ''),
    autoOnly: isAutoOnly(data),
  };
}

export function autoOnlyModels() {
  return [{ id: 'auto', name: 'Auto (lo elige Copilot)', publisher: 'GitHub' }];
}

export function resolveAutoModel(available) {
  const usable = new Set(available);
  for (const candidate of AUTO_PREFERENCE) {
    if (usable.has(candidate)) return candidate;
  }
  return available[0] ?? AUTO_PREFERENCE[0];
}

export async function copilotAutoModel(key, host, prompt, hasImage) {
  const bases = [...new Set([host, DEFAULT_COPILOT_HOST])];
  const body = { prompt };
  if (hasImage) body.has_image = true;
  for (const base of bases) {
    try {
      const response = await fetch(`${base}/auto`, {
        method: 'POST',
        headers: { ...githubHeaders(key), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
      });
      if (!response.ok) continue;
      const data = await response.json().catch(() => null);
      const id = data?.selected_model?.id;
      if (typeof id === 'string' && id) return id;
    } catch { /* siguiente host */ }
  }
  return null;
}
