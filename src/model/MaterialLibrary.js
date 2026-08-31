/**
 * POSU · Biblioteca de materiales
 * ---------------------------------------------------------------------------
 * Un unico catalogo de materiales para todo: las tres variantes del personaje
 * (anatomia, maniqui, esqueleto) y los solidos que el usuario inserta en la
 * escena. Cada preajuste declara que propiedades acepta, de modo que el panel
 * de interfaz se construye solo y nunca ofrece un control que no hace nada.
 *
 *   crearMaterial(id, params)   -> material nuevo (null si es 'original')
 *   aplicarParametros(mat, p)   -> cambia color/rugosidad/... en caliente
 *   aplicarOpacidad(mat, v)     -> deslizador general de transparencia
 *   proyectaSombra(id)          -> si la malla debe proyectar sombra
 *
 * "En caliente" importa: reasignar `material` recompila el shader y provoca un
 * tiron de un par de fotogramas, asi que solo se crea un material cuando el
 * preajuste cambia de verdad.
 */
import * as THREE from 'three';

/** Propiedades que puede tocar cada familia de materiales. */
const CAMPOS = {
  file:     ['color', 'opacity'],
  standard: ['color', 'roughness', 'metalness', 'opacity', 'flat'],
  physical: ['color', 'roughness', 'metalness', 'opacity', 'flat'],
  glass:    ['color', 'roughness', 'opacity'],
  toon:     ['color', 'opacity'],
  basic:    ['color', 'opacity'],
  wire:     ['color', 'opacity'],
  normal:   ['flat'],
  xray:     ['color', 'opacity'],
};

/**
 * Catalogo. `p` son los valores de partida que hereda el panel al elegir el
 * preajuste; `kind` decide la clase de material y los controles visibles.
 */
export const MATERIAL_PRESETS = [
  { id: 'original',  label: 'Original',   icon: 'image',        kind: 'file',
    p: { color: '#ffffff', opacity: 1 },
    note: 'Texturas tal como vienen en el archivo' },

  { id: 'arcilla',   label: 'Arcilla',    icon: 'circle',       kind: 'standard',
    p: { color: '#c9c2b8', roughness: 0.82, metalness: 0, flat: false } },

  { id: 'yeso',      label: 'Yeso',       icon: 'square-dashed', kind: 'standard',
    p: { color: '#d8d4cc', roughness: 0.70, metalness: 0, flat: false } },

  { id: 'madera',    label: 'Madera',     icon: 'box',          kind: 'standard',
    p: { color: '#c08a4a', roughness: 0.55, metalness: 0.04, flat: false } },

  { id: 'hueso',     label: 'Hueso',      icon: 'bone',         kind: 'standard',
    p: { color: '#e9e4d8', roughness: 0.62, metalness: 0, flat: false } },

  { id: 'marmol',    label: 'Marmol',     icon: 'gem',          kind: 'physical',
    p: { color: '#eceff2', roughness: 0.22, metalness: 0, flat: false },
    extra: { clearcoat: 0.6, clearcoatRoughness: 0.3, sheen: 0.2 } },

  { id: 'piel',      label: 'Piel',       icon: 'user',         kind: 'physical',
    p: { color: '#d9a189', roughness: 0.56, metalness: 0.02, flat: false },
    extra: { sheen: 0.5, sheenRoughness: 0.6, sheenColor: '#ffd9c8' } },

  { id: 'metal',     label: 'Metal',      icon: 'scan-line',    kind: 'standard',
    p: { color: '#c9ced6', roughness: 0.28, metalness: 1, flat: false } },

  { id: 'cobre',     label: 'Cobre',      icon: 'flame',        kind: 'standard',
    p: { color: '#c07b49', roughness: 0.36, metalness: 1, flat: false } },

  { id: 'vidrio',    label: 'Vidrio',     icon: 'droplet',      kind: 'glass',
    p: { color: '#dceaf5', roughness: 0.08, opacity: 0.35 },
    extra: { transmission: 0.92, thickness: 0.6, ior: 1.45, metalness: 0 } },

  { id: 'caucho',    label: 'Caucho',     icon: 'circle-dashed', kind: 'standard',
    p: { color: '#2c2f34', roughness: 0.95, metalness: 0, flat: false } },

  { id: 'toon',      label: 'Comic',      icon: 'palette',      kind: 'toon',
    p: { color: '#c9c2b8', opacity: 1 } },

  { id: 'plano',     label: 'Plano',      icon: 'square',       kind: 'basic',
    p: { color: '#8fa6c4', opacity: 1 },
    note: 'Sin iluminacion, util para siluetas' },

  { id: 'normales',  label: 'Normales',   icon: 'compass',      kind: 'normal',
    p: { flat: false },
    note: 'Colorea la orientacion de la superficie' },

  { id: 'wireframe', label: 'Malla',      icon: 'grid-3x3',     kind: 'wire',
    p: { color: '#7fb2ff', opacity: 1 } },

  { id: 'rayosx',    label: 'Rayos X',    icon: 'scan',         kind: 'xray',
    p: { color: '#8fd8ff', opacity: 1 } },
];

export const MATERIAL_BY_ID = Object.fromEntries(MATERIAL_PRESETS.map((m) => [m.id, m]));

/** Rangos de los deslizadores del panel de materiales. */
export const MATERIAL_RANGE = {
  roughness: { min: 0, max: 1, step: 0.01 },
  metalness: { min: 0, max: 1, step: 0.01 },
  opacity:   { min: 0.05, max: 1, step: 0.01 },
};

/** Valores de partida de un preajuste (copia, nunca la referencia). */
export function materialDefaults(id) {
  const preset = MATERIAL_BY_ID[id] ?? MATERIAL_BY_ID.yeso;
  return { preset: preset.id, ...preset.p };
}

/** Si el preajuste `id` expone la propiedad `prop` en la interfaz. */
export function materialSupports(id, prop) {
  const preset = MATERIAL_BY_ID[id] ?? MATERIAL_BY_ID.yeso;
  return (CAMPOS[preset.kind] ?? []).includes(prop);
}

/** Las mallas de rayos X, malla y normales no deben oscurecer la escena. */
export function proyectaSombra(id) {
  return id !== 'rayosx' && id !== 'wireframe' && id !== 'normales';
}

/** Descarta claves vacias para que `Object.assign` no borre valores validos. */
export function quitarVacios(obj = {}) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return out;
}

// --------------------------------------------------------------- rayos X ---

const XRAY_VERT = /* glsl */ `
  #include <common>
  #include <skinning_pars_vertex>
  varying vec3 vNormalView;
  varying vec3 vViewPosition;
  void main() {
    #include <beginnormal_vertex>
    #include <skinbase_vertex>
    #include <skinnormal_vertex>
    #include <defaultnormal_vertex>
    #include <begin_vertex>
    #include <skinning_vertex>
    #include <project_vertex>
    vNormalView = normalize( transformedNormal );
    vViewPosition = - mvPosition.xyz;
  }
`;

const XRAY_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uPower;
  uniform float uOpacity;
  varying vec3 vNormalView;
  varying vec3 vViewPosition;
  void main() {
    // Fresnel: el borde silueteado se ilumina y el centro se vuelve casi
    // transparente, que es como se lee una radiografia.
    float f = 1.0 - abs( dot( normalize( vNormalView ), normalize( vViewPosition ) ) );
    float a = pow( clamp( f, 0.0, 1.0 ), uPower );
    gl_FragColor = vec4( uColor * ( 0.25 + a * 1.75 ), a * uOpacity );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** Material de rayos X: aditivo, sin escribir profundidad, con skinning. */
export function xrayMaterial(color = '#8fd8ff') {
  const mat = new THREE.ShaderMaterial({
    vertexShader: XRAY_VERT,
    fragmentShader: XRAY_FRAG,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uPower: { value: 1.6 },
      uOpacity: { value: 1 },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  mat.userData.alwaysTransparent = true;
  return mat;
}

/** Rampa de 3 tonos compartida por todos los materiales tipo comic. */
let gradient = null;
export function toonGradient() {
  if (gradient) return gradient;
  const data = new Uint8Array([48, 148, 236]);
  gradient = new THREE.DataTexture(data, data.length, 1, THREE.RedFormat);
  gradient.minFilter = THREE.NearestFilter;
  gradient.magFilter = THREE.NearestFilter;
  gradient.generateMipmaps = false;
  gradient.needsUpdate = true;
  return gradient;
}

// ------------------------------------------------------------- fabricacion ---

/**
 * Crea el material de un preajuste. Devuelve `null` para 'original' porque en
 * ese caso quien llama debe usar el material que venia en el archivo.
 */
export function crearMaterial(id, params = {}) {
  const preset = MATERIAL_BY_ID[id];
  if (!preset || preset.id === 'original') return null;

  const p = { ...preset.p, ...quitarVacios(params) };
  const extra = { ...(preset.extra ?? {}) };
  const flat = p.flat === true;
  let mat;

  switch (preset.kind) {
    case 'physical':
    case 'glass':
      mat = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(p.color ?? '#ffffff'),
        roughness: p.roughness ?? 0.5,
        metalness: p.metalness ?? 0,
        flatShading: flat,
        ...extra,
      });
      break;
    case 'toon':
      mat = new THREE.MeshToonMaterial({
        color: new THREE.Color(p.color ?? '#ffffff'),
        gradientMap: toonGradient(),
      });
      break;
    case 'basic':
      mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(p.color ?? '#ffffff') });
      break;
    case 'wire':
      mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(p.color ?? '#ffffff'), wireframe: true });
      break;
    case 'normal':
      mat = new THREE.MeshNormalMaterial({ flatShading: flat });
      break;
    case 'xray':
      mat = xrayMaterial(p.color ?? '#8fd8ff');
      break;
    default:
      mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(p.color ?? '#ffffff'),
        roughness: p.roughness ?? 0.5,
        metalness: p.metalness ?? 0,
        flatShading: flat,
      });
  }

  mat.name = `posu:${preset.id}`;
  mat.userData.presetId = preset.id;
  // El vidrio y los rayos X necesitan mezcla siempre, aunque la opacidad sea 1.
  if (preset.kind === 'glass' || preset.kind === 'xray') {
    mat.userData.alwaysTransparent = true;
    mat.transparent = true;
    mat.depthWrite = false;
  }
  aplicarOpacidad(mat, p.opacity ?? 1);
  return mat;
}

/**
 * Aplica cambios de parametros sin recrear el material. Solo toca lo que el
 * material realmente tiene, asi el mismo objeto sirve para cualquier familia.
 */
export function aplicarParametros(mat, params = {}) {
  if (!mat) return mat;
  const p = quitarVacios(params);

  if (p.color !== undefined) {
    if (mat.uniforms?.uColor) mat.uniforms.uColor.value.set(p.color);
    else if (mat.color) mat.color.set(p.color);
  }
  if (p.roughness !== undefined && 'roughness' in mat) mat.roughness = p.roughness;
  if (p.metalness !== undefined && 'metalness' in mat) mat.metalness = p.metalness;
  if (p.flat !== undefined && 'flatShading' in mat && mat.flatShading !== !!p.flat) {
    mat.flatShading = !!p.flat;
    mat.needsUpdate = true;   // el sombreado plano si obliga a recompilar
  }
  if (p.opacity !== undefined) aplicarOpacidad(mat, p.opacity);
  return mat;
}

/**
 * Deslizador general de transparencia del plan: escribe `.opacity` y activa
 * `.transparent` solo cuando hace falta, para no romper el orden de dibujado.
 */
export function aplicarOpacidad(mat, opacity = 1) {
  if (!mat) return mat;
  const v = THREE.MathUtils.clamp(opacity, 0, 1);
  if (mat.uniforms?.uOpacity) {
    mat.uniforms.uOpacity.value = v;
    return mat;
  }
  if (!('opacity' in mat)) return mat;
  mat.opacity = v;
  const forzado = mat.userData?.alwaysTransparent === true;
  const quiere = v < 0.999 || forzado;
  if (mat.transparent !== quiere) {
    mat.transparent = quiere;
    mat.needsUpdate = true;
  }
  mat.depthWrite = !quiere;
  return mat;
}
