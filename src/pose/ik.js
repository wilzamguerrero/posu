/**
 * ATOM · Cinematica inversa
 * ---------------------------------------------------------------------------
 * Posar arrastrando el extremo: se pone la mano donde se quiere y el hombro y el
 * codo se acomodan solos. Es la otra mitad de un rig, la que hace que colocar una
 * pose sea cuestion de segundos en vez de tres giros por brazo.
 *
 * Dos solucionadores, cada uno para lo que sirve:
 *
 *   - `solveTwoBone` para brazos y piernas: solucion **analitica** con la ley de
 *     cosenos, en tres pasos que no pueden fallar —doblar el codo para que la
 *     distancia cuadre, apuntar el conjunto al objetivo, y girar alrededor del eje
 *     hombro-objetivo para que el codo mire hacia el polo. El tercer paso gira
 *     sobre el propio eje que une el hombro con el objetivo, asi que **no puede
 *     mover la punta**: la reorienta el codo sin perder el alcance.
 *   - `solveChain` (FABRIK) para la columna: tres o cuatro huesos con un solo
 *     extremo, donde no hay formula cerrada y si convergencia rapida.
 *
 * Los dos trabajan girando huesos, nunca escalandolos ni separandolos, asi que el
 * esqueleto no se puede romper: el largo de cada hueso se conserva exactamente.
 */
import * as THREE from 'three';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _t = new THREE.Vector3();
const _p = new THREE.Vector3();
const _u = new THREE.Vector3();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _wq = new THREE.Quaternion();
const _pq = new THREE.Quaternion();
const _scale = new THREE.Vector3();

const EPS = 1e-6;
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

/** Posicion de mundo de un hueso, con sus matrices al dia. */
export function worldOf(bone, out) {
  bone.updateWorldMatrix(true, false);
  return out.setFromMatrixPosition(bone.matrixWorld);
}

/**
 * Gira un hueso en coordenadas de mundo y refresca lo que cuelga de el, para que
 * el paso siguiente lea posiciones de verdad.
 * @param {THREE.Object3D} bone
 * @param {THREE.Quaternion} delta giro que se aplica sobre su orientacion de mundo
 */
export function rotateWorld(bone, delta) {
  bone.updateWorldMatrix(true, false);
  bone.matrixWorld.decompose(_v, _wq, _scale);
  _wq.premultiply(delta);
  const parent = bone.parent;
  if (parent) {
    parent.updateWorldMatrix(true, false);
    parent.matrixWorld.decompose(_v, _pq, _scale);
    bone.quaternion.copy(_pq.invert()).multiply(_wq);
  } else {
    bone.quaternion.copy(_wq);
  }
  bone.updateMatrix();
  bone.updateWorldMatrix(false, true);
}

/** Angulo entre dos vectores, a salvo de vectores nulos. */
function angleBetween(a, b) {
  const l = a.length() * b.length();
  if (l < EPS) return 0;
  return Math.acos(clamp(a.dot(b) / l, -1, 1));
}

/** Un vector cualquiera perpendicular a `dir`, para los casos degenerados. */
function anyPerpendicular(dir, out) {
  out.set(1, 0, 0);
  if (Math.abs(dir.x) > 0.9) out.set(0, 1, 0);
  return out.cross(dir).normalize();
}

/**
 * Lleva la punta de una cadena de dos huesos al objetivo.
 *
 * @param {object} o
 * @param {THREE.Object3D} o.root  hueso de arriba (hombro o muslo)
 * @param {THREE.Object3D} o.mid   hueso de en medio (antebrazo o pierna)
 * @param {THREE.Object3D} o.tip   hueso cuyo origen es la punta (mano o pie)
 * @param {THREE.Vector3} o.target a donde tiene que ir la punta, en mundo
 * @param {THREE.Vector3} [o.pole] hacia donde mira el codo o la rodilla
 * @param {number} [o.margin] cuanto se deja sin estirar del todo (0..0.2)
 * @returns {boolean} false si la cadena no sirve (huesos de largo cero)
 */
export function solveTwoBone({ root, mid, tip, target, pole = null, margin = 0.01 }) {
  if (!root || !mid || !tip || !target) return false;
  worldOf(root, _a);
  worldOf(mid, _b);
  worldOf(tip, _c);

  const lab = _a.distanceTo(_b);
  const lcb = _c.distanceTo(_b);
  if (lab < EPS || lcb < EPS) return false;

  // Alcance: ni estirado del todo (una cadena recta no tiene plano de flexion y
  // se queda sin manera de volver a doblarse) ni mas plegado de lo que permite la
  // diferencia de largos.
  const maxLen = (lab + lcb) * (1 - clamp(margin, 0, 0.2));
  const minLen = Math.abs(lab - lcb) + (lab + lcb) * 0.02;
  const lat = clamp(_a.distanceTo(target), minLen, maxLen);

  // --- 1 · doblar el codo hasta que la distancia hombro-punta sea `lat` -------
  const ba = _v.copy(_a).sub(_b);
  const bc = _w.copy(_c).sub(_b);
  const actual = angleBetween(ba, bc);
  const deseado = Math.acos(clamp((lat * lat - lab * lab - lcb * lcb) / (-2 * lab * lcb), -1, 1));
  _axis.crossVectors(ba, bc);
  if (_axis.lengthSq() < EPS) {
    // Cadena recta o plegada: el plano lo decide el polo, y si no hay, cualquiera.
    const dir = _u.copy(target).sub(_a).normalize();
    if (pole) {
      _axis.crossVectors(dir, _p.copy(pole).sub(_a));
      if (_axis.lengthSq() < EPS) anyPerpendicular(dir, _axis);
      else _axis.normalize();
    } else {
      anyPerpendicular(dir, _axis);
    }
  } else {
    _axis.normalize();
  }
  if (Math.abs(deseado - actual) > 1e-5) {
    rotateWorld(mid, _q.setFromAxisAngle(_axis, deseado - actual));
    worldOf(tip, _c);
  }

  // --- 2 · apuntar el conjunto al objetivo -----------------------------------
  _u.copy(_c).sub(_a);
  _v.copy(target).sub(_a);
  if (_u.lengthSq() > EPS && _v.lengthSq() > EPS) {
    rotateWorld(root, _q.setFromUnitVectors(_u.normalize(), _v.normalize()));
    worldOf(mid, _b);
    worldOf(tip, _c);
  }

  // --- 3 · girar sobre el eje hombro-objetivo para llevar el codo al polo -----
  // Este giro es alrededor de la recta en la que ya esta la punta, asi que la
  // deja donde esta: solo cambia hacia donde apunta el codo.
  if (pole) {
    _u.copy(target).sub(_a);
    if (_u.lengthSq() > EPS) {
      _u.normalize();
      // Componentes perpendiculares al eje: el codo de ahora y el que se quiere.
      _v.copy(_b).sub(_a);
      _v.addScaledVector(_u, -_v.dot(_u));
      _w.copy(pole).sub(_a);
      _w.addScaledVector(_u, -_w.dot(_u));
      if (_v.lengthSq() > EPS && _w.lengthSq() > EPS) {
        _v.normalize();
        _w.normalize();
        const giro = Math.atan2(_p.crossVectors(_v, _w).dot(_u), _v.dot(_w));
        if (Math.abs(giro) > 1e-5) rotateWorld(root, _q.setFromAxisAngle(_u, giro));
      }
    }
  }
  return true;
}

/**
 * Lleva la punta de una cadena de varios huesos al objetivo (FABRIK: se estira la
 * cadena hacia el objetivo y se vuelve a pegar a la raiz, unas cuantas veces).
 * Se usa para el torso, donde tres huesos comparten un solo extremo y no hay
 * formula cerrada.
 *
 * @param {object} o
 * @param {THREE.Object3D[]} o.bones cadena de padre a hijo (por ejemplo lumbar,
 *   dorsal y pecho)
 * @param {THREE.Object3D} o.tip hueso cuyo origen es la punta (el cuello)
 * @param {THREE.Vector3} o.target
 * @param {number} [o.iterations]
 * @param {number} [o.stiffness] 0 = la cadena sigue el objetivo del todo; 0.5 se
 *   queda a medio camino, que es lo que hace que una espalda no se doble como un
 *   junco
 * @returns {boolean}
 */
export function solveChain({ bones, tip, target, iterations = 8, stiffness = 0 }) {
  const cadena = (bones ?? []).filter(Boolean);
  // Un solo hueso vale: es el caso del cuello cuando el modelo no trae la
  // coronilla, donde apuntar la cabeza es un giro y nada mas.
  if (cadena.length < 1 || !tip || !target) return false;

  // Puntos de la cadena: el origen de cada hueso y, al final, el de la punta.
  const P = cadena.map((b) => worldOf(b, new THREE.Vector3()));
  P.push(worldOf(tip, new THREE.Vector3()));
  const n = P.length - 1;
  const largo = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    largo.push(P[i].distanceTo(P[i + 1]));
    total += largo[i];
  }
  if (total < EPS) return false;

  const raiz = P[0].clone();
  const meta = target.clone();
  if (stiffness > 0) meta.lerp(P[n], clamp(stiffness, 0, 0.95));

  if (raiz.distanceTo(meta) > total) {
    // Fuera de alcance: la cadena se estira en linea recta hacia el objetivo.
    _u.copy(meta).sub(raiz).normalize();
    for (let i = 1; i <= n; i++) P[i].copy(P[i - 1]).addScaledVector(_u, largo[i - 1]);
  } else {
    for (let paso = 0; paso < iterations; paso++) {
      if (P[n].distanceTo(meta) < 1e-5) break;
      // Hacia atras: la punta se pone en el objetivo y se arrastra la cadena.
      P[n].copy(meta);
      for (let i = n - 1; i >= 0; i--) {
        _u.copy(P[i]).sub(P[i + 1]).normalize();
        P[i].copy(P[i + 1]).addScaledVector(_u, largo[i]);
      }
      // Hacia delante: la raiz vuelve a su sitio y se rehace la cadena.
      P[0].copy(raiz);
      for (let i = 0; i < n; i++) {
        _u.copy(P[i + 1]).sub(P[i]).normalize();
        P[i + 1].copy(P[i]).addScaledVector(_u, largo[i]);
      }
    }
  }

  // De puntos a giros: cada hueso se orienta hacia donde ha quedado el siguiente.
  for (let i = 0; i < cadena.length; i++) {
    const bone = cadena[i];
    const hijo = i + 1 < cadena.length ? cadena[i + 1] : tip;
    worldOf(bone, _a);
    worldOf(hijo, _b);
    _u.copy(_b).sub(_a);
    _v.copy(P[i + 1]).sub(_a);
    if (_u.lengthSq() < EPS || _v.lengthSq() < EPS) continue;
    rotateWorld(bone, _q.setFromUnitVectors(_u.normalize(), _v.normalize()));
  }
  return true;
}
