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
 * resultados de Bing y DuckDuckGo, y el resto son archivos con API abierta
 * (Wikimedia Commons, Openverse, Art Institute of Chicago, Cleveland Museum of
 * Art, The Met y Wellcome Collection).
 *
 * Todos se preguntan **a la vez** y la lista sale entrelazada por turnos, con mas
 * cupo para los dos buscadores web, que son los que entienden una frase en
 * castellano. Asi una busqueda no depende de que un solo sitio conteste, se
 * llenan las dos primeras filas de la rejilla con lo mas pertinente y detras
 * aparecen las laminas de museo, que para estudio de figura valen tanto como una
 * fotografia. Un proveedor caido o lento solo resta su parte.
 */

/** Navegador que se anuncia al buscador. Sin esto Bing devuelve una pagina vacia. */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Tope de bytes que el proxy acepta reenviar de una sola imagen. */
export const MAX_BYTES = 12 * 1024 * 1024;

/** Resultados que se piden por pagina a cada proveedor. */
const PER_PAGE = 32;

/** DuckDuckGo sirve un centenar de golpe: recortarlos seria tirar resultados. */
const PER_PAGE_DUCK = 100;

/** El Met cuesta una peticion por obra, asi que se le piden pocas. */
const PER_PAGE_MET = 12;

/** Tope de la lista mezclada que se devuelve al navegador. */
const MAX_MEZCLA = 120;

/** Espera maxima de cada peticion de salida. */
const TIMEOUT = 12000;

/** Lo que se aguanta a un proveedor cuando van todos en paralelo. */
const TOPE_MEZCLA = 9000;

/** Se lo pide Art Institute of Chicago en su documentacion. */
const AIC_UA = 'ATOM figure reference (https://github.com/wilzamguerrero)';

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
 * Corta la espera de un proveedor para que uno lento no retrase la respuesta
 * entera. La peticion se queda en el aire: en un Worker muere con la respuesta y
 * en el servidor de desarrollo la recoge el recolector.
 *
 * @template T
 * @param {Promise<T>} promesa
 * @param {number} ms
 * @returns {Promise<T>}
 */
function conTope(promesa, ms) {
  let reloj;
  const limite = new Promise((_, rechazar) => {
    reloj = setTimeout(() => rechazar(new Error('tardo demasiado')), ms);
  });
  return Promise.race([promesa, limite]).finally(() => clearTimeout(reloj));
}

/**
 * Deja los resultados en la forma que espera la interfaz y descarta lo que no
 * sirve para extraer una pose: sin url, repetidos, en formato vectorial (un icono
 * SVG no tiene a nadie a quien detectarle la postura) o tan pequeño que no hay
 * cuerpo que medir. El tamano solo se juzga cuando el buscador lo dice: en Bing
 * hay resultados que llegan sin medida y esos se dejan pasar.
 *
 * `fuente` viaja en cada resultado para que la interfaz pueda decir de donde sale
 * cada miniatura y filtrar la rejilla por sitio. `proxy` marca los servidores que
 * no dejan enlazar sus imagenes desde fuera, cuya miniatura hay que pedir por el
 * propio dominio.
 *
 * @param {Array<object>} items
 * @param {string} fuente identificador del proveedor
 * @param {{proxy?:boolean}} [opts]
 * @returns {Array<{id:string,title:string,thumb:string,full:string,page:string,host:string,w:number,h:number,source:string}>}
 */
function tidy(items, fuente = '', { proxy = false } = {}) {
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
      source: fuente,
      ...(proxy ? { proxy: true } : {}),
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
  return items.filter(Boolean);
}

/* ── Proveedor 2 · DuckDuckGo ──────────────────────────────────────────── */

/**
 * DuckDuckGo sirve las imagenes en JSON, pero antes exige un testigo `vqd` que
 * solo se obtiene de la pagina de busqueda. Son dos peticiones en vez de una; a
 * cambio el resultado ya viene estructurado, con el tamano real y por centenares,
 * asi que es el proveedor que mas llena la rejilla.
 */
async function searchDuck(q, { page, safe }) {
  const portada = await get('https://duckduckgo.com/?q=' + encodeURIComponent(q) + '&iax=images&ia=images');
  if (!portada.ok) throw new Error('ddg portada ' + portada.status);
  const vqd = /vqd=["']?([\d-][\w-]*)/.exec(await portada.text())?.[1];
  if (!vqd) throw new Error('ddg sin vqd');

  const url = 'https://duckduckgo.com/i.js?l=es-es&o=json&q=' + encodeURIComponent(q)
    + `&vqd=${encodeURIComponent(vqd)}&f=,,,&p=${safe ? 1 : -1}&s=${(page - 1) * PER_PAGE_DUCK}`;
  const res = await get(url, { headers: { Accept: 'application/json' }, referer: 'https://duckduckgo.com/' });
  if (!res.ok) throw new Error('ddg ' + res.status);
  const data = await res.json();
  return (data.results ?? []).slice(0, PER_PAGE_DUCK).map((r) => ({
    id: r.image_token || r.image, title: r.title, full: r.image, thumb: r.thumbnail,
    page: r.url, w: r.width, h: r.height,
  }));
}

/* ── Proveedor 3 · Wikimedia Commons ───────────────────────────────────── */

/**
 * API de MediaWiki sobre Wikimedia Commons: `generator=search` en el espacio de
 * nombres de archivos, con `filetype:bitmap` para que no salgan vectores ni
 * videos. Es una API publica de verdad (no una pagina de resultados que puedan
 * rediseñar mañana), no pide clave y responde con CORS abierto, asi que sirve
 * tambien desde el navegador cuando no hay funciones desplegadas.
 *
 * No tiene filtro de contenido adulto: es un archivo documental y lo que sale
 * depende de lo que se busque.
 */
async function searchWikimedia(q, { page }) {
  const url = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2&origin=*'
    + `&generator=search&gsrnamespace=6&gsrlimit=${PER_PAGE}&gsroffset=${(page - 1) * PER_PAGE}`
    + '&gsrsearch=' + encodeURIComponent(q + ' filetype:bitmap')
    + '&prop=imageinfo&iiprop=url%7Csize%7Cmime&iiurlwidth=400';
  const res = await get(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('commons ' + res.status);
  const data = await res.json();
  return (data.query?.pages ?? []).map((p) => {
    const i = p.imageinfo?.[0];
    if (!i?.url || !String(i.mime ?? '').startsWith('image/')) return null;
    return {
      id: String(p.pageid ?? i.url),
      // «File:Marathon_Barcelona_2007.jpg» -> «Marathon Barcelona 2007».
      title: String(p.title ?? '').replace(/^file:/i, '').replace(/\.[^.]+$/, '').replace(/_/g, ' '),
      full: i.url, thumb: i.thumburl || i.url, page: i.descriptionurl,
      w: i.width, h: i.height,
    };
  }).filter(Boolean);
}

/* ── Proveedor 4 · Openverse ───────────────────────────────────────────── */

/**
 * API publica de Openverse (Flickr, museos, archivos abiertos). Tampoco pide
 * clave, pero ha empezado a contestar 401 a las peticiones anonimas segun desde
 * donde se pregunte, asi que se pide igual y, si no contesta, la mezcla sigue con
 * el resto.
 */
async function searchOpenverse(q, { page, safe }) {
  const url = 'https://api.openverse.org/v1/images/?q=' + encodeURIComponent(q)
    + `&page_size=${PER_PAGE}&page=${page}&mature=${safe ? 'false' : 'true'}`;
  const res = await get(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('openverse ' + res.status);
  const data = await res.json();
  return (data.results ?? []).map((r) => ({
    id: r.id, title: r.title, full: r.url,
    // La miniatura pasa por su propio servidor: la original puede estar en un
    // dominio que no admite CORS.
    thumb: r.thumbnail || r.url,
    page: r.foreign_landing_url, w: r.width, h: r.height,
  }));
}

/* ── Proveedor 5 · Art Institute of Chicago ────────────────────────────── */

/**
 * Coleccion del Art Institute de Chicago: dibujo, pintura y escultura con las
 * imagenes servidas por IIIF, de donde se saca el tamano que convenga sin bajar
 * el original entero. Para estudio de figura una lamina academica vale tanto como
 * una fotografia.
 *
 * Su servidor de imagenes contesta 403 a quien enlaza desde fuera, asi que las
 * miniaturas se marcan con `proxy` y salen por el propio dominio; el proxy manda
 * el Referer del museo y entonces si las entrega.
 */
async function searchArtic(q, { page }) {
  const url = 'https://api.artic.edu/api/v1/artworks/search?q=' + encodeURIComponent(q)
    + `&limit=${PER_PAGE}&page=${page}&fields=id,title,image_id,thumbnail,artist_title`;
  const res = await get(url, { headers: { Accept: 'application/json', 'AIC-User-Agent': AIC_UA } });
  if (!res.ok) throw new Error('artic ' + res.status);
  const data = await res.json();
  const iiif = String(data.config?.iiif_url || 'https://www.artic.edu/iiif/2').replace(/\/$/, '');
  return (data.data ?? []).map((d) => {
    if (!d.image_id) return null;
    return {
      id: 'artic-' + d.id,
      title: [d.title, d.artist_title].filter(Boolean).join(' · '),
      full: `${iiif}/${d.image_id}/full/1200,/0/default.jpg`,
      thumb: `${iiif}/${d.image_id}/full/400,/0/default.jpg`,
      page: `https://www.artic.edu/artworks/${d.id}`,
      w: d.thumbnail?.width, h: d.thumbnail?.height,
    };
  }).filter(Boolean);
}

/* ── Proveedor 6 · Cleveland Museum of Art ─────────────────────────────── */

/**
 * Cleveland Museum of Art: API abierta, sin clave y con una copia «web» de cada
 * obra que ya viene en el tamano justo para el detector (unos 500 px de ancho),
 * asi que se usa esa y no la de imprenta, que pesa megas para nada.
 */
async function searchCleveland(q, { page }) {
  const url = 'https://openaccess-api.clevelandart.org/api/artworks/?has_image=1'
    + `&limit=${PER_PAGE}&skip=${(page - 1) * PER_PAGE}&q=` + encodeURIComponent(q);
  const res = await get(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('cleveland ' + res.status);
  const data = await res.json();
  return (data.data ?? []).map((d) => {
    const im = d.images?.web ?? d.images?.print;
    if (!im?.url) return null;
    return {
      id: 'cle-' + (d.id ?? im.url),
      title: [d.title, d.creators?.[0]?.description].filter(Boolean).join(' · '),
      full: im.url, thumb: im.url, page: d.url ?? '',
      w: im.width, h: im.height,
    };
  }).filter(Boolean);
}

/* ── Proveedor 7 · The Metropolitan Museum of Art ──────────────────────── */

/**
 * El Met tiene la API mas abierta de todas (ni clave ni cuota) pero la mas
 * incomoda: la busqueda solo devuelve numeros de obra y hay que pedir cada una
 * aparte. Por eso se le piden pocas por pagina y las fichas se traen de golpe, en
 * paralelo; las que no tengan imagen se caen solas.
 */
async function searchMet(q, { page }) {
  const busca = await get('https://collectionapi.metmuseum.org/public/collection/v1/search?hasImages=true&q='
    + encodeURIComponent(q), { headers: { Accept: 'application/json' } });
  if (!busca.ok) throw new Error('met ' + busca.status);
  const data = await busca.json();
  const ids = (data.objectIDs ?? []).slice((page - 1) * PER_PAGE_MET, page * PER_PAGE_MET);
  const fichas = await Promise.all(ids.map((id) =>
    get('https://collectionapi.metmuseum.org/public/collection/v1/objects/' + id, { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)));
  return fichas.map((o) => {
    // `primaryImageSmall` es la copia grande para web: mas que suficiente para
    // sacar una pose y sin los 20 MB del original de archivo.
    if (!o?.primaryImageSmall) return null;
    return {
      id: 'met-' + o.objectID,
      title: [o.title, o.artistDisplayName].filter(Boolean).join(' · '),
      full: o.primaryImageSmall, thumb: o.primaryImageSmall,
      page: o.objectURL ?? '', w: 0, h: 0,
    };
  }).filter(Boolean);
}

/* ── Proveedor 8 · Wellcome Collection ─────────────────────────────────── */

/**
 * Archivo de la Wellcome Collection: laminas de anatomia y fotografia historica
 * del cuerpo humano, servidas por IIIF. Queda fuera de la mezcla automatica y
 * solo entra si se elige a mano, porque no tiene ningun filtro y su fondo es
 * clinico: buscando cualquier cosa del cuerpo salen imagenes medicas explicitas.
 */
async function searchWellcome(q, { page }) {
  const url = 'https://api.wellcomecollection.org/catalogue/v2/images?query=' + encodeURIComponent(q)
    + `&pageSize=${PER_PAGE}&page=${page}`;
  const res = await get(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('wellcome ' + res.status);
  const data = await res.json();
  return (data.results ?? []).map((r) => {
    // La miniatura viene como `…/image/<id>/info.json`: de ahi sale la base IIIF.
    const info = String(r.thumbnail?.url ?? '');
    if (!info.endsWith('/info.json')) return null;
    const base = info.slice(0, -'/info.json'.length);
    return {
      id: 'wel-' + r.id,
      title: r.source?.title ?? '',
      full: base + '/full/1000,/0/default.jpg',
      thumb: base + '/full/400,/0/default.jpg',
      page: r.source?.id ? 'https://wellcomecollection.org/works/' + r.source.id : '',
      w: 0, h: 0,
    };
  }).filter(Boolean);
}

/* ── Mezcla de proveedores ─────────────────────────────────────────────── */

/**
 * Los ocho sitios de donde se saca una imagen. `peso` es el cupo por turno al
 * entrelazar: los dos buscadores web entienden una frase en castellano y aciertan
 * mas, asi que llenan las primeras filas; los archivos van sumando detras.
 * `mezcla: false` deja al proveedor fuera de la mezcla automatica, disponible solo
 * si se elige a mano.
 */
export const PROVIDERS = {
  bing: { label: 'Bing', run: searchBing, peso: 5 },
  duck: { label: 'DuckDuckGo', run: searchDuck, peso: 5 },
  wikimedia: { label: 'Wikimedia Commons', run: searchWikimedia, peso: 2 },
  openverse: { label: 'Openverse', run: searchOpenverse, peso: 2 },
  artic: { label: 'Art Institute of Chicago', run: searchArtic, peso: 1, proxy: true },
  cleveland: { label: 'Cleveland Museum of Art', run: searchCleveland, peso: 1 },
  met: { label: 'The Met', run: searchMet, peso: 1 },
  wellcome: { label: 'Wellcome Collection', run: searchWellcome, peso: 1, mezcla: false },
};

/** Los que entran cuando no se elige proveedor. */
const MEZCLA = Object.keys(PROVIDERS).filter((id) => PROVIDERS[id].mezcla !== false);

/**
 * Reparte por turnos las listas de cada proveedor: en cada vuelta toma `peso`
 * resultados de cada uno, salta los que ya trajo otro (la web se solapa entre
 * buscadores) y para al llegar al tope. Asi la rejilla se ve mezclada desde la
 * primera fila en vez de por bloques, y sin que un proveedor generoso tape a los
 * demas.
 *
 * @param {Map<string, Array<object>>} porFuente en el orden de preferencia
 * @returns {Array<object>}
 */
function entrelazar(porFuente) {
  const vistos = new Set();
  const cursor = new Map();
  const out = [];
  let vivos = true;
  while (vivos && out.length < MAX_MEZCLA) {
    vivos = false;
    for (const [id, lista] of porFuente) {
      let i = cursor.get(id) ?? 0;
      let puestos = 0;
      const cupo = PROVIDERS[id]?.peso ?? 1;
      while (i < lista.length && puestos < cupo && out.length < MAX_MEZCLA) {
        const it = lista[i];
        i += 1;
        const clave = it.full.split('?')[0];
        if (vistos.has(clave)) continue;
        vistos.add(clave);
        out.push(it);
        puestos += 1;
      }
      cursor.set(id, i);
      if (i < lista.length) vivos = true;
    }
  }
  return out;
}

/** Cuantas imagenes ha puesto cada sitio en la lista final, para la interfaz. */
function fuentesDe(results) {
  const cuenta = new Map();
  for (const r of results) cuenta.set(r.source, (cuenta.get(r.source) ?? 0) + 1);
  return [...cuenta].map(([id, count]) => ({ id, label: PROVIDERS[id]?.label ?? id, count }));
}

/**
 * Busca imagenes. Sin proveedor concreto pregunta a todos a la vez y devuelve la
 * mezcla entrelazada; con uno elegido, solo a ese.
 *
 * @param {string} q texto de busqueda
 * @param {{page?:number, safe?:boolean, provider?:string}} [opts]
 * @returns {Promise<{provider:string,label:string,query:string,page:number,results:Array<object>,fuentes:Array<object>,tried:Array<string>}>}
 */
export async function searchImages(q, { page = 1, safe = true, provider = 'auto' } = {}) {
  const query = String(q ?? '').trim().slice(0, 200);
  if (!query) return { provider: '', label: '', query: '', page: 1, results: [], fuentes: [], tried: [] };
  const pag = Math.max(1, Math.min(20, Number(page) || 1));

  if (PROVIDERS[provider]) {
    const cfg = PROVIDERS[provider];
    const results = tidy(await cfg.run(query, { page: pag, safe }), provider, cfg);
    return { provider, label: cfg.label, query, page: pag, results, fuentes: fuentesDe(results), tried: [provider] };
  }

  const tandas = await Promise.allSettled(MEZCLA.map(async (id) => ({
    id,
    results: tidy(await conTope(PROVIDERS[id].run(query, { page: pag, safe }), TOPE_MEZCLA), id, PROVIDERS[id]),
  })));

  const porFuente = new Map();
  const tried = [];
  let ultimo = null;
  for (const [i, t] of tandas.entries()) {
    if (t.status === 'fulfilled') {
      tried.push(t.value.id);
      if (t.value.results.length) porFuente.set(t.value.id, t.value.results);
    } else {
      tried.push(MEZCLA[i] + ':' + (t.reason?.message ?? 'error'));
      ultimo = t.reason;
    }
  }

  // Solo se da por perdida la busqueda si no ha contestado nadie: que un sitio se
  // caiga no es motivo para dejar al usuario sin resultados.
  if (ultimo && !tried.some((t) => !t.includes(':'))) throw ultimo;

  const results = entrelazar(porFuente);
  const fuentes = fuentesDe(results);
  return {
    provider: fuentes.length === 1 ? fuentes[0].id : 'mezcla',
    label: fuentes.length === 1 ? fuentes[0].label : 'Varias fuentes',
    query, page: pag, results, fuentes, tried,
  };
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
