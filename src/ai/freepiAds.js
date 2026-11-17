/**
 * ATOM · Gestion de anuncios de free-pi
 * ---------------------------------------------------------------------------
 * free-pi paga la inferencia gratuita con anuncios: pide el creativo
 * (`/ads/next`) y reporta su impresion (`/ads/impression`); mientras no conste,
 * el backend corta con `403 ads_required`.
 *
 * El flujo es AUTOMATICO (igual que en el portal): la app pide el anuncio y
 * reporta la impresion sola, primero al arrancar y luego lo renueva cada
 * FREEPI_AD_TTL_MS. El anuncio no se muestra en el chat: en la interfaz solo
 * queda una linea de estado dentro de Ajustes > Asistente IA, donde se
 * configura la API de free-pi.
 */
import { aiHeaders, readError, readJson } from './wire.js';
import { hasCredential } from './config.js';

export const FREEPI_AD_TTL_MS = 240_000;

const state = {
  ad: null,
  at: 0,
  reportedToken: '',
  noAd: false,
  loading: false,
  error: '',
};

const listeners = new Set();
let inflightFetch = null;
let inflightReport = null;

function emit() {
  const snap = getFreePiAdState();
  listeners.forEach((fn) => fn(snap));
}

export function getFreePiAdState() {
  return {
    ad: state.ad,
    at: state.at,
    reported: Boolean(state.ad?.click_token && state.reportedToken === state.ad.click_token),
    noAd: state.noAd,
    loading: state.loading,
    error: state.error,
  };
}

export function subscribeFreePiAd(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function isFreePiAdFresh() {
  return Boolean(state.ad && state.at && (Date.now() - state.at) < FREEPI_AD_TTL_MS);
}

export function clearFreePiAd() {
  state.ad = null;
  state.at = 0;
  state.reportedToken = '';
  state.noAd = false;
  state.loading = false;
  state.error = '';
  emit();
}

export async function fetchFreePiAd({ force = false, signal } = {}) {
  if (!hasCredential('freepi')) return null;
  if (!force && isFreePiAdFresh()) return state.ad;
  if (inflightFetch && !force) return await inflightFetch;

  state.loading = true;
  state.error = '';
  emit();

  const run = (async () => {
    try {
      const response = await fetch('/api/freepi-ad', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...aiHeaders('freepi') },
        body: JSON.stringify({ action: 'next', slot: 'banner' }),
        signal,
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const data = await readJson(response);
      if (!data || typeof data !== 'object') {
        throw new Error('free-pi devolvio un anuncio ilegible.');
      }
      if (data.noAd || !data.ad) {
        state.noAd = true;
        return state.ad;
      }
      state.ad = data.ad;
      state.at = Date.now();
      state.noAd = false;
      state.error = '';
      return state.ad;
    } catch (err) {
      if (!signal?.aborted) {
        state.error = err instanceof Error ? err.message : 'No se pudo cargar el anuncio de free-pi.';
      }
      return state.ad;
    } finally {
      state.loading = false;
      inflightFetch = null;
      emit();
    }
  })();

  inflightFetch = run;
  return await run;
}

/** Reporta la impresion una unica vez por `click_token`. */
export async function reportDisplayedFreePiAd(ad = state.ad, { signal } = {}) {
  if (!ad?.ad_id || !ad?.click_token || !hasCredential('freepi')) return false;
  if (state.reportedToken === ad.click_token) return true;
  if (inflightReport) return await inflightReport;

  const run = (async () => {
    try {
      const response = await fetch('/api/freepi-ad', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...aiHeaders('freepi') },
        body: JSON.stringify({ action: 'impression', ad }),
        signal,
      });
      if (!response.ok) return false;
      const data = await readJson(response);
      if (data?.ok) {
        state.reportedToken = ad.click_token;
        emit();
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      inflightReport = null;
    }
  })();

  inflightReport = run;
  return await run;
}

/**
 * Camino automatico: deja un anuncio pedido y reportado. Se llama al arrancar,
 * al abrir los ajustes y antes de cada peticion a free-pi. Si el anuncio que
 * ya hay sigue vigente no se pide otro: solo se asegura que conste reportado.
 */
export async function ensureFreePiAd({ force = false, signal } = {}) {
  if (!hasCredential('freepi')) return null;
  const ad = await fetchFreePiAd({ force, signal });
  if (!ad) return null;
  await reportDisplayedFreePiAd(ad, { signal });
  return ad;
}

/* ── Renovacion automatica en segundo plano ─────────────────────────────── */

let autoTimer = 0;
let autoRunning = false;

function visible() {
  if (typeof document === 'undefined') return true;
  return document.visibilityState !== 'hidden';
}

/** setTimeout que no mantiene vivo el proceso en Node (pruebas). */
function later(fn, ms) {
  const t = setTimeout(fn, ms);
  if (t && typeof t === 'object' && typeof t.unref === 'function') t.unref();
  return t;
}

async function autoTick() {
  autoTimer = 0;
  if (!autoRunning) return;
  // Sin free-pi configurado no hay nada que renovar: se apaga solo.
  if (!hasCredential('freepi')) {
    autoRunning = false;
    return;
  }
  if (!visible()) {
    autoTimer = later(autoTick, 30_000);
    return;
  }
  await ensureFreePiAd();
  if (!autoRunning) return;
  autoTimer = later(autoTick, FREEPI_AD_TTL_MS);
}

/** Arranca la renovacion automatica (idempotente). */
export function startFreePiAdAutoSync(delayMs = 2_000) {
  if (autoRunning) return;
  if (!hasCredential('freepi')) return;
  autoRunning = true;
  autoTimer = later(autoTick, delayMs);
}

export function stopFreePiAdAutoSync() {
  autoRunning = false;
  if (autoTimer) clearTimeout(autoTimer);
  autoTimer = 0;
}
