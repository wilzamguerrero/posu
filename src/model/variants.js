/**
 * ATOM · Mallas alternativas generadas por codigo
 * ---------------------------------------------------------------------------
 * El plan pide tres mallas ("anatomica", "maniqui", "esqueleto") compartiendo
 * un mismo esqueleto. El archivo de Mixamo solo trae la piel, asi que aqui se
 * construyen las otras dos a partir del esqueleto real del modelo.
 *
 * Como funciona el reparto de pesos
 * ---------------------------------
 * Los vertices se generan en el espacio del MUNDO de la pose de reposo, que se
 * obtiene invirtiendo `skeleton.boneInverses`. Cada vertice se asigna al 100%
 * a un unico hueso. Con `bindMatrix` a identidad y `AttachedBindMode`, el
 * sombreador calcula:
 *
 *   inv(mundoDeLaMalla) · huesoMundo · huesoInverso · vertice
 *
 * y el `modelViewMatrix` vuelve a multiplicar por `mundoDeLaMalla`, de modo que
 * el resultado es correcto sin importar donde este colocada la malla ni como
 * este escalado el personaje. Por eso no hay que replicar transformaciones.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Perfiles de grosor de cada variante (fracciones de las medidas del modelo). */
export const PROFILES = {
  maniqui: { limb: 1, joint: 1, torso: 1, head: 1, radial: 14, jointDetail: 12 },
  esqueleto: { limb: 0.34, joint: 0.62, torso: 0.52, head: 0.82, radial: 10, jointDetail: 10 },
};

/** Añade pesos de un solo hueso a una geometria ya colocada. */
function weightTo(geometry, boneIndex) {
  const count = geometry.attributes.position.count;
  const idx = new Uint16Array(count * 4);
  const w = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    idx[i * 4] = boneIndex;
    w[i * 4] = 1;
  }
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(w, 4));
  if (geometry.attributes.uv === undefined) {
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
  }
  return geometry;
}

const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _mat = new THREE.Matrix4();
const _scale = new THREE.Vector3();

/**
 * Tronco conico orientado de A a B, con seccion eliptica (`flatten` achata el
 * eje Z para que brazos y torso no parezcan tubos perfectos).
 */
function tube(A, B, rA, rB, { flatten = 1, radial = 12 } = {}) {
  const len = A.distanceTo(B);
  if (len < 1e-5) return null;
  const geo = new THREE.CylinderGeometry(Math.max(rB, 1e-4), Math.max(rA, 1e-4), len, radial, 1, false);
  _dir.copy(B).sub(A).normalize();
  _quat.setFromUnitVectors(_up, _dir);
  _mid.copy(A).add(B).multiplyScalar(0.5);
  _mat.compose(_mid, _quat, _scale.set(1, 1, flatten));
  geo.applyMatrix4(_mat);
  return geo;
}

/** Esfera (o elipsoide) centrada en un punto del espacio de reposo. */
function ball(P, r, { scale = null, detail = 10, orient = null } = {}) {
  if (r < 1e-5) return null;
  const geo = new THREE.SphereGeometry(r, detail + 4, detail);
  _mat.compose(P, orient ?? _quat.identity(), scale ? _scale.copy(scale) : _scale.set(1, 1, 1));
  geo.applyMatrix4(_mat);
  return geo;
}

/** Contexto de medidas del modelo cargado, en el espacio de reposo. */
function measure(skeleton, bones) {
  const world = new Map();
  skeleton.bones.forEach((bone, i) => {
    world.set(bone, skeleton.boneInverses[i].clone().invert());
  });

  const pos = (key) => {
    const bone = bones[key];
    const m = bone && world.get(bone);
    return m ? new THREE.Vector3().setFromMatrixPosition(m) : null;
  };
  const index = (key) => (bones[key] ? skeleton.bones.indexOf(bones[key]) : -1);

  const hips = pos('hips');
  const head = pos('head');
  const la = pos('leftArm');
  const ra = pos('rightArm');
  const lu = pos('leftUpLeg');
  const ru = pos('rightUpLeg');

  // Medidas de referencia: si falta alguna se estima a partir de la altura del
  // torso, de modo que la construccion nunca falle por un rigging incompleto.
  const spineLen = hips && head ? hips.distanceTo(head) : 0.65;
  const shoulderW = la && ra ? la.distanceTo(ra) : spineLen * 0.55;
  const hipW = lu && ru ? lu.distanceTo(ru) : spineLen * 0.34;

  return { pos, index, spineLen, shoulderW, hipW };
}

/**
 * Construye la geometria de una variante.
 * @param {THREE.Skeleton} skeleton esqueleto del modelo cargado
 * @param {Object} bones mapa de claves canonicas -> huesos (ver boneMap.js)
 * @param {Object} profile uno de PROFILES
 */
export function buildVariantGeometry(skeleton, bones, profile) {
  const p = { ...PROFILES.maniqui, ...profile };
  const m = measure(skeleton, bones);
  const chunks = [];
  const radial = p.radial;
  const detail = p.jointDetail;

  const push = (geo, key) => {
    const i = m.index(key);
    if (geo && i >= 0) chunks.push(weightTo(geo, i));
  };
  /** Segmento hueso->hueso con grosor proporcional a una medida de referencia. */
  const seg = (from, to, rA, rB, owner, opts) => {
    const A = m.pos(from);
    const B = m.pos(to);
    if (A && B) push(tube(A, B, rA, rB, { radial, ...opts }), owner ?? from);
  };
  const joint = (key, r, opts) => {
    const P = m.pos(key);
    if (P) push(ball(P, r, { detail, ...opts }), key);
  };

  const SW = m.shoulderW;
  const HW = m.hipW;
  const T = p.torso;
  const L = p.limb;
  const J = p.joint;

  // --- Torso: cuatro bloques encadenados, uno por vertebra del rigging ------
  seg('hips', 'spine', HW * 0.58 * T, HW * 0.52 * T, 'hips', { flatten: 0.74 });
  seg('spine', 'spine1', HW * 0.52 * T, SW * 0.30 * T, 'spine', { flatten: 0.72 });
  seg('spine1', 'spine2', SW * 0.30 * T, SW * 0.37 * T, 'spine1', { flatten: 0.66 });
  seg('spine2', 'neck', SW * 0.37 * T, SW * 0.20 * T, 'spine2', { flatten: 0.64 });

  // --- Cuello y cabeza -----------------------------------------------------
  seg('neck', 'head', SW * 0.11 * L, SW * 0.10 * L, 'neck');
  const neck = m.pos('neck');
  const head = m.pos('head');
  if (neck && head) {
    const up = new THREE.Vector3().subVectors(head, neck).normalize();
    const headLen = Math.max(neck.distanceTo(head) * 1.42, m.spineLen * 0.2);
    const center = head.clone().addScaledVector(up, headLen * 0.34);
    const r = headLen * 0.5 * p.head;
    push(ball(center, r, { detail: detail + 2, scale: new THREE.Vector3(0.82, 1, 0.94) }), 'head');
  }

  // --- Brazos --------------------------------------------------------------
  for (const side of ['left', 'right']) {
    const S = (n) => `${side}${n}`;
    seg(S('Shoulder'), S('Arm'), SW * 0.11 * L, SW * 0.12 * L, S('Shoulder'));
    joint(S('Arm'), SW * 0.13 * J);
    seg(S('Arm'), S('ForeArm'), SW * 0.115 * L, SW * 0.093 * L, S('Arm'), { flatten: 0.92 });
    joint(S('ForeArm'), SW * 0.095 * J);
    seg(S('ForeArm'), S('Hand'), SW * 0.093 * L, SW * 0.072 * L, S('ForeArm'), { flatten: 0.9 });
    joint(S('Hand'), SW * 0.07 * J);

    // Mano en bloque (tipo manopla): del carpo a la falange media del corazon.
    const hand = m.pos(S('Hand'));
    const tip = m.pos(`${side}Middle2`) ?? m.pos(`${side}Middle1`) ?? m.pos(`${side}Index2`);
    if (hand && tip) push(tube(hand, tip, SW * 0.075 * L, SW * 0.055 * L, { radial, flatten: 0.42 }), S('Hand'));
  }

  // --- Piernas -------------------------------------------------------------
  for (const side of ['left', 'right']) {
    const S = (n) => `${side}${n}`;
    joint(S('UpLeg'), HW * 0.3 * J);
    seg(S('UpLeg'), S('Leg'), HW * 0.32 * L, HW * 0.23 * L, S('UpLeg'), { flatten: 0.94 });
    joint(S('Leg'), HW * 0.23 * J);
    seg(S('Leg'), S('Foot'), HW * 0.23 * L, HW * 0.145 * L, S('Leg'), { flatten: 0.9 });
    joint(S('Foot'), HW * 0.14 * J);
    seg(S('Foot'), S('Toe'), HW * 0.16 * L, HW * 0.13 * L, S('Foot'), { flatten: 0.86 });

    // Punta del pie: se prolonga en la misma direccion talon -> dedos.
    const foot = m.pos(S('Foot'));
    const toe = m.pos(S('Toe'));
    if (foot && toe) {
      const fwd = new THREE.Vector3().subVectors(toe, foot).normalize();
      const end = toe.clone().addScaledVector(fwd, foot.distanceTo(toe) * 0.55);
      push(tube(toe, end, HW * 0.13 * L, HW * 0.08 * L, { radial, flatten: 0.86 }), S('Toe'));
    }
  }

  const merged = mergeGeometries(chunks.filter(Boolean), false);
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

/**
 * Envuelve una geometria de variante en un SkinnedMesh atado al esqueleto
 * original. La matriz de enlace es la identidad porque los vertices ya estan
 * en el espacio del mundo de la pose de reposo.
 */
export function makeVariantMesh(geometry, skeleton, material, name) {
  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.name = name;
  mesh.bindMode = THREE.AttachedBindMode;
  mesh.bind(skeleton, new THREE.Matrix4());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false; // El volumen cambia con la pose.
  return mesh;
}
