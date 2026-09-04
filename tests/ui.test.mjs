/**
 * Prueba de humo de la capa de interfaz: monta index.html en jsdom y construye
 * UI + lectura flotante con modulos simulados. No hay WebGL en jsdom, asi que
 * el visor real no participa; lo que se comprueba es el cableado del DOM.
 */
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';

// Las rutas de archivo se resuelven desde la raiz del proyecto, sea desde donde
// sea que se lance la prueba.
process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const html = fs.readFileSync('index.html', 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, { pretendToBeVisual: true, url: 'https://localhost/' });
const { window } = dom;
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Image', 'Node', 'Event',
  'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'PointerEvent', 'DOMParser', 'localStorage',
  'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'Intl']) {
  if (window[k] === undefined) continue;
  try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch { /* ya definido */ }
}
globalThis.performance ??= window.performance;

const errors = [];
window.addEventListener('error', (e) => errors.push(String(e.error ?? e.message)));

const { Settings } = await import('../src/core/Settings.js');
const { DEFAULTS, STORAGE_KEY } = await import('../src/config.js');
const { UI } = await import('../src/ui/UI.js');
const { Readout } = await import('../src/ui/Readout.js');
const { initToasts, toast } = await import('../src/ui/Toast.js');

const settings = new Settings(DEFAULTS, STORAGE_KEY);
initToasts(document.getElementById('toasts'));

const called = [];
const act = (name) => (...a) => { called.push(name); return true; };
const frameCbs = new Set();
const vec = (x = 0, y = 0, z = 0) => ({ x, y, z });

// Dos figuras en la escena, para que los controles de figura se pinten de
// verdad: el panel de Figura edita la activa y la lista de escena la elegida.
const figDefs = [
  { id: 'f0', name: 'Figura 1', model: 'character', visible: true,
    position: vec(), rotation: vec(), height: 1.75, anchor: 'suelo', pose: null },
  { id: 'f1', name: 'Figura 2', model: 'xbot', visible: true,
    position: vec(0.7, 0, 0), rotation: vec(0, 30, 0), height: 1.62, anchor: 'suelo', pose: null },
];

const app = {
  settings,
  viewport: { stats: { fps: 60, ms: 4.2, triangles: 120000, calls: 12 }, onFrame: (cb) => (frameCbs.add(cb), () => frameCbs.delete(cb)) },
  source: { listDevices: async () => [{ id: 'abc', label: 'Camara falsa' }] },
  library: { list: () => [{ id: 'p1', name: 'Pose de prueba', created: Date.now() }] },
  // `FigureSet` simulado: solo el papeleo que consulta la interfaz.
  figures: {
    get defs() { return settings.get('scene.figures') ?? []; },
    get count() { return this.defs.length; },
    get activeId() { return settings.get('figure.active') ?? ''; },
    get activeDef() { return this.defs.find((d) => d.id === this.activeId) ?? null; },
    locate(id) {
      const i = this.defs.findIndex((d) => d.id === id);
      return i < 0 ? null : { branch: 'figures', index: i, def: this.defs[i] };
    },
    pathOf(id) { const at = this.locate(id); return at ? 'scene.figures.' + at.index : ''; },
    list() {
      return this.defs.map((d) => ({
        id: d.id, label: d.name, icon: 'user', kind: 'figura',
        meta: d.id === this.activeId ? 'posando' : '',
      }));
    },
  },
  hooks: {},
  // Buscador de imagenes simulado: dos resultados de mentira de dos sitios
  // distintos y un archivo de tres bytes, para que la paleta se monte, se pueda
  // filtrar por fuente y pulsar una miniatura sin tocar la red.
  search: {
    veces: 0,
    async search(q, { page = 1 } = {}) {
      this.veces++;
      return {
        provider: 'mezcla', label: 'Varias fuentes', page, results: [
          { id: 'r1', title: 'Corriendo', full: 'https://ejemplo.test/1.jpg', thumb: 'https://ejemplo.test/t1.jpg', page: 'https://ejemplo.test/a', host: 'ejemplo.test', w: 1200, h: 800, source: 'bing' },
          { id: 'r2', title: 'Saltando', full: 'https://museo.test/2.jpg', thumb: 'https://museo.test/t2.jpg', page: 'https://museo.test/b', host: 'museo.test', w: 900, h: 1600, source: 'artic', proxy: true },
        ],
        fuentes: [
          { id: 'bing', label: 'Bing', count: 1 },
          { id: 'artic', label: 'Art Institute of Chicago', count: 1 },
        ],
      };
    },
    // Los sitios que no dejan enlazar sus imagenes salen por el propio dominio.
    thumbUrl(r) { return r?.proxy ? '/api/img-proxy?url=' + encodeURIComponent(r.thumb) : r.thumb; },
    async toFile() { return new window.File([new Uint8Array([1, 2, 3])], 'referencia.jpg', { type: 'image/jpeg' }); },
  },
  actions: new Proxy({}, { get: (_, name) => act(name) }),
};
settings.batch({ 'scene.figures': figDefs, 'figure.active': 'f0' });

const ui = new UI(app);
app.ui = ui;
const sb = new Readout(document.getElementById('viewport-readout'), app);

// 1 · Todas las secciones existen y solo una esta visible.
const panels = [...document.querySelectorAll('#sidebar-host .panel')];
const visibles = panels.filter((p) => !p.classList.contains('hidden'));
console.log('paneles:', panels.map((p) => p.dataset.panel).join(', '));
console.log('visibles:', visibles.length, '· seccion:', document.getElementById('sidebar-title').textContent);

// 2 · Los iconos se han hidratado (no queda ningun data-icon suelto).
console.log('data-icon sin hidratar:', document.querySelectorAll('[data-icon]').length);
console.log('svg de iconos:', document.querySelectorAll('svg.svg-icon').length);

// 3 · La fila de iconos de lo alto del panel lateral cambia de seccion: un
// icono por panel, sin menus que desplegar.
const tabs = [...document.querySelectorAll('#sidebar-tabs .sidebar-tab')];
console.log('iconos de seccion:', tabs.length, '·', tabs.map((b) => b.dataset.section).join(', '));
const bienPintadas = [];
for (const btn of tabs) {
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const marcada = document.querySelector('.sidebar-tab.is-active')?.dataset.section;
  const alaVista = document.querySelector('#sidebar-host .panel:not(.hidden)')?.dataset.panel;
  bienPintadas.push(settings.get('ui.section') === btn.dataset.section
    && marcada === btn.dataset.section && alaVista === btn.dataset.section);
}
console.log('cada icono abre su panel y queda marcado:', bienPintadas.every(Boolean));
// Volver a pulsar el icono activo no puede replegar el panel: la fila vive
// dentro de el y el usuario se quedaria sin manera de volver.
tabs.at(-1)?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
console.log('seccion final:', settings.get('ui.section'), '· panel lateral:', settings.get('ui.sidebar'));
// El cambio de panel ya no esta en los desplegables del visor: alli solo quedan
// acciones.
const items = [...document.querySelectorAll('#viewport-toolbar .toolbar-dropdown-item')];
console.log('desplegables del visor:', document.querySelectorAll('#viewport-toolbar .toolbar-dropdown').length,
  '· sin entradas de panel:', !items.some((b) => /panel/i.test(b.textContent)));

// 4 · Los controles enlazados escriben en el almacen.
const range = document.querySelector('#sidebar-host input[type="range"]');
range.value = String(Number(range.max));
range.dispatchEvent(new window.Event('input', { bubbles: true }));
const check = document.querySelector('#sidebar-host input[type="checkbox"]');
check.click();

// 5 · Atajos de teclado. Espacio abre el buscador de imagenes, asi que congelar
// la pose se pide con C.
const key = (k, opts = {}) => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, ...opts }));
const flush = () => new Promise((r) => setTimeout(r, 0));
key('2'); key('o'); key('c'); key('g'); key('h'); key('f'); key('b'); key('z', { ctrlKey: true });
console.log('variante:', settings.get('figure.variant'), '· proyeccion:', settings.get('camera.projection'),
  '· congelada:', settings.get('mocap.frozen'), '· pose manual:', settings.get('ui.manualPosing'));
console.log('acciones invocadas:', [...new Set(called)].join(', '));

// 5b · El buscador de imagenes: Espacio lo abre, Intro busca, una miniatura
// entra en el monitor de captura por el mismo camino que un archivo soltado.
const palette = document.getElementById('imgsearch');
key(' ');
console.log('buscador con Espacio:', !palette.classList.contains('hidden'),
  '· foco en el cuadro:', document.activeElement?.id);
const input = document.getElementById('imgsearch-input');
input.value = 'persona corriendo';
input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
await flush();
const cards = [...palette.querySelectorAll('.imgsearch-card')];
console.log('resultados pintados:', cards.length, '· busquedas pedidas:', app.search.veces,
  '· proveedor:', palette.querySelector('.imgsearch-tag')?.textContent,
  '· sobra un «null»:', palette.textContent.includes('null'));
// La fila de sitios filtra lo que ya esta cargado, sin volver a la red, y la
// miniatura del archivo que no deja enlazar se pide por el propio dominio.
const chipFuente = (i) => palette.querySelectorAll('.imgsearch-fuentes .imgsearch-chip')[i];
console.log('fila de fuentes:', [...palette.querySelectorAll('.imgsearch-fuentes .imgsearch-chip')]
  .map((c) => c.textContent).join(' | '));
console.log('miniatura por el proxy:',
  [...palette.querySelectorAll('.imgsearch-card img')][1]?.getAttribute('src')?.startsWith('/api/img-proxy'));
chipFuente(2)?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
console.log('filtrado por un sitio:', palette.querySelectorAll('.imgsearch-card').length,
  'miniatura · sin volver a la red:', app.search.veces === 1);
chipFuente(0)?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
console.log('«Todas» las devuelve:', palette.querySelectorAll('.imgsearch-card').length);
[...palette.querySelectorAll('.imgsearch-card')][0]
  ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await flush();
console.log('al elegir una imagen:', called.includes('handleDroppedFile') ? 'va al monitor de captura' : 'NO LLEGA al monitor',
  '· paleta cerrada:', palette.classList.contains('hidden'));
key(' ');
key('Escape');
console.log('Escape cierra el buscador:', palette.classList.contains('hidden'),
  '· sin tocar la seleccion de escena:', settings.get('scene.selected') === '');

// 6 · Barra de estado y monitor.
sb.setCapture('camara en directo', 'ok');
sb.setConfidence(0.82);
for (const cb of frameCbs) cb(1 / 60);
ui.setMocapFps(28.6);
ui.setStatus('Prueba', 'ok');
console.log('lectura del visor:', document.getElementById('viewport-readout').textContent.replace(/\s+/g, ' ').trim());
// El texto de estado ya no vive en una barra de titulo: `ui.setStatus` tiene que
// acabar en la lectura del borde inferior (antes lanzaba «no es una funcion»).
const chip = document.querySelector('#viewport-readout .status-item.status-text');
console.log('estado:', JSON.stringify(chip?.textContent), '· clase:', chip?.className);
ui.setStatus('Fallo simulado', 'err');
console.log('estado con error:', JSON.stringify(chip?.textContent), '· clase:', chip?.className);
console.log('fps del monitor:', document.getElementById('mocap-fps').textContent);

// 6b · El monitor se redimensiona desde las esquinas y guarda el tamano.
const hud = document.getElementById('mocap-hud');
const grips = hud.querySelectorAll('.mocap-grip');
// jsdom no hace layout: la caja del monitor se simula para que la aritmetica
// del arrastre tenga de donde partir.
const fakeBox = { left: 20, top: 40, width: 268, height: 240, right: 288, bottom: 280 };
hud.getBoundingClientRect = () => fakeBox;
document.getElementById('viewport').getBoundingClientRect = () => ({ left: 0, top: 0, width: 900, height: 600 });
const se = hud.querySelector('.mocap-grip.se');
const pev = (type, x, y) => new window.PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1 });
se.dispatchEvent(pev('pointerdown', 288, 280));
se.dispatchEvent(pev('pointermove', 388, 360));
// Al soltar se lee la caja real: se simula la que deberia haber quedado.
fakeBox.width = 368; fakeBox.height = 320;
se.dispatchEvent(pev('pointerup', 388, 360));
console.log('esquinas del monitor:', grips.length,
  '· ancho guardado:', settings.get('mocap.hudW'),
  '· alto guardado:', settings.get('mocap.hudH'),
  '· estilo:', hud.style.getPropertyValue('--mocap-w'), hud.style.height);
// Doble clic en una esquina: de vuelta al tamano por defecto.
se.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
console.log('tras el doble clic:', settings.get('mocap.hudW'), '/', settings.get('mocap.hudH'),
  '· con alto fijo:', hud.classList.contains('is-sized'));

// 6b-bis · Arrastre del monitor. Al pulsar la cabecera se fijan ya `left`/`top`:
// antes solo se soltaban `right`/`bottom` y la caja se iba de un salto a la
// esquina de arriba a la izquierda si no se movia (o al doble clic que repliega).
// El movimiento se escribe una vez por cuadro y se recorta al visor.
const cabecera = document.getElementById('mocap-hud-drag');
const cuadro = () => new Promise((r) => requestAnimationFrame(r));
Object.assign(fakeBox, { left: 620, top: 300, width: 268, height: 240 });
cabecera.dispatchEvent(pev('pointerdown', 700, 310));
console.log('al pulsar la cabecera:', hud.style.left, '/', hud.style.top,
  '· sin salto:', hud.style.left === '620px' && hud.style.top === '300px',
  '· anclaje suelto:', hud.style.right === 'auto' && hud.style.bottom === 'auto',
  '· arrastrando:', hud.classList.contains('is-dragging'));
cabecera.dispatchEvent(pev('pointermove', 660, 340));
await cuadro();
console.log('tras arrastrar 40 a la izquierda y 30 abajo:', hud.style.left, '/', hud.style.top);
// Fuera del visor: se queda pegado al borde (900x600 menos la caja).
cabecera.dispatchEvent(pev('pointermove', 5000, 5000));
await cuadro();
console.log('recortado al visor:', hud.style.left, '/', hud.style.top);
cabecera.dispatchEvent(pev('pointerup', 5000, 5000));
// Suelto: los avisos que lleguen despues ya no lo mueven.
cabecera.dispatchEvent(pev('pointermove', 100, 100));
await cuadro();
console.log('tras soltar:', hud.style.left, '/', hud.style.top,
  '· sin la marca de arrastre:', !hud.classList.contains('is-dragging'));

// 6c · Pulsar un punto detectado pide el control correspondiente.
const overlayCanvas = document.getElementById('mocap-overlay');
app.overlay = { pick: (x) => (x > 100 ? 13 : -1), clear: () => {} };
overlayCanvas.dispatchEvent(pev('pointermove', 200, 100));
const conCursor = overlayCanvas.classList.contains('is-over-point');
overlayCanvas.dispatchEvent(pev('pointerdown', 200, 100));
overlayCanvas.dispatchEvent(pev('pointerdown', 10, 10));
console.log('cursor sobre un punto:', conCursor,
  '· controles pedidos:', called.filter((n) => n === 'selectJointFromCapture').length);

// 7 · Distintivo del visor y barra de herramientas. La barra ya no lleva el logo
// de ATOM ni el interruptor de espejo, que vive en el panel de Captura.
console.log('distintivo:', document.getElementById('viewport-badge').textContent.replace(/\s+/g, ' ').trim());
console.log('botones de la barra del visor:', document.querySelectorAll('#viewport-toolbar .icon-btn').length,
  '· sin logo:', !document.querySelector('#viewport-toolbar .toolbar-brand'),
  '· sin espejo:', ![...document.querySelectorAll('#viewport-toolbar [title]')].some((b) => /espejo/i.test(b.title)),
  '· espejo en el panel:', [...document.querySelectorAll('#sidebar-host label')].some((l) => /espejo/i.test(l.textContent)));

// 7b · La barra del visor es una columna de herramientas y, al lado, la de las
// opciones de la elegida: un solo lapiz, y elegirlo ya activa el dibujo.
const fallos7 = [];
const revisa = (que, cond, extra = '') => {
  if (!cond) fallos7.push(que + (extra ? ' :: ' + extra : ''));
  console.log((cond ? 'OK   ' : 'FALLA') + ' ' + que + (extra ? '  (' + extra + ')' : ''));
};
{
  const bar = document.getElementById('viewport-toolbar');
  const opts = document.getElementById('viewport-options');
  const herramientas = [...bar.querySelectorAll('[data-tool]')];
  const visibles = () => [...opts.querySelectorAll('.toolbar-options:not(.hidden) .icon-btn')];
  const elige = (id) => bar.querySelector('[data-tool="' + id + '"]')
    ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  revisa('la barra trae una columna de herramientas', herramientas.length >= 8,
    herramientas.map((b) => b.dataset.tool).join(', '));
  revisa('con un solo lapiz',
    [...bar.querySelectorAll('[title]')].filter((b) => /lapiz/i.test(b.title)).length === 1);
  revisa('y cada herramienta tiene su columna de opciones',
    opts.querySelectorAll('.toolbar-options').length === herramientas.length,
    opts.querySelectorAll('.toolbar-options').length + ' columnas');
  revisa('solo se ve la de la elegida', opts.querySelectorAll('.toolbar-options:not(.hidden)').length === 1);

  elige('draw');
  revisa('elegir el lapiz ya activa el dibujo', settings.get('draw.enabled') === true
    && settings.get('ui.tool') === 'draw');
  revisa('y sus opciones son las del lapiz', visibles().some((b) => /borrador/i.test(b.title)),
    visibles().length + ' botones');

  elige('guides');
  revisa('mirar las guias no suelta el lapiz', settings.get('draw.enabled') === true
    && settings.get('ui.tool') === 'guides');
  revisa('el lapiz sigue marcado como modo en marcha',
    bar.querySelector('[data-tool="draw"]').classList.contains('is-mode')
    && bar.querySelector('[data-tool="guides"]').classList.contains('is-active'));
  revisa('y ahora se ven las opciones de guias',
    visibles().some((b) => /ritmo/i.test(b.title)), visibles().length + ' botones');

  elige('pose');
  revisa('posar a mano apaga el lapiz', settings.get('ui.manualPosing') === true
    && settings.get('draw.enabled') === false);

  key('d');
  revisa('la tecla D vuelve al lapiz y trae sus opciones',
    settings.get('draw.enabled') === true && settings.get('ui.manualPosing') === false
    && settings.get('ui.tool') === 'draw');
  key('Escape');
  revisa('Escape lo apaga y vuelve a la herramienta de seleccion',
    settings.get('draw.enabled') === false && settings.get('ui.tool') === 'select');
}

toast('mensaje de prueba', 'ok');
console.log('avisos:', document.querySelectorAll('#toasts > *').length);
// 8 · El panel del elemento seleccionado se construye para TODOS los tipos.
// El grupo "Elemento seleccionado" solo se arma cuando hay algo elegido, asi que
// sin este recorrido un fallo ahi (una importacion que falta, un rango sin
// definir) no aparece hasta que el usuario pincha un objeto en el visor.
const { PRIMITIVES } = await import('../src/scene/primitives.js');
const { LIGHT_TYPES, lightDefaults } = await import('../src/scene/lights.js');
const { materialDefaults } = await import('../src/model/MaterialLibrary.js');

const objDefs = PRIMITIVES.map((p, i) => ({
  id: 'o' + i, type: p.id, name: p.label, visible: true,
  position: vec(0, 0.4, 0), rotation: vec(), scale: vec(1, 1, 1),
  params: { ...p.p }, material: materialDefaults('yeso'),
  castShadow: true, receiveShadow: true,
}));
const luzDefs = LIGHT_TYPES.map((l, i) => ({
  id: 'l' + i, type: l.id, name: l.label, visible: true,
  position: vec(0, 1.9, 0), ...lightDefaults(l.id),
}));

// Un editor de escena simulado que lee de los ajustes, como el de verdad. Las
// figuras van primero en la lista, igual que en SceneEditor.
app.scene = {
  locate(id) {
    let i = (settings.get('scene.objects') ?? []).findIndex((d) => d.id === id);
    if (i >= 0) return { branch: 'objects', index: i, def: settings.get('scene.objects')[i] };
    i = (settings.get('scene.lights') ?? []).findIndex((d) => d.id === id);
    if (i >= 0) return { branch: 'lights', index: i, def: settings.get('scene.lights')[i] };
    return app.figures.locate(id);
  },
  list: () => [
    ...app.figures.list(),
    ...(settings.get('scene.objects') ?? []).map((d) => ({ id: d.id, label: d.name, icon: 'box', kind: 'objeto' })),
    ...(settings.get('scene.lights') ?? []).map((d) => ({ id: d.id, label: d.name, icon: 'lightbulb', kind: 'luz' })),
  ],
};
settings.set('scene.objects', objDefs);
settings.set('scene.lights', luzDefs);

// group() no marca su id en el DOM, asi que la seccion se busca por su titulo.
const grupoPorTitulo = (titulo) => [...document.querySelectorAll('#sidebar-host .group-head')]
  .find((h) => h.textContent.includes(titulo))?.parentElement
  ?.querySelector('.group-body') ?? null;
const cuerpo = grupoPorTitulo('Elemento seleccionado');
if (!cuerpo) console.log('AVISO: no se encontro el grupo del elemento seleccionado');
const cuenta = (id) => {
  settings.set('scene.selected', id);
  return {
    controles: cuerpo?.querySelectorAll('input, select, button').length ?? 0,
    rangos: cuerpo?.querySelectorAll('input[type="range"]').length ?? 0,
  };
};

let minimo = Infinity, fallos = 0;
for (const d of [...figDefs, ...objDefs, ...luzDefs]) {
  const { controles, rangos } = cuenta(d.id);
  // Todo elemento trae al menos nombre, visibilidad, posicion (3 rangos) y los
  // dos botones del pie; si sale por debajo de eso, algo no se ha pintado.
  if (controles < 6 || rangos < 3) { console.log('  POCO: ' + (d.type ?? d.name) + ' -> ' + controles + ' controles, ' + rangos + ' rangos'); fallos++; }
  minimo = Math.min(minimo, controles);
}
console.log('tipos de elemento revisados:', figDefs.length + objDefs.length + luzDefs.length,
  '· minimo de controles:', minimo, '·', fallos === 0 ? 'todos pintan' : fallos + ' incompletos');

// La figura seleccionada que no es la activa ofrece pasarle la captura.
settings.set('scene.selected', 'f1');
const botones = [...(cuerpo?.querySelectorAll('button') ?? [])].map((b) => b.textContent.trim());
console.log('figura no activa:', botones.some((t) => t.includes('Posar con la camara')) ? 'ofrece posar con la camara' : 'FALTA el boton de posar');
settings.set('scene.selected', 'f0');
console.log('figura activa:', [...(cuerpo?.querySelectorAll('button') ?? [])]
  .some((b) => b.textContent.includes('Posar con la camara')) ? 'SOBRA el boton de posar' : 'sin boton redundante');

// El grupo "Colocacion" del panel de Figura edita la figura activa.
const coloc = grupoPorTitulo('Colocacion');
const rangosColoc = coloc?.querySelectorAll('input[type="range"]').length ?? 0;
settings.set('scene.figures.0.height', 1.9);
settings.set('scene.figures.0.position.x', 0.5);
console.log('colocacion de la activa:', rangosColoc, 'rangos · altura:', settings.get('scene.figures.0.height'),
  '· lista de figuras:', grupoPorTitulo('Figuras en la escena')?.querySelectorAll('.list-row').length, 'filas');

// La seleccion vacia vuelve al aviso, sin dejar controles colgando.
settings.set('scene.selected', '');
console.log('sin seleccion:', (cuerpo?.querySelectorAll('input').length ?? -1) === 0 ? 'solo el aviso' : 'quedan controles');
console.log('lista de escena:', grupoPorTitulo('Elementos de la escena')?.querySelectorAll('.list-row').length, 'filas');


// 8b · El grupo de cinematica inversa: sus interruptores escriben la ruta que
// dicen y el resto queda inerte mientras la cinematica inversa esta apagada.
{
  settings.set('ik.enabled', false);
  const ik = grupoPorTitulo('Cinematica inversa');
  const boton = (texto) => [...(ik?.querySelectorAll('button') ?? [])]
    .find((b) => b.textContent.includes(texto));
  const pulsa = (b) => b?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  revisa('el panel de poses trae el grupo de cinematica inversa', !!ik);
  revisa('apagada, sus controles quedan inertes',
    (ik?.querySelectorAll('.stack.is-disabled').length ?? 0) === 1);
  settings.set('ik.enabled', true);
  revisa('encendida, se pueden tocar',
    (ik?.querySelectorAll('.stack.is-disabled').length ?? 0) === 0);
  pulsa(boton('Mano izq.'));
  revisa('el boton de la mano izquierda clava su cadena', settings.get('ik.pins.leftArm') === true);
  pulsa(boton('Mano izq.'));
  revisa('y vuelve a soltarla', settings.get('ik.pins.leftArm') === false);
  pulsa(boton('Brazos'));
  revisa('el interruptor de brazos apaga su grupo', settings.get('ik.arms') === false);
  pulsa(boton('Brazos'));
  revisa('apagar los brazos inhabilita sus fijaciones',
    (() => {
      settings.set('ik.arms', false);
      const inerte = boton('Mano izq.')?.classList.contains('is-disabled') === true
        && boton('Pie izq.')?.classList.contains('is-disabled') === false;
      settings.set('ik.arms', true);
      return inerte;
    })());
  const rango = ik?.querySelector('input[type="range"]');
  revisa('la holgura tiene su deslizador', rango?.getAttribute('max') === '0.15');
  settings.set('ik.enabled', false);
}

// 9 · La firma del autor sale en Ayuda > Acerca de.
const firma = document.querySelector('#sidebar-host .credit');
console.log('firma:', firma ? firma.textContent.replace(/s+/g, ' ').trim() : 'NO APARECE',
  '· icono:', firma?.querySelectorAll('svg.svg-icon').length ?? 0);

console.log(errors.length ? 'ERRORES: ' + errors.join(' | ') : 'sin errores en el DOM');
if (fallos7.length) {
  console.log('FALLOS: ' + fallos7.join(' | '));
  process.exit(1);
}
