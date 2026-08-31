/**
 * PoseEngine
 * ==========
 * Capa que convierte la salida de MediaPipe en la pose del personaje. Es el
 * unico sitio donde se escriben las rotaciones de los huesos durante la
 * captura, de modo que el resto de la aplicacion no necesita saber que motor de
 * retargeting esta activo.
 *
 * Cadena de proceso por fotograma:
 *
 *   MediaPipe (33 puntos)
 *     -> filtro One-Euro sobre las posiciones (quita el ruido de deteccion)
 *     -> motor de retargeting (directo o Kalidokit) -> rotaciones locales
 *     -> slerp por fotograma hacia esas rotaciones (quita el temblor residual)
 *     -> huesos "mixamorig..." de la escena
 *
 * El filtro One-Euro es adaptativo: suaviza mucho cuando el punto esta quieto y
 * deja pasar el movimiento rapido, asi que no introduce el retardo tipico de una
 * media movil. El slerp final es el que exige el plan para evitar el "jittering".
 */

import * as THREE from 'three';
import { DirectRetargeter } from './DirectRetargeter.js';
import { KalidokitRetargeter } from './KalidokitRetargeter.js';
import { OneEuroFilter } from './OneEuroFilter.js';
import { LM } from './landmarks.js';

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _pq = new THREE.Quaternion();

/** Copia superficial reutilizable de una lista de puntos de MediaPipe. */
function reuse(store, length) {
  while (store.length < length) store.push({ x: 0, y: 0, z: 0, visibility: 0 });
  store.length = length;
  return store;
}

export class PoseEngine {
  /**
   * @param {import('../core/Settings.js').Settings} settings
   * @param {import('../model/Character.js').Character} character
   */
  constructor(settings, character) {
    this.settings = settings;
    this.character = character;

    this.direct = new DirectRetargeter();
    this.kalido = new KalidokitRetargeter();
    this.filter3d = new OneEuroFilter();
    this.filter2d = new OneEuroFilter();

    this._lm3d = [];
    this._lm2d = [];
    this._frame = { landmarks: null, worldLandmarks: null };

    /** Ultimo resultado util, para el HUD y la biblioteca de poses. */
    this.confidence = 0;
    this.lastKeys = new Set();
    this.active = false;
    this.hipsTarget = new THREE.Vector3();

    this.#configureFilters();
    settings.on(['mocap.oneEuroFreq', 'mocap.oneEuroMinCutoff', 'mocap.oneEuroBeta'],
      () => this.#configureFilters());
    settings.on('mocap.engine', () => this.reset());
    settings.on('mocap.mirror', () => this.reset());
  }

  #configureFilters() {
    const s = this.settings;
    const cfg = {
      freq: Math.max(1, s.get('mocap.oneEuroFreq')),
      minCutoff: Math.max(0.01, s.get('mocap.oneEuroMinCutoff')),
      beta: Math.max(0, s.get('mocap.oneEuroBeta')),
    };
    this.filter3d.configure(cfg);
    this.filter2d.configure(cfg);
  }

  reset() {
    this.filter3d.reset();
    this.filter2d.reset();
    this.direct.reset?.();
    this.kalido.reset?.();
    this.lastKeys.clear();
    this.active = false;
  }

  /**
   * Cambia la figura que recibe la captura. Los filtros y las cachas de
   * retargeting se limpian: los huesos del personaje nuevo son otros.
   */
  setCharacter(character) {
    if (this.character === character) return this;
    this.character = character;
    this.reset();
    return this;
  }

  /** Suaviza las posiciones de los puntos antes de resolver la pose. */
  #smoothPoints(source, store, filter, dt) {
    if (!source?.length) return null;
    const out = reuse(store, source.length);
    const use = this.settings.get('mocap.oneEuro');
    for (let i = 0; i < source.length; i++) {
      const p = source[i];
      const o = out[i];
      if (!p) { o.visibility = 0; continue; }
      if (use) {
        _v.set(p.x, p.y, p.z ?? 0);
        filter.vector(i, _v, dt);
        o.x = _v.x; o.y = _v.y; o.z = _v.z;
      } else {
        o.x = p.x; o.y = p.y; o.z = p.z ?? 0;
      }
      o.visibility = p.visibility ?? p.score ?? 1;
    }
    return out;
  }

  /** Orientacion de reposo del padre de un hueso, en el espacio del modelo. */
  #parentRest(bone) {
    const ch = this.character;
    const p = bone.parent;
    if (p && ch.rest.world.has(p)) return _pq.copy(ch.rest.world.get(p));
    return _pq.copy(ch.rest.world.get(bone)).multiply(_q.copy(ch.rest.local.get(bone)).invert());
  }

  /**
   * Aplica un fotograma de deteccion al personaje.
   * @param {{landmarks: Array, worldLandmarks: Array}|null} frame
   * @param {number} dt Segundos transcurridos desde el fotograma anterior.
   * @returns {boolean} true si la pose se actualizo.
   */
  update(frame, dt = 1 / 60) {
    const s = this.settings;
    const ch = this.character;
    if (!ch?.loaded || !frame?.landmarks?.length) { this.active = false; return false; }
    if (s.get('mocap.frozen')) return false;

    const step = Math.min(0.25, Math.max(1 / 240, dt || 1 / 60));
    // Los puntos de mundo vienen en metros y centrados en la cadera: son los
    // buenos para deducir rotaciones. Los normalizados (0..1) sirven para el
    // desplazamiento en pantalla y son los que espera Kalidokit como lm2d.
    const src3d = frame.worldLandmarks?.length ? frame.worldLandmarks : frame.landmarks;
    const lm3d = this.#smoothPoints(src3d, this._lm3d, this.filter3d, step);
    const lm2d = this.#smoothPoints(frame.landmarks, this._lm2d, this.filter2d, step);
    if (!lm3d || !lm2d) { this.active = false; return false; }

    const mirror = !!s.get('mocap.mirror');
    const gains = s.get('mocap.parts') ?? {};
    const minVis = s.get('mocap.confidence');

    const direct = this.direct.solve(lm3d, ch, { minVis, mirror, gains, twist: true });
    if (!direct) { this.active = false; return false; }

    let local = direct.local;
    let keys = direct.updated;
    this.confidence = direct.confidence;

    if (s.get('mocap.engine') === 'kalidokit') {
      this._frame.landmarks = lm2d;
      this._frame.worldLandmarks = lm3d;
      // El motor directo ya dejo resueltos cuello, cabeza y claviculas: se le
      // pasan a Kalidokit como semilla para que los padres encajen.
      const k = this.kalido.solve(this._frame, ch, { mirror, gains, seedWorld: this.direct.worldByBone });
      if (k) {
        this._merged ??= new Map();
        this._keys ??= new Set();
        const m = this._merged;
        m.clear();
        for (const key of keys) m.set(key, local.get(key));
        for (const key of k.updated) m.set(key, k.local.get(key));
        this._keys.clear();
        for (const key of m.keys()) this._keys.add(key);
        local = m;
        keys = this._keys;
      }
    }

    // ------------------------------------------------- suavizado por slerp ---
    // `smoothing` es inercia: 0 = instantaneo, 0.9 = muy amortiguado. Se
    // normaliza con el tiempo real del fotograma para que el resultado no
    // dependa de si la camara va a 15 o a 60 fps.
    const inertia = Math.min(0.98, Math.max(0, s.get('mocap.smoothing') ?? 0));
    const alpha = inertia <= 0.001 ? 1 : 1 - Math.pow(inertia, step * 60);

    for (const key of keys) {
      const bone = ch.bones[key];
      const target = local.get(key);
      if (!bone || !target) continue;
      if (alpha >= 1) bone.quaternion.copy(target);
      else bone.quaternion.slerp(target, alpha);
    }

    // ------------------------------------------- desplazamiento de la cadera ---
    const hips = ch.bones.hips;
    if (hips) {
      if (s.get('mocap.followPosition')) {
        const a = lm2d[LM.LEFT_HIP];
        const b = lm2d[LM.RIGHT_HIP];
        const range = Math.max(0, s.get('mocap.positionRange'));
        if (a && b && (a.visibility ?? 1) >= minVis && (b.visibility ?? 1) >= minVis) {
          const cx = (a.x + b.x) * 0.5 - 0.5;
          const cy = (a.y + b.y) * 0.5 - 0.5;
          // Pantalla -> marco de aplicacion (+X izquierda del modelo, +Y arriba)
          // y de ahi al espacio del modelo con la base medida del personaje.
          this.hipsTarget.set((mirror ? -cx : cx) * 2 * range, -cy * 2 * range, 0)
            .applyQuaternion(ch.basis)
            .applyQuaternion(this.#parentRest(hips).invert())
            .add(ch.restHipsLocal ?? hips.position);
          hips.position.lerp(this.hipsTarget, alpha);
        }
      } else if (ch.restHipsLocal && !hips.position.equals(ch.restHipsLocal)) {
        hips.position.lerp(ch.restHipsLocal, alpha);
      }
    }

    this.lastKeys = keys;
    this.active = true;
    return true;
  }

  /** Congela o reanuda la escritura de la pose. */
  setFrozen(frozen) {
    this.settings.set('mocap.frozen', !!frozen);
  }

  /** Devuelve el personaje a su pose de enlace y limpia los filtros. */
  release() {
    this.reset();
    this.character?.resetToRest();
  }
}
