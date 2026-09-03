/**
 * GET /api/img-search?q=…&page=…&safe=1&provider=auto
 * ---------------------------------------------------------------------------
 * Funcion de Cloudflare Pages que busca imagenes en la web y devuelve la lista
 * normalizada. La logica vive en `server/imageSearch.mjs`, compartida con el
 * middleware del servidor de desarrollo de Vite.
 */
import { searchImages, mismoOrigen } from '../../server/imageSearch.mjs';

const json = (data, status = 200, cache = 'no-store') => new Response(JSON.stringify(data), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cache,
    'X-Content-Type-Options': 'nosniff',
  },
});

export async function onRequestGet({ request }) {
  if (!mismoOrigen(request.headers)) return json({ error: 'peticion externa' }, 403);

  const params = new URL(request.url).searchParams;
  const q = params.get('q') ?? '';
  if (!q.trim()) return json({ error: 'falta la busqueda' }, 400);

  try {
    const data = await searchImages(q, {
      page: Number(params.get('page')) || 1,
      safe: params.get('safe') !== '0',
      provider: params.get('provider') ?? 'auto',
    });
    return json(data, 200, 'public, max-age=120');
  } catch (err) {
    return json({ error: 'la busqueda no respondio: ' + (err?.message ?? 'error') }, 502);
  }
}
