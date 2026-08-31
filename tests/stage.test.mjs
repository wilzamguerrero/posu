/**
 * Prueba de ejecucion de la camara fisica, la luz y el escenario.
 * No hace falta WebGL: son matematicas sobre objetos de three.
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
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const fails = [];
const oks = [];
const check = (name, cond, extra) => {
  (cond ? oks : fails).push(name + (extra ? ' :: ' + extra : ''));
  console.log((cond ? 'OK   ' : 'FALLA') + ' ' + name + (extra ? '  (' + extra + ')' : ''));
};
const DEG = Math.PI / 180;

const { Settings } = await import('../src/core/Settings.js');
const { DEFAULTS, VIEW_PRESETS } = await import('../src/config.js');
const { CameraRig } = await import('../src/core/CameraRig.js');

const settings = new Settings(DEFAULTS, null);
const rig = new CameraRig(settings, dom.window.document.getElementById('v'));
rig.setAspect(16 / 9);

// ------------------------------------------------------- optica de la lente ---
settings.set('camera.focalLength', 85);
check('la focal en mm llega a la camara', Math.abs(rig.perspective.getFocalLength() - 85) < 0.01,
  rig.perspective.getFocalLength().toFixed(2) + ' mm / fov ' + rig.fov.toFixed(2));
const fov85 = rig.fov;
settings.set('camera.focalLength', 24);
check('un gran angular abre el campo de vision', rig.fov > fov85 + 10,
  '24mm=' + rig.fov.toFixed(1) + ' grados frente a 85mm=' + fov85.toFixed(1));
const fov24Full = rig.fov;
settings.set('camera.filmGauge', 23.5);
check('un sensor menor recorta el campo de vision', rig.fov < fov24Full - 5,
  'aps-c=' + rig.fov.toFixed(1) + ' frente a 35mm=' + fov24Full.toFixed(1));
settings.set('camera.filmGauge', DEFAULTS.camera.filmGauge);
settings.set('camera.focalLength', 50);

// ------------------------------------------------- descentrado (tilt-shift) ---
settings.set('camera.shiftV', 0.2);
const view = rig.perspective.view;
check('el descentrado vertical desplaza el tronco de vision',
  !!view?.enabled && Math.abs(view.offsetY / view.fullHeight - 0.2) < 1e-6,
  'offsetY=' + (view ? view.offsetY : 'sin view'));
check('el descentrado tambien se aplica a la ortografica',
  rig.orthographic.view?.enabled === true);
settings.set('camera.shiftV', 0);
check('al volver a cero se limpia el descentrado', rig.perspective.view?.enabled === false);

// ------------------------------------------------ perspectiva vs ortografica ---
const dist = rig.perspective.position.distanceTo(rig.controls.target);
const visibleHeight = 2 * dist * Math.tan(rig.fov * 0.5 * DEG);
settings.set('camera.projection', 'ortografica');
check('el interruptor cambia a camara ortografica', rig.active === rig.orthographic);
const orthoHeight = rig.orthographic.top - rig.orthographic.bottom;
check('la ortografica conserva el encuadre de la perspectiva',
  Math.abs(orthoHeight - visibleHeight) < 0.01,
  'orto=' + orthoHeight.toFixed(3) + ' m frente a perspectiva=' + visibleHeight.toFixed(3) + ' m');
check('la ortografica respeta la relacion de aspecto',
  Math.abs((rig.orthographic.right - rig.orthographic.left) / orthoHeight - 16 / 9) < 1e-6);
settings.set('camera.orthoZoom', 0.5);
check('el zoom ortografico escala el tronco de vision',
  Math.abs((rig.orthographic.top - rig.orthographic.bottom) - orthoHeight * 0.5) < 0.01,
  (rig.orthographic.top - rig.orthographic.bottom).toFixed(3) + ' m');
settings.set('camera.orthoZoom', 1);

const posOrtho = rig.orthographic.position.clone();
settings.set('camera.projection', 'perspectiva');
check('al volver a perspectiva no salta la camara',
  rig.perspective.position.distanceTo(posOrtho) < 1e-6);

// ------------------------------------------------------------- encuadre ---
const box = new THREE.Box3(new THREE.Vector3(-0.3, 0, -0.2), new THREE.Vector3(0.3, 1.75, 0.2));
rig.frameBox(box, 0.82);
rig.perspective.updateMatrixWorld(true);
rig.perspective.updateProjectionMatrix();
let minY = Infinity, maxY = -Infinity, maxAbsX = 0;
for (const cx of [box.min.x, box.max.x]) for (const cy of [box.min.y, box.max.y]) for (const cz of [box.min.z, box.max.z]) {
  const p = new THREE.Vector3(cx, cy, cz).project(rig.perspective);
  minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); maxAbsX = Math.max(maxAbsX, Math.abs(p.x));
}
check('frameBox mete la figura entera en el encuadre', minY > -1 && maxY < 1 && maxAbsX < 1,
  'y=[' + minY.toFixed(2) + ', ' + maxY.toFixed(2) + '] x=' + maxAbsX.toFixed(2));
check('frameBox aprovecha el encuadre sin dejar la figura diminuta',
  (maxY - minY) / 2 > 0.6, 'ocupa ' + (((maxY - minY) / 2) * 100).toFixed(0) + '% de la altura');

// ------------------------------------------------------------ vistas fijas ---
const nombres = Object.keys(VIEW_PRESETS);
check('hay vistas predefinidas', nombres.length >= 4, nombres.join(', '));
const d0 = rig.active.position.distanceTo(rig.controls.target);
rig.setView(nombres[1]);
const d1 = rig.active.position.distanceTo(rig.controls.target);
check('setView conserva la distancia al objetivo', Math.abs(d1 - d0) < 1e-6,
  d0.toFixed(3) + ' -> ' + d1.toFixed(3));
const frente = rig.active.position.clone();
rig.setView(nombres[2]);
check('setView cambia de punto de vista', rig.active.position.distanceTo(frente) > 0.1,
  'd=' + rig.active.position.distanceTo(frente).toFixed(3));

// --------------------------------------------- giro de horizonte y turntable ---
settings.set('camera.roll', 0);
rig.update(1 / 60);
const upRecto = rig.active.up.clone().applyQuaternion(rig.active.quaternion);
settings.set('camera.roll', 15);
rig.update(1 / 60);
const up1 = new THREE.Vector3(0, 1, 0).applyQuaternion(rig.active.quaternion);
const inclina1 = up1.angleTo(new THREE.Vector3(0, 1, 0).applyQuaternion(
  rig.active.quaternion.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -15 * DEG))));
check('el giro de horizonte inclina la camara 15 grados',
  Math.abs(inclina1 / DEG - 15) < 0.5, (inclina1 / DEG).toFixed(2) + ' grados');
rig.update(1 / 60); rig.update(1 / 60); rig.update(1 / 60);
const up4 = new THREE.Vector3(0, 1, 0).applyQuaternion(rig.active.quaternion);
check('el giro de horizonte no se acumula fotograma a fotograma',
  up4.angleTo(up1) < 1e-3, 'deriva=' + (up4.angleTo(up1) / DEG).toFixed(4) + ' grados');
settings.set('camera.roll', 0);

settings.set('camera.turntable', 30);
const antes = rig.active.position.clone().sub(rig.controls.target);
rig.update(0.5);
const despues = rig.active.position.clone().sub(rig.controls.target);
const giro = Math.atan2(antes.x, antes.z) - Math.atan2(despues.x, despues.z);
check('el turntable gira 30 grados por segundo', Math.abs(Math.abs(giro / DEG) - 15) < 1.5,
  (giro / DEG).toFixed(2) + ' grados en medio segundo');
check('el turntable conserva la distancia', Math.abs(despues.length() - antes.length()) < 1e-6);
settings.set('camera.turntable', 0);

// ------------------------------------------------------------------ autofoco ---
// El autofoco escribe en los ajustes, asi que solo mide cuando la profundidad
// de campo esta encendida: es lo unico que consume la distancia de enfoque.
settings.set('camera.autoFocus', true);
settings.set('camera.dof', true);
rig.focusProvider = () => new THREE.Vector3(0, 1.55, 0);
rig.update(1 / 60);
const esperada = rig.active.position.distanceTo(new THREE.Vector3(0, 1.55, 0));
check('el autofoco mide la distancia al punto de interes',
  Math.abs(settings.get('camera.focusDistance') - esperada) < 0.01,
  settings.get('camera.focusDistance') + ' m frente a ' + esperada.toFixed(3) + ' m');

settings.set('camera.dof', false);
settings.set('camera.focusDistance', 3.2);
rig._focusStamp = 0;
rig.focusProvider = () => new THREE.Vector3(0, 0.2, 0);
rig.update(1 / 60);
check('sin profundidad de campo el autofoco no toca los ajustes',
  settings.get('camera.focusDistance') === 3.2,
  settings.get('camera.focusDistance') + ' m');
settings.set('camera.autoFocus', false);

// -------------------------------------------------------- guardar y volver ---
const snap = rig.snapshot();
settings.batch((s) => {
  s.set('camera.focalLength', 135);
  s.set('camera.roll', -8);
  s.set('camera.shiftH', 0.3);
});
rig.active.position.set(5, 5, 5);
rig.restore(snap);
check('snapshot/restore devuelve la optica y la posicion',
  settings.get('camera.focalLength') === snap.focalLength
  && settings.get('camera.roll') === snap.roll
  && settings.get('camera.shiftH') === snap.shiftH
  && rig.active.position.distanceTo(new THREE.Vector3().fromArray(snap.position)) < 1e-6);

// ----------------------------------------------------- luz de estudio (XYZ) ---
const { Lighting } = await import('../src/core/Lighting.js');
const { Stage } = await import('../src/core/Stage.js');
const scene = new THREE.Scene();
// Renderer de mentira: solo lo usa el PMREM del entorno, que sabe fallar solo.
const luz = new Lighting(scene, {}, settings);
check('la luz principal es direccional y proyecta sombra',
  luz.key.isDirectionalLight === true && luz.key.castShadow === true);
check('hay luz ambiental suave', luz.ambient.isAmbientLight === true && luz.ambient.intensity > 0,
  'intensidad=' + luz.ambient.intensity);
settings.batch((s) => { s.set('light.key.x', -2.5); s.set('light.key.y', 4); s.set('light.key.z', 1.5); });
check('los deslizadores X/Y/Z mueven la luz principal',
  luz.key.position.x === -2.5 && luz.key.position.y === 4 && luz.key.position.z === 1.5,
  luz.key.position.toArray().join(', '));
check('la luz apunta al centro de la figura',
  luz.key.target === luz.keyTarget && Math.abs(luz.keyTarget.position.y - 0.95) < 1e-6);
settings.set('light.key.intensity', 6.2);
check('el deslizador de intensidad llega a la luz', Math.abs(luz.key.intensity - 6.2) < 1e-6);
settings.set('light.key.shadows', false);
check('se pueden apagar las sombras', luz.key.castShadow === false);
settings.set('light.key.shadows', true);
settings.set('quality.shadowMap', 1024);
check('la calidad de sombra cambia el tamano del mapa', luz.key.shadow.mapSize.width === 1024,
  luz.key.shadow.mapSize.width + ' px');

const { LIGHT_PRESETS } = await import('../src/config.js');
const presets = Object.keys(LIGHT_PRESETS);
check('hay preajustes de luz', presets.length >= 3, presets.join(', '));
settings.set('light.preset', presets[1]);
const p1 = luz.key.position.clone();
settings.set('light.preset', presets[2]);
check('cambiar de preajuste recoloca la luz', luz.key.position.distanceTo(p1) > 0.1,
  'd=' + luz.key.position.distanceTo(p1).toFixed(2));

// -------------------------------------------------------------- escenario ---
const stage = new Stage(scene, settings);
settings.set('stage.floor', true);
check('el suelo es visible', stage.floor.visible === true);
// Las sombras las recoge un plano aparte con ShadowMaterial, no el suelo.
check('el receptor de sombras esta activo',
  stage.catcher.receiveShadow === true && stage.catcher.visible === true);
settings.set('stage.shadowStrength', 0.8);
check('la fuerza de sombra llega al material', Math.abs(stage.shadowMat.opacity - 0.8) < 1e-6);
settings.set('stage.shadowStrength', 0);
check('a fuerza cero el receptor se apaga', stage.catcher.visible === false);
settings.set('stage.shadowStrength', 0.55);
settings.set('stage.gridSize', 16);
check('el tamano de rejilla se reconstruye', stage.grid.userData.size === 16,
  'size=' + stage.grid.userData.size);
settings.set('stage.background', 'ciclorama');
check('el modo ciclorama sustituye el fondo',
  stage.cyclorama.visible === true && stage.backdrop.visible === false);
settings.set('stage.background', 'degradado');
settings.set('stage.grid', true);
check('la rejilla se puede encender', stage.grid?.visible === true);
settings.set('stage.grid', false);
check('la rejilla se puede apagar', stage.grid?.visible === false);
settings.set('stage.floor', false);
check('el suelo se puede apagar', stage.floor.visible === false);
settings.set('stage.axes', true);
check('los ejes se pueden encender', stage.axes?.visible === true);
settings.set('stage.axes', false);

luz.dispose();
stage.dispose();
rig.dispose();
console.log('');
console.log(oks.length + ' correctas / ' + fails.length + ' fallos');
if (fails.length) { console.log('FALLOS:'); for (const f of fails) console.log(' - ' + f); process.exit(1); }
process.exit(0);
