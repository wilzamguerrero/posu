/**
 * ATOM · Gestion de anuncios visibles de free-pi
 * ---------------------------------------------------------------------------
 * free-pi exige que el cliente muestre un anuncio y reporte su impresion
 * (`/ads/next` + `/ads/impression`); mientras no conste, responde con
 * `403 ads_required`. La impresion solo se envia despues de pintar la tarjeta
 * en una interfaz abierta y visible para el usuario.
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

/** Reporta la impresion una unica vez por `click_token` tras mostrarse en pantalla. */
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
