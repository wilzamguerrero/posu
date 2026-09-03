/**
 * Trazos que resumen la pose: linea de accion, hombros, cadera y el fantasma
 * exagerado. Se dibuja sobre un contexto 2D de mentira (no hay lienzos en Node)
 * y con un esqueleto de juguete, asi que lo que se comprueba es la geometria:
 * que el trazo recorre la figura de arriba abajo, que no salen numeros raros y
 * que la exageracion aparta el fantasma de la pose real.
 */
import * as THREE from 'three';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

/** Path2D de mentira: guarda las coordenadas que le piden. */
globalThis.Path2D = class {
  constructor() { this.ops = []; }
  moveTo(...a) { this.ops.push(['moveTo', ...a]); }
  lineTo(...a) { this.ops.push(['lineTo', ...a]); }
  quadraticCurveTo(...a) { this.ops.push(['quad', ...a]); }
  arc(...a) { this.ops.push(['arc', ...a]); }
  closePath() { this.ops.push(['close']); }
};

/** Contexto 2D de mentira: apunta los rellenos y los trazos sueltos. */
function fakeCtx() {
  const ctx = {
    fills: [], strokes: 0, puntos: [], globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1,
    grads: [],
    save() {}, restore() {}, setLineDash() {}, beginPath() {}, closePath() {},
    createLinearGradient(x0, y0, x1, y1) {
      const g = { eje: [x0, y0, x1, y1], stops: [], addColorStop(o, c) { g.stops.push([o, c]); } };
      ctx.grads.push(g);
      return g;
    },
    fill(path) { ctx.fills.push(path); if (path) ctx.puntos.push(...coords(path)); },
    stroke(path) { ctx.strokes++; if (path) ctx.puntos.push(...coords(path)); },
    moveTo(x, y) { ctx.puntos.push([x, y]); },
    lineTo(x, y) { ctx.puntos.push([x, y]); },
    arc(x, y) { ctx.puntos.push([x, y]); },
  };
  return ctx;
}
/** Coordenadas de un Path2D de mentira, por pares. */
function coords(path) {
  const out = [];
  for (const op of path.ops ?? []) {
    if (op[0] === 'arc' || op[0] === 'moveTo' || op[0] === 'lineTo') out.push([op[1], op[2]]);
    else if (op[0] === 'quad') { out.push([op[1], op[2]]); out.push([op[3], op[4]]); }
  }
  return out;
}

const fails = [];
const oks = [];
const check = (name, cond, extra = '') => {
  (cond ? oks : fails).push(name + (extra ? ' :: ' + extra : ''));
  console.log((cond ? 'OK   ' : 'FALLA') + ' ' + name + (extra ? '  (' + extra + ')' : ''));
};

const { Settings } = await import('../src/core/Settings.js');
const { DEFAULTS } = await import('../src/config.js');
const { ActionLine } = await import('../src/guides/ActionLine.js');

/* ── Esqueleto de juguete, de pie mirando a la camara ────────────────── */
const SITIOS = {
  headTop: [0, 1.75, 0], head: [0, 1.62, 0], neck: [0, 1.5, 0],
  spine2: [0.012, 1.35, 0], spine1: [0.016, 1.2, 0], spine: [0.01, 1.05, 0], hips: [0, 0.95, 0],
  leftShoulder: [0.055, 1.45, 0], leftArm: [0.18, 1.42, 0], leftForeArm: [0.45, 1.42, 0], leftHand: [0.68, 1.42, 0],
  leftMiddle2: [0.76, 1.42, 0],
  rightShoulder: [-0.055, 1.45, 0], rightArm: [-0.18, 1.38, 0], rightForeArm: [-0.45, 1.38, 0], rightHand: [-0.68, 1.38, 0],
  rightMiddle2: [-0.76, 1.38, 0],
  leftUpLeg: [0.09, 0.92, 0], leftLeg: [0.11, 0.5, 0], leftFoot: [0.11, 0.1, 0], leftToe: [0.11, 0.03, 0.1],
  rightUpLeg: [-0.09, 0.9, 0], rightLeg: [-0.1, 0.48, 0], rightFoot: [-0.1, 0.04, 0], rightToe: [-0.1, 0.02, 0.1],
};
const raiz = new THREE.Object3D();
const bones = {};
for (const [key, [x, y, z]] of Object.entries(SITIOS)) {
  const o = new THREE.Object3D();
  o.position.set(x, y, z);
  raiz.add(o);
  bones[key] = o;
}
raiz.updateMatrixWorld(true);
const character = { loaded: true, bones };

const W = 900;
const H = 700;
const cam = new THREE.PerspectiveCamera(45, W / H, 0.1, 100);
cam.position.set(0, 1, 3.4);
cam.lookAt(0, 0.95, 0);
cam.updateMatrixWorld(true);
const viewport = { cameras: { active: cam } };

const settings = new Settings(DEFAULTS, null);
const linea = new ActionLine(settings, viewport);
linea.setCharacter(character);

/** Proyeccion de un hueso a pixeles, para comparar con lo dibujado. */
function px(key) {
  const v = bones[key].getWorldPosition(new THREE.Vector3()).project(cam);
  return { x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H };
}

/* ── 1 · Apagado no cuesta nada ──────────────────────────────────────── */
check('sin ningun trazo encendido no hay nada activo', linea.active === false);
{
  const ctx = fakeCtx();
  linea.draw(ctx, W, H, 1);
  check('y no se dibuja nada', ctx.fills.length === 0 && ctx.strokes === 0);
}

/* ── 2 · La linea de accion recorre la figura ────────────────────────── */
settings.set('guides.action.line', true);
settings.set('guides.action.exaggeration', 0);
check('encender la linea la deja activa', linea.active === true);
let ctx = fakeCtx();
linea.draw(ctx, W, H, 1);
const finito = ctx.puntos.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
check('el trazo sale con coordenadas finitas', finito && ctx.puntos.length > 8,
  ctx.puntos.length + ' puntos');
check('se pinta de una sola pasada de relleno', ctx.fills.length === 1);
{
  const ys = ctx.puntos.map(([, y]) => y);
  const arriba = px('headTop').y;
  const abajo = px('rightFoot').y;      // el pie derecho es el mas bajo
  check('el trazo va de la coronilla al pie de apoyo',
    Math.min(...ys) < arriba + 12 && Math.max(...ys) > abajo - 12,
    'trazo ' + Math.min(...ys).toFixed(0) + '..' + Math.max(...ys).toFixed(0)
    + ' · figura ' + arriba.toFixed(0) + '..' + abajo.toFixed(0));
}

/* ── 3 · Se prolonga y se desvanece ──────────────────────────────────── */
{
  const alto = px('headTop');
  const pie = px('rightFoot');
  const largo = Math.hypot(pie.x - alto.x, pie.y - alto.y);
  const ys = ctx.puntos.map(([, y]) => y);
  check('el trazo se prolonga mas alla de la figura',
    Math.min(...ys) < alto.y - largo * 0.05 && Math.max(...ys) > pie.y + largo * 0.05,
    'trazo ' + Math.min(...ys).toFixed(0) + '..' + Math.max(...ys).toFixed(0)
    + ' · figura ' + alto.y.toFixed(0) + '..' + pie.y.toFixed(0));
  const g = ctx.grads[0];
  const transparente = (c) => String(c).endsWith(', 0)');
  check('y se desvanece en las dos puntas',
    !!g && g.stops.length === 4 && transparente(g.stops[0][1]) && transparente(g.stops.at(-1)[1]),
    g ? g.stops.map((s) => s[0] + ':' + s[1]).join(' / ') : 'sin degradado');
}

/* ── 4 · Lineas de ritmo ─────────────────────────────────────────────── */
settings.set('guides.action.arms', true);
ctx = fakeCtx();
linea.draw(ctx, W, H, 1);
check('el ritmo de brazo a brazo anade una curva', ctx.fills.length === 2,
  ctx.fills.length + ' rellenos');
{
  const mano = px('leftHand');
  const hombro = px('leftArm');
  const pecho = px('neck');
  const pasaPor = (p, r) => ctx.puntos.some(([x, y]) => Math.hypot(x - p.x, y - p.y) < r);
  check('la curva encadena mano, hombro y el centro del pecho',
    pasaPor(mano, 22) && pasaPor(hombro, 22) && pasaPor(pecho, 30));
  check('sigue por la mano hasta los dedos', pasaPor(px('leftMiddle2'), 12));
  check('y sale por fuera de ella',
    Math.max(...ctx.puntos.map(([x]) => x)) > px('leftMiddle2').x + 10,
    'dedos en x=' + px('leftMiddle2').x.toFixed(0)
    + ' · trazo hasta ' + Math.max(...ctx.puntos.map(([x]) => x)).toFixed(0));
}

settings.set('guides.action.legs', true);
ctx = fakeCtx();
linea.draw(ctx, W, H, 1);
check('el ritmo de hombro a pierna anade las dos curvas cruzadas',
  ctx.fills.length === 4, ctx.fills.length + ' rellenos');
{
  const pie = px('leftFoot');
  const hombro = px('rightArm');
  const pasaPor = (p, r) => ctx.puntos.some(([x, y]) => Math.hypot(x - p.x, y - p.y) < r);
  check('una de ellas va del hombro derecho al pie izquierdo',
    pasaPor(hombro, 40) && pasaPor(pie, 26));
}

// Y se puede elegir el camino: cruzado, por su lado o por el costado. Se apagan
// los demas trazos para medir solo las dos curvas de las piernas.
settings.set('guides.action.line', false);
settings.set('guides.action.arms', false);
const firma = (c) => c.puntos.map(([x, y]) => Math.round(x) + ',' + Math.round(y)).join(' ');
const pasaPor = (c, p, r) => c.puntos.some(([x, y]) => Math.hypot(x - p.x, y - p.y) < r);
const porCamino = (modo) => {
  settings.set('guides.action.legPath', modo);
  const c = fakeCtx();
  linea.draw(c, W, H, 1);
  return c;
};

const cruzado = porCamino('cruzado');
check('cruzado deja las dos curvas solas', cruzado.fills.length === 2,
  cruzado.fills.length + ' rellenos');

const mismo = porCamino('mismo');
check('por su lado tambien son dos', mismo.fills.length === 2, mismo.fills.length + ' rellenos');
check('pero por otro camino', firma(mismo) !== firma(cruzado));
check('cada una baja del hombro al pie de su lado',
  pasaPor(mismo, px('leftArm'), 40) && pasaPor(mismo, px('leftFoot'), 26));
check('y sigue pasando por la columna', pasaPor(mismo, px('spine1'), 6));

// Por el costado: la columna solo le presta su curvatura.
const costado = porCamino('costado');
check('por el costado tambien son dos', costado.fills.length === 2,
  costado.fills.length + ' rellenos');
{
  // Punto de control esperado: la columna acercada a la recta hombro-cadera.
  const a = px('leftShoulder');
  const b = px('leftUpLeg');
  const p = px('spine1');
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const t = ((p.x - a.x) * ex + (p.y - a.y) * ey) / (ex * ex + ey * ey);
  const qx = a.x + ex * t;
  const qy = a.y + ey * t;
  const esperado = { x: qx + (p.x - qx) * 0.32, y: qy + (p.y - qy) * 0.32 };
  check('no entra al centro del torso', !pasaPor(costado, p, 7),
    'columna en ' + p.x.toFixed(0) + ',' + p.y.toFixed(0));
  check('pero se queda con parte de la curvatura de la espalda',
    pasaPor(costado, esperado, 7) && Math.abs(esperado.x - qx) > 2,
    'esperado ' + esperado.x.toFixed(0) + ',' + esperado.y.toFixed(0)
    + ' · recta ' + qx.toFixed(0) + ',' + qy.toFixed(0));
  check('y baja del hombro al pie de su lado',
    pasaPor(costado, px('leftShoulder'), 22) && pasaPor(costado, px('leftFoot'), 26));
}
settings.set('guides.action.legPath', 'cruzado');
settings.set('guides.action.legs', false);

/* ── 5 · Exageracion y fantasma ──────────────────────────────────────── */
settings.set('guides.action.ghost', true);
// Solo el fantasma: asi los puntos salen en el mismo orden con cualquier
// exageracion y se pueden comparar uno a uno.
settings.set('guides.action.line', false);

/** Reparte los puntos del fantasma para poder comparar dos exageraciones. */
function dibuja(exageracion) {
  settings.set('guides.action.exaggeration', exageracion);
  const c = fakeCtx();
  linea.draw(c, W, H, 1);
  return c;
}
const sin = dibuja(0);
const con = dibuja(0.9);
check('el fantasma se dibuja con lineas sueltas', sin.strokes > 15, sin.strokes + ' trazos');
check('la exageracion no rompe las coordenadas',
  con.puntos.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)));
const separacion = (a, b) => {
  let max = 0;
  const n = Math.min(a.puntos.length, b.puntos.length);
  for (let i = 0; i < n; i++) {
    max = Math.max(max, Math.hypot(a.puntos[i][0] - b.puntos[i][0], a.puntos[i][1] - b.puntos[i][1]));
  }
  return max;
};
const d1 = separacion(sin, con);
const medio = dibuja(0.4);
const d2 = separacion(sin, medio);
check('exagerar aparta el fantasma de la pose real', d1 > 4, d1.toFixed(1) + ' px');
check('y a mas exageracion, mas separacion', d1 > d2 + 1,
  '0.4 -> ' + d2.toFixed(1) + ' px · 0.9 -> ' + d1.toFixed(1) + ' px');

/* ── 6 · Sin figura no se dibuja ─────────────────────────────────────── */
linea.setCharacter(null);
ctx = fakeCtx();
linea.draw(ctx, W, H, 1);
check('sin figura cargada no se pinta nada', ctx.fills.length === 0 && ctx.strokes === 0);

console.log('');
console.log(oks.length + ' correctas / ' + fails.length + ' fallos');
if (fails.length) { console.log('FALLOS:'); for (const f of fails) console.log(' - ' + f); process.exit(1); }
process.exit(0);
