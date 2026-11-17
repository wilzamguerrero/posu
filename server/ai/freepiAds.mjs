/**
 * ATOM · Anuncios oficiales de free-pi (/ads/next y /ads/impression)
 * ---------------------------------------------------------------------------
 * free-pi financia la inferencia gratuita mostrando anuncios en el cliente.
 * Este modulo obtiene el creativo para mostrarlo en la interfaz de ATOM y
 * reporta la impresion (disparando antes el pixel de gravity si aplica)
 * una vez que el usuario lo tiene visible en pantalla.
 */
import { FREEPI_ROOT, freepiHeaders } from './freepi.mjs';

const AD_TIMEOUT_MS = 12_000;
const PIXEL_TIMEOUT_MS = 3_000;
const GRAVITY_HOSTS = ['trygravity.ai', 'trygravity.com'];

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function safeWebUrl(raw, { httpsOnly = false } = {}) {
  const s = str(raw);
  if (!s) return '';
  try {
    const u = new URL(s);
    if (httpsOnly ? u.protocol !== 'https:' : (u.protocol !== 'https:' && u.protocol !== 'http:')) {
      return '';
    }
    return u.toString();
  } catch {
    return '';
  }
}

export function isGravityUrl(raw) {
  const safe = safeWebUrl(raw, { httpsOnly: true });
  if (!safe) return false;
  try {
    const host = new URL(safe).hostname.toLowerCase();
    return GRAVITY_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

export function sanitizeAd(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const adId = str(raw.ad_id);
  const clickToken = str(raw.click_token);
  if (!adId || !clickToken) return null;
  const c = typeof raw.creative === 'object' && raw.creative !== null ? raw.creative : {};
  return {
    ad_id: adId,
    click_token: clickToken,
    source: str(raw.source) || 'own',
    click_url: safeWebUrl(raw.click_url),
    imp_url: safeWebUrl(raw.imp_url, { httpsOnly: true }),
    creative: {
      headline: str(c.headline),
      body: str(c.body),
      cta: str(c.cta),
      accent: str(c.accent),
    },
  };
}

async function adHeaders(token) {
  return {
    ...(await freepiHeaders(token)),
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

export async function fetchNextAd(token, slot = 'banner') {
  const cleanSlot = slot === 'inline' ? 'inline' : 'banner';
  const headers = await adHeaders(token);
  const response = await fetch(`${FREEPI_ROOT}/ads/next?slot=${cleanSlot}`, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(AD_TIMEOUT_MS),
    cache: 'no-store',
  });
  if (response.status === 204) {
    return { ok: true, noAd: true, ad: null };
  }
  const rawText = await response.text().catch(() => '');
  let parsed = null;
  try { parsed = JSON.parse(rawText); } catch { /* noop */ }

  if (!response.ok) {
    const msg = str(parsed?.message) || str(parsed?.error?.message) || str(parsed?.error) || `HTTP ${response.status}`;
    return { ok: false, noAd: false, status: response.status, message: msg, ad: null };
  }
  const ad = sanitizeAd(parsed);
  if (!ad) {
    return { ok: true, noAd: true, ad: null };
  }
  return { ok: true, noAd: false, ad };
}

export async function fireImpressionPixel(ad) {
  if (!ad || ad.source !== 'gravity' || !isGravityUrl(ad.imp_url)) return false;
  try {
    await fetch(ad.imp_url, {
      method: 'GET',
      signal: AbortSignal.timeout(PIXEL_TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch {
    /* noop: el pixel es best-effort sin bloquear el reporte */
  }
  return true;
}

export async function reportAdImpression(token, rawAd) {
  const ad = sanitizeAd(rawAd);
  if (!ad) {
    return { ok: false, status: 400, message: 'Datos de anuncio incompletos.' };
  }
  const fired = await fireImpressionPixel(ad);
  const headers = await adHeaders(token);
  const body = {
    ad_id: ad.ad_id,
    click_token: ad.click_token,
    ...(fired ? { imp_fired: true } : {}),
  };
  const response = await fetch(`${FREEPI_ROOT}/ads/impression`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(AD_TIMEOUT_MS),
  });
  const rawText = await response.text().catch(() => '');
  let parsed = null;
  try { parsed = JSON.parse(rawText); } catch { /* noop */ }

  if (!response.ok) {
    const msg = str(parsed?.message) || str(parsed?.error?.message) || str(parsed?.error) || `HTTP ${response.status}`;
    return { ok: false, status: response.status, fired, message: msg };
  }
  return { ok: true, status: response.status, fired };
}

/**
 * Camino automatico: pide un anuncio y reporta su impresion de una sola vez.
 * Es lo que destraba un `403 ads_required` sin que el usuario toque nada.
 */
export async function ensureAdShown(token, slot = 'banner') {
  const next = await fetchNextAd(token, slot);
  if (!next.ok) return { ok: false, noAd: false, ad: null, reported: false, message: next.message };
  if (!next.ad) return { ok: true, noAd: true, ad: null, reported: false };
  const impression = await reportAdImpression(token, next.ad);
  return {
    ok: true,
    noAd: false,
    ad: next.ad,
    reported: impression.ok === true,
    fired: impression.fired === true,
    message: impression.ok ? '' : impression.message,
  };
}
