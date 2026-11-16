/**
 * ATOM · Directorio publico de proveedores (models.dev filtrado por compatibles OpenAI)
 */
import { readJson } from './wire.js';

let cached = null;
let inflight = null;

export async function loadDirectory(signal) {
  if (cached) return cached;
  if (!inflight) {
    inflight = fetch('/api/ai-registry', { signal })
      .then(async (res) => {
        const data = await readJson(res);
        const list = Array.isArray(data?.providers) ? data.providers : [];
        const dir = { providers: list, loaded: res.ok };
        if (dir.loaded) cached = dir;
        return dir;
      })
      .finally(() => { inflight = null; });
  }
  return await inflight;
}

export function forgetDirectory() {
  cached = null;
}
