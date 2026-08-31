/**
 * Overlay2D
 * =========
 * Dibuja el esqueleto de MediaPipe encima del monitor de captura. El video (o la
 * imagen) lo muestra el propio elemento HTML del monitor; aqui solo se pintan
 * los 33 puntos y sus conexiones, con fondo transparente.
 *
 * Dos detalles de encaje:
 *   - El medio se muestra con `object-fit: contain`, asi que hay que calcular el
 *     rectangulo real que ocupa dentro del recuadro y mapear los puntos a el;
 *     si no, el esqueleto se desplaza cuando la camara no es 4:3.
 *   - En modo espejo el elemento de video lleva `transform: scaleX(-1)` por CSS,
 *     asi que el lienzo se voltea igual para que todo cuadre.
 *
 * Si un punto tiene poca visibilidad se pinta en rojo y translucido: es la pista
 * visual de que ese hueso no se esta moviendo.
 *
 * Cuando los dedos por camara estan activos se pintan tambien los 21 puntos de
 * cada mano detectada, con el color del lado al que se han asignado: es la unica
 * forma de ver de un vistazo si la mano se esta perdiendo o cambiando de lado.
 */

import { POSE_CONNECTIONS, LM } from '../pose/landmarks.js';

const COLOR = {
  torso: '#c586c0',
  izquierda: '#4fc1ff',
  derecha: '#e8a45c',
  cabeza: '#9cdcfe',
  punto: '#f2f2f2',
  bajo: '#f14c4c',
};

/** Los indices impares de MediaPipe corresponden al lado izquierdo del sujeto. */
const LEFT_SET = new Set([1, 2, 3, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31]);

const TORSO = new Set([
  `${LM.LEFT_SHOULDER}-${LM.RIGHT_SHOULDER}`,
  `${LM.LEFT_HIP}-${LM.RIGHT_HIP}`,
  `${LM.LEFT_SHOULDER}-${LM.LEFT_HIP}`,
  `${LM.RIGHT_SHOULDER}-${LM.RIGHT_HIP}`,
]);

function colorFor(a, b) {
  if (a <= LM.MOUTH_RIGHT || b <= LM.MOUTH_RIGHT) return COLOR.cabeza;
  if (TORSO.has(`${a}-${b}`) || TORSO.has(`${b}-${a}`)) return COLOR.torso;
  return LEFT_SET.has(a) ? COLOR.izquierda : COLOR.derecha;
}

/** Conexiones del Hand Landmarker: palma y las cuatro falanges de cada dedo. */
const HAND_LINKS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

export class Overlay2D {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('../core/Settings.js').Settings} settings
   */
  constructor(canvas, settings) {
    this.canvas = canvas;
    this.settings = settings;
    this.ctx = canvas.getContext('2d');
    this.rect = { x: 0, y: 0, w: 0, h: 0 };
  }

  /** Ajusta el buffer del lienzo a su caja CSS y calcula el area del medio. */
  #fit(source) {
    const cssW = this.canvas.clientWidth;
    const cssH = this.canvas.clientHeight;
    if (!cssW || !cssH) return false;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(cssW * dpr);
    const h = Math.round(cssH * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }

    const { width: sw, height: sh } = source.size;
    if (!sw || !sh) return false;
    // Rectangulo equivalente a object-fit: contain.
    const scale = Math.min(w / sw, h / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    this.rect = { x: (w - dw) / 2, y: (h - dh) / 2, w: dw, h: dh };
    return true;
  }

  /**
   * @param {import('./MocapSource.js').MocapSource} source
   * @param {{landmarks: Array}|null} frame
   */
  draw(source, frame, manos = null) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!source?.active || !this.#fit(source)) return this.clear();

    const W = this.canvas.width;
    const H = this.canvas.height;
    const { x: ox, y: oy, w: dw, h: dh } = this.rect;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const lms = frame?.landmarks;
    if (!lms?.length && !manos?.length) return;

    const mirror = !!this.settings.get('mocap.mirror');
    const minVis = this.settings.get('mocap.confidence');
    const px = (p) => ox + p.x * dw;
    const py = (p) => oy + p.y * dh;

    ctx.save();
    // El monitor voltea el video por CSS cuando el espejo esta activo.
    if (mirror) ctx.setTransform(-1, 0, 0, 1, W, 0);

    const scale = Math.max(1, W / 480);
    ctx.lineWidth = 2.6 * scale;
    ctx.lineCap = 'round';
    for (const [a, b] of lms?.length ? POSE_CONNECTIONS : []) {
      const p = lms[a];
      const q = lms[b];
      if (!p || !q) continue;
      const weak = (p.visibility ?? 1) < minVis || (q.visibility ?? 1) < minVis;
      ctx.globalAlpha = weak ? 0.25 : 0.9;
      ctx.strokeStyle = weak ? COLOR.bajo : colorFor(a, b);
      ctx.beginPath();
      ctx.moveTo(px(p), py(p));
      ctx.lineTo(px(q), py(q));
      ctx.stroke();
    }
    for (let i = 0; lms && i < lms.length; i++) {
      const p = lms[i];
      if (!p) continue;
      const v = p.visibility ?? 1;
      ctx.globalAlpha = v < minVis ? 0.35 : 1;
      ctx.fillStyle = v < minVis ? COLOR.bajo : COLOR.punto;
      ctx.beginPath();
      ctx.arc(px(p), py(p), (i <= LM.MOUTH_RIGHT ? 1.8 : 2.9) * scale, 0, Math.PI * 2);
      ctx.fill();
    }
    // Manos: el trazo es mas fino que el del cuerpo para no tapar los dedos.
    for (const mano of manos ?? []) {
      const pts = mano?.points;
      if (!pts?.length) continue;
      const tono = mano.side === 'left' ? COLOR.izquierda : COLOR.derecha;
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = tono;
      ctx.lineWidth = 1.8 * scale;
      for (const [a, b] of HAND_LINKS) {
        const p = pts[a];
        const q = pts[b];
        if (!p || !q) continue;
        ctx.beginPath();
        ctx.moveTo(px(p), py(p));
        ctx.lineTo(px(q), py(q));
        ctx.stroke();
      }
      ctx.fillStyle = tono;
      for (const p of pts) {
        if (!p) continue;
        ctx.beginPath();
        ctx.arc(px(p), py(p), 1.7 * scale, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();
    ctx.globalAlpha = 1;
  }

  clear() {
    if (!this.ctx) return;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
}
