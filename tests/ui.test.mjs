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
console.log(errors.length ? 'ERRORES: ' + errors.join(' | ') : 'sin errores en el DOM');
