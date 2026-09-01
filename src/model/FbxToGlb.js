/**
 * ATOM · Conversor FBX → GLB
 * ---------------------------------------------------------------------------
 * Hace en el navegador lo mismo que `npm run convert` hace en la consola, pero
 * sin instalar nada: lee un `.fbx` con el lector de Three.js y lo vuelve a
 * escribir como `.glb` binario, con el esqueleto, la piel y las animaciones que
 * traiga. El resultado se puede guardar en `public/models` o compartir.
 *
 * Dos cuidados que marcan la diferencia entre un archivo util y uno inservible:
 *
 *   · **Unidades.** Mixamo exporta en centimetros, asi que la figura sale unas
 *     cien veces mas grande que un glTF normal. Si mide mas de diez unidades se
 *     pasa a metros, y entonces el `.glb` sirve igual que los de `models/`.
 *   · **Peso.** Un FBX de Mixamo trae texturas de 4096 px; guardadas en PNG el
 *     GLB se va a decenas de megas. Se limita el lado mayor y el color se
 *     escribe en JPEG cuando el material es opaco (los mapas de datos —normal,
 *     rugosidad, oclusion— se quedan en PNG, que el JPEG los ensucia).
 *
 * Los lectores se importan en diferido: pesan, y solo hacen falta si el usuario
 * llega a convertir algo.
 */
import * as THREE from 'three';

/** Slots cuyo contenido es color y aguanta JPEG sin estropear el sombreado. */
const SLOTS_COLOR = ['map', 'emissiveMap', 'specularMap', 'sheenColorMap'];

/** Altura, en unidades del archivo, a partir de la cual se asume centimetros. */
const LIMITE_CM = 10;

/** Nombre de salida: el mismo del origen con extension `.glb`. */
export const glbName = (name) => String(name || 'figura').replace(/\.[^.]+$/, '') + '.glb';

/** Tamano legible, para el aviso de la interfaz. */
export const humanBytes = (n) => (n >= 1048576
  ? (n / 1048576).toFixed(2) + ' MB'
  : Math.max(1, Math.round(n / 1024)) + ' kB');

/** Un material opaco puede llevar el color en JPEG: no necesita canal alfa. */
function esOpaco(m) {
  return m.transparent !== true && !m.alphaMap
    && (m.alphaTest ?? 0) === 0 && (m.opacity ?? 1) >= 1;
}

/**
 * Recorre los materiales, cuenta las texturas y marca en JPEG las de color. El
 * exportador respeta `texture.userData.mimeType`; sin esa marca lo escribe todo
 * en PNG.
 */
function prepararTexturas(root, jpegColor) {
  const vistas = new Set();
  root.traverse((obj) => {
    for (const m of [].concat(obj.material ?? [])) {
      if (!m) continue;
      for (const [slot, valor] of Object.entries(m)) {
        if (valor?.isTexture) vistas.add(valor);
        if (!jpegColor || !SLOTS_COLOR.includes(slot) || !valor?.isTexture) continue;
        if (esOpaco(m)) valor.userData.mimeType = 'image/jpeg';
      }
    }
  });
  return vistas.size;
}

/** Pasa el modelo a metros si viene en centimetros. Devuelve el factor usado. */
function normalizarEscala(root) {
  const caja = new THREE.Box3().setFromObject(root);
  const alto = caja.max.y - caja.min.y;
  if (!Number.isFinite(alto) || alto <= LIMITE_CM) return 1;
  root.scale.multiplyScalar(0.01);
  root.updateMatrixWorld(true);
  return 0.01;
}

/** Cuenta lo que lleva dentro, para poder decirlo en el aviso. */
function inventario(root) {
  let meshes = 0;
  let bones = 0;
  root.traverse((obj) => {
    if (obj.isMesh) meshes++;
    if (obj.isBone) bones++;
  });
  return { meshes, bones, animations: root.animations?.length ?? 0 };
}

/**
 * Convierte un `.fbx` en un `.glb` binario.
 *
 * @param {File|Blob|ArrayBuffer} source archivo elegido por el usuario
 * @param {object} [o]
 * @param {number} [o.maxTextureSize=2048] lado mayor de las texturas; 0 = tal cual
 * @param {boolean} [o.jpegColor=true] escribir el color en JPEG si es opaco
 * @param {string} [o.name] nombre de origen si `source` no es un File
 * @param {(texto: string, avance: number) => void} [o.onStage] aviso de progreso
 * @returns {Promise<{blob: Blob, name: string, bytes: number, sourceBytes: number,
 *   scale: number, textures: number, meshes: number, bones: number, animations: number}>}
 */
export async function convertFbxToGlb(source, {
  maxTextureSize = 2048,
  jpegColor = true,
  name = '',
  onStage,
} = {}) {
  const avisa = (texto, avance) => { try { onStage?.(texto, avance); } catch { /* da igual */ } };
  const origen = name || source?.name || 'figura.fbx';

  avisa('Leyendo el archivo…', 0.05);
  const buffer = source instanceof ArrayBuffer ? source : await source.arrayBuffer();
  if (!buffer?.byteLength) throw new Error('El archivo esta vacio');

  avisa('Interpretando el FBX…', 0.2);
  const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
  // `parse` no sale a la red por el archivo, pero si por las texturas externas
  // (las carpetas `.fbm` de Mixamo): sin ellas el modelo llega sin mapas, que es
  // mejor que no llegar.
  const root = new FBXLoader().parse(buffer, '');
  if (!root) throw new Error('El lector de FBX no devolvio nada');

  const stats = inventario(root);
  if (!stats.meshes) throw new Error('El FBX no trae ninguna malla');

  const scale = normalizarEscala(root);
  const textures = prepararTexturas(root, jpegColor);

  avisa('Empaquetando el GLB…', 0.45);
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
  const glb = await new GLTFExporter().parseAsync(root, {
    binary: true,
    animations: root.animations ?? [],
    maxTextureSize: maxTextureSize > 0 ? maxTextureSize : Infinity,
    includeCustomExtensions: false,
  });

  avisa('Listo', 1);
  const blob = new Blob([glb], { type: 'model/gltf-binary' });
  return {
    blob,
    name: glbName(origen),
    bytes: blob.size,
    sourceBytes: buffer.byteLength,
    scale,
    textures,
    ...stats,
  };
}
