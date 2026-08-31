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

// ---------------------------------------------------------- figuras falsas ---
// `FigureSet` simulado: el editor solo le pide la lista, el `root` del
// personaje y a quien pasar la captura. El personaje es una caja del tamano de
// una persona, que es justo lo que se apunta con el raton.
const figRoot = new THREE.Object3D();
figRoot.name = 'Figura 1';
figRoot.add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.7, 0.35)));
const personaje = { loaded: true, root: figRoot };
const figures = {
  bajas: [],
  copias: [],
  get defs() { return settings.get('scene.figures') ?? []; },
  get activeId() { return settings.get('figure.active') ?? ''; },
  locate(id) {
    const i = this.defs.findIndex((d) => d.id === id);
    return i < 0 ? null : { branch: 'figures', index: i, def: this.defs[i] };
  },
  get(id) { return this.locate(id) ? personaje : null; },
  list() { return this.defs.map((d) => ({ id: d.id, label: d.name, icon: 'user', kind: 'figura' })); },
  setActive(id) { if (this.locate(id)) settings.set('figure.active', id); },
  remove(id) { this.bajas.push(id); },
  duplicate(id) { this.copias.push(id); return 'copia'; },
};

const editor = new SceneEditor({
  settings,
  viewport,
  figures,
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

// ---------------------------------------------------------------- figuras ---
// Una figura se selecciona y se recoloca como cualquier otro elemento, pero es
// de FigureSet: el editor le presta el gizmo y le pasa la captura, sin crearla
// ni destruirla.
elegidos = [];
viewport.add(figRoot);
settings.batch({
  'scene.figures': [{
    id: 'fig1', name: 'Figura 1', model: 'character', visible: true,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    height: 1.75, anchor: 'suelo', pose: null,
  }],
  'figure.active': 'fig1',
  'scene.selected': '',
});
check('la figura entra en el editor sin construirla', editor.items.get('fig1')?.object === figRoot);

// Se apunta por su caja envolvente: la anatomia no se raycastea en cada movida.
puntero('pointermove', ...centro());
check('la figura se marca al pasar por encima', editor.hovered === 'fig1', editor.hovered || '(nada)');

settings.set('figure.active', '');
clic(...centro());
check('pinchar la caja de una figura la selecciona',
  settings.get('scene.selected') === 'fig1', settings.get('scene.selected') || '(nada)');
check('y de paso la hace la figura que posa',
  settings.get('figure.active') === 'fig1', settings.get('figure.active') || '(ninguna)');
check('la interfaz recibe el aviso, como con un solido',
  elegidos.length === 1 && elegidos[0] === 'fig1', elegidos.join(','));

// La altura tiene su propio deslizador: escalar el root deformaria la figura.
settings.set('scene.tool', 'scale');
check('con una figura seleccionada el gizmo no ofrece escala',
  editor.gizmo.mode === 'translate', editor.gizmo.mode);
settings.set('scene.tool', 'rotate');
check('girar si se puede', editor.gizmo.mode === 'rotate', editor.gizmo.mode);
settings.set('scene.tool', 'translate');

// Arrastre del gizmo: al soltar, el Object3D manda y el almacen se pone al dia.
figRoot.position.set(0.42, 0, -0.75);
figRoot.rotation.set(0, 45 * Math.PI / 180, 0);
editor.gizmo.dispatchEvent({ type: 'dragging-changed', value: true });
editor.gizmo.dispatchEvent({ type: 'dragging-changed', value: false });
check('al soltar el gizmo se escribe la posicion de la figura',
  settings.get('scene.figures.0.position.x') === 0.42
  && settings.get('scene.figures.0.position.z') === -0.75,
  settings.get('scene.figures.0.position.x') + ' / ' + settings.get('scene.figures.0.position.z'));
check('y el giro en grados', Math.abs(settings.get('scene.figures.0.rotation.y') - 45) < 0.2,
  String(settings.get('scene.figures.0.rotation.y')));
check('la figura nunca guarda escala',
  settings.get('scene.figures.0.scale') === undefined, JSON.stringify(settings.get('scene.figures.0.scale')));

// La figura activa es pegajosa: el gizmo salta al cubo, la captura no.
figRoot.position.set(-1.8, 0, 0);
const cubo2 = editor.addObject('cubo');
alOrigen('objects', 0);
settings.set('scene.selected', '');
clic(...centro());
check('pinchar un solido despues no cambia la figura que posa',
  settings.get('scene.selected') === cubo2 && settings.get('figure.active') === 'fig1',
  settings.get('scene.selected') + ' · activa=' + settings.get('figure.active'));
settings.set('scene.tool', 'scale');
check('un solido si se escala', editor.gizmo.mode === 'scale', editor.gizmo.mode);
settings.set('scene.tool', 'translate');

// Alta, baja y copia de figuras son de FigureSet; el editor solo delega.
editor.remove('fig1');
editor.duplicate('fig1');
check('borrar y duplicar una figura se delegan en FigureSet',
  figures.bajas.join() === 'fig1' && figures.copias.join() === 'fig1',
  'bajas=' + figures.bajas.join() + ' copias=' + figures.copias.join());
check('la figura sigue en el almacen: la baja la hace FigureSet',
  (settings.get('scene.figures') ?? []).length === 1);
editor.clearAll();
check('vaciar la escena no se lleva las figuras',
  editor.items.has('fig1') && (settings.get('scene.figures') ?? []).length === 1,
  editor.items.size + ' elementos');

console.log('\n' + oks.length + ' correctas / ' + fails.length + ' fallos');
if (fails.length) {
  console.log('FALLOS:\n - ' + fails.join('\n - '));
  process.exit(1);
}
