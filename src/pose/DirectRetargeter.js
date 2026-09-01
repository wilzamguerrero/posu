/**
 * ATOM · Retargeting directo
 * ---------------------------------------------------------------------------
 * Convierte los 33 puntos de BlazePose en rotaciones locales para el esqueleto
 * cargado. No asume ninguna convencion de ejes del rigging: todo se calcula
 * como una DESVIACION respecto a la pose de reposo del propio archivo.
 *
 *   direccionReposo   = normalizar( posReposo(hijo) - posReposo(hueso) )
 *   direccionObjetivo = normalizar( puntoB - puntoA )   (de MediaPipe)
 *   delta             = rotacion minima que lleva una a la otra
 *   mundoObjetivo     = delta · mundoReposo
 *   localObjetivo     = inv( mundoObjetivo(padre) ) · mundoObjetivo
 *
 * Al ser una desviacion, funciona igual con Mixamo, con un rigging de Blender o
 * con cualquier otro, sin tablas de correccion por hueso.
 *
 * Espacio de trabajo: el "espacio de enlace" del esqueleto. Los puntos de
 * MediaPipe llegan en el sistema (X=izquierda del sujeto, Y=arriba, Z=frente) y
 * se giran con `character.basis`, que es la base corporal medida en el reposo.
 */
import * as THREE from 'three';
import { LM, vis } from './landmarks.js';
import { BONE_GROUP_OF } from '../model/boneMap.js';

/** Contraparte simetrica de cada punto, para el modo espejo. */
const SWAP = (() => {
  const s = Array.from({ length: 33 }, (_, i) => i);
  const pairs = [[1, 4], [2, 5], [3, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16],
    [17, 18], [19, 20], [21, 22], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32]];
  for (const [a, b] of pairs) { s[a] = b; s[b] = a; }
  return s;
})();

/**
 * Cadenas hueso -> punto final. Cada entrada dice de que segmento de MediaPipe
 * se toma la direccion objetivo del hueso, y a que hueso hijo apunta en reposo.
 */
const LIMB_CHAINS = [
  { key: 'leftArm', child: 'leftForeArm', from: LM.LEFT_SHOULDER, to: LM.LEFT_ELBOW },
  { key: 'leftForeArm', child: 'leftHand', from: LM.LEFT_ELBOW, to: LM.LEFT_WRIST },
  { key: 'rightArm', child: 'rightForeArm', from: LM.RIGHT_SHOULDER, to: LM.RIGHT_ELBOW },
  { key: 'rightForeArm', child: 'rightHand', from: LM.RIGHT_ELBOW, to: LM.RIGHT_WRIST },
  { key: 'leftUpLeg', child: 'leftLeg', from: LM.LEFT_HIP, to: LM.LEFT_KNEE },
  { key: 'leftLeg', child: 'leftFoot', from: LM.LEFT_KNEE, to: LM.LEFT_ANKLE },
  { key: 'rightUpLeg', child: 'rightLeg', from: LM.RIGHT_HIP, to: LM.RIGHT_KNEE },
  { key: 'rightLeg', child: 'rightFoot', from: LM.RIGHT_KNEE, to: LM.RIGHT_ANKLE },
  { key: 'leftFoot', child: 'leftToe', from: LM.LEFT_ANKLE, to: LM.LEFT_FOOT_INDEX },
  { key: 'rightFoot', child: 'rightToe', from: LM.RIGHT_ANKLE, to: LM.RIGHT_FOOT_INDEX },
  { key: 'leftHand', child: 'leftMiddle1', from: LM.LEFT_WRIST, toMid: [LM.LEFT_INDEX, LM.LEFT_PINKY], late: true },
  { key: 'rightHand', child: 'rightMiddle1', from: LM.RIGHT_WRIST, toMid: [LM.RIGHT_INDEX, LM.RIGHT_PINKY], late: true },
];

/** Orden de resolucion: siempre padres antes que hijos. */
const ORDER = [
  'hips', 'spine', 'spine1', 'spine2', 'neck', 'head',
  'leftShoulder', 'leftArm', 'leftForeArm', 'leftHand',
  'rightShoulder', 'rightArm', 'rightForeArm', 'rightHand',
  'leftUpLeg', 'leftLeg', 'leftFoot', 'leftToe',
  'rightUpLeg', 'rightLeg', 'rightFoot', 'rightToe',
];

const IDENTITY = new THREE.Quaternion();

/** Marco ortonormal a partir de un eje "izquierda" y un eje "arriba". */
function frameFrom(left, up, out = new THREE.Quaternion()) {
  const u = _fu.copy(up).normalize();
  const l = _fl.copy(left).normalize();
  l.addScaledVector(u, -l.dot(u));
  if (l.lengthSq() < 1e-8) return null;
  l.normalize();
  const f = _ff.crossVectors(l, u);
  return out.setFromRotationMatrix(_fm.makeBasis(l, u, f));
}

const _fu = new THREE.Vector3();
const _fl = new THREE.Vector3();
const _ff = new THREE.Vector3();
const _fm = new THREE.Matrix4();

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _n1 = new THREE.Vector3();
const _n2 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _pq = new THREE.Quaternion();
const _pq2 = new THREE.Quaternion();

export class DirectRetargeter {
  constructor() {
    this.points = Array.from({ length: 33 }, () => new THREE.Vector3());
    this.ok = new Array(33).fill(false);
    this.worldByBone = new Map();
    this.local = new Map();        // clave canonica -> quaternion local objetivo
    this.hipsOffset = new THREE.Vector3();
    this.confidence = 0;
    this.cache = { character: null };
  }

  /** Convierte y valida los 33 puntos, ya girados al espacio del modelo. */
  #read(landmarks, character, minVis, mirror) {
    const basis = character.basis;
    let sum = 0;
    for (let i = 0; i < 33; i++) {
      const lm = landmarks[mirror ? SWAP[i] : i];
      const v = vis(lm);
      sum += v;
      this.ok[i] = !!lm && v >= minVis;
      if (!lm) continue;
      // Reflejar en X y a la vez intercambiar los indices produce una simetria
      // limpia: el resultado sigue siendo una rotacion, no una reflexion.
      this.points[i].set(mirror ? -lm.x : lm.x, -lm.y, -lm.z).applyQuaternion(basis);
    }
    this.confidence = sum / 33;
  }

  /** Punto medio validado. */
  #mid(a, b, out) {
    if (!this.ok[a] || !this.ok[b]) return null;
    return out.copy(this.points[a]).add(this.points[b]).multiplyScalar(0.5);
  }

  /** Marco corporal en reposo, calculado una vez por modelo. */
  #restFrames(character) {
    if (this.cache.character === character) return this.cache.frames;
    const P = (k) => character.rest.position.get(character.bones[k]) ?? null;
    const frames = {};

    const lh = P('leftUpLeg'); const rh = P('rightUpLeg');
    const ls = P('leftArm'); const rs = P('rightArm');
    const hipMid = lh && rh ? _v1.copy(lh).add(rh).multiplyScalar(0.5).clone() : null;
    const shMid = ls && rs ? _v2.copy(ls).add(rs).multiplyScalar(0.5).clone() : null;

    if (lh && rh && hipMid && shMid) {
      frames.pelvis = frameFrom(_v3.copy(lh).sub(rh), _n1.copy(shMid).sub(hipMid), new THREE.Quaternion());
    }
    if (ls && rs && shMid) {
      const neck = P('neck') ?? P('spine2');
      frames.chest = frameFrom(_v3.copy(ls).sub(rs), neck ? _n1.copy(neck).sub(shMid) : _n1.set(0, 1, 0), new THREE.Quaternion());
    }
    const head = P('head');
    const neck = P('neck');
    if (head && neck) {
      // En reposo no hay orejas ni nariz: se usa el eje del cuello y la base
      // corporal, que es la referencia equivalente.
      const leftAxis = ls && rs ? _v3.copy(ls).sub(rs) : _v3.set(1, 0, 0);
      frames.head = frameFrom(leftAxis, _n1.copy(head).sub(neck), new THREE.Quaternion());
    }

    frames.hipMid = hipMid;
    frames.shMid = shMid;

    // Normal de la palma en reposo, para deducir la torsion del antebrazo.
    for (const side of ['left', 'right']) {
      const w = P(`${side}Hand`);
      const idx = P(`${side}Index1`);
      const pky = P(`${side}Pinky1`);
      if (w && idx && pky) {
        frames[`${side}Palm`] = new THREE.Vector3()
          .crossVectors(_v3.copy(idx).sub(w), _n1.copy(pky).sub(w)).normalize();
      }
    }

    this.cache = { character, frames };
    return frames;
  }

  #slot(key) {
    let q = this.local.get(key);
    if (!q) this.local.set(key, (q = new THREE.Quaternion()));
    return q;
  }

  #wslot(key) {
    this.worldPool ??= new Map();
    let q = this.worldPool.get(key);
    if (!q) this.worldPool.set(key, (q = new THREE.Quaternion()));
    return q;
  }

  /**
   * Calcula las rotaciones locales objetivo.
   * @returns {{ local: Map<string, THREE.Quaternion>, updated: Set<string>, confidence: number }}
   */
  solve(landmarks, character, { minVis = 0.5, mirror = true, gains = {}, twist = true } = {}) {
    this.updated ??= new Set();
    this.updated.clear();
    if (!landmarks?.length || !character?.loaded) return null;

    this.#read(landmarks, character, minVis, mirror);
    const rest = this.#restFrames(character);
    this.worldByBone.clear();

    const B = character.bones;
    const RW = (k) => (B[k] ? character.rest.world.get(B[k]) : null);
    const RP = (k) => (B[k] ? character.rest.position.get(B[k]) : null);
    const gain = (k) => {
      const g = gains[BONE_GROUP_OF[k]];
      return g === undefined ? 1 : g;
    };
    /** Atenua un delta acercandolo a la identidad. */
    const soften = (q, g) => (g >= 0.999 ? q : q.slerp(IDENTITY, 1 - g));

    const parentWorld = (bone) => {
      const p = bone.parent;
      if (p && this.worldByBone.has(p)) return this.worldByBone.get(p);
      if (p && character.rest.world.has(p)) return character.rest.world.get(p);
      // Padre no articulado: su orientacion de reposo sale del propio hueso.
      return _pq.copy(character.rest.world.get(bone))
        .multiply(_pq2.copy(character.rest.local.get(bone)).invert());
    };

    const commit = (key, worldQuat) => {
      const bone = B[key];
      if (!bone) return;
      const w = this.#wslot(key).copy(worldQuat);
      this.worldByBone.set(bone, w);
      this.#slot(key).copy(parentWorld(bone)).invert().multiply(w);
      this.updated.add(key);
    };

    // ---------------------------------------------------------------- torso ---
    this._hipMid ??= new THREE.Vector3();
    this._shMid ??= new THREE.Vector3();
    this._earMid ??= new THREE.Vector3();
    this._dPelvis ??= new THREE.Quaternion();
    this._dChest ??= new THREE.Quaternion();
    this._dHead ??= new THREE.Quaternion();

    const hipMid = this.#mid(LM.LEFT_HIP, LM.RIGHT_HIP, this._hipMid);
    const shMid = this.#mid(LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, this._shMid);
    const earMid = this.#mid(LM.LEFT_EAR, LM.RIGHT_EAR, this._earMid);

    let dPelvis = null;
    if (rest.pelvis && hipMid && shMid) {
      const f = frameFrom(_v1.copy(this.points[LM.LEFT_HIP]).sub(this.points[LM.RIGHT_HIP]),
        _v2.copy(shMid).sub(hipMid), _q1);
      if (f) dPelvis = soften(this._dPelvis.copy(f).multiply(_q2.copy(rest.pelvis).invert()), gain('hips'));
    }

    let dChest = null;
    if (rest.chest && shMid) {
      const upRef = earMid ? _v2.copy(earMid).sub(shMid) : (hipMid ? _v2.copy(shMid).sub(hipMid) : null);
      if (upRef) {
        const f = frameFrom(_v1.copy(this.points[LM.LEFT_SHOULDER]).sub(this.points[LM.RIGHT_SHOULDER]), upRef, _q1);
        if (f) dChest = soften(this._dChest.copy(f).multiply(_q2.copy(rest.chest).invert()), gain('spine2'));
      }
    }

    let dHead = null;
    if (rest.head && earMid && this.ok[LM.NOSE]) {
      // Marco de la cabeza: eje entre orejas y frente hacia la nariz.
      const left = _v1.copy(this.points[LM.LEFT_EAR]).sub(this.points[LM.RIGHT_EAR]);
      const fwd = _v2.copy(this.points[LM.NOSE]).sub(earMid);
      const up = _v3.crossVectors(fwd, left);
      const f = frameFrom(left, up, _q1);
      if (f) dHead = soften(this._dHead.copy(f).multiply(_q2.copy(rest.head).invert()), gain('head'));
    }

    const base = dPelvis ?? dChest;
    if (dPelvis && RW('hips')) commit('hips', _q1.copy(dPelvis).multiply(RW('hips')));
    const chain = [['spine', 1 / 3], ['spine1', 2 / 3], ['spine2', 1]];
    for (const [key, t] of chain) {
      if (!RW(key) || !base) continue;
      const d = _q1.copy(base);
      if (dChest && dPelvis) d.slerp(dChest, t);
      commit(key, d.multiply(RW(key)));
    }
    if (RW('neck')) {
      const d = _q1.copy(dChest ?? dPelvis ?? IDENTITY);
      if (dHead) d.slerp(dHead, 0.45);
      if (dChest || dPelvis || dHead) commit('neck', d.multiply(RW('neck')));
    }
    if (dHead && RW('head')) commit('head', _q1.copy(dHead).multiply(RW('head')));

    // ------------------------------------------------------------ claviculas ---
    // La clavicula no tiene un segmento equivalente en MediaPipe, asi que se
    // compara la direccion "centro de hombros -> hombro" con la misma medida
    // tomada sobre el rig en reposo.
    for (const side of ['left', 'right']) {
      const key = `${side}Shoulder`;
      const armKey = `${side}Arm`;
      const idx = side === 'left' ? LM.LEFT_SHOULDER : LM.RIGHT_SHOULDER;
      if (!RW(key) || !RP(armKey) || !rest.shMid || !shMid || !this.ok[idx]) continue;
      const restDir = _v1.copy(RP(armKey)).sub(rest.shMid);
      const liveDir = _v2.copy(this.points[idx]).sub(shMid);
      if (restDir.lengthSq() < 1e-10 || liveDir.lengthSq() < 1e-10) continue;
      const d = soften(_q1.setFromUnitVectors(restDir.normalize(), liveDir.normalize()), gain(key) * 0.6);
      commit(key, _q2.copy(d).multiply(RW(key)));
    }

    // --------------------------------------------------------- extremidades ---
    const solveChain = (c) => {
      const key = c.key;
      const childP = RP(c.child);
      if (!RW(key) || !RP(key) || !childP || !this.ok[c.from]) return;
      const to = c.toMid ? this.#mid(c.toMid[0], c.toMid[1], _v3) : (this.ok[c.to] ? this.points[c.to] : null);
      if (!to) return;
      const restDir = _v1.copy(childP).sub(RP(key));
      const liveDir = _v2.copy(to).sub(this.points[c.from]);
      if (restDir.lengthSq() < 1e-10 || liveDir.lengthSq() < 1e-10) return;
      const d = soften(_q1.setFromUnitVectors(restDir.normalize(), liveDir.normalize()), gain(key));
      commit(key, _q2.copy(d).multiply(RW(key)));
    };

    for (const c of LIMB_CHAINS) if (!c.late) solveChain(c);

    // ---------------------------------------------- torsion de los antebrazos ---
    // El giro del antebrazo sobre su eje no se deduce de la posicion del codo:
    // hay que leerlo del plano de la mano (indice - muñeca x menique - muñeca).
    if (twist) {
      this._tq ??= new THREE.Quaternion();
      for (const side of ['left', 'right']) {
        const key = `${side}ForeArm`;
        const palmRest = rest[`${side}Palm`];
        const bone = B[key];
        const w = bone ? this.worldByBone.get(bone) : null;
        const handRest = RP(`${side}Hand`);
        if (!palmRest || !w || !handRest || !RW(key)) continue;

        const iIdx = side === 'left' ? LM.LEFT_INDEX : LM.RIGHT_INDEX;
        const pIdx = side === 'left' ? LM.LEFT_PINKY : LM.RIGHT_PINKY;
        const wIdx = side === 'left' ? LM.LEFT_WRIST : LM.RIGHT_WRIST;
        if (!this.ok[iIdx] || !this.ok[pIdx] || !this.ok[wIdx]) continue;

        // Delta acumulado del hueso: sirve para saber donde ha quedado su eje.
        const delta = this._tq.copy(w).multiply(_q2.copy(RW(key)).invert());
        const axis = _v1.copy(handRest).sub(RP(key)).normalize().applyQuaternion(delta);
        const nRest = _v2.copy(palmRest).applyQuaternion(delta);
        const nLive = _n1.crossVectors(
          _v3.copy(this.points[iIdx]).sub(this.points[wIdx]),
          _n2.copy(this.points[pIdx]).sub(this.points[wIdx]),
        );
        if (nLive.lengthSq() < 1e-10) continue;
        nLive.normalize();

        // Angulo firmado alrededor del eje entre las dos normales proyectadas.
        nRest.addScaledVector(axis, -nRest.dot(axis));
        nLive.addScaledVector(axis, -nLive.dot(axis));
        if (nRest.lengthSq() < 1e-8 || nLive.lengthSq() < 1e-8) continue;
        nRest.normalize();
        nLive.normalize();
        const angle = Math.atan2(_n2.crossVectors(nRest, nLive).dot(axis), nRest.dot(nLive));
        const g = gain('hands');
        commit(key, _q1.setFromAxisAngle(axis, angle * g).multiply(w));
      }
    }

    for (const c of LIMB_CHAINS) if (c.late) solveChain(c);

    // Desplazamiento de la cadera en el espacio del modelo (metros).
    if (hipMid) this.hipsOffset.copy(hipMid);

    return { local: this.local, updated: this.updated, confidence: this.confidence, hipsOffset: this.hipsOffset };
  }

  reset() {
    this.updated?.clear();
    this.worldByBone.clear();
  }
}
