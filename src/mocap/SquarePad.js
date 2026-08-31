/**
 * SquarePad
 * =========
 * Encuadre cuadrado con bandas negras para los grafos de MediaPipe que solo
 * aceptan una region de interes cuadrada.
 *
 * El delegado CPU (tanto del Pose Landmarker como del Hand Landmarker) rechaza
 * cualquier entrada que no sea 1:1 con el error "Using NORM_RECT without
 * IMAGE_DIMENSIONS is only supported for the square ROI" y no devuelve ningun
 * punto. La solucion es dibujar el video en un lienzo cuadrado, centrado y con
 * bandas negras arriba y abajo (o a los lados), y despues deshacer ese encuadre
 * en los puntos que devuelve el modelo:
 *
 *     x_imagen = (x_cuadrado · S − offX) / w
 *     y_imagen = (y_cuadrado · S − offY) / h
 *
 * La `z` normalizada de MediaPipe comparte escala con la `x`, asi que se
 * reescala igual que ella. Los puntos metricos (`worldLandmarks`) estan en
 * metros respecto al cuerpo y no dependen del encuadre: no se tocan.
 *
 * Ademas de cuadrar, el lienzo reduce la resolucion (`max`), que es la otra
 * mitad del problema de la CPU: a 1280x720 una inferencia puede costar mas de
 * 100 ms, y a 512x512 baja a la mitad sin perder precision util.
 */

/** Tamano real en pixeles de un video, imagen, lienzo o bitmap. */
export function sizeOf(el) {
  const w = el?.videoWidth || el?.naturalWidth || el?.width || 0;
  const h = el?.videoHeight || el?.naturalHeight || el?.height || 0;
  return { w, h };
}

export class SquarePad {
  /** @param {number} [max] Lado maximo del lienzo cuadrado. */
  constructor(max = 512) {
    this.max = max;
    this.canvas = null;
    this.ctx = null;
    /** @type {{S:number, offX:number, offY:number, w:number, h:number}|null} */
    this.pad = null;
  }

  /**
   * Dibuja la fuente centrada en el lienzo cuadrado y guarda el encuadre.
   * @returns {HTMLCanvasElement|null} el lienzo listo para el detector.
   */
  input(el, max = this.max) {
    const { w, h } = sizeOf(el);
    if (!w || !h) return null;
    const lado = Math.max(w, h);
    const k = Math.min(1, max / lado);
    const S = Math.round(lado * k);
    const w2 = Math.max(1, Math.round(w * k));
    const h2 = Math.max(1, Math.round(h * k));
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d', { alpha: false, willReadFrequently: false });
    }
    if (this.canvas.width !== S || this.canvas.height !== S) {
      this.canvas.width = S;
      this.canvas.height = S;
    }
    const offX = Math.round((S - w2) / 2);
    const offY = Math.round((S - h2) / 2);
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, S, S);
    this.ctx.drawImage(el, offX, offY, w2, h2);
    this.pad = { S, offX, offY, w: w2, h: h2 };
    return this.canvas;
  }

  /** Devuelve una lista de puntos normalizados a las coordenadas originales. */
  unpad(lista) {
    const pad = this.pad;
    if (!Array.isArray(lista) || !pad) return lista;
    const { S, offX, offY, w, h } = pad;
    return lista.map((p) => ({
      ...p,
      x: (p.x * S - offX) / w,
      y: (p.y * S - offY) / h,
      z: typeof p.z === 'number' ? (p.z * S) / w : p.z,
    }));
  }

  /** Igual que `unpad`, pero sobre un `{landmarks, worldLandmarks}`. */
  unpadFrame(frame) {
    if (!frame?.landmarks || !this.pad) return frame;
    frame.landmarks = this.unpad(frame.landmarks);
    return frame;
  }

  /** Olvida el ultimo encuadre (la fuente ya no pasa por el lienzo). */
  reset() {
    this.pad = null;
  }

  /** Libera el lienzo. */
  dispose() {
    this.canvas = null;
    this.ctx = null;
    this.pad = null;
  }
}
