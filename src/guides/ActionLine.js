/**
 * ATOM · Linea de accion y lineas de ritmo
 * ---------------------------------------------------------------------------
 * Los trazos con los que un dibujante resume una pose antes de dibujar nada:
 *
 *   - **Linea de accion**: el recorrido del movimiento, de la coronilla al pie
 *     que aguanta el peso, pasando por la columna. Es la que decide si una figura
 *     esta viva o plantada.
 *   - **Lineas de ritmo**: las curvas que cruzan el cuerpo y encadenan sus
 *     partes — de una mano a la otra pasando por los hombros, y de cada hombro,
 *     cruzando el torso, hasta el pie del lado contrario. No son segmentos entre
 *     articulaciones: son una sola curva que fluye, que sale y entra del dibujo
 *     prolongandose por las puntas y desvaneciendose en ellas.
 *   - **Exageracion**: amplifica la curva de la linea de accion y, si se pide,
 *     dibuja el mismo personaje llevado a esa exageracion, para ver de un vistazo
 *     hacia donde conviene empujar la pose.
 *
 * Todo se pinta en el lienzo 2D de las guias (proyectando los huesos a pantalla),
 * no en la escena: asi el trazo es nitido, no lo desenfoca la lente y no cuesta
 * tiempo de GPU. La exageracion es una deformacion del dibujo, no de la pose: el
 * esqueleto no se toca.
 */
import * as THREE from 'three';
import { strokePath, curvePath, resample, extend, pathLength } from '../draw/stroke.js';

const _v = new THREE.Vector3();

/** Columna, de la cabeza a la cadera: el tronco de la linea de accion. */
const COLUMNA = ['head', 'neck', 'spine2', 'spine1', 'spine', 'hips'];

/**
 * Ritmo de brazo a brazo: de una mano a la otra, arqueandose por encima de los
 * hombros. Los dos brazos se encadenan con UN solo punto en medio (ver
 * `#girdle`): con las dos claviculas y el cuello como puntos de control, tres
 * puntos casi encima quedaban entre dos tramos largos y la curva salia con un
 * rizo justo en el pecho.
 */
const RITMO_BRAZOS = [
  ['leftHand', 'leftForeArm', 'leftArm'],
  ['rightArm', 'rightForeArm', 'rightHand'],
];

/**
 * Ritmo de hombro a pie: baja por el torso y sigue por una pierna. `cruzado` va
 * al lado contrario (los dos trazos se cruzan en la pelvis, la construccion
 * clasica del contrapposto) y `mismo` sigue la pierna de su propio lado.
 */
const RITMO_PIERNAS = {
  cruzado: [
    ['rightShoulder', 'spine1', 'leftUpLeg', 'leftLeg', 'leftFoot'],
    ['leftShoulder', 'spine1', 'rightUpLeg', 'rightLeg', 'rightFoot'],
  ],
  mismo: [
    ['leftShoulder', 'spine1', 'leftUpLeg', 'leftLeg', 'leftFoot'],
    ['rightShoulder', 'spine1', 'rightUpLeg', 'rightLeg', 'rightFoot'],
  ],
};

/** Huesos del muñeco fantasma, por parejas. */
const HUESOS = [
  ['hips', 'spine'], ['spine', 'spine1'], ['spine1', 'spine2'], ['spine2', 'neck'], ['neck', 'head'],
  ['spine2', 'leftArm'], ['leftArm', 'leftForeArm'], ['leftForeArm', 'leftHand'],
  ['spine2', 'rightArm'], ['rightArm', 'rightForeArm'], ['rightForeArm', 'rightHand'],
  ['leftArm', 'rightArm'],
  ['hips', 'leftUpLeg'], ['leftUpLeg', 'leftLeg'], ['leftLeg', 'leftFoot'], ['leftFoot', 'leftToe'],
  ['hips', 'rightUpLeg'], ['rightUpLeg', 'rightLeg'], ['rightLeg', 'rightFoot'], ['rightFoot', 'rightToe'],
];

/** Miembros que arrastra el giro de los hombros y el de la cadera. */
const CUELGA_DE_HOMBROS = ['leftArm', 'leftForeArm', 'leftHand', 'rightArm', 'rightForeArm', 'rightHand', 'neck', 'head'];
const CUELGA_DE_CADERA = ['leftUpLeg', 'leftLeg', 'leftFoot', 'leftToe', 'rightUpLeg', 'rightLeg', 'rightFoot', 'rightToe'];

/** Color con la opacidad pedida, para los degradados del desvanecido. */
function conAlfa(color, alfa) {
  const m = /^#([0-9a-f]{3,8})$/i.exec(String(color).trim());
  if (!m) return String(color);
  let h = m[1];
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alfa})`;
}

export class ActionLine {
  /**
   * @param {import('../core/Settings.js').Settings} settings
   * @param {import('../core/Viewport.js').Viewport} viewport
   */
  constructor(settings, viewport) {
    this.settings = settings;
    this.viewport = viewport;
    this.character = null;
  }

  setCharacter(character) {
    this.character = character;
  }

  /** ¿Hay algun trazo encendido? */
  get active() {
    const a = this.settings.get('guides.action');
    return !!(a && (a.line || a.arms || a.legs || a.ghost));
  }

  /** Cuanto se amplifica la curva: 0 = la pose tal cual. */
  get exaggeration() {
    return Math.max(0, Number(this.settings.get('guides.action.exaggeration')) || 0);
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} W ancho del lienzo en pixeles de dispositivo
   * @param {number} H alto del lienzo
   * @param {number} dpr pixeles de dispositivo por pixel CSS
   */
  draw(ctx, W, H, dpr) {
    const ch = this.character;
    if (!ch?.loaded || !this.active) return;
    const a = this.settings.get('guides.action');
    const P = this.#projectBones(ch, W, H);
    if (!P.size) return;

    const grosor = Math.max(1, Number(a.width) || 4) * dpr;
    const e = this.exaggeration;
    const alfa = Math.max(0.05, Math.min(1, Number(a.opacity) || 0.9));

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // El desvanecido de las puntas va en el degradado de cada trazo, no en la
    // opacidad global: asi los trazos que se cruzan no se suman.
    ctx.globalAlpha = 1;
    ctx.strokeStyle = a.color;

    const columna = this.#actionPoints(ch, P);
    const campo = columna.length >= 3 ? this.#warpField(columna) : null;

    if (a.line) this.#flow(ctx, columna, grosor, a.color, alfa);
    if (a.line && campo && e > 0.02) {
      // La version exagerada del mismo trazo, a puntos para distinguirla.
      this.#dashed(ctx, columna.map((p) => campo.warp(p, e)), grosor, a.color, alfa);
    }
    if (a.arms) this.#flow(ctx, this.#armPoints(P), grosor * 0.78, a.color, alfa * 0.92);
    if (a.legs) {
      const modo = a.cross === false ? 'mismo' : 'cruzado';
      for (const cadena of RITMO_PIERNAS[modo]) {
        this.#flow(ctx, this.#chain(P, cadena), grosor * 0.78, a.color, alfa * 0.92);
      }
    }
    if (a.ghost && campo) this.#ghost(ctx, P, campo, e, dpr, alfa);

    ctx.restore();
  }

  /* ── Trazos ──────────────────────────────────────────────────────────── */

  /**
   * Traza una curva que fluye por una cadena de articulaciones: se suaviza con
   * Catmull-Rom, se prolonga por las dos puntas siguiendo la tangente y se pinta
   * con un degradado que la hace nacer y morir en el aire. El grosor sigue la
   * misma campana: fino en las puntas, lleno en el centro.
   */
  #flow(ctx, puntos, grosor, color, alfa) {
    if (puntos.length < 3) return;
    const curva = resample(puntos, 64);
    const largo = pathLength(curva);
    if (largo < 8) return;
    // La prolongacion crece con el trazo, pero con tope: en un trazo corto una
    // cola larga se comeria el dibujo.
    const abierta = extend(curva, Math.min(largo * 0.13, grosor * 22));
    ctx.fillStyle = this.#fade(ctx, abierta, color, alfa);
    ctx.fill(strokePath(this.#brush(abierta, grosor)));
  }

  /** La misma curva, a puntos: es la que muestra la exageracion. */
  #dashed(ctx, puntos, grosor, color, alfa) {
    if (puntos.length < 3) return;
    const curva = resample(puntos, 64);
    const largo = pathLength(curva);
    if (largo < 8) return;
    const abierta = extend(curva, Math.min(largo * 0.13, grosor * 22));
    ctx.save();
    ctx.globalAlpha = alfa * 0.6;
    ctx.lineWidth = Math.max(1, grosor * 0.42);
    ctx.setLineDash([grosor * 2.4, grosor * 1.8]);
    ctx.stroke(curvePath(abierta));
    ctx.restore();
  }

  /** Puntos de una cadena de huesos que esten a la vista. */
  #chain(P, keys) {
    const out = [];
    for (const key of keys) {
      const p = P.get(key);
      if (p) out.push(p);
    }
    return out;
  }

  /** Cadena del ritmo de los brazos: brazo, cintura escapular, brazo. */
  #armPoints(P) {
    const centro = this.#girdle(P);
    return [
      ...this.#chain(P, RITMO_BRAZOS[0]),
      ...(centro ? [centro] : []),
      ...this.#chain(P, RITMO_BRAZOS[1]),
    ];
  }

  /**
   * Punto medio de la cintura escapular, un poco arqueado hacia el cuello: es
   * por donde pasa el trazo que ata los dos brazos. Uno solo, y a media
   * distancia de los dos hombros, para que la curva cruce el pecho de un tiron.
   */
  #girdle(P) {
    const a = P.get('leftShoulder') ?? P.get('leftArm');
    const b = P.get('rightShoulder') ?? P.get('rightArm');
    const cuello = P.get('neck');
    if (!a || !b) return cuello ?? null;
    const x = (a.x + b.x) / 2;
    const y = (a.y + b.y) / 2;
    if (!cuello) return { x, y };
    return { x: x + (cuello.x - x) * 0.35, y: y + (cuello.y - y) * 0.35 };
  }

  /**
   * Reparte el grosor a lo largo del trazo: nace en punta, engorda en la mitad y
   * vuelve a afilarse. Es la campana de un gesto hecho con un lapiz de verdad.
   */
  #brush(points, grosor) {
    const n = points.length - 1;
    return points.map((p, i) => {
      const t = n > 0 ? i / n : 0.5;
      const f = 0.12 + 0.88 * Math.sin(Math.PI * t) ** 0.6;
      return { x: p.x, y: p.y, w: (grosor * f) / 2 };
    });
  }

  /**
   * Degradado a lo largo del trazo que lo hace aparecer y desaparecer sin cortes.
   * El eje es la cuerda entre las dos puntas, que para una curva de ritmo (una S
   * tumbada o una C) es justo la direccion en la que se quiere el desvanecido.
   */
  #fade(ctx, puntos, color, alfa) {
    const a = puntos[0];
    const b = puntos[puntos.length - 1];
    if (!ctx.createLinearGradient || Math.hypot(b.x - a.x, b.y - a.y) < 1) return conAlfa(color, alfa);
    const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
    g.addColorStop(0, conAlfa(color, 0));
    g.addColorStop(0.16, conAlfa(color, alfa));
    g.addColorStop(0.84, conAlfa(color, alfa));
    g.addColorStop(1, conAlfa(color, 0));
    return g;
  }

  /**
   * Muñeco fantasma con la exageracion aplicada. Se dibuja el mismo esqueleto
   * proyectado, desplazado por el campo de la linea de accion y con los hombros y
   * la cadera mas volcados de lo que estan: es el dibujo que saldria si se llevara
   * la pose hasta donde apunta su linea de movimiento.
   */
  #ghost(ctx, P, campo, e, dpr, alfa) {
    const G = new Map();
    for (const [key, p] of P) G.set(key, campo.warp(p, e));
    // Volcado extra de hombros y cadera: es lo que da el contrapposto.
    this.#tilt(G, 'leftArm', 'rightArm', CUELGA_DE_HOMBROS, e);
    this.#tilt(G, 'leftUpLeg', 'rightUpLeg', CUELGA_DE_CADERA, e);

    ctx.save();
    ctx.globalAlpha = alfa * 0.85;
    ctx.lineWidth = Math.max(1, 1.6 * dpr);
    for (const [a, b] of HUESOS) {
      const p = G.get(a);
      const q = G.get(b);
      if (!p || !q) continue;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(q.x, q.y);
      ctx.stroke();
    }
    // La cabeza, del tamano que da la distancia del cuello a la coronilla.
    const cabeza = G.get('head');
    const cuello = G.get('neck');
    if (cabeza && cuello) {
      const r = Math.max(4 * dpr, Math.hypot(cabeza.x - cuello.x, cabeza.y - cuello.y) * 0.72);
      ctx.beginPath();
      ctx.arc(cabeza.x, cabeza.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Articulaciones, para que el fantasma se lea como un muñeco y no como una maraña.
    ctx.fillStyle = conAlfa(this.settings.get('guides.action.color'), alfa * 0.8);
    for (const p of G.values()) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.8 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * Gira una pareja simetrica (y lo que cuelga de ella) alrededor de su centro,
   * amplificando la inclinacion que ya tiene.
   */
  #tilt(G, izq, der, arrastra, e) {
    if (e <= 0.001) return;
    const a = G.get(izq);
    const b = G.get(der);
    if (!a || !b) return;
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    // Inclinacion respecto a la horizontal, en el sentido corto.
    let ang = Math.atan2(b.y - a.y, b.x - a.x);
    if (ang > Math.PI / 2) ang -= Math.PI;
    if (ang < -Math.PI / 2) ang += Math.PI;
    const giro = ang * e;
    const cos = Math.cos(giro);
    const sin = Math.sin(giro);
    // Sin repetidos: los dos extremos ya aparecen en la lista de lo que cuelga,
    // y girarlos dos veces doblaria el volcado.
    for (const key of new Set([izq, der, ...arrastra])) {
      const p = G.get(key);
      if (!p) continue;
      const dx = p.x - cx;
      const dy = p.y - cy;
      G.set(key, { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos });
    }
  }

  /* ── Calculo ─────────────────────────────────────────────────────────── */

  /**
   * Campo de deformacion de la exageracion. La linea de accion se compara con la
   * recta que une sus extremos: la separacion de cada punto respecto a esa
   * cuerda es la curva del movimiento, y exagerar es multiplicarla. Cualquier
   * punto del dibujo se desplaza lo mismo que la columna a su altura, de modo que
   * el fantasma y el trazo exagerado cuentan lo mismo.
   */
  #warpField(points) {
    const base = points[points.length - 1];
    const punta = points[0];
    let ux = punta.x - base.x;
    let uy = punta.y - base.y;
    const len = Math.hypot(ux, uy);
    if (len < 1) return null;
    ux /= len;
    uy /= len;
    const nx = -uy;
    const ny = ux;

    // Separacion de cada punto respecto a la cuerda, ordenada por altura.
    const muestras = points.map((p) => {
      const dx = p.x - base.x;
      const dy = p.y - base.y;
      return { t: (dx * ux + dy * uy) / len, d: dx * nx + dy * ny };
    }).sort((a, b) => a.t - b.t);

    const desvio = (t) => {
      const c = Math.max(muestras[0].t, Math.min(muestras[muestras.length - 1].t, t));
      for (let i = 1; i < muestras.length; i++) {
        if (c > muestras[i].t) continue;
        const a = muestras[i - 1];
        const b = muestras[i];
        const k = b.t - a.t < 1e-6 ? 0 : (c - a.t) / (b.t - a.t);
        return a.d + (b.d - a.d) * k;
      }
      return muestras[muestras.length - 1].d;
    };

    return {
      /** Punto exagerado: se aparta de la cuerda `1 + 1.5·e` veces. */
      warp(p, e) {
        const dx = p.x - base.x;
        const dy = p.y - base.y;
        const t = (dx * ux + dy * uy) / len;
        const empuje = desvio(t) * 1.5 * e;
        return { x: p.x + nx * empuje, y: p.y + ny * empuje };
      },
    };
  }

  /**
   * Puntos de la linea de accion: la columna y, colgando de la cadera, la pierna
   * que aguanta el peso (la del pie mas bajo). Es la construccion clasica: el
   * trazo baja hasta el punto de apoyo.
   */
  #actionPoints(ch, P) {
    const out = [];
    // La coronilla, si el rig la trae, es el arranque natural del trazo.
    for (const key of (P.has('headTop') ? ['headTop', ...COLUMNA] : COLUMNA)) {
      const p = P.get(key);
      if (p) out.push(p);
    }
    const lado = this.#supportSide(ch);
    for (const key of [`${lado}Leg`, `${lado}Foot`]) {
      const p = P.get(key);
      if (p) out.push(p);
    }
    return out;
  }

  /** Lado que aguanta el peso: el del pie mas bajo en el mundo. */
  #supportSide(ch) {
    const alto = (key) => {
      const bone = ch.bones[key];
      if (!bone) return Infinity;
      return bone.getWorldPosition(_v).y;
    };
    return alto('leftFoot') <= alto('rightFoot') ? 'left' : 'right';
  }

  /** Huesos que hacen falta, proyectados a pixeles del lienzo. */
  #projectBones(ch, W, H) {
    const cam = this.viewport.cameras.active;
    const claves = new Set([
      'headTop', ...COLUMNA, ...RITMO_BRAZOS.flat(),
      ...Object.values(RITMO_PIERNAS).flat(2),
    ]);
    for (const [a, b] of HUESOS) { claves.add(a); claves.add(b); }
    const out = new Map();
    for (const key of claves) {
      const bone = ch.bones[key];
      if (!bone) continue;
      bone.getWorldPosition(_v).project(cam);
      // Detras de la camara: el punto proyectado no significa nada.
      if (!Number.isFinite(_v.x) || !Number.isFinite(_v.y) || _v.z > 1) continue;
      out.set(key, { x: (_v.x * 0.5 + 0.5) * W, y: (-_v.y * 0.5 + 0.5) * H });
    }
    return out;
  }
}
