/**
 * GET /api/img-proxy?u=<url de la imagen>
 * ---------------------------------------------------------------------------
 * Reenvia los bytes de una imagen de otro dominio desde el propio origen. Sin
 * esto no hay nada que hacer con un resultado de busqueda: MediaPipe sube la
 * imagen a una textura de WebGL y el navegador no lo permite si viene de un
 * dominio ajeno que no manda cabeceras CORS.
 *
 * Solo atiende peticiones de la propia pagina (`Sec-Fetch-Site`), acepta unicamente
 * respuestas de tipo `image/*` y corta por tamano, para que no se pueda usar
 * como pasarela de descargas ajena a la aplicacion.
 */
import { fetchImage, mismoOrigen } from '../../server/imageSearch.mjs';

const fallo = (texto, status) => new Response(texto, {
  status,
  headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
});

export async function onRequestGet({ request }) {
  if (!mismoOrigen(request.headers)) return fallo('peticion externa', 403);

  const u = new URL(request.url).searchParams.get('u');
  if (!u) return fallo('falta la imagen', 400);

  const res = await fetchImage(u);
  if (!res.ok) return fallo(res.error, res.status);

  return new Response(res.body, {
    headers: {
      'Content-Type': res.type,
      'Content-Length': String(res.body.byteLength),
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; sandbox",
    },
  });
}
