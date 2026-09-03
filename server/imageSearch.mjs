/**
 * ATOM · Buscador de imagenes · logica compartida
 * ---------------------------------------------------------------------------
 * El navegador no puede buscar imagenes en la web por su cuenta: ningun buscador
 * responde con cabeceras CORS, y una imagen de un dominio ajeno sin CORS no se
 * puede subir a una textura de WebGL, que es justo lo que necesita MediaPipe
 * para sacarle la pose. Asi que hacen falta dos rutas del lado del servidor:
 *
 *   · GET /api/img-search?q=…   busca y devuelve una lista normalizada en JSON
 *   · GET /api/img-proxy?u=…    reenvia los bytes de una imagen con CORS abierto
 *
 * Este modulo es el motor de las dos, escrito solo con `fetch`, `URL` y
 * expresiones regulares para que sirva igual en los dos sitios donde corre:
 * como funcion de Cloudflare Pages (`functions/api/*`) al desplegar y como
 * middleware del servidor de Vite (`vite.config.js`) en desarrollo.
 *
 * No hay ninguna clave de API por ninguna parte: se leen las paginas publicas de
 * resultados de Bing y DuckDuckGo, y detras quedan dos archivos con API abierta,
 * Wikimedia Commons y Openverse, para cuando alguno de los dos primeros cambie de
 * formato o deje de contestar.
 */

/** Navegador que se anuncia al buscador. Sin esto Bing devuelve una pagina vacia. */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Tope de bytes que el proxy acepta reenviar de una sola imagen. */
export const MAX_BYTES = 12 * 1024 * 1024;

/** Resultados que se piden por pagina a cada proveedor. */
const PER_PAGE = 32;

/** Espera maxima de cada peticion de salida. */
const TIMEOUT = 12000;

/** Deshace las entidades HTML que aparecen en los atributos de los resultados. */
const unescapeHtml = (s) => String(s)
  .replace(/&quot;/g, '"')
  .replace(/&#0?39;|&apos;/g, "'")
  .replace(/&#215;/g, '×')
  .replace(/&nbsp;/g, ' ')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&');

/** Dominio legible de una url, sin el `www.`. */
const hostOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

/** Peticion de salida con tiempo limite y cabeceras de navegador. */
function get(url, { headers = {}, referer = '' } = {}) {
  return fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      ...(referer ? { Referer: referer } : {}),
      ...headers,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT),
  });
}

/* ── Normalizacion ─────────────────────────────────────────────────────── */

/**
 * Deja los resultados en la forma que espera la interfaz y descarta lo que no
 * sirve para extraer una pose: sin url, repetidos, en formato vectorial (un icono
 * SVG no tiene a nadie a quien detectarle la postura) o tan pequeño que no hay
 * cuerpo que medir. El tamano solo se juzga cuando el buscador lo dice: en Bing
 * hay resultados que llegan sin medida y esos se dejan pasar.
 *
 * @param {Array<object>} items
 * @returns {Array<{id:string,title:string,thumb:string,full:string,page:string,host:string,w:number,h:number}>}
 */
function tidy(items) {
  const vistos = new Set();
  const out = [];
  for (const it of items) {
    const full = String(it.full ?? '').trim();
    if (!/^https?:\/\//i.test(full)) continue;
    if (/\.svgz?($|[?#])/i.test(full)) continue;
    const w = Number(it.w) || 0;
    const h = Number(it.h) || 0;
    if (w && h && (w < 120 || h < 120)) continue;
    const clave = full.split('?')[0];
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    out.push({
      id: String(it.id ?? clave),
      title: unescapeHtml(it.title ?? '').slice(0, 160),
      thumb: String(it.thumb || full),
      full,
      page: String(it.page ?? ''),
      host: hostOf(it.page || full),
      w,
      h,
    });
  }
  return out;
}

/* ── Proveedor 1 · Bing ────────────────────────────────────────────────── */

/**
 * Pagina de resultados «async» de Bing Imagenes. Cada miniatura viene con un
 * atributo `m` que trae un JSON con la url original (`murl`), la miniatura
 * (`turl`), la pagina de origen (`purl`) y el titulo (`t`). El tamano en pixeles
 * va en un `<span class="nowrap">` dentro del mismo bloque, asi que se busca
 * entre un resultado y el siguiente para que no se descoloque.
 */
async function searchBing(q, { page, safe }) {
  const first = (page - 1) * PER_PAGE + 1;
  const url = 'https://www.bing.com/images/async?q=' + encodeURIComponent(q)
    + `&first=${first}&count=${PER_PAGE}&mmasync=1&adlt=${safe ? 'strict' : 'off'}`;
  const res = await get(url, { referer: 'https://www.bing.com/images/search' });
  if (!res.ok) throw new Error('bing ' + res.status);
  const html = await res.text();

  const re = /m="(\{[^"]*\})"/g;
  const crudos = [];
  for (let m = re.exec(html); m; m = re.exec(html)) crudos.push({ json: m[1], at: m.index });

  const items = crudos.map((c, i) => {
    let d = null;
    try { d = JSON.parse(unescapeHtml(c.json)); } catch { return null; }
    if (!d?.murl) return null;
    // El tamano se busca solo dentro del trozo de este resultado.
    const hasta = crudos[i + 1]?.at ?? Math.min(html.length, c.at + 4000);
    const dim = /<span class="nowrap">\s*(\d+)\s*(?:&#215;|×|x)\s*(\d+)/.exec(html.slice(c.at, hasta));
    return {
      id: d.cid || d.murl, title: d.t, full: d.murl, thumb: d.turl, page: d.purl,
      w: dim?.[1], h: dim?.[2],
    };
  });
  return tidy(items.filter(Boolean));
}

/* ── Proveedor 2 · DuckDuckGo ──────────────────────────────────────────── */

/**
 * DuckDuckGo sirve las imagenes en JSON, pero antes exige un testigo `vqd` que
 * solo se obtiene de la pagina de busqueda. Son dos peticiones en vez de una;
 * a cambio el resultado ya viene estructurado y con el tamano real.
 */
async function searchDuck(q, { page, safe }) {
  const portada = await get('https://duckduckgo.com/?q=' + encodeURIComponent(q) + '&iax=images&ia=images');
  if (!portada.ok) throw new Error('ddg portada ' + portada.status);
  const vqd = /vqd=["']?([\d-][\w-]*)/.exec(await portada.text())?.[1];
  if (!vqd) throw new Error('ddg sin vqd');

  const url = 'https://duckduckgo.com/i.js?l=es-es&o=json&q=' + encodeURIComponent(q)
    + `&vqd=${encodeURIComponent(vqd)}&f=,,,&p=${safe ? 1 : -1}&s=${(page - 1) * 100}`;
  const res = await get(url, { headers: { Accept: 'application/json' }, referer: 'https://duckduckgo.com/' });
  if (!res.ok) throw new Error('ddg ' + res.status);
  const data = await res.json();
  return tidy((data.results ?? []).slice(0, PER_PAGE).map((r) => ({
    id: r.image_token || r.image, title: r.title, full: r.image, thumb: r.thumbnail,
    page: r.url, w: r.width, h: r.height,
  })));
}

/* ── Proveedor 3 · Wikimedia Commons ───────────────────────────────────── */

/**
 * API de MediaWiki sobre Wikimedia Commons: `generator=search` en el espacio de
 * nombres de archivos, con `filetype:bitmap` para que no salgan vectores ni
 * videos. Es la mas solida de las tres, porque es una API publica de verdad (no
 * una pagina de resultados que puedan rediseñar mañana), no pide clave y responde
 * con CORS abierto, asi que sirve tambien desde el navegador cuando no hay
 * funciones desplegadas.
 *
 * No tiene filtro de contenido adulto: es un archivo documental y lo que sale
 * depende de lo que se busque. Por eso va detras de los dos buscadores, que si lo
 * tienen.
 */
async function searchWikimedia(q, { page }) {
  const url = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2&origin=*'
    + `&generator=search&gsrnamespace=6&gsrlimit=${PER_PAGE}&gsroffset=${(page - 1) * PER_PAGE}`
    + '&gsrsearch=' + encodeURIComponent(q + ' filetype:bitmap')
    + '&prop=imageinfo&iiprop=url%7Csize%7Cmime&iiurlwidth=400';
  const res = await get(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('commons ' + res.status);
  const data = await res.json();
  return tidy((data.query?.pages ?? []).map((p) => {
    const i = p.imageinfo?.[0];
    if (!i?.url || !String(i.mime ?? '').startsWith('image/')) return null;
    return {
      id: String(p.pageid ?? i.url),
      // «File:Marathon_Barcelona_2007.jpg» -> «Marathon Barcelona 2007».
      title: String(p.title ?? '').replace(/^file:/i, '').replace(/\.[^.]+$/, '').replace(/_/g, ' '),
      full: i.url, thumb: i.thumburl || i.url, page: i.descriptionurl,
      w: i.width, h: i.height,
    };
  }).filter(Boolean));
}

/* ── Proveedor 4 · Openverse ───────────────────────────────────────────── */

/**
 * Ultimo respaldo: API publica de Openverse (Flickr, museos, archivos abiertos).
 * Tampoco pide clave, pero ha empezado a contestar 401 a las peticiones anonimas
 * segun desde donde se pregunte, asi que va al final de la cola: si contesta,
 * suma; si no, la cadena ya ha probado tres sitios antes.
 */
async function searchOpenverse(q, { page, safe }) {
  const url = 'https://api.openverse.org/v1/images/?q=' + encodeURIComponent(q)
    + `&page_size=${PER_PAGE}&page=${page}&mature=${safe ? 'false' : 'true'}`;
  const res = await get(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('openverse ' + res.status);
  const data = await res.json();
  return tidy((data.results ?? []).map((r) => ({
    id: r.id, title: r.title, full: r.url,
    // La miniatura pasa por su propio servidor: la original puede estar en un
    // dominio que no admite CORS.
    thumb: r.thumbnail || r.url,
    page: r.foreign_landing_url, w: r.width, h: r.height,
  })));
}

/* ── Cadena de proveedores ─────────────────────────────────────────────── */

export const PROVIDERS = {
  bing: { label: 'Bing', run: searchBing },
  duck: { label: 'DuckDuckGo', run: searchDuck },
  wikimedia: { label: 'Wikimedia Commons', run: searchWikimedia },
  openverse: { label: 'Openverse', run: searchOpenverse },
};

/** Orden en que se prueban cuando el proveedor pedido es `auto`. */
const CADENA = ['bing', 'duck', 'wikimedia', 'openverse'];

/**
 * Busca imagenes y devuelve el primer proveedor que responda con resultados.
 *
 * @param {string} q texto de busqueda
 * @param {{page?:number, safe?:boolean, provider?:string}} [opts]
 * @returns {Promise<{provider:string,label:string,query:string,page:number,results:Array<object>,tried:Array<string>}>}
 */
export async function searchImages(q, { page = 1, safe = true, provider = 'auto' } = {}) {
  const query = String(q ?? '').trim().slice(0, 200);
  if (!query) return { provider: '', label: '', query: '', page: 1, results: [], tried: [] };
  const pag = Math.max(1, Math.min(20, Number(page) || 1));
  const orden = PROVIDERS[provider] ? [provider] : CADENA;

  const tried = [];
  let ultimo = null;
  for (const id of orden) {
    try {
      const results = await PROVIDERS[id].run(query, { page: pag, safe });
      tried.push(id);
      if (results.length) {
        return { provider: id, label: PROVIDERS[id].label, query, page: pag, results, tried };
      }
    } catch (err) {
      tried.push(id + ':' + (err?.message ?? 'error'));
      ultimo = err;
    }
  }
  if (ultimo && !tried.some((t) => !t.includes(':'))) throw ultimo;
  return { provider: '', label: '', query, page: pag, results: [], tried };
}

/* ── Proxy de imagenes ─────────────────────────────────────────────────── */

/** Nombres de maquina que nunca se piden: apuntan a la red interna. */
const HOST_PROHIBIDO = /^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i;

/** Direcciones literales de rango privado, local o reservado. */
function ipPrivada(host) {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
    if (a === 169 && b === 254) return true;          // enlace local y metadatos
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  const v6 = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (!v6.includes(':')) return false;
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

/**
 * Comprueba que una url se puede pedir desde el proxy.
 *
 * Solo http/https, puertos estandar y ningun destino de la red interna. Queda
 * fuera de alcance el caso de un dominio publico que resuelva a una direccion
 * privada: ni Cloudflare Workers ni el middleware pueden mirar el DNS antes de
 * pedir. En Workers no importa (no tienen ruta hacia redes privadas) y el
 * servidor de Vite solo escucha en la red local de quien desarrolla.
 *
 * @param {string} raw
 * @returns {{ok:true,url:URL}|{ok:false,reason:string}}
 */
export function checkTarget(raw) {
  let url;
  try {
    url = new URL(String(raw ?? ''));
  } catch {
    return { ok: false, reason: 'url invalida' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'protocolo no admitido' };
  if (url.port && url.port !== '80' && url.port !== '443') return { ok: false, reason: 'puerto no admitido' };
  const host = url.hostname;
  if (!host || HOST_PROHIBIDO.test(host) || ipPrivada(host)) return { ok: false, reason: 'destino no permitido' };
  return { ok: true, url };
}

/**
 * Descarga una imagen para el navegador. Devuelve siempre un objeto, nunca
 * lanza: el que llama decide con que codigo responder.
 *
 * @param {string} raw url de la imagen
 * @returns {Promise<{ok:boolean,status:number,type:string,body:ArrayBuffer|null,error:string}>}
 */
export async function fetchImage(raw) {
  const check = checkTarget(raw);
  if (!check.ok) return { ok: false, status: 400, type: '', body: null, error: check.reason };

  let res;
  try {
    res = await get(check.url.href, {
      headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8' },
      // Muchos servidores devuelven 403 a una peticion sin origen: se anuncia la
      // pagina del propio dominio de la imagen, que es lo que haria un navegador
      // al mostrarla dentro de su web.
      referer: check.url.origin + '/',
    });
  } catch (err) {
    return { ok: false, status: 502, type: '', body: null, error: 'no se pudo descargar: ' + (err?.message ?? 'error') };
  }
  if (!res.ok) return { ok: false, status: res.status === 404 ? 404 : 502, type: '', body: null, error: 'el servidor respondio ' + res.status };

  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!type.startsWith('image/')) return { ok: false, status: 415, type, body: null, error: 'la respuesta no es una imagen' };
  const declarado = Number(res.headers.get('content-length'));
  if (declarado > MAX_BYTES) return { ok: false, status: 413, type, body: null, error: 'imagen demasiado grande' };

  const body = await res.arrayBuffer();
  if (body.byteLength > MAX_BYTES) return { ok: false, status: 413, type, body: null, error: 'imagen demasiado grande' };
  return { ok: true, status: 200, type, body, error: '' };
}

/**
 * Rechaza las peticiones que no vienen de la propia pagina. `Sec-Fetch-Site` lo
 * pone el navegador y no se puede falsear desde JavaScript, asi que basta para
 * que nadie use este proxy como pasarela de imagenes para otra web.
 *
 * @param {{get:(name:string)=>string|null|undefined}} headers
 */
export function mismoOrigen(headers) {
  const site = headers.get('sec-fetch-site');
  if (site) return site === 'same-origin' || site === 'same-site' || site === 'none';
  return true;                    // cliente antiguo o sin cabecera: se deja pasar
}
