/**
 * ATOM · Lapiz del visor
 * ---------------------------------------------------------------------------
 * Dibujar a mano alzada encima de la escena, para practicar sobre la figura sin
 * salir de la aplicacion. Lo que importa aqui es el tacto del trazo:
 *
 *   - **Presion de la pluma.** Se lee `pointerEvent.pressure` y se traduce a
 *     grosor (y, si se quiere, a opacidad). Los eventos se piden en bruto con
 *     `getCoalescedEvents()`, asi que una pluma de 240 Hz no pierde puntos por
 *     culpa de los 60 avisos por segundo que reparte el navegador.
 *   - **Sin presion, la velocidad manda.** Con raton, trackpad o una pluma que no
 *     informa, el grosor sale de la velocidad del trazo: lento = grueso, rapido =
 *     fino, con las entradas y salidas afiladas. Es lo que hace que un trazo de
 *     raton no parezca un tubo.
 *   - **Estabilizador.** Cada punto tira del anterior (`streamline`), que es como
 *     se quita el pulso sin cortar la respuesta.
 *
 * Dos lienzos: uno guarda lo ya trazado (mapa de bits) y otro solo el trazo en
 * curso, que se repinta entero en cada cuadro. Al soltar, el trazo se pasa al
 * primero. Asi el coste no crece con el dibujo.
 *
 * Los trazos se guardan en coordenadas normalizadas por la ALTURA del visor y
 * centradas: la camara en perspectiva conserva su campo vertical, de modo que al
 * cambiar el tamano de la ventana el dibujo sigue cuadrando con lo que hay
 * debajo.
 *
 * El puntero se atrapa en la fase de captura del documento: asi el lapiz se
 * queda el gesto antes de que lo vean los controles de orbita, la seleccion de
 * la escena o los manejadores de pose. Con Alt pulsado no se atrapa nada, de
 * modo que se puede orbitar sin apagar el lapiz.
 */
import { strokePath, streamline, taper, decimate } from './stroke.js';

/** Velocidad (en alturas de visor por milisegundo) a la que el trazo va mas fino. */
const SPEED_MAX = 0.0042;

/** Trazos guardados como maximo; el dibujo es una practica, no un documento. */
const MAX_STROKES = 600;

/** Pasos de deshacer. */
const MAX_HISTORY = 60;

export class Sketch {
  /**
   * @param {object} deps
   * @param {import('../core/Settings.js').Settings} deps.settings
   * @param {import('../core/Viewport.js').Viewport} deps.viewport
   * @param {HTMLCanvasElement} deps.canvas lienzo de lo ya trazado
   * @param {HTMLCanvasElement} deps.live   lienzo del trazo en curso
   */
  constructor({ settings, viewport, canvas, live }) {
    this.settings = settings;
    this.viewport = viewport;
    this.canvas = canvas;
    this.liveCanvas = live;
    this.ctx = canvas.getContext('2d');
    this.liveCtx = live.getContext('2d');

    /** @type {object[]} trazos confirmados, en orden de dibujo */
    this.strokes = [];
    this.history = [];
    this.future = [];
    /** Trazo en curso, o null. */
    this.stroke = null;
    this.pointerId = null;
    this.dpr = 1;
    this.frame = 0;
    /** Borrado en marcha: guarda lo quitado para poder deshacerlo de una vez. */
    this.erasing = null;
    /** La ultima pluma que ha tocado el lienzo manda presion de verdad. */
    this.pen = false;

    this.enabled = settings.get('draw.enabled') === true;
    this.#bind();
    this.#fit();
    this.#apply();
  }

  /* ── Ajustes y estado ────────────────────────────────────────────────── */

  #bind() {
    const s = this.settings;
    this.offs = [
      s.on('draw.enabled', (v) => this.setEnabled(v === true)),
      s.on('draw.visible', () => this.#apply()),
      s.on('draw.tool', () => this.#apply()),
    ];

    this._down = (e) => this.#onDown(e);
    this._move = (e) => this.#onMove(e);
    this._up = (e) => this.#onUp(e);
    for (const [tipo, fn] of this.#listeners()) document.addEventListener(tipo, fn, true);
    // Si la ventana pierde el foco a media raya (un atajo del sistema, otra
    // aplicacion encima) el trazo se cierra donde iba en vez de quedarse a medias.
    this._blur = () => { if (this.stroke) this.#commit(); };
    window.addEventListener('blur', this._blur);

    const host = this.canvas.parentElement ?? this.canvas;
    this.observer = new ResizeObserver(() => { if (this.#fit()) this.redraw(); });
    this.observer.observe(host);
  }

  /** Los cuatro avisos de puntero que atrapa el lapiz, con su funcion. */
  #listeners() {
    return [
      ['pointerdown', this._down], ['pointermove', this._move],
      ['pointerup', this._up], ['pointercancel', this._up],
    ];
  }

  /** Pone o quita el lapiz al mando del puntero. */
  setEnabled(on) {
    this.enabled = !!on;
    if (!this.enabled) this.#cancel();
    this.#apply();
    return this;
  }

  get tool() { return this.settings.get('draw.tool') ?? 'lapiz'; }

  get count() { return this.strokes.length; }

  get canUndo() { return this.history.length > 0; }

  get canRedo() { return this.future.length > 0; }

  /** Cursor del visor y visibilidad de los dos lienzos. */
  #apply() {
    const visible = this.settings.get('draw.visible') !== false;
    this.canvas.classList.toggle('is-hidden', !visible);
    this.liveCanvas.classList.toggle('is-hidden', !visible);
    const dom = this.viewport.renderer?.domElement;
    if (!dom) return;
    if (this.enabled) dom.style.cursor = this.tool === 'borrador' ? 'cell' : 'crosshair';
    else if (dom.style.cursor === 'crosshair' || dom.style.cursor === 'cell') dom.style.cursor = '';
  }

  /* ── Medidas ─────────────────────────────────────────────────────────── */

  /** Ajusta los dos lienzos al tamano del visor. Devuelve true si cambiaron. */
  #fit() {
    const cssW = this.canvas.clientWidth;
    const cssH = this.canvas.clientHeight;
    if (!cssW || !cssH) return false;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(cssW * dpr);
    const h = Math.round(cssH * dpr);
    this.dpr = dpr;
    if (this.canvas.width === w && this.canvas.height === h) return false;
    for (const c of [this.canvas, this.liveCanvas]) {
      c.width = w;
      c.height = h;
    }
    return true;
  }

  /** Punto de pantalla a las coordenadas en las que se guarda el dibujo. */
  #toLocal(event) {
    const r = this.canvas.getBoundingClientRect();
    const h = r.height || 1;
    return {
      x: (event.clientX - r.left - r.width / 2) / h,
      y: (event.clientY - r.top - h / 2) / h,
    };
  }

  /** Coordenada guardada a pixeles de un lienzo de W por H. */
  #toPixels(p, W, H) {
    return { x: p.x * H + W / 2, y: p.y * H + H / 2 };
  }

  /* ── Entrada ─────────────────────────────────────────────────────────── */

  /** Es este gesto para el lapiz? */
  #owns(event) {
    if (!this.enabled || !this.#overCanvas(event)) return false;
    // Alt deja pasar el gesto: orbitar sin apagar el lapiz.
    if (event.altKey) return false;
    if (event.pointerType === 'touch' && this.settings.get('draw.touch') !== true) return false;
    // Solo la punta y el boton de borrar de la pluma; el resto navega.
    return event.button === 0 || event.button === 5 || (event.buttons & 32) !== 0;
  }

  /** Esta el puntero sobre el visor (y no sobre un panel)? */
  #overCanvas(event) {
    const dom = this.viewport.renderer?.domElement;
    return event.target === dom || event.target === this.canvas || event.target === this.liveCanvas;
  }

  #onDown(event) {
    // Lo que no es para el lapiz sigue su camino: asi Alt orbita, el dedo navega
    // y los botones secundarios mueven la camara sin apagar nada.
    if (!this.#owns(event)) return;
    event.stopPropagation();
    if (event.cancelable) event.preventDefault();
    // Un gesto anterior sin cerrar (el puntero se solto fuera de la ventana) no
    // puede dejar el lapiz sordo: se cierra y empieza el nuevo.
    if (this.stroke) this.#commit();
    if (this.erasing?.quitados.length) this.#remember({ tipo: 'borrar', quitados: this.erasing.quitados });
    this.erasing = null;
    this.pointerId = event.pointerId;
    if (this.tool === 'borrador' || (event.buttons & 32) !== 0) {
      this.erasing = { quitados: [] };
      this.#erase(event);
      return;
    }
    this.#start(event);
  }

  #onMove(event) {
    if (this.erasing) {
      if (event.pointerId !== this.pointerId) return;
      event.stopPropagation();
      this.#erase(event);
      return;
    }
    if (!this.stroke) {
      // Sin gesto en marcha se corta el aviso igualmente: si no, el editor de
      // escena pintaria contornos y cambiaria el cursor debajo del lapiz.
      if (this.enabled && event.buttons === 0 && this.#overCanvas(event)) event.stopPropagation();
      return;
    }
    if (event.pointerId !== this.pointerId) return;
    event.stopPropagation();
    for (const ev of this.#raw(event)) this.#push(ev);
    this.#schedule();
  }

  #onUp(event) {
    if (this.erasing) {
      event.stopPropagation();
      const quitados = this.erasing.quitados;
      this.erasing = null;
      this.pointerId = null;
      if (quitados.length) this.#remember({ tipo: 'borrar', quitados });
      return;
    }
    if (!this.stroke || event.pointerId !== this.pointerId) return;
    event.stopPropagation();
    this.#push(event);
    this.#commit();
  }

  /** Puntos en bruto de un aviso de movimiento (una pluma manda varios). */
  #raw(event) {
    try {
      const list = event.getCoalescedEvents?.();
      if (list?.length) return list;
    } catch { /* eventos sinteticos: no hay nada que desplegar */ }
    return [event];
  }

  /* ── Trazo ───────────────────────────────────────────────────────────── */

  #start(event) {
    const s = this.settings;
    const cssH = this.canvas.clientHeight || 1;
    // Una pluma que siempre manda 0.5 no tiene sensor: mejor la velocidad.
    this.pen = event.pointerType === 'pen' && event.pressure > 0 && event.pressure !== 0.5;
    this.stroke = {
      tool: this.tool,
      color: s.get('draw.color') ?? '#e9e9ea',
      // Grosor y opacidad se guardan ya normalizados: el dibujo sobrevive a un
      // cambio de tamano de la ventana sin engordar ni adelgazar.
      size: Math.max(0.5, Number(s.get('draw.size')) || 4) / cssH,
      alpha: Math.max(0.05, Math.min(1, Number(s.get('draw.opacity')) || 1)),
      points: [],
    };
    this.lastAt = event.timeStamp || performance.now();
    this.lastPos = this.#toLocal(event);
    this.lastF = null;
    this.#push(event);
    this.#schedule();
  }

  /** Anade un punto al trazo en curso, con su factor de grosor. */
  #push(event) {
    if (!this.stroke) return;
    const p = this.#toLocal(event);
    const t = event.timeStamp || performance.now();
    const dt = Math.max(1, t - this.lastAt);
    const paso = Math.hypot(p.x - this.lastPos.x, p.y - this.lastPos.y);
    const s = this.settings;

    let f;
    if (this.pen && event.pressure > 0) {
      // Presion de verdad: influye tanto como diga el panel.
      const infl = Math.max(0, Math.min(1, Number(s.get('draw.pressureSize')) || 0));
      const pr = Math.max(0.02, Math.min(1, event.pressure));
      f = (1 - infl) + infl * Math.pow(pr, 0.75);
    } else {
      // Sin presion: la velocidad. Lento = grueso, rapido = fino.
      const vel = Math.min(1, paso / dt / SPEED_MAX);
      const infl = Math.max(0, Math.min(1, Number(s.get('draw.speed')) || 0));
      const objetivo = 1 - infl * vel;
      // Suavizado temporal: sin el, un salto del raton adelgaza el trazo de golpe.
      f = this.lastF == null ? objetivo : this.lastF + (objetivo - this.lastF) * 0.35;
    }
    this.lastF = f;
    this.lastAt = t;
    this.lastPos = p;
    this.stroke.points.push({ x: p.x, y: p.y, f: Math.max(0.06, Math.min(1.25, f)) });
  }

  /** Pide repintar el trazo en curso en el siguiente cuadro. */
  #schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.#paintLive();
    });
  }

  #paintLive() {
    const ctx = this.liveCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.liveCanvas.width, this.liveCanvas.height);
    if (!this.stroke) return;
    this.#paintStroke(ctx, this.stroke, this.liveCanvas.width, this.liveCanvas.height, false);
  }

  /** Pasa el trazo terminado al lienzo de lo ya trazado. */
  #commit() {
    const stroke = this.stroke;
    this.#cancel();
    if (!stroke?.points.length) return;
    // Un punto por cada medio pixel basta: una pluma rapida manda muchos mas.
    stroke.points = decimate(stroke.points, 0.5 / (this.canvas.clientHeight || 1));
    stroke.bbox = bbox(stroke);
    this.strokes.push(stroke);
    if (this.strokes.length > MAX_STROKES) this.strokes.shift();
    this.#remember({ tipo: 'anadir', stroke });
    this.#paintStroke(this.ctx, stroke, this.canvas.width, this.canvas.height, true);
  }

  /** Suelta el trazo en curso y limpia el lienzo del trazo vivo. */
  #cancel() {
    this.stroke = null;
    this.pointerId = null;
    if (this.frame) { cancelAnimationFrame(this.frame); this.frame = 0; }
    this.liveCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.liveCtx.clearRect(0, 0, this.liveCanvas.width, this.liveCanvas.height);
  }

  /* ── Dibujado ────────────────────────────────────────────────────────── */

  /**
   * Pinta un trazo en un contexto cualquiera (el del visor o el de la captura
   * PNG). `hecho` afila tambien la salida: mientras se dibuja, la punta sigue al
   * puntero y afilarla la dejaria siempre en falso.
   */
  #paintStroke(ctx, stroke, W, H, hecho) {
    const pts = stroke.points;
    if (!pts.length) return;
    const base = stroke.size * H;              // grosor en pixeles de este lienzo
    let puntos = pts.map((p) => {
      const q = this.#toPixels(p, W, H);
      return { x: q.x, y: q.y, w: (base * p.f) / 2 };
    });

    const suave = Math.max(0, Math.min(0.95, Number(this.settings.get('draw.smoothing')) || 0));
    puntos = streamline(puntos, stroke.tool === 'rotulador' ? suave * 0.6 : suave);
    if (stroke.tool !== 'rotulador' && this.settings.get('draw.taper') !== false) {
      const rampa = base * 1.6;
      puntos = taper(puntos, { start: rampa, end: hecho ? rampa : 0 });
    }

    // Opacidad: la presion media aclara u oscurece el trazo entero. Variarla
    // punto a punto obligaria a partirlo en trozos y se verian las costuras.
    const media = pts.reduce((n, p) => n + p.f, 0) / pts.length;
    const infl = Math.max(0, Math.min(1, Number(this.settings.get('draw.pressureAlpha')) || 0));
    ctx.save();
    ctx.globalAlpha = Math.max(0.03, Math.min(1, stroke.alpha * ((1 - infl) + infl * media)));
    ctx.fillStyle = stroke.color;
    ctx.fill(strokePath(puntos));
    ctx.restore();
  }

  /** Vuelve a pintar todo lo trazado (deshacer, borrar, cambio de tamano). */
  redraw() {
    const W = this.canvas.width;
    const H = this.canvas.height;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, W, H);
    for (const stroke of this.strokes) this.#paintStroke(this.ctx, stroke, W, H, true);
    if (this.stroke) this.#paintLive();
  }

  /**
   * Vuelca el dibujo en otro lienzo, para incluirlo en la captura PNG.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} W ancho en pixeles del lienzo de destino
   * @param {number} H alto en pixeles del lienzo de destino
   */
  renderTo(ctx, W, H) {
    if (this.settings.get('draw.visible') === false) return;
    for (const stroke of this.strokes) this.#paintStroke(ctx, stroke, W, H, true);
    if (this.stroke) this.#paintStroke(ctx, this.stroke, W, H, true);
  }

  /* ── Borrador ────────────────────────────────────────────────────────── */

  /**
   * Borra los trazos que toca el puntero. Se quita el trazo entero, como en las
   * pizarras digitales: es lo que se espera de un borrador de vectores y evita
   * dejar migas de pixeles sueltas.
   */
  #erase(event) {
    const p = this.#toLocal(event);
    const cssH = this.canvas.clientHeight || 1;
    const r = Math.max(6, (Number(this.settings.get('draw.size')) || 4) * 2.2) / cssH;
    let alguno = false;
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      const stroke = this.strokes[i];
      const margen = r + stroke.size;
      const b = stroke.bbox;
      if (b && (p.x < b.x0 - margen || p.x > b.x1 + margen
        || p.y < b.y0 - margen || p.y > b.y1 + margen)) continue;
      if (!toca(stroke, p, margen)) continue;
      this.strokes.splice(i, 1);
      this.erasing?.quitados.push({ i, stroke });
      alguno = true;
    }
    if (alguno) this.redraw();
  }

  /* ── Deshacer ────────────────────────────────────────────────────────── */

  #remember(paso) {
    this.history.push(paso);
    if (this.history.length > MAX_HISTORY) this.history.shift();
    this.future.length = 0;
    this.onChange?.();
  }

  undo() {
    const paso = this.history.pop();
    if (!paso) return false;
    if (paso.tipo === 'anadir') {
      const i = this.strokes.lastIndexOf(paso.stroke);
      if (i >= 0) this.strokes.splice(i, 1);
    } else if (paso.tipo === 'borrar') {
      // De menor a mayor indice: asi cada trazo vuelve a su sitio en la pila.
      for (const { i, stroke } of [...paso.quitados].sort((a, b) => a.i - b.i)) {
        this.strokes.splice(Math.min(i, this.strokes.length), 0, stroke);
      }
    } else if (paso.tipo === 'vaciar') {
      this.strokes = paso.strokes.slice();
    }
    this.future.push(paso);
    this.redraw();
    this.onChange?.();
    return true;
  }

  redo() {
    const paso = this.future.pop();
    if (!paso) return false;
    if (paso.tipo === 'anadir') {
      this.strokes.push(paso.stroke);
    } else if (paso.tipo === 'borrar') {
      for (const { stroke } of paso.quitados) {
        const i = this.strokes.indexOf(stroke);
        if (i >= 0) this.strokes.splice(i, 1);
      }
    } else if (paso.tipo === 'vaciar') {
      this.strokes = [];
    }
    this.history.push(paso);
    this.redraw();
    this.onChange?.();
    return true;
  }

  /** Vacia el dibujo. Se puede deshacer. */
  clear() {
    if (!this.strokes.length) return false;
    this.#remember({ tipo: 'vaciar', strokes: this.strokes.slice() });
    this.strokes = [];
    this.redraw();
    return true;
  }

  dispose() {
    for (const off of this.offs ?? []) off?.();
    this.offs = [];
    for (const [tipo, fn] of this.#listeners()) document.removeEventListener(tipo, fn, true);
    window.removeEventListener('blur', this._blur);
    this.observer?.disconnect();
    if (this.frame) cancelAnimationFrame(this.frame);
    this.strokes = [];
    this.history = [];
    this.future = [];
  }
}

/** Caja del trazo en coordenadas guardadas, para descartar rapido al borrar. */
function bbox(stroke) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of stroke.points) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1 };
}

/** Cae el punto `p` sobre el trazo, con `margen` de tolerancia? */
function toca(stroke, p, margen) {
  const pts = stroke.points;
  const m2 = margen * margen;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const dx = p.x - a.x;
    const dy = p.y - a.y;
    if (dx * dx + dy * dy <= m2) return true;
    const b = pts[i + 1];
    if (!b) break;
    // Distancia al segmento: un trazo rapido deja puntos muy separados.
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const largo = ex * ex + ey * ey;
    if (largo < 1e-12) continue;
    const t = Math.max(0, Math.min(1, (dx * ex + dy * ey) / largo));
    const qx = p.x - (a.x + ex * t);
    const qy = p.y - (a.y + ey * t);
    if (qx * qx + qy * qy <= m2) return true;
  }
  return false;
}
