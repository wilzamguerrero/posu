/**
 * ImageSearch · cliente del buscador de imagenes
 * ---------------------------------------------------------------------------
 * Habla con las dos rutas que sirven `functions/api/*` al desplegar y el
 * middleware de Vite en desarrollo, y entrega el resultado elegido convertido en
 * un `File`, que es lo que ya sabe tragar `MocapSource.useFile()`: a partir de
 * ahi la imagen entra en el monitor de captura por el mismo camino que un
 * archivo soltado en la ventana.
 *
 * Los tres caminos para traerse los bytes de una imagen ajena, en orden:
 *
 *   1. el proxy del propio dominio, que es el que funciona siempre,
 *   2. la peticion directa, para los servidores que si abren CORS (Wikimedia,
 *      Flickr, Pexels…), por si la aplicacion esta en un alojamiento estatico
 *      sin las funciones desplegadas,
 *   3. la miniatura, ultimo recurso: 600 px de lado bastan de sobra para que el
 *      detector saque la pose.
 */

/** Ruta de la aplicacion, respetando `base: './'` y los subdirectorios. */
const api = (nombre) => new URL('api/' + nombre, document.baseURI).href;

/**
 * Lo que sirve para sacar una pose, en los respaldos que se leen sin servidor:
 * ni vectores ni miniaturas de tamano icono. El servidor hace la misma criba en
 * `server/imageSearch.mjs`.
 */
const util = (url, w, h) => /^https?:\/\//i.test(url)
  && !/\.svgz?($|[?#])/i.test(url)
  && !(w && h && (w < 120 || h < 120));

/** Nombre de archivo presentable a partir de la url original. */
function fileName(url, type) {
  let base = 'referencia';
  try {
    const limpio = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
    const sinExt = limpio.replace(/\.[^.]+$/, '').replace(/[^\w\-]+/g, '-').replace(/^-+|-+$/g, '');
    if (sinExt) base = sinExt.slice(0, 48);
  } catch { /* url rara: se queda el nombre generico */ }
  const ext = (type.split('/')[1] ?? 'jpg').replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '') || 'jpg';
  return `${base}.${ext}`;
}

/** Descarga una url y devuelve el Blob solo si de verdad es una imagen. */
async function blobDe(url) {
  const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!res.ok) throw new Error(String(res.status));
  const blob = await res.blob();
  if (!blob.size) throw new Error('vacia');
  if (blob.type && !blob.type.startsWith('image/')) throw new Error('no es imagen');
  return blob;
}

export class ImageSearch {
  /** @param {import('../core/Settings.js').Settings} settings */
  constructor(settings) {
    this.settings = settings;
    /** Se apaga si las rutas del servidor no estan disponibles. */
    this.serverOk = true;
    this.lastProvider = '';
  }

  /** Url del proxy para una imagen concreta. */
  proxy(url) {
    return api('img-proxy') + '?u=' + encodeURIComponent(url);
  }

  /**
   * Busca imagenes en la web.
   *
   * @param {string} query
   * @param {{page?:number}} [opts]
   * @returns {Promise<{results:Array<object>, provider:string, label:string, page:number}>}
   */
  async search(query, { page = 1 } = {}) {
    const q = String(query ?? '').trim();
    if (!q) return { results: [], provider: '', label: '', page: 1 };
    const safe = this.settings.get('search.safe') === false ? '0' : '1';
    const provider = this.settings.get('search.provider') || 'auto';
    const url = `${api('img-search')}?q=${encodeURIComponent(q)}&page=${page}&safe=${safe}&provider=${encodeURIComponent(provider)}`;

    if (this.serverOk) {
      try {
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        if (res.status === 404) {
          // Sitio estatico sin las funciones: se deja de intentar.
          this.serverOk = false;
        } else {
          const data = await res.json();
          if (!res.ok) throw new Error(data?.error || 'error ' + res.status);
          this.lastProvider = data.label || data.provider || '';
          return { results: data.results ?? [], provider: data.provider ?? '', label: this.lastProvider, page };
        }
      } catch (err) {
        if (this.serverOk) throw err;
      }
    }
    return this.#sinServidor(q, page);
  }

  /**
   * Respaldo sin servidor, para un alojamiento estatico sin las funciones: los
   * dos unicos sitios que contestan con CORS abierto y sin clave, asi que la
   * busqueda sigue viva aunque no haya nada del lado del servidor. Wikimedia va
   * primero porque es el que responde siempre.
   */
  async #sinServidor(q, page) {
    let ultimo = null;
    for (const intento of [() => this.#wikimedia(q, page), () => this.#openverse(q, page)]) {
      try {
        const res = await intento();
        if (res.results.length) return res;
      } catch (err) {
        ultimo = err;
      }
    }
    if (ultimo) throw ultimo;
    return { results: [], provider: '', label: '', page };
  }

  /** Archivo de Wikimedia Commons: API de MediaWiki, `origin=*` abre el CORS. */
  async #wikimedia(q, page) {
    const url = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2&origin=*'
      + `&generator=search&gsrnamespace=6&gsrlimit=32&gsroffset=${(page - 1) * 32}`
      + '&gsrsearch=' + encodeURIComponent(q + ' filetype:bitmap')
      + '&prop=imageinfo&iiprop=url%7Csize%7Cmime&iiurlwidth=400';
    const res = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'omit' });
    if (!res.ok) throw new Error('Wikimedia respondio ' + res.status);
    const data = await res.json();
    const results = (data.query?.pages ?? []).map((p) => {
      const i = p.imageinfo?.[0];
      if (!i?.url || !String(i.mime ?? '').startsWith('image/')) return null;
      if (!util(i.url, Number(i.width) || 0, Number(i.height) || 0)) return null;
      return {
        id: String(p.pageid ?? i.url),
        title: String(p.title ?? '').replace(/^file:/i, '').replace(/\.[^.]+$/, '').replace(/_/g, ' '),
        full: i.url, thumb: i.thumburl || i.url, page: i.descriptionurl ?? '',
        host: 'commons.wikimedia.org', w: Number(i.width) || 0, h: Number(i.height) || 0,
      };
    }).filter(Boolean);
    this.lastProvider = 'Wikimedia Commons';
    return { results, provider: 'wikimedia', label: 'Wikimedia Commons', page };
  }

  /** Openverse: API abierta, aunque no siempre atiende peticiones anonimas. */
  async #openverse(q, page) {
    const mature = this.settings.get('search.safe') === false ? 'true' : 'false';
    const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=32&page=${page}&mature=${mature}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('Openverse respondio ' + res.status);
    const data = await res.json();
    const results = (data.results ?? [])
      .filter((r) => util(String(r.url ?? ''), Number(r.width) || 0, Number(r.height) || 0))
      .map((r) => ({
        id: r.id, title: r.title ?? '', full: r.url, thumb: r.thumbnail || r.url,
        page: r.foreign_landing_url ?? '', host: (r.provider ?? '').toLowerCase(),
        w: Number(r.width) || 0, h: Number(r.height) || 0,
      }));
    this.lastProvider = 'Openverse';
    return { results, provider: 'openverse', label: 'Openverse', page };
  }

  /**
   * Trae el resultado elegido como archivo de imagen.
   *
   * @param {{full:string, thumb?:string}} result
   * @returns {Promise<File>}
   */
  async toFile(result) {
    const full = String(result?.full ?? '');
    const thumb = String(result?.thumb ?? '');
    const intentos = [
      this.serverOk && full ? this.proxy(full) : null,
      full,
      this.serverOk && thumb && thumb !== full ? this.proxy(thumb) : null,
      thumb && thumb !== full ? thumb : null,
    ].filter(Boolean);

    let ultimo = null;
    for (const url of intentos) {
      try {
        const blob = await blobDe(url);
        const type = blob.type.startsWith('image/') ? blob.type : 'image/jpeg';
        return new File([blob], fileName(full || url, type), { type });
      } catch (err) {
        ultimo = err;
      }
    }
    throw new Error('no se pudo descargar la imagen' + (ultimo?.message ? ` (${ultimo.message})` : ''));
  }
}
