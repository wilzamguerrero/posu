/**
 * ATOM · Primitivas geometricas
 * ---------------------------------------------------------------------------
 * Catalogo de solidos que el usuario puede insertar en la escena para montar
 * bodegones, cajas de encaje o planos de apoyo. Cada entrada sabe construir su
 * geometria a partir de los parametros editables (`p`), que el panel expone.
 *
 * Las medidas estan en metros para que convivan con la figura (1,75 m).
 */
import * as THREE from 'three';

/** Parametros por omision comunes: todo solido nace con 40 cm de lado. */
const S = 0.4;

export const PRIMITIVES = [
  {
    id: 'cubo', label: 'Cubo', icon: 'box',
    p: { ancho: S, alto: S, fondo: S, seg: 1 },
    geo: (p) => new THREE.BoxGeometry(p.ancho, p.alto, p.fondo, p.seg, p.seg, p.seg),
  },
  {
    id: 'esfera', label: 'Esfera', icon: 'circle',
    p: { radio: S * 0.5, seg: 32 },
    geo: (p) => new THREE.SphereGeometry(p.radio, p.seg, Math.max(3, Math.round(p.seg / 2))),
  },
  {
    id: 'cilindro', label: 'Cilindro', icon: 'cylinder',
    p: { radio: S * 0.5, alto: S, seg: 32 },
    geo: (p) => new THREE.CylinderGeometry(p.radio, p.radio, p.alto, p.seg),
  },
  {
    id: 'cono', label: 'Cono', icon: 'cone',
    p: { radio: S * 0.5, alto: S, seg: 32 },
    geo: (p) => new THREE.ConeGeometry(p.radio, p.alto, p.seg),
  },
  {
    id: 'toro', label: 'Toro', icon: 'torus',
    p: { radio: S * 0.5, grosor: S * 0.16, seg: 48 },
    geo: (p) => new THREE.TorusGeometry(p.radio, p.grosor, Math.max(6, Math.round(p.seg / 3)), p.seg),
  },
  {
    id: 'plano', label: 'Plano', icon: 'square',
    p: { ancho: S * 2, alto: S * 2, seg: 1 },
    geo: (p) => new THREE.PlaneGeometry(p.ancho, p.alto, p.seg, p.seg),
    doubleSide: true,
  },
  {
    id: 'piramide', label: 'Piramide', icon: 'pyramid',
    p: { radio: S * 0.7, alto: S, seg: 4 },
    geo: (p) => new THREE.ConeGeometry(p.radio, p.alto, Math.max(3, p.seg)),
  },
  {
    id: 'capsula', label: 'Capsula', icon: 'donut',
    p: { radio: S * 0.3, alto: S, seg: 24 },
    geo: (p) => new THREE.CapsuleGeometry(p.radio, p.alto, Math.max(2, Math.round(p.seg / 6)), p.seg),
  },
  {
    id: 'icosaedro', label: 'Icosaedro', icon: 'gem',
    p: { radio: S * 0.55, seg: 0 },
    geo: (p) => new THREE.IcosahedronGeometry(p.radio, Math.min(3, Math.max(0, Math.round(p.seg)))),
  },
  {
    id: 'octaedro', label: 'Octaedro', icon: 'triangle',
    p: { radio: S * 0.55, seg: 0 },
    geo: (p) => new THREE.OctahedronGeometry(p.radio, Math.min(3, Math.max(0, Math.round(p.seg)))),
  },
];

export const PRIMITIVE_BY_ID = Object.fromEntries(PRIMITIVES.map((x) => [x.id, x]));

/** Rangos de los deslizadores de cada parametro, para el panel. */
export const PARAM_RANGE = {
  ancho: { min: 0.02, max: 6, step: 0.01, unit: ' m' },
  alto: { min: 0.02, max: 6, step: 0.01, unit: ' m' },
  fondo: { min: 0.02, max: 6, step: 0.01, unit: ' m' },
  radio: { min: 0.01, max: 4, step: 0.01, unit: ' m' },
  grosor: { min: 0.005, max: 1, step: 0.005, unit: ' m' },
  seg: { min: 0, max: 64, step: 1 },
};

/** Construye la geometria de una definicion, con sus parametros ya mezclados. */
export function buildGeometry(def) {
  const preset = PRIMITIVE_BY_ID[def.type] ?? PRIMITIVE_BY_ID.cubo;
  return preset.geo({ ...preset.p, ...(def.params ?? {}) });
}
