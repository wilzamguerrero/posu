/**
 * ATOM · Flujo de dispositivo free-pi (nivel gratuito via GitHub)
 */
import { readError, readJson } from './wire.js';

const DEFAULT_INTERVAL_S = 5;
const MARGIN_MS = 250;

async function post(body, signal) {
  const response = await fetch('/api/freepi-device', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(await readError(response));
  const data = await readJson(response);
  if (!data || typeof data !== 'object') {
    throw new Error('free-pi devolvió una respuesta ilegible.');
  }
  return data;
}

function text(v) { return typeof v === 'string' ? v : ''; }
function seconds(v, fallback) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Espera cancelada.', 'AbortError')); return; }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Espera cancelada.', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function startFreePiFlow(signal) {
  const data = await post({ action: 'start' }, signal);
  const sessionId = text(data.session_id);
  const userCode = text(data.user_code);
  if (!sessionId || !userCode) {
    throw new Error(text(data.message) || 'free-pi no devolvió ningún código.');
  }
  return {
    sessionId,
    userCode,
    verificationUri: text(data.verification_uri) || 'https://github.com/login/device',
    verificationUriComplete: text(data.verification_uri_complete) || text(data.verification_uri),
    expiresIn: seconds(data.expires_in, 900),
    interval: Math.max(3, seconds(data.interval, DEFAULT_INTERVAL_S)),
    consentText: text(data.consent_text),
  };
}

export async function consentFreePi(sessionId, signal) {
  await post({ action: 'consent', session_id: sessionId }, signal);
}

export async function waitForFreePiToken(start, signal) {
  await consentFreePi(start.sessionId, signal);
  const deadline = Date.now() + start.expiresIn * 1000;
  let wait = start.interval;

  for (;;) {
    await sleep(wait * 1000 + MARGIN_MS, signal);
    if (Date.now() > deadline) throw new Error('El código caducó. Empieza otra vez.');

    const data = await post({ action: 'poll', session_id: start.sessionId }, signal);
    const token = text(data.token);
    if (token) {
      return { token, days: typeof data.days === 'number' ? data.days : null };
    }
    if (data.status === 'pending') {
      const asked = seconds(data.retry_after, 0);
      if (asked) wait = Math.max(wait, asked);
      continue;
    }
    if (data.error === 'expired_token') throw new Error('El código caducó. Empieza otra vez.');
    if (data.status === 'consent_required') {
      throw new Error(text(data.message) || 'free-pi no registró el consentimiento.');
    }
    throw new Error(text(data.message) || 'free-pi no devolvió ningún token.');
  }
}

export async function freePiAccount(token, signal) {
  const key = (token ?? '').trim();
  if (!key) return null;
  try {
    const response = await fetch('/api/freepi-device', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ai-Key': key },
      body: JSON.stringify({ action: 'me' }),
      signal,
    });
    if (!response.ok) return null;
    const data = await readJson(response);
    if (!data || typeof data !== 'object') return null;
    return {
      handle: text(data.handle),
      tier: text(data.tier),
      remainingCredits: typeof data.remainingCredits === 'number' ? data.remainingCredits : null,
      allowanceCredits: typeof data.allowanceCredits === 'number' ? data.allowanceCredits : null,
      days: typeof data.days === 'number' ? data.days : null,
    };
  } catch {
    return null;
  }
}
