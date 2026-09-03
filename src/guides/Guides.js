/**
 * Guides
 * ======
 * Reglas de dibujo sobre el visor: canon de cabezas, tercios, seccion aurea,
 * eje de simetria, linea de horizonte, diagonales, rejilla y encuadre seguro.
 *
 * Se pintan en un canvas 2D superpuesto al lienzo 3D, no dentro de la escena:
 * asi son nitidas (un pixel es un pixel), no se ven afectadas por el desenfoque
 * ni por la distorsion de lente, y no cuestan tiempo de GPU.
 *
 * El canon de cabezas y el eje de simetria se calculan proyectando la caja
 * envolvente real del personaje, de modo que siguen a la figura cuando se gira
 * la camara, se cambia de proyeccion o se ajusta la altura.
 */

import * as THREE from 'three';
import { Perspective } from './Perspective.js';
import { ActionLine } from './ActionLine.js';

const _v = new THREE.Vector3();
const _box = new THREE.Box3();

/** Relaciones de aspecto del encuadre seguro. */
const ASPECTS = {
  '1:1': 1,
  '4:5': 4 / 5,
  '3:2': 3 / 2,
  '16:9': 16 / 9,
};

export class Guides {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('../core/Settings.js').Settings} settings
   * @param {import('../core/Viewport.js').Viewport} viewport
   */
  constructor(canvas, settings, viewport) {
    this.canvas = canvas;
    this.settings = settings;
    this.viewport = viewport;
    this.ctx = canvas.getContext('2d');
    this.character = null;
    this.dpr = 1;
    /** ¿Queda algo dibujado en el lienzo? Evita borrarlo una y otra vez. */
    this.painted = false;
    // Modulos hermanos que comparten este lienzo 2D: la reticula de fugas (que
    // necesita la camara para calcular los puntos de fuga) y los trazos que
    // resumen la pose (que necesitan los huesos proyectados).
    this.perspective = new Perspective(settings, viewport);
    this.action = new ActionLine(settings, viewport);
  }

  setCharacter(character) {
    this.character = character;
    this.action.setCharacter(character);
  }

  /** ¿Hay alguna guia activa? Evita repintar cuando todo esta apagado. */
  get anyActive() {
    const g = this.settings.get('guides');
    return !!(g.heads || g.thirds || g.golden || g.symmetry || g.horizon
      || g.diagonals || g.grid > 0 || (g.safeFrame && g.safeFrame !== 'ninguno')
      || this.perspective.active || this.action.active);
  }

  #fit() {
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
    this.dpr = dpr;
    return true;
  }

  /** Proyecta un punto del mundo a pixeles del lienzo. */
  #project(point, out) {
    const cam = this.viewport.cameras.active;
    _v.copy(point).project(cam);
    out.x = (_v.x * 0.5 + 0.5) * this.canvas.width;
    out.y = (-_v.y * 0.5 + 0.5) * this.canvas.height;
    out.z = _v.z;
    return out;
  }

  draw() {
    const ctx = this.ctx;
    if (!ctx) return;
    // Con todas las guias apagadas basta con borrar una vez. Repintar un lienzo
    // a pantalla completa en cada fotograma obliga al compositor a volver a
    // subir la capa, y eso se nota sobre todo en movil.
    if (!this.anyActive) {
      if (this.painted) {
        this.clear();
        this.painted = false;
      }
      return;
    }
    if (!this.#fit()) return;
    this.painted = true;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const g = this.settings.get('guides');
    const line = Math.max(1, this.dpr);
    ctx.strokeStyle = g.color;
    ctx.fillStyle = g.color;
    ctx.globalAlpha = g.opacity;
    ctx.lineWidth = line;
    ctx.font = `${11 * this.dpr}px ui-monospace, 'Cascadia Mono', Consolas, monospace`;

    if (g.safeFrame && g.safeFrame !== 'ninguno') this.#safeFrame(ctx, W, H, ASPECTS[g.safeFrame]);    // La perspectiva va primero: es una malla densa y conviene que el resto de
    // guias (tercios, canon, simetria) queden por encima.
    if (this.perspective.active) {
      this.perspective.draw(ctx, W, H, this.dpr);
      ctx.strokeStyle = g.color;
      ctx.fillStyle = g.color;
      ctx.globalAlpha = g.opacity;
      ctx.lineWidth = line;
    }
    if (g.grid > 0) this.#grid(ctx, W, H, Math.round(g.grid));
    if (g.thirds) this.#fractions(ctx, W, H, [1 / 3, 2 / 3]);
    if (g.golden) this.#fractions(ctx, W, H, [0.381966, 0.618034], true);
    if (g.diagonals) this.#diagonals(ctx, W, H);
    if (g.horizon) this.#horizon(ctx, W, H);
    if (g.symmetry) this.#symmetry(ctx, W, H);
    if (g.heads) this.#heads(ctx, W, H, Math.max(2, Math.round(g.headCount)));
    // Los trazos de la pose van encima de todo: son el dibujo, no la reticula.
    if (this.action.active) this.action.draw(ctx, W, H, this.dpr);

    ctx.globalAlpha = 1;
  }

  #segment(ctx, x1, y1, x2, y2) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  #grid(ctx, W, H, n) {
    ctx.save();
    ctx.globalAlpha *= 0.6;
    for (let i = 1; i < n; i++) {
      const t = i / n;
      this.#segment(ctx, Math.round(W * t), 0, Math.round(W * t), H);
      this.#segment(ctx, 0, Math.round(H * t), W, Math.round(H * t));
    }
    ctx.restore();
  }

  #fractions(ctx, W, H, list, dashed = false) {
    ctx.save();
    if (dashed) ctx.setLineDash([6 * this.dpr, 5 * this.dpr]);
    for (const t of list) {
      this.#segment(ctx, Math.round(W * t), 0, Math.round(W * t), H);
      this.#segment(ctx, 0, Math.round(H * t), W, Math.round(H * t));
    }
    ctx.restore();
  }

  #diagonals(ctx, W, H) {
    ctx.save();
    ctx.globalAlpha *= 0.75;
    this.#segment(ctx, 0, 0, W, H);
    this.#segment(ctx, W, 0, 0, H);
    // Armadura armonica: de cada esquina al centro del lado opuesto.
    this.#segment(ctx, 0, 0, W, H / 2);
    this.#segment(ctx, 0, H, W, H / 2);
    this.#segment(ctx, W, 0, 0, H / 2);
    this.#segment(ctx, W, H, 0, H / 2);
    ctx.restore();
  }

  #safeFrame(ctx, W, H, aspect) {
    if (!aspect) return;
    const boxAspect = W / H;
    let w = W;
    let h = H;
    if (aspect > boxAspect) h = W / aspect;
    else w = H * aspect;
    const x = (W - w) / 2;
    const y = (H - h) / 2;

    ctx.save();
    // Zona fuera de encuadre atenuada, para juzgar la composicion final.
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.rect(x, y, w, h);
    ctx.fill('evenodd');
    ctx.restore();

    ctx.save();
    ctx.globalAlpha *= 0.9;
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
    ctx.restore();
  }

  /**
   * Linea de horizonte: altura de la camara proyectada al infinito. Con la
   * camara ortografica basta con proyectar un punto a la altura del ojo.
   */
  #horizon(ctx, W, H) {
    const cam = this.viewport.cameras.active;
    const dir = cam.getWorldDirection(new THREE.Vector3());
    dir.y = 0;
    if (dir.lengthSq() < 1e-8) return;      // camara mirando a plomo
    dir.normalize();
    const p = new THREE.Vector3().copy(cam.position).addScaledVector(dir, 5000);
    const out = this.#project(p, { x: 0, y: 0, z: 0 });
    if (!Number.isFinite(out.y)) return;
    ctx.save();
    ctx.setLineDash([10 * this.dpr, 6 * this.dpr]);
    this.#segment(ctx, 0, Math.round(out.y) + 0.5, W, Math.round(out.y) + 0.5);
    ctx.restore();
  }

  /** Eje de simetria de la figura (o del encuadre si no hay modelo). */
  #symmetry(ctx, W, H) {
    let x = W / 2;
    const ch = this.character;
    if (ch?.loaded) {
      _box.copy(ch.box);
      const center = _box.getCenter(new THREE.Vector3());
      const p = this.#project(center, { x: 0, y: 0, z: 0 });
      if (Number.isFinite(p.x)) x = p.x;
    }
    ctx.save();
    ctx.globalAlpha *= 0.85;
    this.#segment(ctx, Math.round(x) + 0.5, 0, Math.round(x) + 0.5, H);
    ctx.restore();
  }

  /**
   * Canon de cabezas: divide la altura proyectada de la figura en N partes
   * iguales. Es la regla clasica de proporcion (8 cabezas para la figura
   * heroica, 7,5 para la natural).
   */
  #heads(ctx, W, H, count) {
    const ch = this.character;
    if (!ch?.loaded) return;
    _box.copy(ch.box);
    if (_box.isEmpty()) return;

    const center = _box.getCenter(new THREE.Vector3());
    const top = this.#project(_v.set(center.x, _box.max.y, center.z), { x: 0, y: 0, z: 0 });
    const topY = top.y;
    const topX = top.x;
    const bottom = this.#project(_v.set(center.x, _box.min.y, center.z), { x: 0, y: 0, z: 0 });
    if (!Number.isFinite(topY) || !Number.isFinite(bottom.y)) return;

    const height = bottom.y - topY;
    if (Math.abs(height) < 4) return;

    const half = Math.min(W * 0.5, Math.abs(height) / count * 1.9);
    const cx = (topX + bottom.x) / 2;
    ctx.save();
    for (let i = 0; i <= count; i++) {
      const t = i / count;
      const y = Math.round(topY + height * t) + 0.5;
      const wide = i === 0 || i === count;
      ctx.globalAlpha = this.settings.get('guides.opacity') * (wide ? 1 : 0.65);
      ctx.lineWidth = (wide ? 1.6 : 1) * this.dpr;
      this.#segment(ctx, cx - half, y, cx + half, y);
    }
    // Numeracion de las cabezas.
    ctx.globalAlpha = this.settings.get('guides.opacity');
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < count; i++) {
      const y = topY + height * ((i + 0.5) / count);
      ctx.fillText(String(i + 1), cx + half + 5 * this.dpr, y);
    }
    ctx.restore();
  }

  clear() {
    if (!this.ctx) return;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.painted = false;
  }
}
