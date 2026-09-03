/**
 * Lapiz del visor: geometria del trazo y captura del puntero.
 *
 * jsdom no trae lienzos de verdad, asi que el contexto 2D y Path2D se sustituyen
 * por dos grabadoras: lo que se comprueba es la logica (presion, velocidad,
 * borrador, deshacer) y que el lapiz se queda el gesto antes de que lo vean los
 * controles de orbita.
 */
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const dom = new JSDOM('<!doctype html><html><body><div id="v"></div></body></html>',
  { pretendToBeVisual: true });
const { window } = dom;
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event',
  'MouseEvent', 'PointerEvent', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle']) {
  if (window[k] === undefined) continue;
  try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch { /* ya esta */ }
}
globalThis.performance ??= window.performance;
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
globalThis.ResizeObserver = class { observe() {} disconnect() {} };

/** Path2D de mentira: solo apunta los tramos que le piden. */
globalThis.Path2D = class {
  constructor() { this.ops = []; }
  moveTo(...a) { this.ops.push(['moveTo', ...a]); }
  lineTo(...a) { this.ops.push(['lineTo', ...a]); }
  quadraticCurveTo(...a) { this.ops.push(['quad', ...a]); }
  arc(...a) { this.ops.push(['arc', ...a]); }
  closePath() { this.ops.push(['close']); }
};

/** Contexto 2D de mentira. */
function fakeCtx() {
  const ctx = {
    fills: [], clears: 0, fillStyle: '', globalAlpha: 1,
    setTransform() {}, clearRect() { ctx.clears++; },
    save() {}, restore() {},
    fill(path) { ctx.fills.push({ path, alpha: ctx.globalAlpha, color: ctx.fillStyle }); },
    stroke() {}, beginPath() {}, arc() {}, moveTo() {}, lineTo() {}, closePath() {},
    drawImage() {},
  };
  return ctx;
}

const W = 800;
const H = 600;
function fakeCanvas() {
  const c = window.document.createElement('canvas');
  const ctx = fakeCtx();
  c.getContext = () => ctx;
  Object.defineProperty(c, 'clientWidth', { value: W, configurable: true });
  Object.defineProperty(c, 'clientHeight', { value: H, configurable: true });
  c.getBoundingClientRect = () => ({ left: 0, top: 0, right: W, bottom: H, width: W, height: H, x: 0, y: 0 });
  window.document.getElementById('v').appendChild(c);
  return c;
}

const fails = [];
const oks = [];
const check = (name, cond, extra = '') => {
  (cond ? oks : fails).push(name + (extra ? ' :: ' + extra : ''));
  console.log((cond ? 'OK   ' : 'FALLA') + ' ' + name + (extra ? '  (' + extra + ')' : ''));
};

const { Settings } = await import('../src/core/Settings.js');
const { DEFAULTS } = await import('../src/config.js');
const { Sketch } = await import('../src/draw/Sketch.js');
const { strokePath, taper, streamline, decimate, resample, extend, pathLength } = await import('../src/draw/stroke.js');

/* ── 1 · Geometria del trazo ─────────────────────────────────────────── */

const recta = [
  { x: 10, y: 10, w: 4 }, { x: 40, y: 10, w: 4 }, { x: 70, y: 10, w: 4 }, { x: 100, y: 10, w: 4 },
];
const path = strokePath(recta);
const finitos = path.ops.every((op) => op.slice(1).every((n) => typeof n !== 'number' || Number.isFinite(n)));
check('el contorno del trazo sale con numeros finitos', finitos);
check('el contorno se cierra', path.ops.some((op) => op[0] === 'close'));
check('lleva las dos tapas redondas', path.ops.filter((op) => op[0] === 'arc').length === 2);
check('un solo punto sale como un circulo',
  strokePath([{ x: 5, y: 5, w: 3 }]).ops.filter((o) => o[0] === 'arc').length === 1);

const afilado = taper(recta, { start: 30, end: 30 });
check('afilar adelgaza las puntas y respeta el centro',
  afilado[0].w < 0.5 && afilado[3].w < 0.5 && afilado[1].w > afilado[0].w,
  afilado.map((p) => p.w.toFixed(2)).join(' / '));

const zigzag = [{ x: 0, y: 0, w: 1 }, { x: 30, y: 0, w: 1 }, { x: 0, y: 6, w: 1 }, { x: 30, y: 6, w: 1 }];
const estable = streamline(zigzag, 0.7);
check('el estabilizador acerca los puntos intermedios a la linea',
  Math.abs(estable[1].x) < Math.abs(zigzag[1].x) && estable.at(-1).x === 30,
  'x=' + estable.map((p) => p.x.toFixed(1)).join(','));
check('los puntos pegados se descartan',
  decimate([{ x: 0, y: 0, w: 1 }, { x: 0.1, y: 0, w: 1 }, { x: 20, y: 0, w: 1 }], 1).length === 2);

// Cadena con tramos muy desiguales: dos largos y tres puntos casi encima en el
// medio. Es la forma de un ritmo de brazo a brazo, y con nudos uniformes la
// curva se pasaba de largo y dejaba un rizo justo ahi.
const desigual = [
  { x: 0, y: 200 }, { x: 120, y: 120 }, { x: 240, y: 62 },
  { x: 250, y: 56 }, { x: 260, y: 62 }, { x: 380, y: 120 }, { x: 500, y: 200 },
];
{
  const curva = resample(desigual, 90);
  const techo = Math.min(...desigual.map((p) => p.y));
  const alto = Math.min(...curva.map((p) => p.y));
  check('el remuestreo no se pasa del poligono de control', alto >= techo - 1.5,
    'control ' + techo + ' · curva ' + alto.toFixed(1));
  const empieza = Math.hypot(curva[0].x - desigual[0].x, curva[0].y - desigual[0].y);
  const acaba = Math.hypot(curva.at(-1).x - desigual.at(-1).x, curva.at(-1).y - desigual.at(-1).y);
  check('y pasa por los dos extremos', empieza < 0.01 && acaba < 0.01,
    empieza.toFixed(3) + ' / ' + acaba.toFixed(3));
  // Una curva que fluye avanza siempre en el mismo sentido: si se rizara, la x
  // retrocederia en algun punto.
  let atras = 0;
  for (let i = 1; i < curva.length; i++) if (curva[i].x < curva[i - 1].x - 0.01) atras++;
  check('la curva avanza sin retroceder', atras === 0, atras + ' retrocesos');
}
{
  const largo = pathLength(desigual);
  const abierta = extend(resample(desigual, 60), 40);
  check('prolongar alarga el trazo por las dos puntas',
    abierta[0].x < 0 && abierta.at(-1).x > 500 && pathLength(abierta) > largo,
    abierta[0].x.toFixed(0) + ' .. ' + abierta.at(-1).x.toFixed(0));
}

/* ── 2 · Captura del puntero ─────────────────────────────────────────── */

const gl = fakeCanvas();
const lienzo = fakeCanvas();
const vivo = fakeCanvas();
const settings = new Settings(DEFAULTS, null);
const viewport = { renderer: { domElement: gl } };
const sketch = new Sketch({ settings, viewport, canvas: lienzo, live: vivo });

// Quien mire el lienzo 3D no debe recibir nada mientras el lapiz manda.
let alVisor = 0;
gl.addEventListener('pointerdown', () => { alVisor++; });
gl.addEventListener('pointermove', () => { alVisor++; });

let reloj = 1000;
/** Evento de puntero con todo lo que lee el lapiz. */
function pev(type, { x = 100, y = 100, dt = 16, tipo = 'mouse', presion = 0, boton = 0, botones = 1, alt = false } = {}) {
  reloj += dt;
  const ev = new window.MouseEvent(type, {
    clientX: x, clientY: y, button: boton, buttons: botones, altKey: alt, bubbles: true, cancelable: true,
  });
  for (const [k, v] of Object.entries({ pointerId: 1, pointerType: tipo, pressure: presion, timeStamp: reloj })) {
    Object.defineProperty(ev, k, { value: v, configurable: true });
  }
  return ev;
}
const traza = (puntos, opts = {}) => {
  gl.dispatchEvent(pev('pointerdown', { ...puntos[0], ...opts }));
  for (const p of puntos.slice(1)) gl.dispatchEvent(pev('pointermove', { ...p, ...opts }));
  gl.dispatchEvent(pev('pointerup', { ...puntos.at(-1), ...opts, botones: 0 }));
};
const flush = () => new Promise((r) => setTimeout(r, 30));
const medio = (s) => s.points.reduce((n, p) => n + p.f, 0) / s.points.length;

// Con el lapiz apagado, el visor recibe sus eventos como siempre.
traza([{ x: 100, y: 100 }, { x: 140, y: 120 }]);
check('apagado, el lapiz no dibuja ni estorba', sketch.count === 0 && alVisor > 0, alVisor + ' avisos al visor');

settings.set('draw.enabled', true);
alVisor = 0;
traza([{ x: 100, y: 300 }, { x: 150, y: 300 }, { x: 200, y: 310 }, { x: 260, y: 320 }]);
await flush();
check('encendido, un gesto deja un trazo', sketch.count === 1, sketch.count + ' trazos');
check('y el visor no se entera del gesto', alVisor === 0, alVisor + ' avisos al visor');
check('el trazo guarda todos los puntos', (sketch.strokes[0]?.points.length ?? 0) === 4,
  (sketch.strokes[0]?.points.length ?? 0) + ' puntos');
check('las coordenadas se guardan normalizadas y centradas',
  Math.abs(sketch.strokes[0].points[0].x - (100 - W / 2) / H) < 1e-9
  && Math.abs(sketch.strokes[0].points[0].y - (300 - H / 2) / H) < 1e-9);

// Velocidad: el mismo recorrido lento sale mas gordo que rapido.
sketch.clear();
traza([{ x: 100, y: 200, dt: 60 }, { x: 110, y: 200, dt: 60 }, { x: 120, y: 200, dt: 60 }, { x: 130, y: 200, dt: 60 }]);
const lento = medio(sketch.strokes[0]);
sketch.clear();
traza([{ x: 100, y: 200, dt: 4 }, { x: 260, y: 200, dt: 4 }, { x: 420, y: 200, dt: 4 }, { x: 580, y: 200, dt: 4 }]);
const rapido = medio(sketch.strokes[0]);
check('sin presion, el trazo rapido sale mas fino que el lento', rapido < lento - 0.1,
  'lento=' + lento.toFixed(2) + ' rapido=' + rapido.toFixed(2));

// Presion de pluma: manda ella, no la velocidad.
sketch.clear();
traza([{ x: 100, y: 200, tipo: 'pen', presion: 0.95 }, { x: 200, y: 200, tipo: 'pen', presion: 0.95 }]);
const fuerte = medio(sketch.strokes[0]);
sketch.clear();
traza([{ x: 100, y: 200, tipo: 'pen', presion: 0.1 }, { x: 200, y: 200, tipo: 'pen', presion: 0.1 }]);
const suave = medio(sketch.strokes[0]);
check('con pluma, apretar engorda el trazo', fuerte > suave + 0.3,
  'fuerte=' + fuerte.toFixed(2) + ' suave=' + suave.toFixed(2));

// Alt deja pasar el gesto: orbitar sin apagar el lapiz.
sketch.clear();
alVisor = 0;
traza([{ x: 100, y: 100, alt: true }, { x: 160, y: 130, alt: true }]);
check('con Alt se orbita sin dibujar', sketch.count === 0 && alVisor > 0, alVisor + ' avisos al visor');

// El dedo navega salvo que se pida lo contrario.
sketch.clear();
traza([{ x: 100, y: 100, tipo: 'touch' }, { x: 160, y: 130, tipo: 'touch' }]);
check('el dedo navega por defecto', sketch.count === 0);
settings.set('draw.touch', true);
traza([{ x: 100, y: 100, tipo: 'touch' }, { x: 160, y: 130, tipo: 'touch' }]);
check('y dibuja si se activa', sketch.count === 1);
settings.set('draw.touch', false);

/* ── 3 · Borrador y deshacer ─────────────────────────────────────────── */

sketch.clear();
traza([{ x: 100, y: 400 }, { x: 300, y: 400 }]);
traza([{ x: 100, y: 100 }, { x: 300, y: 100 }]);
check('dos trazos en el lienzo', sketch.count === 2, String(sketch.count));
settings.set('draw.tool', 'borrador');
traza([{ x: 200, y: 400 }, { x: 205, y: 401 }]);
check('el borrador se lleva el trazo que toca', sketch.count === 1, sketch.count + ' queda');
check('y no toca a los demas', Math.abs(sketch.strokes[0].points[0].y - (100 - H / 2) / H) < 1e-9);
sketch.undo();
check('deshacer devuelve lo borrado', sketch.count === 2, String(sketch.count));
sketch.redo();
check('y rehacer vuelve a quitarlo', sketch.count === 1, String(sketch.count));
settings.set('draw.tool', 'lapiz');

// El historial es una pila: deshacer el borrado, y luego los dos trazos.
sketch.undo();
sketch.undo();
sketch.undo();
check('deshacer paso a paso deja el lienzo vacio', sketch.count === 0, String(sketch.count));
sketch.redo();
sketch.redo();
check('rehacer los recupera en orden', sketch.count === 2, String(sketch.count));

sketch.clear();
check('vaciar deja el lienzo limpio', sketch.count === 0);
sketch.undo();
check('y se puede deshacer', sketch.count === 2, String(sketch.count));

/* ── 4 · Volcado para la captura PNG ─────────────────────────────────── */

const destino = fakeCtx();
sketch.renderTo(destino, 1600, 1200);
check('el dibujo se vuelca en otro lienzo', destino.fills.length === 2, destino.fills.length + ' trazos pintados');
settings.set('draw.visible', false);
destino.fills.length = 0;
sketch.renderTo(destino, 1600, 1200);
check('oculto, no entra en la captura', destino.fills.length === 0);
settings.set('draw.visible', true);

sketch.dispose();
alVisor = 0;
traza([{ x: 100, y: 100 }, { x: 160, y: 130 }]);
check('al soltarlo deja de atrapar el puntero', alVisor > 0, alVisor + ' avisos al visor');

console.log('');
console.log(oks.length + ' correctas / ' + fails.length + ' fallos');
if (fails.length) { console.log('FALLOS:'); for (const f of fails) console.log(' - ' + f); process.exit(1); }
process.exit(0);
