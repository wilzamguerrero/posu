/**
 * KalidokitRetargeter
 * ===================
 * Segundo motor de retargeting, exigido por el plan: usa Kalidokit para
 * convertir los 33 puntos de MediaPipe en rotaciones y las traslada a los
 * huesos "mixamorig..." cargados en la escena.
 *
 * Kalidokit esta pensado para avatares VRM: devuelve rotaciones LOCALES
 * (angulos de Euler) relativas a la pose T de un rig VRM, cuyos huesos tienen
 * todos el mismo marco en reposo, alineado con los ejes del mundo. En VRM 0.x
 * el personaje mira hacia -Z, de modo que ese marco es:
 *
 *     +X = DERECHA del personaje    +Y = arriba    +Z = ESPALDA del personaje
 *
 * El marco de aplicacion, en cambio, sale de leer MediaPipe con
 * `toVector` -> (x, -y, -z):
 *
 *     +X = izquierda del sujeto     +Y = arriba    +Z = frente del sujeto
 *
 * Los dos describen las mismas direcciones fisicas girados 180 grados en Y, asi
 * que la conversion es una conjugacion por ese giro, que en un quaternion se
 * reduce a negar las componentes x y z (ver `vrmToApp`). Sin ella el brazo que
 * el sujeto levanta baja en el modelo. Con la conversion hecha, el resto es:
 *
 *   1. acumular las rotaciones locales de Kalidokit a lo largo de la jerarquia
 *      VRM para obtener un "delta de mundo" por hueso,
 *   2. llevar ese delta al espacio del modelo conjugandolo con la base medida
 *      del personaje:  D = basis * d * basis⁻¹,
 *   3. reutilizar la misma tuberia que el motor directo:
 *      mundoObjetivo = D * mundoReposo   y   local = padreMundo⁻¹ * mundoObjetivo.
 *
 * De este modo el resultado es independiente del rig (no hay tablas de ejes por
 * hueso) y es intercambiable con DirectRetargeter: ambos devuelven el mismo
 * tipo de mapa de rotaciones locales, que PoseEngine suaviza con slerp.
 *
 * Kalidokit solo resuelve torso, brazos, piernas y muñecas. Cabeza, cuello y
 * claviculas los aporta el motor directo; PoseEngine mezcla ambos resultados y
 * pasa aqui `seedWorld` para que los padres no calculados se resuelvan bien.
 */

import * as THREE from 'three';
import * as Kalidokit from 'kalidokit';

/**
 * Cadena de acumulacion. `src` es la clave que devuelve Kalidokit, `parent` es
 * el padre dentro de la jerarquia VRM (no del rig destino) y `blend` permite
 * repartir una sola rotacion entre varios huesos (la columna).
 */
const CHAIN = [
  { key: 'hips', src: 'Hips', rot: 'rotation', parent: null },
  { key: 'spine', src: 'Spine', parent: 'hips', blend: 1 / 3 },
  { key: 'spine1', src: 'Spine', parent: 'spine', blend: 1 / 3 },
  { key: 'spine2', src: 'Spine', parent: 'spine1', blend: 1 / 3 },

  { key: 'leftArm', src: 'LeftUpperArm', parent: 'spine2' },
  { key: 'leftForeArm', src: 'LeftLowerArm', parent: 'leftArm' },
  { key: 'leftHand', src: 'LeftHand', parent: 'leftForeArm' },
  { key: 'rightArm', src: 'RightUpperArm', parent: 'spine2' },
  { key: 'rightForeArm', src: 'RightLowerArm', parent: 'rightArm' },
  { key: 'rightHand', src: 'RightHand', parent: 'rightForeArm' },

  { key: 'leftUpLeg', src: 'LeftUpperLeg', parent: 'hips' },
  { key: 'leftLeg', src: 'LeftLowerLeg', parent: 'leftUpLeg' },
  { key: 'rightUpLeg', src: 'RightUpperLeg', parent: 'hips' },
  { key: 'rightLeg', src: 'RightLowerLeg', parent: 'rightUpLeg' },
];

/** Grupo de ganancia (mocap.parts) al que pertenece cada clave. */
const GROUP = {
  hips: 'torso', spine: 'torso', spine1: 'torso', spine2: 'torso',
  leftArm: 'arms', leftForeArm: 'arms', rightArm: 'arms', rightForeArm: 'arms',
  leftHand: 'hands', rightHand: 'hands',
  leftUpLeg: 'legs', leftLeg: 'legs', rightUpLeg: 'legs', rightLeg: 'legs',
};

/** Pares izquierda/derecha para el modo espejo. */
const MIRROR = {
  leftArm: 'rightArm', rightArm: 'leftArm',
  leftForeArm: 'rightForeArm', rightForeArm: 'leftForeArm',
  leftHand: 'rightHand', rightHand: 'leftHand',
  leftUpLeg: 'rightUpLeg', rightUpLeg: 'leftUpLeg',
  leftLeg: 'rightLeg', rightLeg: 'leftLeg',
};

/** clave canonica -> nombre en la salida de Kalidokit. */
const SRC = Object.fromEntries(CHAIN.map((l) => [l.key, l.src]));

const IDENTITY = new THREE.Quaternion();
const _e = new THREE.Euler();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _pq = new THREE.Quaternion();
const _pq2 = new THREE.Quaternion();
const _basisInv = new THREE.Quaternion();

/** Euler de Kalidokit -> quaternion, respetando su orden de rotacion. */
function toQuat(rot, out = new THREE.Quaternion()) {
  if (!rot) return null;
  const { x = 0, y = 0, z = 0 } = rot;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  _e.set(x, y, z, rot.rotationOrder || 'XYZ');
  return out.setFromEuler(_e);
}

/**
 * Refleja una rotacion en el plano sagital (normal = eje X del marco de
 * aplicacion). Una reflexion S = diag(-1,1,1) transforma la rotacion de eje
 * `a` y angulo `t` en la de eje `-S·a` y el mismo angulo, es decir: se niegan
 * las componentes y y z del quaternion.
 */
function mirrorQuat(q) {
  q.set(q.x, -q.y, -q.z, q.w);
  return q;
}

/**
 * Marco de VRM0 (+X derecha, +Z espalda) -> marco de aplicacion (+X izquierda,
 * +Z frente). Los dos marcos se diferencian en un giro de 180 grados alrededor
 * de Y; conjugar un quaternion por Ry(180) equivale a negar sus componentes x y
 * z, porque ese giro manda el eje (ax, ay, az) al eje (-ax, ay, -az).
 */
function vrmToApp(q) {
  q.set(-q.x, q.y, -q.z, q.w);
  return q;
}

export class KalidokitRetargeter {
  constructor() {
    /** clave canonica -> rotacion local objetivo */
    this.local = new Map();
    /** claves resueltas en el ultimo fotograma */
    this.updated = new Set();
    /** hueso -> orientacion de mundo objetivo (compartido con el motor directo) */
    this.worldByBone = new Map();
    /** clave -> delta de mundo acumulado, en el marco de aplicacion */
    this.delta = new Map();
    this.confidence = 0;
    this.hipsOffset = new THREE.Vector3();
    /** ultimo resultado crudo de Kalidokit, util para depurar en el HUD */
    this.raw = null;
    this.worldPool = new Map();
  }

  #slot(map, key) {
    let q = map.get(key);
    if (!q) map.set(key, (q = new THREE.Quaternion()));
    return q;
  }

  /**
   * @param {{landmarks: Array, worldLandmarks: Array}} frame  Salida de MediaPipe.
   * @param {import('../model/Character.js').Character} character
   * @param {object} opts
   * @param {boolean} opts.mirror        Kalidokit ya devuelve una pose en espejo.
   * @param {object}  opts.gains         Ganancias por grupo (mocap.parts).
   * @param {Map}     opts.seedWorld     Orientaciones de mundo ya calculadas por
   *                                     otro motor (cuello, cabeza, claviculas).
   * @returns {{local: Map, updated: Set<string>, confidence: number}|null}
   */
  solve(frame, character, { mirror = true, gains = {}, seedWorld = null, enableLegs = true } = {}) {
    this.updated.clear();
    if (!character?.loaded) return null;

    const lm3d = frame?.worldLandmarks;
    const lm2d = frame?.landmarks;
    if (!lm3d?.length || !lm2d?.length) return null;

    let rigged = null;
    try {
      // runtime "mediapipe": Kalidokit no modifica los arreglos de entrada.
      rigged = Kalidokit.Pose.solve(lm3d, lm2d, { runtime: 'mediapipe', enableLegs });
    } catch (err) {
      console.warn('[Kalidokit] no se pudo resolver la pose:', err);
      return null;
    }
    if (!rigged) return null;
    this.raw = rigged;

    let sum = 0;
    for (const p of lm3d) sum += p?.visibility ?? 1;
    this.confidence = sum / Math.max(1, lm3d.length);

    const B = character.bones;
    const RW = (k) => (B[k] ? character.rest.world.get(B[k]) : null);
    const basis = character.basis;
    _basisInv.copy(basis).invert();

    this.worldByBone.clear();
    if (seedWorld) for (const [bone, q] of seedWorld) this.worldByBone.set(bone, q);

    const parentWorld = (bone) => {
      const p = bone.parent;
      if (p && this.worldByBone.has(p)) return this.worldByBone.get(p);
      if (p && character.rest.world.has(p)) return character.rest.world.get(p);
      return _pq.copy(character.rest.world.get(bone))
        .multiply(_pq2.copy(character.rest.local.get(bone)).invert());
    };

    for (const link of CHAIN) {
      const { key } = link;
      const bone = B[key];
      const restWorld = RW(key);

      // Delta del padre en la jerarquia VRM (identidad en la raiz).
      const parentDelta = link.parent ? this.delta.get(link.parent) : null;

      // Rotacion local que entrega Kalidokit, ya en modo espejo si toca.
      const srcKey = mirror ? key : (MIRROR[key] ?? key);
      const source = rigged[SRC[srcKey] ?? link.src];
      const raw = link.rot ? source?.[link.rot] : source;
      let localVrm = toQuat(raw, _q1);
      if (localVrm) {
        vrmToApp(localVrm);
        // Kalidokit nombra los lados como si el avatar fuera un espejo del
        // sujeto, asi que solo hay que reflejar cuando NO se quiere espejo.
        if (!mirror) mirrorQuat(localVrm);
      }

      // Reparto de la columna y ganancia por grupo.
      if (localVrm) {
        const g = gains[GROUP[key]] ?? 1;
        const t = (link.blend ?? 1) * g;
        if (t < 0.999) localVrm.slerp(IDENTITY, 1 - Math.max(0, t));
      }

      // Acumulacion: delta(hueso) = delta(padreVRM) * localVRM.
      const acc = this.#slot(this.delta, key);
      if (parentDelta) acc.copy(parentDelta);
      else acc.identity();
      if (localVrm) acc.multiply(localVrm);

      if (!bone || !restWorld) continue;

      // Del marco de aplicacion al espacio del modelo y de ahi al mundo objetivo.
      const world = _q2.copy(basis).multiply(acc).multiply(_basisInv).multiply(restWorld);
      const stored = this.#slot(this.worldPool, key).copy(world);
      this.worldByBone.set(bone, stored);
      this.#slot(this.local, key).copy(parentWorld(bone)).invert().multiply(stored);
      this.updated.add(key);
    }

    // Kalidokit entrega la cadera en un espacio propio; el desplazamiento
    // metrico lo aporta el motor directo, que lee los puntos en metros.
    const hp = rigged.Hips?.position;
    // Mismo cambio de marco que las rotaciones: (x, y, z) -> (-x, y, -z).
    if (hp) this.hipsOffset.set(-(hp.x ?? 0), hp.y ?? 0, -(hp.z ?? 0)).applyQuaternion(basis);

    return { local: this.local, updated: this.updated, confidence: this.confidence, hipsOffset: this.hipsOffset };
  }

  reset() {
    this.updated.clear();
    this.delta.clear();
    this.worldByBone.clear();
    this.raw = null;
  }
}
