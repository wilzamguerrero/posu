/**
 * ATOM · Cubo del reto: geometria y proyeccion
 * ---------------------------------------------------------------------------
 * El cubo se proyecta a mano, sin pasar por Three.js. No es por capricho: el
 * reto necesita que el problema sea *identico* en cualquier pantalla, y para eso
 * la proyeccion tiene que ser una funcion pura de (rotacion, distancia,
 * traslacion) sin tocar el estado del visor 3D. Three.js entra despues, solo
 * para dibujar la reticula de fugas cuando se revela la solucion.
 *
 * Convenios
 * ---------
 * Vertices en +-1, asi que una unidad de modelo son 0.5 m si el cubo mide 1 m de
 * arista. La camara mira hacia +Z y se proyecta dividiendo por (z + D): el eje Y
 * se invierte al proyectar porque en pantalla crece hacia abajo.
 *
 * Solo hay guinada (yaw) y cabeceo (pitch), nunca alabeo (roll). Un cubo con
 * roll no ensena nada nuevo sobre perspectiva — es el mismo problema girado — y
 * en cambio arruina la lectura del horizonte.
 */

/** Los 8 vertices del cubo, en +-1. El orden importa: lo usan caras y aristas. */
export const CUBE_V = [
  [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
];

/** Las 6 caras con su normal saliente y sus vertices en orden antihorario. */
export const CUBE_FACES = [
  { n: [0, 0, -1], idx: [0, 1, 2, 3] },
  { n: [0, 0, 1], idx: [5, 4, 7, 6] },
  { n: [-1, 0, 0], idx: [4, 0, 3, 7] },
  { n: [1, 0, 0], idx: [1, 5, 6, 2] },
  { n: [0, -1, 0], idx: [4, 5, 1, 0] },
  { n: [0, 1, 0], idx: [3, 2, 6, 7] },
];

/**
 * Las 12 aristas, deducidas de las caras para que cada una sepa a que dos caras
 * pertenece. Con eso se decide si una arista es visible (alguna de sus caras lo
 * es) y si forma parte de la cara-pista.
 */
export const CUBE_EDGES = (() => {
  const m = new Map();
  CUBE_FACES.forEach((f, fi) => {
    for (let k = 0; k < 4; k++) {
      const a = f.idx[k], b = f.idx[(k + 1) % 4];
      const key = Math.min(a, b) + '_' + Math.max(a, b);
      if (!m.has(key)) m.set(key, { a: Math.min(a, b), b: Math.max(a, b), faces: [] });
      m.get(key).faces.push(fi);
    }
  });
  return [...m.values()];
})();

/**
 * Las 12 aristas agrupadas en las 3 familias de paralelas. Cada familia converge
 * en un punto de fuga, asi que estos grupos son la base de los filtros de
 * legibilidad y del calculo de fugas.
 */
export const PARALLEL_GROUPS = [
  [[0, 1], [3, 2], [4, 5], [7, 6]],
  [[0, 3], [1, 2], [4, 7], [5, 6]],
  [[0, 4], [1, 5], [2, 6], [3, 7]],
];

/** Matriz de rotacion de guinada y cabeceo (sin alabeo). */
export function rotMat(yaw, pitch) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  return [
    [cy, 0, sy],
    [sp * sy, cp, -sp * cy],
    [-cp * sy, sp, cp * cy],
  ];
}

/** Matriz por vector. */
export const mulVec = (m, v) => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];

/**
 * Proyeccion normalizada del cubo: independiente del tamano de pantalla.
 *
 * @param {{yaw:number, pitch:number}} rot
 * @param {number} D  distancia del centro del cubo a la camara (unidades de modelo)
 * @param {number} tx traslacion lateral
 * @param {number} ty traslacion vertical
 * @returns {object} forma con vertices proyectados, visibilidad y cara-pista
 */
export function shapeOf(rot, D, tx = 0, ty = 0) {
  const R = rotMat(rot.yaw, rot.pitch);

  // Vertices al plano de imagen. La division por Z es la perspectiva.
  const Q = CUBE_V.map((v) => {
    const q = mulVec(R, v);
    const Z = q[2] + D;
    return { x: (q[0] + tx) / Z, y: -(q[1] + ty) / Z };
  });

  /* Visibilidad por cara. No basta comparar la normal con el eje Z: con
     perspectiva hay que mirar la normal contra el vector que va de la camara al
     centro de la cara, o las caras del borde salen mal clasificadas. */
  const vis = CUBE_FACES.map((f) => {
    const n = mulVec(R, f.n);
    const c = [n[0] + tx, n[1] + ty, n[2] + D];
    return n[0] * c[0] + n[1] * c[1] + n[2] * c[2] < 0;
  });

  /* La cara-pista es la mas frontal de las visibles: la que menos escorzo tiene.
     Es la que se le ensena al alumno, asi que tiene que ser la mas legible. */
  let shown = -1, best = -2;
  CUBE_FACES.forEach((f, i) => {
    if (!vis[i]) return;
    const n = mulVec(R, f.n);
    const c = [n[0] + tx, n[1] + ty, n[2] + D];
    const L = Math.hypot(c[0], c[1], c[2]) || 1;
    const s = -(n[0] * c[0] + n[1] * c[1] + n[2] * c[2]) / L;
    if (s > best) { best = s; shown = i; }
  });

  const edges = CUBE_EDGES.map((e) => ({
    a: e.a,
    b: e.b,
    inShown: e.faces.includes(shown),
    visible: vis[e.faces[0]] || vis[e.faces[1]],
  }));

  return { Q, vis, shown, edges, rot, D, tx, ty };
}

/** Area del poligono proyectado de una cara (valor absoluto, formula del zapatero). */
export function faceArea(shape, fi, pts = shape.Q) {
  const ix = CUBE_FACES[fi].idx;
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const p = pts[ix[i]], q = pts[ix[(i + 1) % 4]];
    s += p.x * q.y - q.x * p.y;
  }
  return Math.abs(s) / 2;
}
