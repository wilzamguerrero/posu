/**
 * POSU · Filtro One Euro
 * ---------------------------------------------------------------------------
 * Suavizado adaptativo: filtra mucho cuando el punto esta quieto (elimina el
 * temblor del detector) y poco cuando se mueve rapido (no añade retardo). Es el
 * filtro que usa MediaPipe internamente y funciona mucho mejor que una media
 * exponencial fija para datos de vision por computador.
 *
 *   alfa = 1 / (1 + tau/te)      tau = 1 / (2·pi·fc)
 *   fc   = minCutoff + beta·|derivada|
 */

function alpha(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

class Scalar {
  constructor(minCutoff, beta, dCutoff) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = null;
    this.dx = 0;
  }

  filter(value, dt) {
    if (this.x === null) {
      this.x = value;
      return value;
    }
    const dxRaw = (value - this.x) / dt;
    const aD = alpha(this.dCutoff, dt);
    this.dx = aD * dxRaw + (1 - aD) * this.dx;

    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    const a = alpha(cutoff, dt);
    this.x = a * value + (1 - a) * this.x;
    return this.x;
  }

  reset() {
    this.x = null;
    this.dx = 0;
  }
}

export class OneEuroFilter {
  /** @param {{freq?:number, minCutoff?:number, beta?:number, dCutoff?:number}} opts */
  constructor({ freq = 30, minCutoff = 1.2, beta = 0.35, dCutoff = 1 } = {}) {
    this.freq = freq;
    this.opts = { minCutoff, beta, dCutoff };
    this.channels = new Map();
  }

  configure({ freq, minCutoff, beta, dCutoff } = {}) {
    if (freq !== undefined) this.freq = freq;
    if (minCutoff !== undefined) this.opts.minCutoff = minCutoff;
    if (beta !== undefined) this.opts.beta = beta;
    if (dCutoff !== undefined) this.opts.dCutoff = dCutoff;
    for (const ch of this.channels.values()) Object.assign(ch, this.opts);
  }

  /** Filtra un valor identificado por una clave estable. */
  value(key, v, dt = 1 / this.freq) {
    let ch = this.channels.get(key);
    if (!ch) {
      ch = new Scalar(this.opts.minCutoff, this.opts.beta, this.opts.dCutoff);
      this.channels.set(key, ch);
    }
    return ch.filter(v, Math.max(dt, 1e-3));
  }

  /** Filtra un Vector3 in situ usando tres canales derivados de la clave. */
  vector(key, vec, dt) {
    vec.x = this.value(`${key}.x`, vec.x, dt);
    vec.y = this.value(`${key}.y`, vec.y, dt);
    vec.z = this.value(`${key}.z`, vec.z, dt);
    return vec;
  }

  reset() {
    for (const ch of this.channels.values()) ch.reset();
  }
}
