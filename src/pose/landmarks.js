/**
 * POSU · Puntos clave de BlazePose
 * ---------------------------------------------------------------------------
 * Indices de los 33 landmarks de MediaPipe Pose y utilidades para leerlos con
 * seguridad (todos los accesos comprueban visibilidad, porque en cuanto una
 * mano sale de plano el punto sigue existiendo pero con valores inventados).
 */
import * as THREE from 'three';

export const LM = {
  NOSE: 0,
  LEFT_EYE_INNER: 1, LEFT_EYE: 2, LEFT_EYE_OUTER: 3,
  RIGHT_EYE_INNER: 4, RIGHT_EYE: 5, RIGHT_EYE_OUTER: 6,
  LEFT_EAR: 7, RIGHT_EAR: 8,
  MOUTH_LEFT: 9, MOUTH_RIGHT: 10,
  LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13, RIGHT_ELBOW: 14,
  LEFT_WRIST: 15, RIGHT_WRIST: 16,
  LEFT_PINKY: 17, RIGHT_PINKY: 18,
  LEFT_INDEX: 19, RIGHT_INDEX: 20,
  LEFT_THUMB: 21, RIGHT_THUMB: 22,
  LEFT_HIP: 23, RIGHT_HIP: 24,
  LEFT_KNEE: 25, RIGHT_KNEE: 26,
  LEFT_ANKLE: 27, RIGHT_ANKLE: 28,
  LEFT_HEEL: 29, RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31, RIGHT_FOOT_INDEX: 32,
};

/** Pares de puntos que dibuja el visor 2D. */
export const POSE_CONNECTIONS = [
  [11, 12], [11, 23], [12, 24], [23, 24],
  [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  [23, 25], [25, 27], [27, 29], [27, 31], [29, 31],
  [24, 26], [26, 28], [28, 30], [28, 32], [30, 32],
  [9, 10], [0, 2], [0, 5], [2, 7], [5, 8],
];

/**
 * Convierte un landmark de MediaPipe al sistema de la aplicacion.
 *
 * MediaPipe entrega metros con Y hacia abajo y Z creciente al alejarse de la
 * camara. El modelo trabaja con Y hacia arriba y Z hacia el frente del cuerpo,
 * de ahi el cambio de signo en las dos componentes. Tras la conversion los ejes
 * significan: X = izquierda del sujeto, Y = arriba, Z = frente.
 */
export function toVector(landmark, out = new THREE.Vector3()) {
  return out.set(landmark.x, -landmark.y, -landmark.z);
}

/** Visibilidad efectiva de un punto (algunos modelos solo dan `presence`). */
export function vis(landmark) {
  if (!landmark) return 0;
  const v = landmark.visibility;
  return typeof v === 'number' ? v : 1;
}

/** Lee un punto solo si supera el umbral de confianza. */
export function point(list, index, minVis, out = new THREE.Vector3()) {
  const lm = list?.[index];
  if (!lm || vis(lm) < minVis) return null;
  return toVector(lm, out);
}

/** Punto medio de dos landmarks; null si alguno no es fiable. */
export function mid(list, a, b, minVis, out = new THREE.Vector3()) {
  const pa = point(list, a, minVis, _tmpA);
  const pb = point(list, b, minVis, _tmpB);
  if (!pa || !pb) return null;
  return out.copy(pa).add(pb).multiplyScalar(0.5);
}

const _tmpA = new THREE.Vector3();
const _tmpB = new THREE.Vector3();

/** Confianza media de un conjunto de indices. */
export function confidenceOf(list, indices) {
  if (!list?.length) return 0;
  let sum = 0;
  for (const i of indices) sum += vis(list[i]);
  return sum / indices.length;
}
