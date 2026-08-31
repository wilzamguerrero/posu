/**
 * Prueba de las guias de perspectiva.
 * Comprueba la geometria (donde caen los puntos de fuga con la camara puesta en
 * cada posicion canonica) y que los seis modos dibujan sin romperse, con un
 * contexto 2D simulado que solo cuenta ordenes.
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
const { Perspective, PERSPECTIVE_MODES } = await import('../src/guides/Perspective.js');

const W = 1600;
const H = 900;
const settings = new Settings(DEFAULTS, null);
const rig = new CameraRig(settings, dom.window.document.getElementById('v'));
rig.setAspect(W / H);
const persp = new Perspective(settings, { cameras: rig });

/** Coloca la camara en un acimut/elevacion respecto al objetivo. */
function place(az, el, dist = 6) {
  const t = rig.controls.target;
  const phi = (90 - el) * (Math.PI / 180);
  const th = az * (Math.PI / 180);
  rig.active.position.set(
    t.x + dist * Math.sin(phi) * Math.sin(th),
    t.y + dist * Math.cos(phi),
    t.z + dist * Math.sin(phi) * Math.cos(th),
  );
  rig.active.up.set(0, 1, 0);
  rig.active.lookAt(t);
  rig.active.updateMatrixWorld(true);
}

const AX = new THREE.Vector3(1, 0, 0);
const AY = new THREE.Vector3(0, 1, 0);
const AZ = new THREE.Vector3(0, 0, 1);

/* ------------------------------------------------- 1 punto: fuga central --- */

settings.set('guides.perspective.mode', '1punto');
place(0, 0);
let vz = persp.vanishingPoint(AZ, W, H);
let vx = persp.vanishingPoint(AX, W, H);
let vy = persp.vanishingPoint(AY, W, H);
check('un punto: la fuga del eje de vista cae en el centro',
  !!vz && !vz.paralela && Math.abs(vz.x - W / 2) < 1 && Math.abs(vz.y - H / 2) < 1,
  vz && !vz.paralela ? Math.round(vz.x) + ',' + Math.round(vz.y) : String(vz));
check('un punto: las horizontales transversales son paralelas', !!vx && vx.paralela === true);
check('un punto: las verticales son paralelas', !!vy && vy.paralela === true);

/* ------------------------------------ 2 puntos: dos fugas en el horizonte --- */

settings.set('guides.perspective.mode', '2puntos');
place(45, 0);
vx = persp.vanishingPoint(AX, W, H);
vz = persp.vanishingPoint(AZ, W, H);
vy = persp.vanishingPoint(AY, W, H);
const finitas = !!vx && !!vz && !vx.paralela && !vz.paralela;
check('dos puntos: las dos fugas horizontales son finitas', finitas);
check('dos puntos: ambas quedan a la altura del ojo',
  finitas && Math.abs(vx.y - H / 2) < 1.5 && Math.abs(vz.y - H / 2) < 1.5,
  finitas ? Math.round(vx.y) + ' / ' + Math.round(vz.y) : '');
check('dos puntos: quedan simetricas respecto al centro',
  finitas && Math.abs((vx.x - W / 2) + (vz.x - W / 2)) < 2,
  finitas ? Math.round(vx.x) + ' / ' + Math.round(vz.x) : '');
check('dos puntos: una queda a cada lado del encuadre', finitas && (vx.x - W / 2) * (vz.x - W / 2) < 0);
check('dos puntos: la vertical no fuga', !!vy && vy.paralela === true);

/* ----------------------------------------- 3 puntos: tercera fuga al cenit --- */

settings.set('guides.perspective.mode', '3puntos');
place(45, -35);   // contrapicado: se mira hacia arriba, la vertical fuga arriba
vy = persp.vanishingPoint(AY, W, H);
check('tres puntos: en contrapicado la vertical si fuga', !!vy && vy.paralela !== true);
check('tres puntos: la tercera fuga cae sobre el centro del encuadre',
  !!vy && !vy.paralela && vy.y < H / 2, vy && !vy.paralela ? 'y=' + Math.round(vy.y) : '');

/* --------------------------------------- ortografica: todo al infinito ------ */

place(45, 0);
settings.set('camera.projection', 'ortografica');
rig.applyProjection();
rig.active.updateMatrixWorld(true);
const ox = persp.vanishingPoint(AX, W, H);
check('ortografica: no hay fugas finitas, las familias son paralelas',
  !!ox && ox.paralela === true);
settings.set('camera.projection', 'perspectiva');
rig.applyProjection();
place(45, 0);

/* ----------------------------------- curvas: cenit y horizonte del ojo de pez */

settings.set('guides.perspective.mode', '5puntos');
place(0, 0);
const cenit = persp.vanishingPoint(AY, W, H);
const R = Math.min(W, H) * 0.5;
check('cinco puntos: el cenit cae justo arriba del centro',
  !!cenit && Math.abs(cenit.x - W / 2) < 1 && Math.abs((H / 2 - cenit.y) - R * 0.98) < 2,
  cenit ? Math.round(cenit.x) + ',' + Math.round(cenit.y) : '');
settings.set('guides.perspective.mode', '6puntos');
const nadir = persp.vanishingPoint(new THREE.Vector3(0, -1, 0), W, H);
check('seis puntos: el nadir cae a media esfera del centro',
  !!nadir && Math.abs((nadir.y - H / 2) - (Math.min(W, H) * 0.5 * 0.98) / 2) < 2,
  nadir ? 'y=' + Math.round(nadir.y) : '');
settings.set('guides.perspective.mode', '4puntos');
const detras = persp.vanishingPoint(new THREE.Vector3(0.25, 0, 1), W, H);
check('cuatro puntos: la panoramica cilindrica tambien proyecta lo que queda detras',
  !!detras && Number.isFinite(detras.x) && Math.abs(detras.x - W / 2) > W / 2,
  detras ? 'x=' + Math.round(detras.x) : String(detras));
const baja = persp.vanishingPoint(new THREE.Vector3(0.5, 0, 1).normalize(), W, H);
const alta = persp.vanishingPoint(new THREE.Vector3(0.5, 0.9, 1).normalize(), W, H);
check('cuatro puntos: las verticales del mundo siguen siendo rectas verticales',
  !!baja && !!alta && Math.abs(baja.x - alta.x) < 0.01,
  baja && alta ? Math.round(baja.x) + ' vs ' + Math.round(alta.x) : '');

/* ------------------------------------------- dibujo: los seis modos pintan --- */

/** Contexto 2D minimo: cuenta trazos y no valida nada mas. */
function stubCtx() {
  const c = {
    strokes: 0, fills: 0, textos: 0, lineWidth: 1, globalAlpha: 1,
    strokeStyle: '', fillStyle: '', font: '', textAlign: '', lineCap: '', lineJoin: '',
    save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
    arc() {}, rect() {}, ellipse() {}, setLineDash() {}, clip() {}, translate() {},
    stroke() { c.strokes++; }, fill() { c.fills++; }, fillText() { c.textos++; },
    measureText() { return { width: 10 }; },
  };
  return c;
}

settings.batch({
  'guides.perspective.floorGrid': true,
  'guides.perspective.wallGrid': true,
  'guides.perspective.cube': true,
  'guides.perspective.cone': true,
  'guides.perspective.measuring': true,
  'guides.perspective.objects': true,
  'guides.perspective.letterbox': true,
  'guides.perspective.points': true,
  'guides.perspective.labels': true,
});
place(35, -20);
for (const modo of PERSPECTIVE_MODES) {
  settings.set('guides.perspective.mode', modo.id);
  const ctx = stubCtx();
  let err = null;
  try { persp.draw(ctx, W, H, 1); } catch (e) { err = e; }
  const espera = modo.id !== 'ninguno';
  check('dibuja el modo ' + modo.label.toLowerCase(),
    !err && (espera ? ctx.strokes > 20 : ctx.strokes === 0),
    err ? String(err.message || err) : ctx.strokes + ' trazos · ' + ctx.textos + ' etiquetas');
}

/* -------------------------------------- alinear y congelar la camara -------- */

settings.set('guides.perspective.mode', '2puntos');
place(12, 0);
persp.alignCamera();
rig.active.updateMatrixWorld(true);
const off = rig.active.position.clone().sub(rig.controls.target);
const az = (Math.atan2(off.x, off.z) * 180) / Math.PI;
check('alinear: el acimut se ajusta al giro de 45 grados de dos puntos',
  Math.abs(((az + 360) % 90) - 45) < 0.5, az.toFixed(1) + ' grados');
check('alinear: el horizonte queda a nivel', Math.abs(off.y) < 1e-6, off.y.toFixed(4));

settings.set('guides.perspective.lock', true);
const antes = persp.vanishingPoint(new THREE.Vector3(1, 0, 0), W, H);
place(80, -30);
const despues = persp.vanishingPoint(new THREE.Vector3(1, 0, 0), W, H);
check('congelar: mover la camara no mueve las fugas',
  !!antes && !!despues && Math.abs(antes.x - despues.x) < 0.01);
settings.set('guides.perspective.lock', false);
const suelta = persp.vanishingPoint(new THREE.Vector3(1, 0, 0), W, H);
check('soltar: la fuga vuelve a seguir a la camara',
  !!suelta && Math.abs(suelta.x - antes.x) > 1);

console.log('\n' + oks.length + ' correctas / ' + fails.length + ' fallos');
if (fails.length) process.exit(1);
