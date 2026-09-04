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

/* ── 5 · Las rectas de los hombros y de la cadera ────────────────────── */
// Son lineas de construccion: van rectas y lo que se lee es su inclinacion, asi
// que se comprueba que pasan por las dos articulaciones, que salen por fuera de
// ellas y que no se disfrazan del trazo de gesto.
check('con todo apagado no queda nada activo', linea.active === false);
settings.set('guides.action.shoulders', true);
check('la recta de los hombros enciende el trazo por si sola', linea.active === true);
const hombros = fakeCtx();
linea.draw(hombros, W, H, 1);
check('es un trazo suelto de dos puntos, sin relleno ni curva',
  hombros.strokes === 1 && hombros.fills.length === 0 && hombros.puntos.length === 2,
  hombros.strokes + ' trazos · ' + hombros.puntos.length + ' puntos');
check('con su propio color y mas fina que el trazo de accion',
  hombros.strokeStyle === settings.get('guides.action.color2')
  && hombros.strokeStyle !== settings.get('guides.action.color')
  && hombros.lineWidth < settings.get('guides.action.width'),
  hombros.strokeStyle + ' · ' + hombros.lineWidth);

/** Cuanto se sale un punto de la recta que pasa por dos articulaciones, en px. */
const fuera = (a, b, p) => Math.abs((p[0] - a.x) * (b.y - a.y) - (p[1] - a.y) * (b.x - a.x))
  / Math.hypot(b.x - a.x, b.y - a.y);
/** Angulo de la recta dibujada, para comparar dos inclinaciones. */
const inclina = (c, i = 0) => Math.atan2(c.puntos[i * 2 + 1][1] - c.puntos[i * 2][1],
  c.puntos[i * 2 + 1][0] - c.puntos[i * 2][0]);
{
  const a = px('leftArm');
  const b = px('rightArm');
  const [p, q] = hombros.puntos;
  const largo = Math.hypot(b.x - a.x, b.y - a.y);
  check('la recta pasa por los dos encajes del brazo, que es donde se ven los hombros',
    fuera(a, b, p) < 0.01 && fuera(a, b, q) < 0.01,
    fuera(a, b, p).toExponential(1) + ' / ' + fuera(a, b, q).toExponential(1) + ' px');
  check('y se prolonga por fuera de los dos',
    Math.hypot(q[0] - p[0], q[1] - p[1]) > largo * 1.2
    && Math.min(p[0], q[0]) < Math.min(a.x, b.x) - 1
    && Math.max(p[0], q[0]) > Math.max(a.x, b.x) + 1,
    'recta de ' + Math.hypot(q[0] - p[0], q[1] - p[1]).toFixed(0)
    + ' px · hombros ' + largo.toFixed(0) + ' px');
  // La clavicula nace pegada al cuello: de raiz a raiz la recta salia mucho mas
  // corta que los hombros que se ven, que es lo que se veia mal.
  const raices = Math.hypot(px('rightShoulder').x - px('leftShoulder').x,
    px('rightShoulder').y - px('leftShoulder').y);
  check('y bastante mas ancha que la distancia entre las dos claviculas',
    largo > raices * 2,
    'hombros ' + largo.toFixed(0) + ' px · claviculas ' + raices.toFixed(0) + ' px');
}

// No todo esqueleto trae clavicula, y a esta recta le da igual: se apoya en los
// brazos, asi que sin ellas sale exactamente la misma.
{
  const clav = { leftShoulder: bones.leftShoulder, rightShoulder: bones.rightShoulder };
  delete bones.leftShoulder;
  delete bones.rightShoulder;
  const sinClav = fakeCtx();
  linea.draw(sinClav, W, H, 1);
  check('sin claviculas la recta de los hombros no se mueve',
    sinClav.strokes === 1 && sinClav.puntos.length === 2
    && sinClav.puntos.every((p, i) => Math.hypot(p[0] - hombros.puntos[i][0],
      p[1] - hombros.puntos[i][1]) < 1e-9),
    sinClav.strokes + ' trazos');
  Object.assign(bones, clav);
}

// Y si los dos lados caen en el mismo punto —la figura vista de canto— no hay
// recta que trazar: dejarla salir daria un palo apuntando a cualquier lado.
{
  const sitio = bones.rightArm.position.clone();
  bones.rightArm.position.copy(bones.leftArm.position);
  raiz.updateMatrixWorld(true);
  const encima = fakeCtx();
  linea.draw(encima, W, H, 1);
  check('con los dos hombros en el mismo punto no se traza nada',
    encima.strokes === 0 && encima.puntos.length === 0, encima.strokes + ' trazos');
  bones.rightArm.position.copy(sitio);
  raiz.updateMatrixWorld(true);
}

// Las dos juntas: es la pareja lo que se mira.
settings.set('guides.action.hips', true);
const dos = fakeCtx();
linea.draw(dos, W, H, 1);
check('las dos rectas son dos trazos de dos puntos cada uno',
  dos.strokes === 2 && dos.puntos.length === 4, dos.strokes + ' trazos');
{
  const a = px('leftUpLeg');
  const b = px('rightUpLeg');
  check('la segunda pasa por las dos caderas',
    fuera(a, b, dos.puntos[2]) < 0.01 && fuera(a, b, dos.puntos[3]) < 0.01,
    fuera(a, b, dos.puntos[2]).toExponential(1) + ' px');
}

// Volcar la cadera las saca de paralelas, que es lo que se lee de la pareja.
{
  const sitio = bones.rightUpLeg.position.clone();
  bones.rightUpLeg.position.y += 0.09;
  raiz.updateMatrixWorld(true);
  const volcada = fakeCtx();
  linea.draw(volcada, W, H, 1);
  // El seno de la diferencia: da igual por que punta se haya dibujado cada una.
  const g = Math.abs(Math.sin(inclina(volcada, 0) - inclina(volcada, 1)));
  check('con la cadera volcada las dos no salen paralelas: eso es el contrapposto',
    g > 0.02, (Math.asin(g) * 180 / Math.PI).toFixed(1) + ' grados de diferencia');
  bones.rightUpLeg.position.copy(sitio);
  raiz.updateMatrixWorld(true);
}

// Y se ensanchan con la figura. Engordar el pecho no mueve los hombros —a cada
// hijo se le descuenta la escala del padre, que es lo que evita que se cizalle la
// piel—, pero el cuerpo se ve mas ancho y la recta tiene que crecer con el. El
// personaje de juguete no deforma nada: se le presta lo que la guia consulta.
{
  const UNO = new THREE.Vector3(1, 1, 1);
  const deform = new Map();
  character.lengthAxis = () => 1;               // la Y a lo largo del hueso
  character.boneDeform = (key, out = new THREE.Vector3()) => out.copy(deform.get(key) ?? UNO);
  /** Largo de una de las rectas dibujadas. */
  const largoDe = (c, i = 0) => Math.hypot(c.puntos[i * 2 + 1][0] - c.puntos[i * 2][0],
    c.puntos[i * 2 + 1][1] - c.puntos[i * 2][1]);
  /** Centro de una de las rectas dibujadas. */
  const centroDe = (c, i = 0) => [(c.puntos[i * 2][0] + c.puntos[i * 2 + 1][0]) / 2,
    (c.puntos[i * 2][1] + c.puntos[i * 2 + 1][1]) / 2];
  const antes = fakeCtx();
  linea.draw(antes, W, H, 1);
  check('sin deformar nada salen exactamente las mismas dos rectas',
    Math.abs(largoDe(antes) - largoDe(dos)) < 1e-9
    && Math.abs(largoDe(antes, 1) - largoDe(dos, 1)) < 1e-9,
    largoDe(antes).toFixed(1) + ' px');

  deform.set('spine2', new THREE.Vector3(1.5, 1, 1));
  const ancho = fakeCtx();
  linea.draw(ancho, W, H, 1);
  // No sale 1,5 clavado porque el factor se mide a lo largo de la recta, y esta va
  // algo inclinada: es el estirado que le toca a su direccion.
  check('engordar el pecho al ancho ensancha la recta de los hombros otro tanto',
    Math.abs(largoDe(ancho) / largoDe(antes) - 1.5) < 0.02,
    (largoDe(ancho) / largoDe(antes)).toFixed(3) + ' veces');
  check('crece por las dos puntas, sin irse de sitio',
    Math.hypot(centroDe(ancho)[0] - centroDe(antes)[0],
      centroDe(ancho)[1] - centroDe(antes)[1]) < 1e-9);
  check('y la de la cadera no se entera',
    Math.abs(largoDe(ancho, 1) - largoDe(antes, 1)) < 1e-9);

  deform.set('spine2', new THREE.Vector3(1, 1, 1.6));
  const fondo = fakeCtx();
  linea.draw(fondo, W, H, 1);
  check('engordarlo de fondo no la ensancha: cuenta el ancho que mira la recta',
    Math.abs(largoDe(fondo) - largoDe(antes)) < 1e-9, largoDe(fondo).toFixed(1) + ' px');

  deform.set('spine2', new THREE.Vector3(1, 2.5, 1));
  const alto = fakeCtx();
  linea.draw(alto, W, H, 1);
  check('ni alargarlo: el largo no escala, mueve la articulacion, y eso ya se ve',
    Math.abs(largoDe(alto) - largoDe(antes)) < 1e-9, largoDe(alto).toFixed(1) + ' px');

  deform.clear();
  deform.set('hips', new THREE.Vector3(1.4, 1, 1));
  const pelvis = fakeCtx();
  linea.draw(pelvis, W, H, 1);
  check('la de la cadera la ensancha su propio hueso, sin tocar la de los hombros',
    Math.abs(largoDe(pelvis, 1) / largoDe(antes, 1) - 1.4) < 0.02
    && Math.abs(largoDe(pelvis) - largoDe(antes)) < 1e-9,
    (largoDe(pelvis, 1) / largoDe(antes, 1)).toFixed(3) + ' veces');

  deform.set('hips', new THREE.Vector3(0.6, 1, 1));
  const estrecha = fakeCtx();
  linea.draw(estrecha, W, H, 1);
  check('y adelgazarla la acorta, que se mide la figura y no el hueso',
    Math.abs(largoDe(estrecha, 1) / largoDe(antes, 1) - 0.6) < 0.02,
    (largoDe(estrecha, 1) / largoDe(antes, 1)).toFixed(3) + ' veces');

  delete character.lengthAxis;
  delete character.boneDeform;
}
settings.set('guides.action.shoulders', false);
const soloCadera = fakeCtx();
linea.draw(soloCadera, W, H, 1);
check('cada una se enciende y se apaga por su lado',
  linea.active === true && soloCadera.strokes === 1, soloCadera.strokes + ' trazos');
settings.set('guides.action.hips', false);
check('y apagando las dos vuelve a no haber nada activo', linea.active === false);

/* ── 6 · Exageracion y fantasma ──────────────────────────────────────── */
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

/* ── 7 · De perfil el trazo no puede desaparecer ─────────────────────── */
// Brazos colgando y camara de canto: los dos brazos se proyectan casi encima, el
// trazo vuelve sobre si mismo y la cuerda entre las dos manos se queda en nada.
// Con un solo degradado por esa cuerda, todo el trazo caia fuera del eje y se
// dibujaba transparente: la linea desaparecia del visor.
for (const [key, sitio] of Object.entries({
  leftArm: [0.16, 1.42, 0], leftForeArm: [0.19, 1.16, 0], leftHand: [0.21, 0.92, 0], leftMiddle2: [0.215, 0.84, 0],
  rightArm: [-0.16, 1.42, 0], rightForeArm: [-0.19, 1.16, 0], rightHand: [-0.21, 0.92, 0], rightMiddle2: [-0.215, 0.84, 0],
})) bones[key].position.set(...sitio);
raiz.updateMatrixWorld(true);

const perfil = new THREE.PerspectiveCamera(45, W / H, 0.1, 100);
perfil.position.set(3.4, 1, 0);
perfil.lookAt(0, 0.95, 0);
perfil.updateMatrixWorld(true);
viewport.cameras.active = perfil;

settings.set('guides.action.line', false);
settings.set('guides.action.ghost', false);
settings.set('guides.action.arms', true);
const lado = fakeCtx();
linea.draw(lado, W, H, 1);
{
  const ejes = lado.grads.map((g) => Math.hypot(g.eje[2] - g.eje[0], g.eje[3] - g.eje[1]));
  check('de perfil el trazo se sigue pintando', lado.fills.length > 0,
    lado.fills.length + ' rellenos');
  check('y se parte en dos mitades con su propio eje',
    lado.fills.length === 2 && ejes.length === 2 && ejes.every((d) => d > 60),
    'ejes de ' + ejes.map((d) => d.toFixed(0)).join(' y ') + ' px');
  const ys = lado.puntos.map(([, y]) => y);
  check('y cubre el brazo de arriba abajo', Math.max(...ys) - Math.min(...ys) > 100,
    (Math.max(...ys) - Math.min(...ys)).toFixed(0) + ' px de alto');
}
// Con los brazos abiertos y de frente, las dos puntas quedan lejos: un solo
// relleno con un degradado basta, y es el camino barato.
for (const key of ['leftArm', 'leftForeArm', 'leftHand', 'leftMiddle2',
  'rightArm', 'rightForeArm', 'rightHand', 'rightMiddle2']) {
  bones[key].position.set(...SITIOS[key]);
}
raiz.updateMatrixWorld(true);
viewport.cameras.active = cam;
const frente = fakeCtx();
linea.draw(frente, W, H, 1);
check('de frente y con los brazos abiertos basta un relleno', frente.fills.length === 1,
  frente.fills.length + ' rellenos');
settings.set('guides.action.arms', false);

/* ── 8 · Sin figura no se dibuja ─────────────────────────────────────── */
linea.setCharacter(null);
ctx = fakeCtx();
linea.draw(ctx, W, H, 1);
check('sin figura cargada no se pinta nada', ctx.fills.length === 0 && ctx.strokes === 0);

console.log('');
console.log(oks.length + ' correctas / ' + fails.length + ' fallos');
if (fails.length) { console.log('FALLOS:'); for (const f of fails) console.log(' - ' + f); process.exit(1); }
process.exit(0);
