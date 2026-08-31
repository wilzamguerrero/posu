/**
 * HandTracker
 * ===========
 * Segundo detector de MediaPipe (Hand Landmarker, 21 puntos por mano) dedicado
 * a mover las falanges del personaje. El Pose Landmarker solo entrega la muneca
 * y un par de puntos de la mano, insuficientes para los dedos, asi que los
 * dedos necesitan su propio modelo.
 *
 * Como se obtienen los angulos
 * ----------------------------
 * No se copian rotaciones: se miden angulos entre segmentos, que es lo unico
 * que no depende de la orientacion de la camara ni del tamano de la mano.
 *
 *   metacarpo  m = nudillo − muneca
 *   falanges   v1 = pip − mcp,  v2 = dip − pip,  v3 = punta − dip
 *
 *   flexion 1 (nudillo) = angulo(m, v1) − holgura     · el dedo se dobla hacia la palma
 *   flexion 2 (media)   = angulo(v1, v2)
 *   flexion 3 (punta)   = angulo(v2, v3)
 *
 * Los angulos van sin signo porque las articulaciones media y distal no pueden
 * hiperextenderse; en el nudillo se resta una holgura para que una mano abierta
 * (donde el metacarpo y la falange nunca estan perfectamente alineados) quede
 * en cero y no con los dedos medio cerrados.
 *
 * La apertura entre dedos sale del angulo entre la falange del indice y la del
 * menique, y la separacion del pulgar del angulo entre su metacarpo y el eje de
 * la palma. Los tres valores se entregan a `HandRig.applyAngles`, que ya sabe
 * sobre que ejes anatomicos girar cada falange en cualquier esqueleto Mixamo.
 *
 * Se usan los puntos metricos (`worldLandmarks`, en metros) y no los
 * normalizados, porque estos ultimos estan deformados por la relacion de
 * aspecto del video y falsearian todos los angulos.
 *
 * De que mano es cada deteccion
 * -----------------------------
 * La etiqueta `handedness` de MediaPipe se calcula suponiendo que la imagen
 * llega en espejo, asi que es poco fiable como fuente unica. Cuando hay una
 * pose detectada se decide por cercania: la muneca de cada mano se compara con
 * los puntos 15 y 16 de la pose (munecas izquierda y derecha anatomicas), que
 * son fiables. La etiqueta queda solo como respaldo.
 *
 * El intercambio final por «Vista en espejo» es el mismo que aplica el motor de
 * pose, para que dedos y brazos nunca acaben en lados distintos.
 */

import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { HAND_MODEL, WASM_PATH } from '../config.js';
import { errorText } from '../core/errors.js';
import { SquarePad } from './SquarePad.js';

const DEG = Math.PI / 180;

/** Lado maximo del lienzo que se envia al modelo de manos. */
const SQUARE_MAX = 384;

/** Indices de MediaPipe por dedo: [base del metacarpo, mcp, pip, dip, punta]. */
const CHAINS = {
  thumb: [0, 1, 2, 3, 4],
  index: [0, 5, 6, 7, 8],
  middle: [0, 9, 10, 11, 12],
  ring: [0, 13, 14, 15, 16],
  pinky: [0, 17, 18, 19, 20],
};

/** Holgura del nudillo: con la mano abierta el metacarpo y la falange no se alinean. */
const SLACK = { thumb: 8 * DEG, index: 12 * DEG, middle: 10 * DEG, ring: 10 * DEG, pinky: 12 * DEG };

/** Topes de la separacion, en radianes (coinciden con los del rig). */
const SPREAD_MAX = 22 * DEG;
const THUMB_OUT_MAX = 46 * DEG;
const SPREAD_SLACK = 18 * DEG;
const THUMB_SLACK = 30 * DEG;

/* ── Geometria de los 21 puntos ───────────────────────────────────────── */

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: (a.z ?? 0) - (b.z ?? 0) });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a) => Math.hypot(a.x, a.y, a.z);

/** Angulo entre dos vectores, 0 si alguno es degenerado. */
function angle(a, b) {
  const n = len(a) * len(b);
  if (n < 1e-9) return 0;
  return Math.acos(Math.max(-1, Math.min(1, dot(a, b) / n)));
}

/**
 * Convierte los 21 puntos de una mano en los angulos que espera el rig.
 * @param {Array<{x:number,y:number,z:number}>} p puntos metricos de la mano
 * @returns {{thumb:number[], index:number[], middle:number[], ring:number[], pinky:number[], spread:number, thumbOut:number}|null}
 */
export function handAngles(p) {
  if (!p || p.length < 21) return null;
  const out = {};
  for (const [dedo, idx] of Object.entries(CHAINS)) {
    const m = sub(p[idx[1]], p[idx[0]]);          // metacarpo
    const v1 = sub(p[idx[2]], p[idx[1]]);
    const v2 = sub(p[idx[3]], p[idx[2]]);
    const v3 = sub(p[idx[4]], p[idx[3]]);
    out[dedo] = [
      Math.max(0, angle(m, v1) - (SLACK[dedo] ?? 10 * DEG)),
      angle(v1, v2),
      angle(v2, v3),
    ];
  }
  // Apertura: cuanto se abren indice y menique respecto a la mano cerrada.
  const abanico = angle(sub(p[6], p[5]), sub(p[18], p[17]));
  out.spread = Math.max(0, Math.min(SPREAD_MAX, (abanico - SPREAD_SLACK) * 0.5));
  // Pulgar hacia fuera: su metacarpo contra el eje de la palma (muneca → corazon).
  const eje = sub(p[9], p[0]);
  out.thumbOut = Math.max(0, Math.min(THUMB_OUT_MAX, angle(sub(p[2], p[1]), eje) - THUMB_SLACK));
  return out;
}

/**
 * Decide a que mano del personaje corresponde una deteccion.
 *
 * La etiqueta `handedness` de MediaPipe se calcula suponiendo que la imagen
 * llega en espejo, asi que solo se usa de respaldo: cuando hay una pose
 * detectada se decide por cercania a sus munecas (puntos 15 y 16), que si son
 * anatomicas. El intercambio final por «vista en espejo» es el mismo que aplica
 * el motor de pose, para que dedos y brazos no acaben en lados distintos.
 *
 * @param {{x:number,y:number}|null} muneca  punto 0 de la mano, normalizado
 * @param {Array|null} pose                  los 33 puntos normalizados de la pose
 * @param {string} etiqueta                  'Left' | 'Right' segun MediaPipe
 * @param {boolean} espejo                   ajuste mocap.mirror
 * @returns {'left'|'right'} mano del personaje
 */
export function handSide(muneca, pose, etiqueta, espejo) {
  let anatomica = null;
  const izq = pose?.[15];
  const der = pose?.[16];
  if (muneca && izq && der) {
    const d = (p) => Math.hypot(p.x - muneca.x, p.y - muneca.y);
    const a = d(izq);
    const b = d(der);
    // Solo se hace caso si una muneca esta claramente mas cerca que la otra.
    if (Math.abs(a - b) > 0.04) anatomica = a < b ? 'left' : 'right';
  }
  // Respaldo: la etiqueta supone imagen en espejo, asi que la mano anatomica
  // es la contraria a la que declara.
  if (!anatomica) anatomica = etiqueta === 'Left' ? 'right' : 'left';
  if (!espejo) return anatomica;
  return anatomica === 'left' ? 'right' : 'left';
}

/* ── Detector ─────────────────────────────────────────────────────────── */

export class HandTracker {
  /**
   * @param {import('../core/Settings.js').Settings} settings
   * @param {import('../model/HandRig.js').HandRig} rig
   */
  constructor(settings, rig) {
    this.settings = settings;
    this.rig = rig;
    this.landmarker = null;
    this.fileset = null;
    this.signature = '';
    this.busy = false;
    this.ready = false;
    this.lastError = null;
    this.forceCpu = false;
    this._pending = null;

    this.lastDetect = 0;
    this.detections = 0;
    this.count = 0;                 // manos de la ultima deteccion
    /** @type {Array<{side:'left'|'right', points: Array}>} para el monitor. */
    this.hands = [];
    this.square = new SquarePad(SQUARE_MAX);
    /** @type {((n: number) => void)|null} */
    this.onCount = null;

    // El delegado se comparte con el detector de pose: cambiarlo obliga a
    // recrear tambien este modelo.
    settings.on(['mocap.delegate'], () => { this.forceCpu = false; this.lastError = null; });
  }

  get delegate() {
    return this.forceCpu ? 'CPU' : (this.settings.get('mocap.delegate') === 'CPU' ? 'CPU' : 'GPU');
  }

  /** El modelo de manos es el segundo de la cola, asi que se pide menos ritmo. */
  get targetFps() {
    const pedido = Number(this.settings.get('mocap.detectFps')) || 0;
    const techo = this.delegate === 'CPU' ? 8 : 24;
    return pedido > 0 ? Math.min(pedido, techo) : techo;
  }

  get stale() {
    return Boolean(this.landmarker) && this.signature !== this.#signature();
  }

  /** Lo unico que obliga a recrear el modelo es el delegado. */
  #signature() {
    return this.delegate;
  }

  /** Crea el detector si hace falta (una sola creacion en vuelo). */
  async ensure(onProgress) {
    const wanted = this.#signature();
    if (this.landmarker && wanted === this.signature) return this.landmarker;
    if (this._pending) {
      try { await this._pending; } catch { /* se reintenta abajo */ }
      if (this.landmarker && this.#signature() === this.signature) return this.landmarker;
    }
    this._pending = this.#create(onProgress);
    try {
      return await this._pending;
    } finally {
      this._pending = null;
    }
  }

  async #create(onProgress) {
    onProgress?.('Cargando runtime de MediaPipe…');
    this.fileset ??= await FilesetResolver.forVisionTasks(WASM_PATH);
    const delegate = this.delegate;
    const options = {
      baseOptions: { modelAssetPath: HAND_MODEL, delegate },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: this.settings.get('mocap.minDetection') ?? 0.5,
      minHandPresenceConfidence: this.settings.get('mocap.minPresence') ?? 0.5,
      minTrackingConfidence: this.settings.get('mocap.minTracking') ?? 0.5,
    };
    onProgress?.('Cargando el modelo de manos…');
    const previo = this.landmarker;
    try {
      this.landmarker = await HandLandmarker.createFromOptions(this.fileset, options);
    } catch (err) {
      if (delegate === 'GPU' && !this.forceCpu) {
        console.warn('[Manos] la GPU no esta disponible, se usa CPU:', errorText(err));
        this.forceCpu = true;
        return this.#create(onProgress);
      }
      this.ready = false;
      this.lastError = err;
      throw err;
    }
    previo?.close?.();
    this.signature = this.#signature();
    this.ready = true;
    this.lastError = null;
    this.lastDetect = 0;
    return this.landmarker;
  }

  #side(puntos, pose, etiqueta) {
    return handSide(puntos?.[0], pose, etiqueta, this.settings.get('mocap.mirror') === true);
  }

  /**
   * Detecta las manos del fotograma y mueve las falanges del personaje.
   * @param {HTMLVideoElement} video
   * @param {number} timestampMs
   * @param {{landmarks: Array}|null} [poseFrame] pose del mismo fotograma
   * @returns {boolean} true si se aplico alguna mano
   */
  update(video, timestampMs, poseFrame = null) {
    if (!this.landmarker || this.busy) return false;
    if (this.settings.get('mocap.hands') !== true) return false;
    if (this.settings.get('mocap.frozen') === true) return false;
    if (!this.rig?.ready) return false;
    if (!video || video.readyState < 2 || !video.videoWidth) return false;

    const periodo = 1000 / this.targetFps;
    if (timestampMs - this.lastDetect < periodo - 1) return false;
    this.lastDetect = timestampMs;

    this.busy = true;
    try {
      const cuadrado = this.#squareWanted() ? this.square.input(video) : null;
      if (!cuadrado) this.square.reset();
      const out = this.landmarker.detectForVideo(cuadrado ?? video, timestampMs);
      const manos = out?.landmarks ?? [];
      const mundo = out?.worldLandmarks ?? [];
      const etiquetas = out?.handednesses ?? out?.handedness ?? [];

      const suave = Number(this.settings.get('mocap.handSmoothing'));
      const smooth = Number.isFinite(suave) ? Math.max(0.05, Math.min(1, suave)) : 0.45;
      const hechas = new Set();
      let aplicadas = 0;
      this.hands = [];

      for (let i = 0; i < manos.length; i++) {
        // Los puntos metricos dan angulos correctos; los normalizados solo
        // sirven para saber de que lado esta la mano en la imagen.
        const angulos = handAngles(mundo[i] ?? manos[i]);
        if (!angulos) continue;
        const normal = this.square.pad ? this.square.unpad(manos[i]) : manos[i];
        const lado = this.#side(normal, poseFrame?.landmarks ?? null, etiquetas[i]?.[0]?.categoryName ?? '');
        // Si el modelo devuelve dos manos para el mismo lado, manda la primera
        // (MediaPipe las ordena por confianza).
        if (hechas.has(lado)) continue;
        hechas.add(lado);
        if (!this.rig.applyAngles(lado, angulos, smooth)) continue;
        aplicadas++;
        this.hands.push({ side: lado, points: normal });
      }

      this.detections++;
      if (this.count !== aplicadas) {
        this.count = aplicadas;
        this.onCount?.(aplicadas);
      }
      return aplicadas > 0;
    } catch (err) {
      this.lastError = err;
      const texto = errorText(err);
      if (/square ROI|IMAGE_DIMENSIONS/i.test(texto) && this.settings.get('mocap.square') === 'no') {
        this.settings.set('mocap.square', 'auto');
      } else {
        console.warn('[Manos] error en detectForVideo:', texto);
      }
      return false;
    } finally {
      this.busy = false;
    }
  }

  /** El grafo de CPU tambien exige region cuadrada aqui. */
  #squareWanted() {
    const modo = this.settings.get('mocap.square');
    if (modo === 'si') return true;
    if (modo === 'no') return false;
    return this.delegate === 'CPU';
  }

  /** Mensaje legible del ultimo fallo. */
  get errorMessage() {
    return this.lastError ? errorText(this.lastError) : '';
  }

  dispose() {
    this.landmarker?.close?.();
    this.landmarker = null;
    this.ready = false;
    this.signature = '';
    this.count = 0;
    this.hands = [];
    this.square.dispose();
  }
}
