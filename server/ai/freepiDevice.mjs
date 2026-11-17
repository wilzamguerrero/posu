/**
 * ATOM · free-pi device flow + estado de cuenta (alineado con api.freepi.ai / Zence-R2 / iii)
 */
import { FREEPI_ROOT } from './freepi.mjs';

export const CONSENT_VERSION = '4';
const GITHUB_DEVICE = 'https://github.com/login/device';

export const CONSENT_TEXT =
  'free-pi es gratis. A cambio, muestra anuncios y puede entrenar con tus datos. '
  + 'Si quieres usarlo, aceptas eso. Si no, no lo uses.\n'
  + 'Debes tener al menos 13 años en EE. UU., 16 en EEE/RU, o 18 en el resto.\n'
  + 'Términos: https://freepi.ai/terms   Privacidad: https://freepi.ai/privacy';

function str(value) {
  return typeof value === 'string' ? value : '';
}

function positive(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const SESSION_RE = /^[0-9a-fA-F-]{16,64}$/;
function validSession(value) {
  return typeof value === 'string' && SESSION_RE.test(value.trim());
}

async function postRoot(path, body) {
  const response = await fetch(`${FREEPI_ROOT}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const raw = await response.text();
  let data = {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') data = parsed;
  } catch { /* cuerpo no JSON */ }
  return { status: response.status, data };
}

export async function deviceStart() {
  const { status, data } = await postRoot('/auth/github/device', {});
  const sessionId = str(data.session_id).trim();
  const userCode = str(data.user_code).trim();
  const verificationUri = str(data.verification_uri) || GITHUB_DEVICE;

  if (status !== 200 || !sessionId || !userCode) {
    const message = str(data.message) || str(data.error);
    throw new Error(`free-pi no dio código de dispositivo (HTTP ${status}${message ? `: ${message}` : ''}).`);
  }

  return {
    sessionId,
    userCode,
    verificationUri,
    verificationUriComplete: str(data.verification_uri_complete)
      || str(data.verification_uri)
      || `${verificationUri}?user_code=${encodeURIComponent(userCode)}`,
    interval: Math.max(3, positive(data.interval, 5)),
    expiresIn: positive(data.expires_in, 900),
    consentText: CONSENT_TEXT,
  };
}

export async function deviceConsent(sessionId) {
  if (!validSession(sessionId)) throw new Error('La sesión de login no es válida.');
  const { status, data } = await postRoot('/auth/consent', {
    session_id: sessionId.trim(),
    consent_version: CONSENT_VERSION,
  });
  if (status !== 200) {
    const message = str(data.message) || str(data.error);
    throw new Error(`El consentimiento fue rechazado (HTTP ${status}${message ? `: ${message}` : ''}).`);
  }
}

function daysLeft(token) {
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '=')));
    if (typeof json.exp !== 'number') return null;
    return Math.max(0, Math.floor((json.exp * 1000 - Date.now()) / 86_400_000));
  } catch {
    return null;
  }
}

export async function devicePoll(sessionId) {
  if (!validSession(sessionId)) {
    return { kind: 'error', message: 'La sesión de login no es válida.' };
  }
  let status;
  let data;
  try {
    ({ status, data } = await postRoot('/auth/token', { session_id: sessionId.trim() }));
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : 'Sin respuesta.' };
  }

  const token = str(data.token);
  if (token) return { kind: 'token', token, days: daysLeft(token) };
  if (str(data.code) === 'consent_required') {
    return { kind: 'consent', message: str(data.message) || 'Falta aceptar el consentimiento.' };
  }
  if (status === 410 || str(data.message) === 'expired_token') {
    return { kind: 'expired', message: 'El código caducó. Empieza otra vez.' };
  }
  if (status === 200 && str(data.status) === 'pending') {
    const retry = Number(data.retry_after);
    return { kind: 'pending', retryAfter: Number.isFinite(retry) && retry > 0 ? retry : null };
  }
  return { kind: 'error', message: `HTTP ${status}: ${JSON.stringify(data).slice(0, 160)}` };
}

export async function freepiMe(token) {
  const key = (token ?? '').trim();
  if (!key) return null;
  try {
    const response = await fetch(`${FREEPI_ROOT}/me`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const num = (v) => {
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : null;
    };
    return {
      handle: str(data.handle),
      tier: str(data.tier),
      remainingCredits: num(data.remaining_credits_today),
      allowanceCredits: num(data.allowance_credits),
      days: daysLeft(key),
    };
  } catch {
    return null;
  }
}
