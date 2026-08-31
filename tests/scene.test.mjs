/**
 * Prueba de la seleccion en el visor.
 * Comprueba que pinchar un solido o una luz en la vista 3D los selecciona (sin
 * pasar por la lista de escena), que el contorno de aviso aparece al pasar por
 * encima y que otro modulo puede quedarse el clic cuando le toca.
 */
import { JSDOM } from 'jsdom';
import * as THREE from 'three';

const dom = new JSDOM('<!doctype html><html><body><div id="v"></div></body></html>',
  { pretendToBeVisual: true });
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node',
  'requestAnimationFrame', 'cancelAnimationFrame', 'PointerEvent', 'MouseEvent',
  'WheelEvent', 'KeyboardEvent', 'getComputedStyle', 'DOMRect']) {
  try {
    Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
  } catch { /* algunos son de solo lectura y ya sirven */ }
}
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const fails = [];
const oks = [];
const check = (name, cond, extra) => {
  (cond ? oks : fails).push(name);
  console.log((cond ? 'OK   ' : 'FALLA') + ' ' + name + (extra ? '  (' + extra + ')' : ''));
};

const { Settings } = await import('../src/core/Settings.js');
const { DEFAULTS } = await import('../src/config.js');
const { CameraRig } = await import('../src/core/CameraRig.js');
const { SceneEditor } = await import('../src/scene/SceneEditor.js');

const W = 800;
const H = 600;
const settings = new Settings(DEFAULTS, null);

// ------------------------------------------------------------ visor falso ---
const canvas = dom.window.document.createElement('canvas');
canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: W, bottom: H, width: W, height: H, x: 0, y: 0 });
// jsdom no implementa la captura de puntero, que si usan los controles.
canvas.setPointerCapture = () => {};
canvas.releasePointerCapture = () => {};
canvas.hasPointerCapture = () => false;
dom.window.document.body.appendChild(canvas);

const scene = new THREE.Scene();
const rig = new CameraRig(settings, canvas);
rig.setAspect(W / H);
rig.controls.target.set(0, 0, 0);
rig.active.position.set(0, 0, 4);
rig.active.lookAt(0, 0, 0);
rig.active.updateMatrixWorld(true);

let sombras = 0;
const viewport = {
  cameras: rig,
  renderer: { domElement: canvas },
  add: (...o) => scene.add(...o),
  remove: (...o) => scene.remove(...o),
  onFrame: () => () => {},
  invalidateShadows: () => { sombras++; },
};

let bloqueado = false;
let elegidos = [];
const editor = new SceneEditor({
  settings,
  viewport,
  blocked: () => bloqueado,
  onPick: (id) => elegidos.push(id),
});

/** Devuelve la camara a su sitio: los clics simulados tambien orbitan. */
function apunta() {
  rig.controls.target.set(0, 0, 0);
  rig.active.position.set(0, 0, 4);
  rig.active.lookAt(0, 0, 0);
  rig.active.updateMatrixWorld(true);
  scene.updateMatrixWorld(true);
}

/** Lanza un evento de puntero sobre el lienzo, en pixeles de pantalla. */
function puntero(tipo, x, y) {
  apunta();
  canvas.dispatchEvent(new dom.window.MouseEvent(tipo, {
    clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true,
  }));
}

/** Clic completo: sin soltar, los controles de orbita siguen arrastrando. */
function clic(x, y) {
  puntero('pointerdown', x, y);
  puntero('pointerup', x, y);
}
const centro = () => [W / 2, H / 2];

/** Deja el elemento en el origen, delante de la camara. */
function alOrigen(branch, index) {
  settings.batch({
    [`scene.${branch}.${index}.position.x`]: 0,
    [`scene.${branch}.${index}.position.y`]: 0,
    [`scene.${branch}.${index}.position.z`]: 0,
  });
}

// ------------------------------------------------------------------ solido ---
const cubo = editor.addObject('cubo');
alOrigen('objects', 0);
settings.set('scene.selected', '');

puntero('pointermove', ...centro());
check('el contorno avisa de que hay algo seleccionable debajo',
  editor.hovered === cubo && editor.outline.visible === true, editor.hovered || '(nada)');
check('el cursor cambia sobre un elemento', canvas.style.cursor === 'pointer', canvas.style.cursor || '(sin cursor)');

clic(...centro());
check('pinchar en el visor selecciona el solido',
  settings.get('scene.selected') === cubo, settings.get('scene.selected') || '(nada)');
check('la interfaz recibe el aviso para abrir el panel',
  elegidos.length === 1 && elegidos[0] === cubo, elegidos.join(','));
check('el contorno se retira: manda el gizmo', editor.outline.visible === false);

// Sobre lo ya seleccionado no se repite el contorno.
puntero('pointermove', ...centro());
check('lo seleccionado no lleva contorno de aviso',
  editor.hovered === '' && editor.outline.visible === false, editor.hovered || '(nada)');

// ------------------------------------------------------------------- vacio ---
puntero('pointermove', 6, 6);
clic(6, 6);
check('pinchar en el vacio deselecciona',
  settings.get('scene.selected') === '', settings.get('scene.selected') || '(nada)');
check('el vacio no avisa a la interfaz', elegidos.length === 1, String(elegidos.length));
check('el cursor vuelve a la normalidad', canvas.style.cursor === '', canvas.style.cursor || '(sin cursor)');

// ------------------------------------------------------- clic de otro modulo ---
bloqueado = true;
puntero('pointermove', ...centro());
check('bloqueado: no se pinta contorno', editor.hovered === '' && editor.outline.visible === false);
clic(...centro());
check('bloqueado: el clic no selecciona',
  settings.get('scene.selected') === '', settings.get('scene.selected') || '(nada)');
bloqueado = false;

// -------------------------------------------------------------------- luz ---
editor.clearAll();
elegidos = [];
const luz = editor.addLight('punto');
alOrigen('lights', 0);
settings.set('scene.selected', '');
clic(...centro());
check('el cuerpo de la luz tambien se puede pinchar',
  settings.get('scene.selected') === luz, settings.get('scene.selected') || '(nada)');

settings.set('scene.helpers', false);
settings.set('scene.selected', '');
clic(...centro());
check('con los ayudantes apagados la luz no estorba al raton',
  settings.get('scene.selected') === '', settings.get('scene.selected') || '(nada)');
settings.set('scene.helpers', true);

// -------------------------------------------------------- elemento borrado ---
settings.set('scene.selected', '');
puntero('pointermove', ...centro());
check('la luz vuelve a marcarse al pasar por encima', editor.hovered === luz, editor.hovered || '(nada)');
editor.clearAll();
check('al borrar el elemento el contorno desaparece',
  editor.hovered === '' && editor.outline.visible === false, editor.hovered || '(nada)');

console.log('\n' + oks.length + ' correctas / ' + fails.length + ' fallos');
if (fails.length) {
  console.log('FALLOS:\n - ' + fails.join('\n - '));
  process.exit(1);
}
