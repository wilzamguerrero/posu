/**
 * ATOM · Flujo de dispositivo GitHub OAuth (Copilot)
 */
import { readError, readJson } from './wire.js';

const DEFAULT_INTERVAL_S = 5;
const MARGIN_MS = 250;

async function post(body, signal) {
  const response = await fetch('/api/github-device', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(await readError(response));
  const data = await readJson(response);
  if (!data || typeof data !== 'object') {
    throw new Error('Respuesta ilegible de GitHub al autorizar.');
  }
  return data;
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

export async function startDeviceFlow(signal) {
  const data = await post({ action: 'start' }, signal);
  const userCode = typeof data.user_code === 'string' ? data.user_code : '';
  const deviceCode = typeof data.device_code === 'string' ? data.device_code : '';
  const uri = typeof data.verification_uri === 'string' ? data.verification_uri : 'https://github.com/login/device';
  if (!userCode || !deviceCode) {
    throw new Error(typeof data.error_description === 'string' ? data.error_description : 'GitHub no devolvió ningún código.');
  }
  const expires = Number(data.expires_in);
  const interval = Number(data.interval);
  return {
    userCode,
    deviceCode,
    verificationUri: uri,
    expiresIn: Number.isFinite(expires) && expires > 0 ? expires : 900,
    interval: Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_INTERVAL_S,
  };
}

export async function waitForDeviceToken(start, signal) {
  const deadline = Date.now() + start.expiresIn * 1000;
  let wait = start.interval;
  for (;;) {
    await sleep(wait * 1000 + MARGIN_MS, signal);
    if (Date.now() > deadline) throw new Error('El código caducó. Empieza otra vez.');

    const data = await post({ action: 'poll', device_code: start.deviceCode }, signal);
    if (typeof data.access_token === 'string' && data.access_token) {
      return data.access_token;
    }
    const err = typeof data.error === 'string' ? data.error : '';
    if (err === 'authorization_pending') continue;
    if (err === 'slow_down') { wait += 5; continue; }
    if (err === 'expired_token') throw new Error('El código caducó. Empieza otra vez.');
    if (err === 'access_denied') throw new Error('Autorización cancelada en GitHub.');
    throw new Error(typeof data.error_description === 'string' ? data.error_description : (err || 'GitHub no devolvió ningún token.'));
  }
}
