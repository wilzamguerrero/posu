/**
 * ATOM · Biblioteca de figuras de la carpeta `models`
 * ---------------------------------------------------------------------------
 * `MODEL_LIBRARY` se rellena con los archivos que hay en la carpeta de modelos.
 * El nombre que se ve en el panel es el del archivo sin extension, tal cual: no
 * hay tabla de nombres, ni indice, ni manifiesto guardado en ninguna parte, asi
 * que anadir, quitar o renombrar un `.glb` se refleja al recargar.
 *
 * Quien lee el directorio es Vite (ver el plugin `atom-model-list`), por dos
 * caminos y en este orden:
 *
 *   1. `GET /@atom/model-list`, que relee la carpeta en cada peticion. La sirven
 *      `npm run dev` (leyendo `public/models`) y `npm run preview` (leyendo
 *      `dist/models`): es la via que refleja los cambios sin reconstruir.
 *   2. el modulo virtual `virtual:atom-models`, con la lista dentro del paquete,
 *      para un servidor estatico que no responda a esa ruta.
 *
 * Fuera de Vite (las pruebas en Node) no hay ninguna de las dos: se cae al
 * respaldo de `config.js` y la lista se puede pasar a mano.
 */
import { MODEL_LIBRARY, modelEntry } from '../config.js';

/** Extensiones que el cargador de `Character` sabe abrir. */
const MODEL_EXT = /\.(glb|gltf|fbx)$/i;

/** Preferencia cuando el mismo nombre viene en varios formatos. */
const PESO_EXT = { glb: 0, gltf: 1, fbx: 2 };

/** Ruta del servidor que relee la carpeta; ha de coincidir con el plugin. */
const MODELS_ROUTE = '@atom/model-list';

const extDe = (file) => file.split('.').pop().toLowerCase();

/** Pregunta al servidor por el contenido de la carpeta. */
async function askServer() {
  try {
    const res = await fetch(new URL(MODELS_ROUTE, document.baseURI), { cache: 'no-store' });
    if (!res.ok) return [];
    const data = await res.json();
    const files = Array.isArray(data) ? data : data?.files;
    return Array.isArray(files) ? files.filter((f) => typeof f === 'string') : [];
  } catch {
    return [];
  }
}

/** Respaldo: la lista que quedo incrustada en el paquete al construir. */
async function askBundle() {
  try {
    const mod = await import('virtual:atom-models');
    const files = mod?.default;
    return Array.isArray(files) ? files.filter((f) => typeof f === 'string') : [];
  } catch {
    return [];
  }
}

/** Nombres de archivo de la carpeta de modelos, o `[]` si no hay manera. */
export async function readModelFolder() {
  const enVivo = await askServer();
  return enVivo.length ? enVivo : await askBundle();
}

/**
 * Ordena y desduplica la lista de archivos en entradas de biblioteca. El orden es
 * alfabetico, el mismo que muestra el explorador de archivos: asi el panel se
 * lee igual que la carpeta.
 */
export function buildModelLibrary(files) {
  // Un id por figura: si existen `x.glb` y `x.fbx` gana el formato mas rapido.
  const porId = new Map();
  for (const file of files ?? []) {
    if (!MODEL_EXT.test(file)) continue;
    const entry = modelEntry(file);
    const previo = porId.get(entry.id);
    if (previo && PESO_EXT[extDe(previo.file)] <= PESO_EXT[extDe(file)]) continue;
    porId.set(entry.id, entry);
  }
  return [...porId.values()].sort(
    (a, b) => a.label.localeCompare(b.label, 'es', { sensitivity: 'base', numeric: true }),
  );
}

/**
 * Pone en `MODEL_LIBRARY` lo que haya en la carpeta. Se muta el mismo array a
 * proposito: los paneles y `FigureSet` ya lo tienen importado, y asi la lista
 * llega a todos sin reimportar nada. Si la carpeta no se puede leer se conserva
 * el respaldo, que es mejor que un panel vacio.
 *
 * @param {string[]} [files] lista de archivos; por defecto, la de la carpeta
 * @returns {Promise<typeof MODEL_LIBRARY>}
 */
export async function refreshModelLibrary(files = null) {
  const entries = buildModelLibrary(files ?? await readModelFolder());
  if (!entries.length) return MODEL_LIBRARY;
  MODEL_LIBRARY.length = 0;
  MODEL_LIBRARY.push(...entries);
  return MODEL_LIBRARY;
}
