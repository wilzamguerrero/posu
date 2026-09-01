/**
 * ATOM · Luces insertables
 * ---------------------------------------------------------------------------
 * Catalogo de luces que el usuario puede añadir a la escena, ademas del tripode
 * fijo de estudio (principal, relleno y contra) que gestiona core/Lighting.js.
 *
 * Cada tipo declara que parametros tiene sentido editar; el panel construye los
 * controles a partir de esa lista, de forma que añadir un tipo nuevo no obliga a
 * tocar la interfaz.
 */
import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { RectAreaLightHelper } from 'three/examples/jsm/helpers/RectAreaLightHelper.js';

let areaLista = false;

export const LIGHT_TYPES = [
  {
    id: 'punto', label: 'Punto', icon: 'lightbulb',
    fields: ['intensity', 'distance', 'decay', 'radius', 'shadow'],
    make: () => new THREE.PointLight(0xffffff, 12, 0, 2),
    helper: (l) => new THREE.PointLightHelper(l, 0.09),
    hint: 'Irradia en todas direcciones, como una bombilla desnuda.',
  },
  {
    id: 'foco', label: 'Foco', icon: 'lamp',
    fields: ['intensity', 'distance', 'decay', 'angle', 'penumbra', 'radius', 'shadow', 'target'],
    make: () => new THREE.SpotLight(0xffffff, 30, 0, Math.PI / 7, 0.35, 2),
    helper: (l) => new THREE.SpotLightHelper(l),
    hint: 'Cono dirigido: el mejor para claroscuro y para recortar la figura.',
  },
  {
    id: 'area', label: 'Area', icon: 'rectangle-horizontal',
    fields: ['intensity', 'width', 'height', 'target'],
    make: () => {
      // Las luces de area necesitan sus tablas LTC antes del primer render.
      if (!areaLista) { RectAreaLightUniformsLib.init(); areaLista = true; }
      return new THREE.RectAreaLight(0xffffff, 8, 1, 1);
    },
    helper: (l) => new RectAreaLightHelper(l),
    hint: 'Panel suave tipo softbox. No proyecta sombras (limite de WebGL).',
  },
  {
    id: 'direccional', label: 'Direccional', icon: 'sun',
    fields: ['intensity', 'radius', 'shadow', 'target'],
    make: () => new THREE.DirectionalLight(0xffffff, 2),
    helper: (l) => new THREE.DirectionalLightHelper(l, 0.4),
    hint: 'Rayos paralelos, como el sol: sombras de borde constante.',
  },
  {
    id: 'hemisferica', label: 'Hemisferica', icon: 'sunrise',
    fields: ['intensity', 'groundColor'],
    make: () => new THREE.HemisphereLight(0xbfd4ff, 0x40382e, 1.2),
    helper: (l) => new THREE.HemisphereLightHelper(l, 0.2),
    hint: 'Cielo arriba y rebote del suelo abajo. Rellena sin dirigir.',
  },
];

export const LIGHT_BY_ID = Object.fromEntries(LIGHT_TYPES.map((l) => [l.id, l]));

/** Valores iniciales de una luz nueva. */
export function lightDefaults(type) {
  return {
    color: '#ffffff',
    groundColor: '#40382e',
    intensity: type === 'foco' ? 30 : type === 'punto' ? 12 : type === 'area' ? 8 : 2,
    distance: 0,
    decay: 2,
    angle: 26,          // grados (la mitad del cono)
    penumbra: 0.35,
    width: 1,
    height: 1,
    radius: 3,          // difuminado del borde de sombra (mapas VSM)
    shadow: type !== 'area' && type !== 'hemisferica',
    bias: -0.0005,
    target: { x: 0, y: 0.95, z: 0 },
  };
}

/** Rangos de los controles, en las unidades que ve el usuario. */
export const LIGHT_RANGE = {
  intensity: { min: 0, max: 120, step: 0.1 },
  distance: { min: 0, max: 40, step: 0.1, unit: ' m', hint: '0 = sin limite de alcance.' },
  decay: { min: 0, max: 4, step: 0.05 },
  angle: { min: 2, max: 89, step: 0.5, unit: '°' },
  penumbra: { min: 0, max: 1, step: 0.01 },
  width: { min: 0.05, max: 12, step: 0.05, unit: ' m' },
  height: { min: 0.05, max: 12, step: 0.05, unit: ' m' },
  radius: { min: 0, max: 24, step: 0.1 },
};
