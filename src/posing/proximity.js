/**
 * ATOM · Manejadores por proximidad
 * ---------------------------------------------------------------------------
 * Una figura entera ofrece mas de cuarenta manejadores contando los objetivos de
 * cinematica inversa, y de espaldas o de cerca se tapan unos a otros. Con la
 * proximidad encendida solo se ven los que caen junto al puntero: el visor queda
 * limpio y siempre se pincha el que se buscaba.
 *
 * Aqui vive esa cuenta y nada mas —ni mallas, ni escena, ni punteros del DOM—,
 * asi que se puede probar en Node con una camara de verdad.
 *
 * Dos decisiones que se notan al usarlo:
 *
 *   - La distancia se mide **en pantalla**, no en el espacio de la escena: lo que
 *     importa es lo que el raton tiene al lado, no lo que esta cerca en metros.
 *     Y se mide en **alturas de visor**, no en pixeles, para que el radio se
 *     comporte igual en una pantalla de 4K que en un portatil.
 *   - El borde es blando: entre el radio y `FADE` veces el radio el manejador
 *     asoma poco a poco (una rampa suave, no un salto), de modo que aparece
 *     creciendo en vez de parpadear cuando el puntero pasa justo por el limite.
 */
import * as THREE from 'three';

const _p = new THREE.Vector3();

/** Hasta donde llega el borde blando, en multiplos del radio. */
export const FADE = 1.4;

/** Relacion ancho/alto del encuadre, tanto en perspectiva como en ortografica. */
export function viewAspect(camera) {
  if (!camera) return 1;
  if (camera.isOrthographicCamera) {
    const w = Math.abs(camera.right - camera.left);
    const h = Math.abs(camera.top - camera.bottom);
    return h > 1e-9 ? w / h : 1;
  }
  const a = Number(camera.aspect);
  return Number.isFinite(a) && a > 0 ? a : 1;
}

/**
 * Distancia en pantalla entre un punto de la escena y el puntero, medida en
 * alturas de visor (0.5 = media pantalla).
 *
 * @param {THREE.Vector3} point punto en coordenadas de mundo
 * @param {THREE.Camera} camera
 * @param {{x:number,y:number}} pointer puntero en coordenadas normalizadas (-1..1)
 * @param {number} [aspect]
 * @returns {number} la distancia, o `Infinity` si el punto no se ve
 */
export function screenDistance(point, camera, pointer, aspect = viewAspect(camera)) {
  if (!point || !camera || !pointer) return Infinity;
  _p.copy(point).project(camera);
  // Detras de la camara (o delante del plano cercano) no hay distancia que medir.
  if (!Number.isFinite(_p.x) || !Number.isFinite(_p.y) || _p.z < -1 || _p.z > 1) return Infinity;
  // El eje X normalizado abarca el ancho; multiplicarlo por la relacion de
  // aspecto lo pasa a alturas, que es lo que hace que el entorno sea un circulo
  // en pantalla y no una elipse.
  const dx = (_p.x - pointer.x) * 0.5 * aspect;
  const dy = (_p.y - pointer.y) * 0.5;
  return Math.hypot(dx, dy);
}

/**
 * Cuanto asoma un manejador: 1 dentro del radio, 0 pasado el borde blando y una
 * rampa suave en medio. El que llama lo usa para dos cosas a la vez, esconder el
 * manejador (cero) y encogerlo mientras entra, que es lo que da la sensacion de
 * que aparece en vez de encenderse.
 *
 * @param {THREE.Vector3} point
 * @param {THREE.Camera} camera
 * @param {{x:number,y:number}} pointer
 * @param {number} radius radio en alturas de visor
 * @param {number} [aspect]
 * @returns {number} 0..1
 */
export function nearFactor(point, camera, pointer, radius, aspect = viewAspect(camera)) {
  const r = Math.max(1e-4, Number(radius) || 0);
  const d = screenDistance(point, camera, pointer, aspect);
  if (!Number.isFinite(d)) return 0;
  if (d <= r) return 1;
  const t = (r * FADE - d) / (r * (FADE - 1));
  if (t <= 0) return 0;
  return t * t * (3 - 2 * t);
}
