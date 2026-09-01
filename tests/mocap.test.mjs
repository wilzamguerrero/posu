/**
 * Prueba del cableado de captura que no necesita camara:
 *   - el encuadre cuadrado que exige el delegado CPU y la vuelta de los puntos
 *     a las coordenadas del video (SquarePad),
 *   - los angulos de los dedos que se deducen de los 21 puntos de la mano,
 *   - a que mano del personaje va cada deteccion,
 *   - el limitador de frecuencia de los dos detectores.
 *
 * jsdom no trae lienzo 2D, asi que se simula el minimo que usa SquarePad: lo que
 * se comprueba es la aritmetica del encuadre, no el dibujado.
 */
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://localhost/' });
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Event', 'localStorage']) {
  if (dom.window[k] === undefined) continue;
  try { Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true }); } catch { /* ya definido */ }
}
globalThis.performance ??= dom.window.performance;

// Lienzo simulado: registra las llamadas de dibujo y nada mas.
const dibujos = [];
const crear = dom.window.document.createElement.bind(dom.window.document);
dom.window.document.createElement = (tag, ...rest) => {
  if (String(tag).toLowerCase() !== 'canvas') return crear(tag, ...rest);
  return {
    width: 0, height: 0,
    getContext: () => ({
      fillStyle: '',
      fillRect: (...a) => dibujos.push(['fillRect', ...a]),
      drawImage: (...a) => dibujos.push(['drawImage', a.length]),
    }),
  };
};

let ok = 0;
let fail = 0;
const check = (nombre, cond, extra = '') => {
  if (cond) { ok++; console.log('OK   ', nombre, extra); } else { fail++; console.log('FALLA', nombre, extra); }
};
const cerca = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const DEG = Math.PI / 180;

/* ── 1 · Encuadre cuadrado ─────────────────────────────────────────────── */

const { SquarePad, sizeOf } = await import('../src/mocap/SquarePad.js');

check('sizeOf lee un video', (() => {
  const s = sizeOf({ videoWidth: 1280, videoHeight: 720 });
  return s.w === 1280 && s.h === 720;
})());
check('sizeOf lee una imagen', (() => {
  const s = sizeOf({ naturalWidth: 800, naturalHeight: 600 });
  return s.w === 800 && s.h === 600;
})());
check('sizeOf devuelve 0 sin fuente', sizeOf(null).w === 0);

const pad = new SquarePad(512);
const video = { videoWidth: 1280, videoHeight: 720 };
const lienzo = pad.input(video);
check('el lienzo es cuadrado', lienzo.width === 512 && lienzo.height === 512,
  `(${lienzo.width}x${lienzo.height})`);
check('la fuente cabe entera con bandas', pad.pad.w === 512 && pad.pad.h === 288,
  `(w=${pad.pad.w} h=${pad.pad.h})`);
check('las bandas se reparten arriba y abajo', pad.pad.offX === 0 && pad.pad.offY === 112,
  `(offX=${pad.pad.offX} offY=${pad.pad.offY})`);
check('se pinta el fondo antes de la fuente',
  dibujos[0]?.[0] === 'fillRect' && dibujos[1]?.[0] === 'drawImage');

// Un punto conocido del video: se lleva al cuadrado a mano y se pide la vuelta.
const { S, offX, offY, w: pw, h: ph } = pad.pad;
const alCuadrado = (x, y) => ({ x: (offX + x * pw) / S, y: (offY + y * ph) / S, z: 0 });
const vuelta = pad.unpad([alCuadrado(0.25, 0.5), alCuadrado(0, 0), alCuadrado(1, 1)]);
check('el punto vuelve a las coordenadas del video',
  cerca(vuelta[0].x, 0.25, 1e-9) && cerca(vuelta[0].y, 0.5, 1e-9),
  `(${vuelta[0].x.toFixed(4)}, ${vuelta[0].y.toFixed(4)})`);
check('las esquinas siguen siendo las esquinas',
  cerca(vuelta[1].x, 0, 1e-9) && cerca(vuelta[1].y, 0, 1e-9) && cerca(vuelta[2].y, 1, 1e-9));
// Fuente vertical: las bandas cambian de lado y la z cambia de escala.
const vertical = new SquarePad(512);
const retrato = vertical.input({ videoWidth: 480, videoHeight: 640 });
check('una fuente vertical se centra en horizontal',
  retrato.width === 512 && vertical.pad.offY === 0 && vertical.pad.offX === 64,
  `(offX=${vertical.pad.offX} offY=${vertical.pad.offY})`);
const conZ = vertical.unpad([{ x: 0.5, y: 0.5, z: 0.5 }])[0];
check('la z se reescala como la x', cerca(conZ.z, 0.5 * vertical.pad.S / vertical.pad.w, 1e-9),
  `(z=${conZ.z.toFixed(4)} escala=${(vertical.pad.S / vertical.pad.w).toFixed(3)})`);

// Sin encuadre no se toca nada.
pad.reset();
check('sin encuadre los puntos pasan tal cual', pad.unpad([{ x: 0.3, y: 0.7 }])[0].x === 0.3);
check('input devuelve null sin tamano', new SquarePad().input({ videoWidth: 0, videoHeight: 0 }) === null);

/* ── 2 · Angulos de los dedos ──────────────────────────────────────────── */

const { handAngles, handSide, HandTracker } = await import('../src/mocap/HandTracker.js');

const norm = (v) => { const n = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / n, y: v.y / n, z: v.z / n }; };
const cruz = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const mas = (a, b, k = 1) => ({ x: a.x + b.x * k, y: a.y + b.y * k, z: a.z + b.z * k });
/** Rotacion de Rodrigues de `v` un angulo `t` alrededor del eje unitario `e`. */
const gira = (v, e, t) => {
  const c = Math.cos(t);
  const s = Math.sin(t);
  const d = e.x * v.x + e.y * v.y + e.z * v.z;
  const cr = cruz(e, v);
  return {
    x: v.x * c + cr.x * s + e.x * d * (1 - c),
    y: v.y * c + cr.y * s + e.y * d * (1 - c),
    z: v.z * c + cr.z * s + e.z * d * (1 - c),
  };
};

/**
 * Mano sintetica: la palma mira a +Z, los dedos salen hacia +Y y se doblan
 * girando sobre el eje perpendicular a su propia direccion. Asi el angulo entre
 * segmentos consecutivos es exactamente el que se pide.
 */
function manoSintetica({ curls = [0, 0, 0], abre = 0.3, pulgar = 60 * DEG, curlsPulgar = null } = {}) {
  const p = new Array(21);
  const wrist = { x: 0, y: 0, z: 0 };
  p[0] = wrist;
  const palma = { x: 0, y: 0, z: 1 };
  const dedos = [
    ['thumb', [1, 2, 3, 4], null],
    ['index', [5, 6, 7, 8], abre],
    ['middle', [9, 10, 11, 12], abre * 0.1],
    ['ring', [13, 14, 15, 16], -abre * 0.5],
    ['pinky', [17, 18, 19, 20], -abre],
  ];
  for (const [nombre, idx, x] of dedos) {
    // Direccion del metacarpo. El pulgar se aparta en el plano de la palma.
    const dir = nombre === 'thumb'
      ? norm({ x: Math.sin(pulgar), y: Math.cos(pulgar), z: 0 })
      : norm({ x, y: 1, z: 0 });
    const eje = norm(cruz(dir, palma));
    const angulos = nombre === 'thumb' ? (curlsPulgar ?? curls) : curls;
    let punto = mas(wrist, dir, 0.3);
    p[idx[0]] = punto;
    let acumulado = 0;
    for (let i = 0; i < 3; i++) {
      acumulado += angulos[i] ?? 0;
      punto = mas(punto, gira(dir, eje, acumulado), 0.12);
      p[idx[i + 1]] = punto;
    }
  }
  return p;
}

const abierta = handAngles(manoSintetica({ curls: [0, 0, 0] }));
// El cero exacto no se puede pedir: acos de un producto escalar de casi 1 deja
// restos del orden de 1e-8 radianes, invisibles en pantalla.
check('una mano abierta no dobla ningun dedo',
  ['thumb', 'index', 'middle', 'ring', 'pinky'].every((f) => abierta[f].every((a) => a < 1e-4)),
  `(indice=${abierta.index.map((a) => a.toFixed(3)).join(' ')})`);

const doblada = handAngles(manoSintetica({ curls: [40 * DEG, 90 * DEG, 30 * DEG] }));
check('el nudillo descuenta la holgura', cerca(doblada.index[0], 28 * DEG, 1e-6),
  `(${(doblada.index[0] / DEG).toFixed(2)}°)`);
check('la falange media mide el angulo exacto', cerca(doblada.index[1], 90 * DEG, 1e-6),
  `(${(doblada.index[1] / DEG).toFixed(2)}°)`);
check('la falange distal mide el angulo exacto', cerca(doblada.index[2], 30 * DEG, 1e-6),
  `(${(doblada.index[2] / DEG).toFixed(2)}°)`);
check('cada dedo lleva tres flexiones',
  ['thumb', 'index', 'middle', 'ring', 'pinky'].every((f) => doblada[f].length === 3));
check('la holgura del pulgar es menor que la del indice',
  doblada.thumb[0] > doblada.index[0], `(pulgar=${(doblada.thumb[0] / DEG).toFixed(1)}° indice=${(doblada.index[0] / DEG).toFixed(1)}°)`);

const juntos = handAngles(manoSintetica({ abre: 0.05 }));
const separados = handAngles(manoSintetica({ abre: 0.5 }));
check('los dedos juntos no piden apertura', juntos.spread === 0, `(${juntos.spread.toFixed(4)})`);
check('los dedos separados piden apertura', separados.spread > 0.05,
  `(${(separados.spread / DEG).toFixed(2)}°)`);
check('la apertura respeta el tope de 22°', separados.spread <= 22 * DEG + 1e-9);

const pegado = handAngles(manoSintetica({ pulgar: 20 * DEG }));
const fuera = handAngles(manoSintetica({ pulgar: 75 * DEG }));
check('el pulgar pegado no se separa', pegado.thumbOut === 0, `(${pegado.thumbOut.toFixed(4)})`);
check('el pulgar abierto se separa', fuera.thumbOut > 20 * DEG,
  `(${(fuera.thumbOut / DEG).toFixed(2)}°)`);
check('la separacion del pulgar respeta el tope de 46°', fuera.thumbOut <= 46 * DEG + 1e-9);

check('sin 21 puntos no hay angulos', handAngles([{ x: 0, y: 0, z: 0 }]) === null && handAngles(null) === null);
const degenerada = handAngles(new Array(21).fill({ x: 1, y: 1, z: 1 }));
check('los puntos repetidos no producen NaN',
  Object.values(degenerada).flat().every((v) => Number.isFinite(v)));

/* ── 3 · De que mano es cada deteccion ─────────────────────────────────── */

// Pose sintetica: solo importan los puntos 15 y 16 (munecas anatomicas).
const poseCon = (izq, der) => {
  const l = new Array(33).fill(null).map(() => ({ x: 0.5, y: 0.5 }));
  l[15] = izq;
  l[16] = der;
  return l;
};
const pose = poseCon({ x: 0.2, y: 0.6 }, { x: 0.8, y: 0.6 });

check('la muneca cercana decide el lado (sin espejo)',
  handSide({ x: 0.22, y: 0.6 }, pose, 'Right', false) === 'left');
check('la vista en espejo intercambia el lado',
  handSide({ x: 0.22, y: 0.6 }, pose, 'Right', true) === 'right');
check('la otra muneca decide el otro lado',
  handSide({ x: 0.78, y: 0.6 }, pose, 'Left', false) === 'right');
check('la pose manda sobre la etiqueta',
  handSide({ x: 0.2, y: 0.6 }, pose, 'Left', false) === 'left');
check('con las munecas juntas gana la etiqueta',
  handSide({ x: 0.5, y: 0.6 }, poseCon({ x: 0.5, y: 0.6 }, { x: 0.51, y: 0.6 }), 'Left', false) === 'right');
check('sin pose la etiqueta se invierte (imagen en espejo)',
  handSide({ x: 0.2, y: 0.6 }, null, 'Left', false) === 'right'
  && handSide({ x: 0.2, y: 0.6 }, null, 'Right', false) === 'left');
check('sin pose ni etiqueta cae en la izquierda',
  handSide(null, null, '', false) === 'left');

/* ── 4 · Limitadores de frecuencia ─────────────────────────────────────── */

const { Settings } = await import('../src/core/Settings.js');
const { DEFAULTS } = await import('../src/config.js');
const { PoseDetector } = await import('../src/mocap/PoseDetector.js');

const settings = new Settings(DEFAULTS, 'posu-test-mocap');
settings.set('mocap.delegate', 'GPU');
settings.set('mocap.detectFps', 0);
const det = new PoseDetector(settings);
const tra = new HandTracker(settings, null);

check('en GPU la pose va a 60 fps', det.targetFps === 60, `(${det.targetFps})`);
check('en GPU las manos van a 24 fps', tra.targetFps === 24, `(${tra.targetFps})`);
settings.set('mocap.delegate', 'CPU');
check('en CPU la pose baja a 15 fps', det.targetFps === 15, `(${det.targetFps})`);
check('en CPU las manos bajan a 8 fps', tra.targetFps === 8, `(${tra.targetFps})`);
settings.set('mocap.detectFps', 30);
check('el ritmo pedido a mano manda en la pose', det.targetFps === 30, `(${det.targetFps})`);
check('las manos nunca pasan de su techo', tra.targetFps === 8, `(${tra.targetFps})`);
settings.set('mocap.detectFps', 4);
check('un ritmo menor que el techo tambien vale en las manos', tra.targetFps === 4, `(${tra.targetFps})`);

settings.set('mocap.detectFps', 0);
check('el delegado real manda sobre el ajuste', (() => {
  settings.set('mocap.delegate', 'GPU');
  det.forceCpu = true;
  const cpu = det.delegate === 'CPU' && det.targetFps === 15;
  det.forceCpu = false;
  return cpu && det.delegate === 'GPU';
})());
check('el resumen dice modelo, delegado y ritmo',
  /full · GPU · 60 fps/.test(det.describe()), `("${det.describe()}")`);
settings.set('mocap.delegate', 'CPU');
settings.set('mocap.square', 'si');
check('el resumen avisa del recorte cuadrado cuando se usa', (() => {
  det.usingSquare = true;
  const txt = det.describe();
  det.usingSquare = false;
  return /CPU · 15 fps · recorte cuadrado/.test(txt);
})(), `("${det.describe()}")`);

// Sin detector cargado nada de esto debe lanzar.
check('detectVideo sin modelo devuelve null', det.detectVideo({ readyState: 4, videoWidth: 640 }, 0) === null);
check('update sin modelo devuelve false', tra.update({ readyState: 4, videoWidth: 640 }, 0) === false);
check('los mensajes de error salen legibles', det.errorMessage === '' && tra.errorMessage === '');

/* ── 5 · El monitor pinta las manos ────────────────────────────────────── */

const { Overlay2D } = await import('../src/mocap/Overlay2D.js');

// Lienzo simulado que solo cuenta trazos y circulos.
const trazos = { stroke: 0, arc: 0, colores: new Set() };
const ctxFalso = {
  set strokeStyle(v) { trazos.colores.add(v); },
  get strokeStyle() { return ''; },
  fillStyle: '', globalAlpha: 1, lineWidth: 1, lineCap: '',
  setTransform() {}, clearRect() {}, save() {}, restore() {},
  beginPath() {}, moveTo() {}, lineTo() {}, stroke() { trazos.stroke++; },
  arc() { trazos.arc++; }, fill() {},
};
const lienzoFalso = { clientWidth: 480, clientHeight: 270, width: 0, height: 0, getContext: () => ctxFalso };

const overlay = new Overlay2D(lienzoFalso, settings);
const fuente = { active: true, size: { width: 640, height: 480 } };
const manoDibujable = { side: 'left', points: new Array(21).fill(null).map((_, i) => ({ x: 0.4 + i * 0.005, y: 0.5 })) };

overlay.draw(fuente, null, [manoDibujable]);
check('el monitor pinta la mano aunque no haya pose', trazos.arc === 21 && trazos.stroke === 21,
  `(puntos=${trazos.arc} trazos=${trazos.stroke})`);
check('la mano izquierda se pinta con su color', trazos.colores.has('#4fc1ff'));
trazos.stroke = 0; trazos.arc = 0; trazos.colores.clear();
overlay.draw(fuente, null, [{ side: 'right', points: manoDibujable.points }]);
check('la mano derecha se pinta con el otro color', trazos.colores.has('#e8a45c'));
trazos.arc = 0;
overlay.draw(fuente, null, []);
check('sin manos ni pose no se pinta nada', trazos.arc === 0);

/* ── 6 · Pulsar un punto del monitor elige un hueso ────────────────────── */

const { boneForLandmark } = await import('../src/pose/landmarks.js');

check('el punto del hombro apunta al brazo del mismo lado', boneForLandmark(11, false) === 'leftArm');
check('con espejo el lado se cruza, como en el retargeting', boneForLandmark(11, true) === 'rightArm');
check('los puntos de la cara comparten la cabeza', boneForLandmark(0, true) === 'head' && boneForLandmark(7, false) === 'head');
check('un indice fuera de rango no devuelve hueso', boneForLandmark(99, false) === null);

// El lienzo simulado necesita una caja en pantalla para traducir el cursor.
lienzoFalso.getBoundingClientRect = () => ({ left: 0, top: 0, width: 480, height: 270 });

// 33 puntos, todos visibles; el 11 se aparta del centro para que el espejo se note.
const cuadroPose = { landmarks: Array.from({ length: 33 }, () => ({ x: 0.9, y: 0.9, z: 0, visibility: 1 })) };
cuadroPose.landmarks[11] = { x: 0.25, y: 0.5, z: 0, visibility: 1 };

settings.set('mocap.mirror', true);
overlay.draw(fuente, cuadroPose, null);
// rect = {x:60, y:0, w:360, h:270} -> el punto cae en 150 px y el espejo lo lleva a 330.
check('se localiza el punto pulsado con el espejo puesto', overlay.pick(330, 135) === 11,
  `(indice=${overlay.pick(330, 135)})`);
check('lejos de cualquier punto no se selecciona nada', overlay.pick(20, 20) === -1);

settings.set('mocap.mirror', false);
overlay.draw(fuente, cuadroPose, null);
check('sin espejo el punto esta en su sitio', overlay.pick(150, 135) === 11,
  `(indice=${overlay.pick(150, 135)})`);

overlay.clear();
check('limpiar el monitor deja de aceptar pulsaciones', overlay.pick(150, 135) === -1);

console.log(`\n${ok} correctas / ${fail} fallos`);
process.exit(fail ? 1 : 0);
