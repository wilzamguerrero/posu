/**
 * Buscador de imagenes de referencia: el motor que comparten la funcion de
 * Cloudflare Pages y el middleware del servidor de Vite. Aqui no se sale a la
 * red: `fetch` se sustituye por un servidor falso, asi que lo que se comprueba es
 * el analisis del HTML de Bing, la mezcla entrelazada de los ocho sitios y, sobre
 * todo, los frenos del proxy de imagenes, que es lo unico de la aplicacion que
 * pide una url que escribe cualquiera.
 */
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const fails = [];
const oks = [];
const check = (name, cond, extra = '') => {
  (cond ? oks : fails).push(name + (extra ? ' :: ' + extra : ''));
  console.log((cond ? 'OK   ' : 'FALLA') + ' ' + name + (extra ? '  (' + extra + ')' : ''));
};

const { searchImages, checkTarget, fetchImage, mismoOrigen, MAX_BYTES } =
  await import('../server/imageSearch.mjs');

/* -- Servidor falso ---------------------------------------------------- */

const realFetch = globalThis.fetch;
let pedidas = [];

/**
 * Sustituye `fetch` por una tabla de rutas. Cada entrada es `[trozo de url,
 * fabrica]`; si la fabrica devuelve un Error, se lanza (una caida de red).
 *
 * @param {Array<[string, (url:string, opts:object)=>Response|Error]>} rutas
 */
function servir(rutas) {
  pedidas = [];
  globalThis.fetch = async (url, opts = {}) => {
    const href = String(url);
    pedidas.push({ url: href, opts });
    for (const [patron, fabrica] of rutas) {
      if (!href.includes(patron)) continue;
      const out = fabrica(href, opts);
      if (out instanceof Error) throw out;
      return out;
    }
    throw new Error('el servidor falso no tiene ruta para ' + href);
  };
}

const html = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const bytes = (n) => new Uint8Array(n).fill(120);
const img = (body, type = 'image/jpeg', extra = {}) => new Response(body, { headers: { 'Content-Type': type, ...extra } });
const pedida = (patron) => pedidas.find((p) => p.url.includes(patron));
const cab = (v) => new Headers(v ? { 'Sec-Fetch-Site': v } : {});

/* -- 1 - El HTML de Bing ----------------------------------------------- */

// Cada miniatura de Bing viene con un atributo `m` que lleva un JSON escapado, y
// el tamano real en el `<span class="nowrap">` que va detras. El falso reproduce
// eso e incluye la basura que hay que descartar: un SVG, un repetido con
// parametros, uno sin url original, una url relativa y un JSON roto.
const mAttr = (d) => 'm="' + JSON.stringify(d).replace(/"/g, '&quot;') + '"';
const tarjeta = (d, dim = '') => `<div class="imgpt"><a class="iusc" ${mAttr(d)} href="/images/search?view=detailV2">`
  + `<div class="img_cont"><img class="mimg" src="${d.turl ?? ''}"></div></a>`
  + `<div class="img_info">${dim ? `<span class="nowrap">${dim}</span>` : ''}<span>jpeg</span></div></div>`;

const BING = '<html><body><ul class="dgControl_list">'
  + tarjeta({ cid: 'ABC1', t: 'Mujer corriendo &amp; saltando', murl: 'https://static.ejemplo.com/fotos/mujer%20corriendo.jpg', turl: 'https://tse1.mm.bing.net/th?id=OIP.a1', purl: 'https://ejemplo.com/galeria/corredora' }, '1200 &#215; 800')
  + tarjeta({ cid: 'SVG1', t: 'Silueta', murl: 'https://iconos.ejemplo.org/silueta.svg', turl: 'https://tse1.mm.bing.net/th?id=OIP.s1', purl: 'https://iconos.ejemplo.org/' }, '512 &#215; 512')
  + tarjeta({ cid: 'DUP1', t: 'La misma con parametros', murl: 'https://static.ejemplo.com/fotos/mujer%20corriendo.jpg?w=200', turl: 'https://tse1.mm.bing.net/th?id=OIP.a2', purl: 'https://ejemplo.com/galeria/corredora' }, '200 &#215; 133')
  + tarjeta({ cid: 'NOU1', t: 'Sin original', turl: 'https://tse1.mm.bing.net/th?id=OIP.n1', purl: 'https://ejemplo.com/' })
  + tarjeta({ cid: 'REL1', t: 'Url relativa', murl: '//static.ejemplo.com/x.jpg', purl: 'https://ejemplo.com/' })
  + '<a class="iusc" m="{&quot;murl&quot;:}" href="#"></a>'
  + tarjeta({ cid: 'MINI1', t: 'Icono diminuto', murl: 'https://static.ejemplo.com/iconos/mini.png', turl: 'https://tse1.mm.bing.net/th?id=OIP.m1', purl: 'https://ejemplo.com/iconos' }, '80 &#215; 60')
  + tarjeta({ cid: 'OK2', t: 'Salto', murl: 'https://cdn.otro.net/salto.jpeg', turl: 'https://tse2.mm.bing.net/th?id=OIP.b1', purl: 'https://otro.net/blog/salto' }, '900 x 1600')
  + '</ul></body></html>';

servir([['bing.com/images/async', () => html(BING)]]);
let r = await searchImages('mujer corriendo', { provider: 'bing' });
const uno = r.results[0] ?? {};
check('Bing responde cuando se le pide a mano', r.provider === 'bing' && r.label === 'Bing');
check('del HTML salen solo los resultados utiles', r.results.length === 2, r.results.map((x) => x.id).join(', '));
check('la url original es la del atributo m', uno.full === 'https://static.ejemplo.com/fotos/mujer%20corriendo.jpg', uno.full);
check('la miniatura es la que sirve Bing', uno.thumb === 'https://tse1.mm.bing.net/th?id=OIP.a1');
check('el dominio se toma de la pagina de origen', uno.host === 'ejemplo.com', uno.host);
check('el titulo llega sin entidades HTML', uno.title === 'Mujer corriendo & saltando', uno.title);
check('el tamano se lee del bloque del propio resultado', uno.w === 1200 && uno.h === 800, uno.w + 'x' + uno.h);
check('el identificador es el cid de Bing', uno.id === 'ABC1', uno.id);
check('un SVG no sirve para sacar una pose', !r.results.some((x) => /\.svg/i.test(x.full)));
check('el repetido con parametros se descarta',
  r.results.filter((x) => x.full.includes('mujer%20corriendo')).length === 1);
check('sin url original no hay resultado', !r.results.some((x) => x.id === 'NOU1'));
check('una url relativa se descarta', !r.results.some((x) => x.full.startsWith('//')));
// Un icono de 80x60 pasa el filtro de formato pero no tiene cuerpo que medir.
check('lo que es demasiado pequeno para tener pose se descarta',
  !r.results.some((x) => x.id === 'MINI1'), r.results.map((x) => x.id).join(', '));
check('el tamano tambien se lee con la x sin escapar',
  r.results[1]?.w === 900 && r.results[1]?.h === 1600, r.results[1]?.w + 'x' + r.results[1]?.h);

const url1 = pedida('images/async')?.url ?? '';
check('se pide la pagina async de 32 en 32', url1.includes('first=1') && url1.includes('count=32'), url1);
check('el filtro de contenido adulto va en adlt=strict', url1.includes('adlt=strict'));
// Anadir `qft=…photo-photo` parecia afinar los resultados y en realidad los
// arruina: buscando «hombre corriendo cuerpo completo» salian camisas de vestir y
// laminas de la evolucion humana. Que no vuelva a colarse.
check('no se envia ningun filtro qft, que destroza la relevancia', !url1.includes('qft'), url1);
check('se anuncia un navegador de verdad, o Bing contesta una pagina vacia',
  /Chrome\//.test(String(pedida('images/async')?.opts?.headers?.['User-Agent'] ?? '')));

servir([['bing.com/images/async', () => html(BING)]]);
await searchImages('mujer corriendo', { provider: 'bing', page: 3, safe: false });
const url3 = pedida('images/async')?.url ?? '';
check('la pagina 3 arranca en el resultado 65', url3.includes('first=65'), url3);
check('sin filtro de adultos se pide adlt=off', url3.includes('adlt=off'));

servir([['bing.com/images/async', () => html(BING)]]);
await searchImages('x', { provider: 'bing', page: 999 });
check('la pagina se limita a la 20', (pedida('images/async')?.url ?? '').includes('first=609'),
  pedida('images/async')?.url);

/* -- 2 - Mezcla de proveedores ----------------------------------------- */

const DDG_PORTADA = '<html><script>DDG.deep.initialize(\'d.js?q=correr&vqd="4-987654321"\');</script></html>';
const DDG_JSON = { results: [
  { image: 'https://fotos.ddg.test/1.jpg', thumbnail: 'https://ext.ddg.test/th1', title: 'Correr', url: 'https://sitio.ddg.test/1', width: 1024, height: 768, image_token: 'tok1' },
  { image: 'https://fotos.ddg.test/2.png', thumbnail: 'https://ext.ddg.test/th2', title: 'Andar', url: 'https://sitio.ddg.test/2', width: 800, height: 600, image_token: 'tok2' },
] };
const OV_JSON = { results: [
  { id: 'ov1', title: 'Runner', url: 'https://live.static.test/1.jpg', thumbnail: 'https://api.openverse.org/v1/images/ov1/thumb/', foreign_landing_url: 'https://flickr.test/photos/1', provider: 'flickr', width: 640, height: 480 },
] };
const rutaDuck = [
  ['duckduckgo.com/?q=', () => html(DDG_PORTADA)],
  ['duckduckgo.com/i.js', () => json(DDG_JSON)],
];
const rutaOv = [['api.openverse.org', () => json(OV_JSON)]];
const WM_JSON = { query: { pages: [
  { pageid: 7060789, title: 'File:Marathon_Barcelona_Catalunya_2007.jpg', imageinfo: [{ mime: 'image/jpeg', width: 2048, height: 1360, url: 'https://upload.wikimedia.org/wikipedia/commons/1/12/Marathon.jpg', thumburl: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/1/12/Marathon.jpg/400px-Marathon.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Marathon.jpg' }] },
  { pageid: 111, title: 'File:Diagrama.svg', imageinfo: [{ mime: 'image/svg+xml', width: 512, height: 512, url: 'https://upload.wikimedia.org/wikipedia/commons/9/99/Diagrama.svg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Diagrama.svg' }] },
  { pageid: 222, title: 'File:Video.webm', imageinfo: [{ mime: 'video/webm', width: 640, height: 480, url: 'https://upload.wikimedia.org/wikipedia/commons/2/22/Video.webm', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Video.webm' }] },
  { pageid: 333, title: 'File:Sin_informacion.jpg' },
  { pageid: 444, title: 'File:Sello_diminuto.jpg', imageinfo: [{ mime: 'image/jpeg', width: 13, height: 13, url: 'https://upload.wikimedia.org/wikipedia/commons/4/44/Sello.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Sello.jpg' }] },
] } };
const rutaWm = [['commons.wikimedia.org', () => json(WM_JSON)]];

// Los cuatro archivos de museo: cada uno tiene su forma de decir donde esta la
// imagen, y en todos hay fichas sin foto que no pueden llegar a la rejilla.
const ARTIC_JSON = {
  config: { iiif_url: 'https://iiif.artic.test/2' },
  data: [
    { id: 500, title: 'Figura corriendo', artist_title: 'Anonimo', image_id: 'abc-123', thumbnail: { width: 2400, height: 3000 } },
    { id: 501, title: 'Obra sin foto', artist_title: '', thumbnail: { width: 900, height: 900 } },
  ],
};
const CLE_JSON = { data: [
  { id: 900, title: 'Thetis corriendo', url: 'https://www.clevelandart.test/art/1963.92',
    creators: [{ description: 'Severo da Ravenna' }],
    images: {
      web: { url: 'https://cdn.clevelandart.test/1963.92_web.jpg', width: '528', height: '893' },
      print: { url: 'https://cdn.clevelandart.test/1963.92_print.jpg', width: '2012', height: '3400' },
    } },
  { id: 901, title: 'Ficha sin foto', url: 'https://www.clevelandart.test/art/2', images: {} },
] };
const MET_OBJ = {
  11: { objectID: 11, title: 'Atleta', artistDisplayName: 'Rodin', primaryImageSmall: 'https://images.met.test/11-web.jpg', objectURL: 'https://www.met.test/11' },
  12: { objectID: 12, title: 'Ficha sin foto', primaryImageSmall: '', objectURL: 'https://www.met.test/12' },
  13: { objectID: 13, title: 'Discobolo', primaryImageSmall: 'https://images.met.test/13-web.jpg', objectURL: 'https://www.met.test/13' },
};
const WEL_JSON = { results: [
  { id: 'wel1', source: { id: 'ttv1', title: 'Lamina de anatomia' }, thumbnail: { url: 'https://iiif.wellcome.test/image/L001.jpg/info.json' } },
  { id: 'wel2', source: { id: 'ttv2', title: 'Ficha sin IIIF' }, thumbnail: { url: 'https://otro.test/x.png' } },
] };
const rutaBing = [['bing.com/images/async', () => html(BING)]];
const rutaArtic = [['api.artic.edu', () => json(ARTIC_JSON)]];
const rutaCle = [['clevelandart.org', () => json(CLE_JSON)]];
const rutaMet = [
  ['collection/v1/search', () => json({ total: 3, objectIDs: [11, 12, 13] })],
  ['collection/v1/objects/', (url) => json(MET_OBJ[Number(url.split('/').pop())] ?? {})],
];
const rutaWel = [['wellcomecollection.org', () => json(WEL_JSON)]];
const todas = [...rutaBing, ...rutaDuck, ...rutaWm, ...rutaOv, ...rutaArtic, ...rutaCle, ...rutaMet];

// Sin proveedor elegido se pregunta a los siete a la vez y la rejilla sale
// entrelazada: es la diferencia con la cadena de respaldo que habia antes, donde
// el primero que contestaba (Bing, siempre) tapaba a los demas.
servir(todas);
r = await searchImages('correr');
const orden = r.results.map((x) => x.source).join(',');
check('sin proveedor elegido contestan los siete',
  r.provider === 'mezcla' && r.label === 'Varias fuentes' && r.fuentes.length === 7,
  r.provider + ' ' + JSON.stringify(r.tried));
check('la rejilla junta lo de todos, no lo del primero que responde',
  r.results.length === 10, r.results.length + ' :: ' + JSON.stringify(r.fuentes));
check('la lista viene entrelazada y no por bloques',
  orden === 'bing,bing,duck,duck,wikimedia,openverse,artic,cleveland,met,met', orden);
check('los dos buscadores web se quedan las primeras filas',
  r.results.slice(0, 4).every((x) => x.source === 'bing' || x.source === 'duck'), orden);
check('cada resultado dice de que sitio sale', r.results.every((x) => x.source));
check('y el recuento por sitio viaja con nombre para la interfaz',
  r.fuentes.every((f) => f.count > 0 && f.label), JSON.stringify(r.fuentes));
check('Wellcome se queda fuera de la mezcla automatica',
  !pedida('wellcomecollection'), pedida('wellcomecollection')?.url);
check('el testigo vqd de la portada viaja en la peticion JSON',
  (pedida('i.js')?.url ?? '').includes('vqd=4-987654321'), pedida('i.js')?.url);
check('DuckDuckGo ya trae el tamano resuelto',
  r.results[2]?.w === 1024 && r.results[2]?.h === 768, r.results[2]?.w + 'x' + r.results[2]?.h);

// Cada sitio por dentro: de donde sale la imagen y que se queda fuera.
const deWm = r.results.find((x) => x.source === 'wikimedia');
check('de Commons solo salen imagenes de mapa de bits',
  !r.results.some((x) => /\.svg|\.webm|Sello/i.test(x.full)), r.results.map((x) => x.full).join(', '));
check('el titulo de Commons se limpia del File: y los guiones bajos',
  deWm?.title === 'Marathon Barcelona Catalunya 2007', deWm?.title);
check('a Commons se le pide el espacio de archivo y solo bitmap',
  /gsrnamespace=6/.test(pedida('wikimedia')?.url ?? '')
  && /filetype%3Abitmap/.test(pedida('wikimedia')?.url ?? ''), pedida('wikimedia')?.url);

const deOv = r.results.find((x) => x.source === 'openverse');
check('Openverse pide la miniatura a su propio servidor',
  deOv?.thumb.startsWith('https://api.openverse.org/'), deOv?.thumb);
check('y su filtro de adultos se traduce a mature=false',
  (pedida('openverse')?.url ?? '').includes('mature=false'));

const deArtic = r.results.find((x) => x.source === 'artic');
check('del Art Institute la imagen se pide por IIIF al tamano que hace falta',
  deArtic?.full === 'https://iiif.artic.test/2/abc-123/full/1200,/0/default.jpg'
  && deArtic?.thumb === 'https://iiif.artic.test/2/abc-123/full/400,/0/default.jpg', deArtic?.full);
check('y queda marcada para pedirla por el propio dominio, que ese servidor no deja enlazar',
  deArtic?.proxy === true && r.results.filter((x) => x.proxy).length === 1);
check('la obra sin imagen no llega a la rejilla', !r.results.some((x) => x.id === 'artic-501'));

const deCle = r.results.find((x) => x.source === 'cleveland');
check('de Cleveland se usa la copia web, no la de imprenta',
  deCle?.full === 'https://cdn.clevelandart.test/1963.92_web.jpg' && deCle?.w === 528, deCle?.full);
check('y el autor va pegado al titulo',
  deCle?.title === 'Thetis corriendo · Severo da Ravenna', deCle?.title);

const delMet = r.results.filter((x) => x.source === 'met');
check('el Met necesita una ficha por obra y se piden todas de golpe',
  pedidas.filter((p) => p.url.includes('collection/v1/objects/')).length === 3);
check('y las obras sin fotografia se caen solas',
  delMet.length === 2 && delMet[0]?.full === 'https://images.met.test/11-web.jpg', String(delMet.length));

// Que un sitio se caiga resta resultados, no la busqueda entera. Los que no
// tienen ruta en el servidor falso cuentan como caidos, asi que aqui contestan
// dos: DuckDuckGo y Commons.
servir([['bing.com', () => html('vaya', 500)], ...rutaDuck, ...rutaWm]);
r = await searchImages('correr');
check('si Bing se cae la mezcla sigue con los demas',
  r.results.length === 3 && !r.results.some((x) => x.source === 'bing'), JSON.stringify(r.fuentes));
check('y el fallo queda anotado en la lista de intentos',
  r.tried.some((t) => t.startsWith('bing:')), JSON.stringify(r.tried));

servir([['bing.com', () => html('no', 500)], ['duckduckgo.com', () => html('no', 500)],
  ['commons.wikimedia.org', () => json({}, 500)], ['openverse', () => json({}, 500)],
  ['artic.edu', () => json({}, 500)], ['clevelandart.org', () => json({}, 500)],
  ['metmuseum.org', () => json({}, 500)]]);
let lanzo = '';
try { await searchImages('correr'); } catch (err) { lanzo = err?.message ?? 'error'; }
check('solo si fallan todos la busqueda se rinde con un error', lanzo !== '', lanzo);

// La web se solapa: la misma foto la tienen indexada los dos buscadores, y con
// parametros distintos en la url.
const DDG_REPE = { results: [
  { image: 'https://static.ejemplo.com/fotos/mujer%20corriendo.jpg?w=800', thumbnail: 'https://ext.ddg.test/th0', title: 'La de Bing otra vez', url: 'https://sitio.ddg.test/0', width: 1200, height: 800 },
  ...DDG_JSON.results,
] };
servir([...rutaBing, ['duckduckgo.com/?q=', () => html(DDG_PORTADA)],
  ['duckduckgo.com/i.js', () => json(DDG_REPE)]]);
r = await searchImages('correr');
check('una imagen que traen dos buscadores aparece una sola vez',
  r.results.filter((x) => x.full.includes('mujer%20corriendo')).length === 1 && r.results.length === 4,
  r.results.length + ' resultados');

// DuckDuckGo sirve un centenar de golpe y Commons hasta 64: mas de lo que cabe en
// la rejilla, asi que la mezcla corta y reparte por cupos.
const DDG_MUCHOS = { results: Array.from({ length: 200 }, (_, i) => ({
  image: `https://fotos.ddg.test/m${i}.jpg`, thumbnail: `https://ext.ddg.test/m${i}`,
  title: 'foto ' + i, url: `https://sitio.ddg.test/m${i}`, width: 900, height: 600 })) };
const WM_MUCHOS = { query: { pages: Array.from({ length: 40 }, (_, i) => ({
  pageid: 1000 + i, title: `File:Foto_${i}.jpg`,
  imageinfo: [{ mime: 'image/jpeg', width: 900, height: 600,
    url: `https://upload.wikimedia.test/${i}.jpg`, descriptionurl: `https://commons.wikimedia.test/${i}` }] })) } };
servir([['duckduckgo.com/?q=', () => html(DDG_PORTADA)], ['duckduckgo.com/i.js', () => json(DDG_MUCHOS)],
  ['commons.wikimedia.org', () => json(WM_MUCHOS)]]);
r = await searchImages('correr');
const cuenta = Object.fromEntries(r.fuentes.map((f) => [f.id, f.count]));
check('la lista mezclada se corta en 120, que es lo que se manda al navegador',
  r.results.length === 120, String(r.results.length));
check('y el reparto sigue el cupo: cinco del buscador por cada dos del archivo',
  cuenta.duck === 86 && cuenta.wikimedia === 34, JSON.stringify(cuenta));

servir(rutaWm);
r = await searchImages('correr', { provider: 'wikimedia', page: 3 });
check('el proveedor elegido a mano es el unico al que se pregunta',
  r.provider === 'wikimedia' && r.label === 'Wikimedia Commons' && pedidas.length === 1,
  pedidas.length + ' peticiones');
check('la pagina 3 de Commons salta los 64 primeros',
  (pedida('wikimedia')?.url ?? '').includes('gsroffset=64'), pedida('wikimedia')?.url);

servir(rutaDuck);
await searchImages('correr', { provider: 'duck', page: 3 });
check('la pagina 3 de DuckDuckGo salta 200, que sirve de cien en cien',
  (pedida('i.js')?.url ?? '').includes('s=200'), pedida('i.js')?.url);

// Wellcome se queda fuera de la mezcla, pero elegido a mano funciona igual.
servir(rutaWel);
r = await searchImages('anatomia', { provider: 'wellcome' });
check('Wellcome responde cuando se elige a mano',
  r.provider === 'wellcome' && r.results.length === 1, r.provider + ' ' + r.results.length);
check('y su imagen se arma desde el info.json de IIIF',
  r.results[0]?.thumb === 'https://iiif.wellcome.test/image/L001.jpg/full/400,/0/default.jpg',
  r.results[0]?.thumb);

servir(rutaBing);
r = await searchImages('correr', { provider: 'loquesea' });
check('un proveedor desconocido cae en la mezcla', r.tried.length > 1, JSON.stringify(r.tried));
check('y si solo contesta uno la respuesta lleva su nombre y no «mezcla»',
  r.provider === 'bing' && r.label === 'Bing' && r.fuentes.length === 1, r.provider + '/' + r.label);

servir([]);
r = await searchImages('   ');
check('una busqueda vacia no sale a la red', r.results.length === 0 && pedidas.length === 0);

/* -- 3 - Frenos del proxy: a donde no se pide -------------------------- */

// El usuario no escribe estas urls, pero la ruta del proxy esta abierta en el
// dominio de la aplicacion: sin esta lista seria una pasarela para leer la red
// interna de quien la despliegue.
const prohibidas = [
  'file:///etc/passwd', 'ftp://ejemplo.com/a.jpg', 'javascript:alert(1)', 'data:image/png;base64,AAA',
  'http://localhost/a.jpg', 'http://algo.localhost/a.jpg', 'http://impresora.local/a.jpg',
  'http://api.internal/a.jpg', 'http://metadata.google.internal/computeMetadata/v1/',
  'http://127.0.0.1/a.jpg', 'http://0.0.0.0/a.jpg', 'http://10.1.2.3/a.jpg',
  'http://172.16.0.9/a.jpg', 'http://172.31.255.1/a.jpg', 'http://192.168.1.1/a.jpg',
  'http://169.254.169.254/latest/meta-data/', 'http://239.0.0.1/a.jpg',
  'http://[::1]/a.jpg', 'http://[fd00::1]/a.jpg', 'http://[fe80::1]/a.jpg',
  'https://ejemplo.com:8080/a.jpg', 'https://ejemplo.com:22/a.jpg', 'esto no es una url',
];
const colados = prohibidas.filter((u) => checkTarget(u).ok);
check('el proxy no pide nada de la red interna ni fuera de http', colados.length === 0, colados.join(', '));

const permitidas = ['https://ejemplo.com/foto.jpg', 'http://ejemplo.com/foto.jpg',
  'https://cdn.ejemplo.com:443/foto.jpg', 'http://cdn.ejemplo.com:80/foto.jpg',
  'https://93.184.216.34/foto.jpg', 'https://ejemplo.com/ruta con espacios.jpg',
  'http://172.32.0.1/a.jpg'];
const frenadas = permitidas.filter((u) => !checkTarget(u).ok);
check('una imagen publica normal si pasa', frenadas.length === 0, frenadas.join(', '));
check('el rechazo explica el motivo',
  /destino no permitido/.test(checkTarget('http://10.0.0.1/a.jpg').reason ?? ''));

/* -- 4 - Frenos del proxy: que se reenvia ------------------------------ */

servir([['ejemplo.com', () => img(bytes(2048))]]);
let f = await fetchImage('https://ejemplo.com/foto.jpg');
check('una imagen normal se reenvia tal cual',
  f.ok && f.status === 200 && f.type === 'image/jpeg' && f.body.byteLength === 2048, String(f.error));
check('se manda Referer del dominio de la propia imagen, que es lo que esperan muchos servidores',
  pedidas[0]?.opts?.headers?.Referer === 'https://ejemplo.com/', pedidas[0]?.opts?.headers?.Referer);

servir([['ejemplo.com', () => html('<html>no soy una imagen</html>')]]);
f = await fetchImage('https://ejemplo.com/pagina.html');
check('lo que no es una imagen se rechaza con 415', !f.ok && f.status === 415, String(f.status));

servir([['ejemplo.com', () => img(bytes(64), 'image/jpeg', { 'Content-Length': String(MAX_BYTES + 1) })]]);
f = await fetchImage('https://ejemplo.com/enorme.jpg');
check('una imagen que se declara enorme no se descarga', !f.ok && f.status === 413, String(f.status));

servir([['ejemplo.com', () => img(bytes(MAX_BYTES + 1))]]);
f = await fetchImage('https://ejemplo.com/enorme2.jpg');
check('y si miente en la cabecera se corta al pesarla', !f.ok && f.status === 413, String(f.status));

servir([['ejemplo.com', () => html('no esta', 404)]]);
f = await fetchImage('https://ejemplo.com/no.jpg');
check('un 404 del servidor ajeno llega como 404', f.status === 404, String(f.status));

servir([['ejemplo.com', () => new Error('ECONNRESET')]]);
f = await fetchImage('https://ejemplo.com/roto.jpg');
check('si la descarga se cae se responde 502', !f.ok && f.status === 502, f.error);
f = await fetchImage('http://169.254.169.254/latest/meta-data/');
check('el destino se comprueba antes de pedir nada',
  !f.ok && f.status === 400 && pedidas.length === 1, pedidas.length + ' peticiones');

/* -- 5 - Solo desde la propia pagina ----------------------------------- */

check('una peticion de otra web no usa el proxy', !mismoOrigen(cab('cross-site')));
check('la propia pagina si', mismoOrigen(cab('same-origin')) && mismoOrigen(cab('same-site')));
check('escribir la direccion a mano (none) tambien', mismoOrigen(cab('none')));
check('un cliente sin la cabecera no se queda fuera', mismoOrigen(cab('')));

/* -- 6 - Las funciones de Cloudflare Pages ----------------------------- */

const { onRequestGet: rutaBuscar } = await import('../functions/api/img-search.js');
const { onRequestGet: rutaProxy } = await import('../functions/api/img-proxy.js');
const pet = (url, site = 'same-origin') => ({ request: { url, headers: cab(site) } });

servir([['bing.com/images/async', () => html(BING)]]);
let res = await rutaBuscar(pet('https://app.test/api/img-search?q=mujer%20corriendo'));
let data = await res.json();
check('/api/img-search devuelve la lista en JSON',
  res.status === 200 && data.results?.length === 2, res.status + ' ' + JSON.stringify(data).slice(0, 80));
check('la respuesta se puede cachear un par de minutos',
  /max-age=120/.test(res.headers.get('cache-control') ?? ''), res.headers.get('cache-control'));

res = await rutaBuscar(pet('https://app.test/api/img-search?q=x', 'cross-site'));
check('otra web no puede usar la busqueda', res.status === 403, String(res.status));
res = await rutaBuscar(pet('https://app.test/api/img-search?q=%20%20'));
check('sin texto que buscar contesta 400', res.status === 400, String(res.status));

servir([['bing.com', () => html('no', 500)], ['duckduckgo.com', () => html('no', 500)],
  ['commons.wikimedia.org', () => json({}, 500)], ['openverse', () => json({}, 500)]]);
res = await rutaBuscar(pet('https://app.test/api/img-search?q=correr'));
check('si ningun buscador responde, 502 con el motivo',
  res.status === 502 && !!(await res.json()).error, String(res.status));

servir([['ejemplo.com', () => img(bytes(1024), 'image/png')]]);
res = await rutaProxy(pet('https://app.test/api/img-proxy?u=' + encodeURIComponent('https://ejemplo.com/a.png')));
check('/api/img-proxy reenvia los bytes con su tipo',
  res.status === 200 && res.headers.get('content-type') === 'image/png'
  && (await res.arrayBuffer()).byteLength === 1024, String(res.status));
check('y sin dejar que el navegador adivine el tipo',
  res.headers.get('x-content-type-options') === 'nosniff');
res = await rutaProxy(pet('https://app.test/api/img-proxy'));
check('sin url el proxy contesta 400', res.status === 400, String(res.status));
res = await rutaProxy(pet('https://app.test/api/img-proxy?u=' + encodeURIComponent('http://127.0.0.1:9000/secreto.png')));
check('el proxy no entra en la red local', res.status === 400, await res.text());
res = await rutaProxy(pet('https://app.test/api/img-proxy?u=https%3A%2F%2Fejemplo.com%2Fa.png', 'cross-site'));
check('ni hace de pasarela para otra web', res.status === 403, String(res.status));

/* -- 7 - Las mismas rutas en `npm run dev` ----------------------------- */

// El buscador tiene que funcionar igual en desarrollo, donde no hay funciones de
// Pages: las dos rutas las monta un plugin sobre el servidor de Vite. Si una de
// las dos copias se queda atras, esto lo dice.
const { default: viteConfig } = await import('../vite.config.js');
const plugin = viteConfig.plugins.flat().find((p) => p?.name === 'atom-image-search');
const montados = [];
plugin?.configureServer({ middlewares: { use: (fn) => montados.push(fn) } });
check('el plugin del buscador monta su middleware en dev', montados.length === 1);
check('y tambien en preview', typeof plugin?.configurePreviewServer === 'function');

const pedirDev = async (url, site = 'same-origin') => {
  const res = {
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    end(b) { this.body = b; },
  };
  let siguiente = false;
  await montados[0]({ url, originalUrl: url, headers: site ? { 'sec-fetch-site': site } : {} },
    res, () => { siguiente = true; });
  return { res, siguiente };
};

servir([['bing.com/images/async', () => html(BING)]]);
let dev = await pedirDev('/api/img-search?q=mujer%20corriendo');
check('en dev /api/img-search responde lo mismo',
  dev.res.statusCode === 200 && JSON.parse(dev.res.body).results.length === 2,
  dev.res.statusCode + ' ' + String(dev.res.body).slice(0, 60));

servir([['ejemplo.com', () => img(bytes(1024), 'image/png')]]);
dev = await pedirDev('/api/img-proxy?u=' + encodeURIComponent('https://ejemplo.com/a.png'));
check('en dev /api/img-proxy reenvia los bytes',
  dev.res.statusCode === 200 && dev.res.headers['content-type'] === 'image/png'
  && dev.res.body?.length === 1024, dev.res.statusCode + ' ' + typeof dev.res.body);

dev = await pedirDev('/api/img-proxy?u=' + encodeURIComponent('https://ejemplo.com/a.png'), 'cross-site');
check('en dev tampoco se atiende a otra web', dev.res.statusCode === 403);
dev = await pedirDev('/index.html');
check('el resto de la aplicacion sigue su camino',
  dev.siguiente === true && dev.res.body === null);

globalThis.fetch = realFetch;

console.log('');
console.log(oks.length + ' correctas / ' + fails.length + ' fallos');
if (fails.length) { console.log('FALLOS:'); for (const f of fails) console.log(' - ' + f); process.exit(1); }
