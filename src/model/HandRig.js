/**
 * POSU · Rig de manos
 * ---------------------------------------------------------------------------
 * Las falanges de Mixamo no tienen una orientacion local previsible: segun el
 * personaje, doblar un dedo puede ser girar en X, en Z o en un eje mezclado.
 * Por eso este modulo no toca ejes locales, sino que deduce de la geometria de
 * reposo dos ejes anatomicos por falange:
 *
 *   - `curlAxis`   flexion: cierra el dedo hacia la palma.
 *   - `spreadAxis` separacion: abre los dedos en abanico dentro de la palma.
 *
 * Los ejes se guardan en el espacio del padre en reposo. Eso sigue siendo
 * valido al recorrer la cadena de un dedo porque una rotacion alrededor de un
 * eje deja ese mismo eje invariante: al cerrar la falange 1, el eje de flexion
 * de la 2 gira con ella y sigue apuntando a donde debe.
 *
 * La pose final de cada falange es:
 *     q_local = R(spreadAxis, separacion) * R(curlAxis, flexion) * q_reposo
 *
 * No se modela la oposicion del pulgar (giro sobre su propio eje); para el
 * estudio de dibujo basta con flexion + separacion, que es lo que cambia la
 * silueta de la mano.
 */
import * as THREE from 'three';
import { FINGERS, fingerKeys } from './boneMap.js';

const DEG = Math.PI / 180;

/** Recorrido maximo de flexion por falange (grados), de la palma a la punta. */
const CURL_MAX = {
  thumb: [30, 46, 58],
  index: [82, 100, 72],
  middle: [84, 102, 74],
  ring: [82, 100, 74],
  pinky: [80, 98, 72],
};

/**
 * Reparto del abanico. Negativo = hacia el lado del pulgar, positivo = hacia
 * el del menique. El medio apenas se mueve porque es el eje de la mano.
 */
const FAN = { thumb: 0, index: -1, middle: -0.15, ring: 0.55, pinky: 1.1 };

/** Apertura maxima del abanico y de la separacion del pulgar. */
const SPREAD_MAX = 22 * DEG;
const THUMB_OUT_MAX = 46 * DEG;

/** Gestos de partida. Los valores son los mismos que manejan los sliders. */
export const HAND_PRESETS = [
  {
    id: 'abierta', label: 'Abierta', icon: 'hand',
    values: { thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0, spread: 0.6, thumbOut: 0.62 },
  },
  {
    id: 'relajada', label: 'Relajada', icon: 'hand-grab',
    values: { thumb: 0.22, index: 0.18, middle: 0.16, ring: 0.18, pinky: 0.22, spread: 0.15, thumbOut: 0.35 },
  },
  {
    id: 'puno', label: 'Puno', icon: 'hand-fist',
    values: { thumb: 0.82, index: 0.96, middle: 0.98, ring: 0.96, pinky: 0.94, spread: 0.02, thumbOut: 0.08 },
  },
  {
    id: 'garra', label: 'Garra', icon: 'hand-metal',
    values: { thumb: 0.5, index: 0.58, middle: 0.62, ring: 0.6, pinky: 0.56, spread: 0.35, thumbOut: 0.4 },
  },
  {
    id: 'senalar', label: 'Senalar', icon: 'pointer',
    values: { thumb: 0.62, index: 0.02, middle: 0.92, ring: 0.94, pinky: 0.92, spread: 0.05, thumbOut: 0.12 },
  },
  {
    id: 'pinza', label: 'Pinza', icon: 'fingerprint',
    values: { thumb: 0.52, index: 0.5, middle: 0.26, ring: 0.24, pinky: 0.26, spread: 0.12, thumbOut: 0.44 },
  },
  {
    id: 'lapiz', label: 'Con lapiz', icon: 'pen-tool',
    values: { thumb: 0.46, index: 0.44, middle: 0.5, ring: 0.72, pinky: 0.8, spread: 0.08, thumbOut: 0.3 },
  },
];

/** Acceso por id, para la interfaz y para `applyPreset`. */
export const HAND_PRESET_BY_ID = Object.fromEntries(HAND_PRESETS.map((p) => [p.id, p]));

/** Claves numericas que definen una mano (el orden es el de los sliders). */
export const HAND_VALUES = ['thumb', 'index', 'middle', 'ring', 'pinky', 'spread', 'thumbOut'];

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();
const _n = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();

const clamp01 = (v) => (v <= 0 ? 0 : v >= 1 ? 1 : v);

/**
 * Deduce los ejes anatomicos de las dos manos y aplica sobre ellos los valores
 * de `hands.*`. Es un objeto barato: solo guarda 30 referencias a huesos y sus
 * ejes, y se reconstruye cuando cambia el personaje.
 */
export class HandRig {
  /**
   * @param {import('./Character.js').Character} character
   * @param {import('../core/Settings.js').Settings} settings
   */
  constructor(character, settings) {
    this.character = character;
    this.settings = settings;
    /** @type {{left: object|null, right: object|null}} */
    this.sides = { left: null, right: null };
  }

  /** True cuando al menos una mano tiene falanges utilizables. */
  get ready() { return Boolean(this.sides.left || this.sides.right); }

  /** Vuelve a leer la geometria de reposo. Se llama tras cargar un personaje. */
  rebuild() {
    this.sides = { left: this.#derive('left'), right: this.#derive('right') };
    return this.ready;
  }

  /** Cambia la figura cuyos dedos manejan los deslizadores de `hands.*`. */
  setCharacter(character) {
    if (this.character === character) return this;
    this.character = character;
    if (character?.loaded) this.rebuild();
    else this.clear();
    return this;
  }

  /** Olvida los ejes (al descargar el personaje). */
  clear() { this.sides = { left: null, right: null }; }

  /** Numero de falanges controlables, para los avisos de la interfaz. */
  count() {
    let n = 0;
    for (const rig of Object.values(this.sides)) {
      if (!rig) continue;
      for (const chain of Object.values(rig.chains)) n += chain.parts.length;
    }
    return n;
  }

  /** Vector unitario "arriba" del modelo, para desempatar el lado de la palma. */
  #modelUp() {
    return new THREE.Vector3(0, 1, 0).applyQuaternion(this.character.basis ?? _q.identity());
  }

  /**
   * Construye el marco de la palma y los ejes de cada falange de un lado.
   * Devuelve null si el personaje no trae dedos en esa mano.
   */
  #derive(side) {
    const ch = this.character;
    if (!ch?.loaded || !ch.rest?.position?.size) return null;
    const bone = (k) => ch.bones[k] ?? null;
    const pos = (k) => { const b = bone(k); return b ? ch.rest.position.get(b) ?? null : null; };

    // --- cadenas disponibles ------------------------------------------------
    const chains = {};
    for (const f of FINGERS) {
      const bones = fingerKeys(side, f).map(bone);
      if (!bones[0]) continue;                       // dedo ausente en el rig
      chains[f] = { bones: bones.filter(Boolean), parts: [], fan: 0 };
    }
    if (!Object.keys(chains).length) return null;

    // --- eje de la mano (dedo medio) y linea de nudillos --------------------
    const pHand = pos(`${side}Hand`);
    const pMid1 = pos(`${side}Middle1`) ?? pos(`${side}Index1`);
    const pMidTip = pos(`${side}Middle3`) ?? pos(`${side}Middle2`) ?? pos(`${side}Index3`);
    if (pMid1 && pMidTip) _d.copy(pMidTip).sub(pMid1);
    else if (pHand && pMid1) _d.copy(pMid1).sub(pHand);
    else return null;
    if (_d.lengthSq() < 1e-12) return null;
    _d.normalize();

    const pIndex = pos(`${side}Index1`);
    const pPinky = pos(`${side}Pinky1`);
    if (pIndex && pPinky) _w.copy(pPinky).sub(pIndex);
    else _w.set(1, 0, 0).applyQuaternion(ch.basis ?? _q.identity()).multiplyScalar(side === 'left' ? -1 : 1);
    _w.addScaledVector(_d, -_w.dot(_d));             // Gram-Schmidt contra el eje
    if (_w.lengthSq() < 1e-12) return null;
    _w.normalize();

    // Normal de la palma: el signo se decide con la punta del pulgar, que
    // siempre cae del lado palmar. Si el pulgar no da margen suficiente se usa
    // la base del cuerpo (en T las palmas miran al suelo).
    _n.crossVectors(_d, _w).normalize();
    const escala = pHand && pMidTip ? pMidTip.distanceTo(pHand) : 1;
    const pThumb = pos(`${side}Thumb3`) ?? pos(`${side}Thumb2`);
    const ref = pIndex ?? pMid1;
    let s = 0;
    if (pThumb && ref) s = _n.dot(_b.copy(pThumb).sub(ref));
    if (Math.abs(s) < escala * 0.02) s = -_n.dot(this.#modelUp());
    if (s < 0) _n.negate();

    // Signo del abanico: giro positivo alrededor de la normal que lleva el
    // dedo hacia el lado del menique.
    const sgn = Math.sign(_a.crossVectors(_n, _d).dot(_w)) || 1;

    // --- ejes por falange, en el espacio del padre en reposo ----------------
    const dedo = new THREE.Vector3();
    const curl = new THREE.Vector3();
    for (const [f, chain] of Object.entries(chains)) {
      const b0 = chain.bones[0];
      const p0 = ch.rest.position.get(b0);
      const p1 = chain.bones[1] ? ch.rest.position.get(chain.bones[1]) : null;
      if (p0 && p1) dedo.copy(p1).sub(p0);
      else if (pHand && p0) dedo.copy(p0).sub(pHand);
      else dedo.copy(_d);
      if (dedo.lengthSq() < 1e-12) dedo.copy(_d);
      dedo.normalize();

      // Girar +angulo alrededor de cross(dedo, normal) lleva la punta a la palma.
      curl.crossVectors(dedo, _n);
      if (curl.lengthSq() < 1e-10) curl.crossVectors(_d, _n);
      curl.normalize();

      chain.fan = (f === 'thumb' ? -1 : FAN[f] ?? 0) * sgn;
      chain.bones.forEach((b, i) => {
        const restLocal = ch.rest.local.get(b)?.clone() ?? b.quaternion.clone();
        const padre = b.parent ? ch.rest.world.get(b.parent) : null;
        _q.copy(padre ?? _q2.identity()).invert();
        chain.parts.push({
          bone: b,
          curlAxis: curl.clone().applyQuaternion(_q),
          spreadAxis: _n.clone().applyQuaternion(_q),
          restLocal,
          max: (CURL_MAX[f]?.[i] ?? 80) * DEG,
        });
      });
    }

    return { chains, palma: _n.clone(), eje: _d.clone(), nudillos: _w.clone(), sgn };
  }

  /**
   * Escribe la pose de un dedo. `curls` son radianes por falange y `abanico`
   * el giro de separacion, que solo afecta a la primera.
   */
  #write(chain, curls, abanico, smooth) {
    chain.parts.forEach((part, i) => {
      _q.setFromAxisAngle(part.curlAxis, curls[i] ?? 0);
      if (i === 0 && Math.abs(abanico) > 1e-6) {
        _q2.setFromAxisAngle(part.spreadAxis, abanico);
        _q.premultiply(_q2);                       // separacion por fuera
      }
      _q.multiply(part.restLocal);
      if (smooth >= 1) part.bone.quaternion.copy(_q);
      else part.bone.quaternion.slerp(_q, smooth); // suavizado de la captura
    });
  }

  /** Aplica los valores 0..1 guardados en `hands.<lado>`. */
  #fromSettings(side) {
    const rig = this.sides[side];
    if (!rig) return false;
    const conf = this.settings.get(`hands.${side}`) ?? {};
    const spread = clamp01(conf.spread ?? 0) * SPREAD_MAX;
    const out = clamp01(conf.thumbOut ?? 0) * THUMB_OUT_MAX;
    for (const [f, chain] of Object.entries(rig.chains)) {
      const v = clamp01(conf[f] ?? 0);
      this.#write(chain, chain.parts.map((p) => v * p.max), chain.fan * (f === 'thumb' ? out : spread), 1);
    }
    return true;
  }

  /** Pose manual: sin argumento actua sobre las dos manos. */
  apply(side = null) {
    const lados = side ? [side] : ['left', 'right'];
    let hecho = false;
    for (const s of lados) hecho = this.#fromSettings(s) || hecho;
    return hecho;
  }

  /**
   * Camino de la captura: angulos ya medidos en radianes.
   * @param {'left'|'right'} side
   * @param {{[dedo:string]: number[], spread?: number, thumbOut?: number}} angulos
   * @param {number} smooth 1 = directo, <1 = interpolacion por fotograma.
   */
  applyAngles(side, angulos, smooth = 1) {
    const rig = this.sides[side];
    if (!rig || !angulos) return false;
    for (const [f, chain] of Object.entries(rig.chains)) {
      const curls = angulos[f];
      if (!curls) continue;
      const limite = (a, p) => Math.max(-0.25 * p.max, Math.min(1.2 * p.max, a || 0));
      const abanico = f === 'thumb'
        ? chain.fan * (angulos.thumbOut ?? 0)
        : chain.fan * (angulos.spread ?? 0);
      this.#write(chain, chain.parts.map((p, i) => limite(curls[i], p)), abanico, smooth);
    }
    return true;
  }

  /** Devuelve las falanges a su reposo, sin tocar los ajustes. */
  reset(side = null) {
    for (const s of side ? [side] : ['left', 'right']) {
      const rig = this.sides[s];
      if (!rig) continue;
      for (const chain of Object.values(rig.chains)) {
        for (const part of chain.parts) part.bone.quaternion.copy(part.restLocal);
      }
    }
  }

  /** Escribe un gesto en los ajustes y lo aplica. */
  applyPreset(side, id) {
    const preset = HAND_PRESET_BY_ID[id];
    if (!preset) return false;
    for (const s of side ? [side] : ['left', 'right']) {
      this.settings.set(`hands.${s}.preset`, id);
      for (const k of HAND_VALUES) this.settings.set(`hands.${s}.${k}`, preset.values[k]);
    }
    return this.apply(side);
  }

  /** Copia los valores de una mano en la otra (interruptor "manos unidas"). */
  mirror(from) {
    const to = from === 'left' ? 'right' : 'left';
    const conf = this.settings.get(`hands.${from}`) ?? {};
    this.settings.set(`hands.${to}.preset`, conf.preset ?? 'libre');
    for (const k of HAND_VALUES) this.settings.set(`hands.${to}.${k}`, conf[k] ?? 0);
    return this.apply(to);
  }

  /** Lectura de los valores actuales de una mano (para pruebas y guardado). */
  values(side) {
    const conf = this.settings.get(`hands.${side}`) ?? {};
    return Object.fromEntries(HAND_VALUES.map((k) => [k, conf[k] ?? 0]));
  }
}
