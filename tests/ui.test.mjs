/**
 * Prueba de humo de la capa de interfaz: monta index.html en jsdom y construye
 * UI + StatusBar con modulos simulados. No hay WebGL en jsdom, asi que el visor
 * real no participa; lo que se comprueba es el cableado del DOM.
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
const { StatusBar } = await import('../src/ui/StatusBar.js');
const { initToasts, toast } = await import('../src/ui/Toast.js');

const settings = new Settings(DEFAULTS, STORAGE_KEY);
initToasts(document.getElementById('toasts'));

const called = [];
const act = (name) => (...a) => { called.push(name); return true; };
const frameCbs = new Set();
const app = {
  settings,
  viewport: { stats: { fps: 60, ms: 4.2, triangles: 120000, calls: 12 }, onFrame: (cb) => (frameCbs.add(cb), () => frameCbs.delete(cb)) },
  source: { listDevices: async () => [{ id: 'abc', label: 'Camara falsa' }] },
  library: { list: () => [{ id: 'p1', name: 'Pose de prueba', created: Date.now() }] },
  hooks: {},
  actions: new Proxy({}, { get: (_, name) => act(name) }),
};
const ui = new UI(app);
app.ui = ui;
const sb = new StatusBar(document.getElementById('statusbar'), app);

// 1 · Todas las secciones existen y solo una esta visible.
const panels = [...document.querySelectorAll('#sidebar-host .panel')];
const visibles = panels.filter((p) => !p.classList.contains('hidden'));
console.log('paneles:', panels.map((p) => p.dataset.panel).join(', '));
console.log('visibles:', visibles.length, '· seccion:', document.getElementById('sidebar-title').textContent);

// 2 · Los iconos se han hidratado (no queda ningun data-icon suelto).
console.log('data-icon sin hidratar:', document.querySelectorAll('[data-icon]').length);
console.log('svg de iconos:', document.querySelectorAll('svg.svg-icon').length);

// 3 · Cada boton de la barra de actividad cambia de seccion.
for (const btn of document.querySelectorAll('.activity-item')) {
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}
console.log('seccion final:', settings.get('ui.section'), '· panel lateral:', settings.get('ui.sidebar'));

// 4 · Los controles enlazados escriben en el almacen.
const range = document.querySelector('#sidebar-host input[type="range"]');
range.value = String(Number(range.max));
range.dispatchEvent(new window.Event('input', { bubbles: true }));
const check = document.querySelector('#sidebar-host input[type="checkbox"]');
check.click();

// 5 · Atajos de teclado.
const key = (k, opts = {}) => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, ...opts }));
key('2'); key('o'); key(' '); key('g'); key('h'); key('f'); key('b'); key('z', { ctrlKey: true });
console.log('variante:', settings.get('figure.variant'), '· proyeccion:', settings.get('camera.projection'),
  '· congelada:', settings.get('mocap.frozen'), '· pose manual:', settings.get('ui.manualPosing'));
console.log('acciones invocadas:', [...new Set(called)].join(', '));

// 6 · Barra de estado y monitor.
sb.setCapture('camara en directo', 'ok');
sb.setConfidence(0.82);
for (const cb of frameCbs) cb(1 / 60);
ui.setMocapFps(28.6);
ui.setStatus('Prueba', 'ok');
console.log('barra de estado:', document.getElementById('statusbar').textContent.replace(/\s+/g, ' ').trim());
console.log('fps del monitor:', document.getElementById('mocap-fps').textContent);

// 7 · Distintivo del visor y barra de herramientas.
console.log('distintivo:', document.getElementById('viewport-badge').textContent.replace(/\s+/g, ' ').trim());
console.log('botones de la barra del visor:', document.querySelectorAll('#viewport-toolbar .icon-btn').length);

toast('mensaje de prueba', 'ok');
console.log('avisos:', document.querySelectorAll('#toasts > *').length);
// 8 · El panel del elemento seleccionado se construye para TODOS los tipos.
// El grupo "Elemento seleccionado" solo se arma cuando hay algo elegido, asi que
// sin este recorrido un fallo ahi (una importacion que falta, un rango sin
// definir) no aparece hasta que el usuario pincha un objeto en el visor.
const { PRIMITIVES } = await import('../src/scene/primitives.js');
const { LIGHT_TYPES, lightDefaults } = await import('../src/scene/lights.js');
const { materialDefaults } = await import('../src/model/MaterialLibrary.js');

const vec = (x = 0, y = 0, z = 0) => ({ x, y, z });
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

// Un editor de escena simulado que lee de los ajustes, como el de verdad.
app.scene = {
  locate(id) {
    let i = (settings.get('scene.objects') ?? []).findIndex((d) => d.id === id);
    if (i >= 0) return { branch: 'objects', index: i, def: settings.get('scene.objects')[i] };
    i = (settings.get('scene.lights') ?? []).findIndex((d) => d.id === id);
    if (i >= 0) return { branch: 'lights', index: i, def: settings.get('scene.lights')[i] };
    return null;
  },
  list: () => [
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
for (const d of [...objDefs, ...luzDefs]) {
  const { controles, rangos } = cuenta(d.id);
  // Todo elemento trae al menos nombre, visibilidad, posicion (3 rangos) y los
  // dos botones del pie; si sale por debajo de eso, algo no se ha pintado.
  if (controles < 6 || rangos < 3) { console.log('  POCO: ' + d.type + ' -> ' + controles + ' controles, ' + rangos + ' rangos'); fallos++; }
  minimo = Math.min(minimo, controles);
}
console.log('tipos de elemento revisados:', objDefs.length + luzDefs.length,
  '· minimo de controles:', minimo, '·', fallos === 0 ? 'todos pintan' : fallos + ' incompletos');

// La seleccion vacia vuelve al aviso, sin dejar controles colgando.
settings.set('scene.selected', '');
console.log('sin seleccion:', (cuerpo?.querySelectorAll('input').length ?? -1) === 0 ? 'solo el aviso' : 'quedan controles');
console.log('lista de escena:', grupoPorTitulo('Elementos de la escena')?.querySelectorAll('.list-row').length, 'filas');


// 9 · La firma del autor sale en Ayuda > Acerca de.
const firma = document.querySelector('#sidebar-host .credit');
console.log('firma:', firma ? firma.textContent.replace(/s+/g, ' ').trim() : 'NO APARECE',
  '· icono:', firma?.querySelectorAll('svg.svg-icon').length ?? 0);

console.log(errors.length ? 'ERRORES: ' + errors.join(' | ') : 'sin errores en el DOM');
