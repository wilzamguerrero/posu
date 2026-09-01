/**
 * Biblioteca de figuras leida de la carpeta: `refreshModelLibrary()` convierte
 * los nombres de archivo en las entradas que pintan los paneles. Aqui se le pasa
 * la lista a mano (fuera de Vite no hay servidor ni modulo virtual) para
 * comprobar que el nombre que se muestra es el del archivo sin extension, el
 * orden alfabetico, el descarte de lo que no es un modelo y que sin carpeta
 * legible se conserva el respaldo.
 */
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const fails = [];
const oks = [];
const check = (name, cond, extra = '') => {
  (cond ? oks : fails).push(name + (extra ? ' :: ' + extra : ''));
  console.log((cond ? 'OK   ' : 'FALLA') + ' ' + name + (extra ? '  (' + extra + ')' : ''));
};

const { MODEL_LIBRARY, DEFAULT_MODEL_URL } = await import('../src/config.js');
const { refreshModelLibrary, readModelFolder, buildModelLibrary } = await import('../src/model/library.js');

const ids = () => MODEL_LIBRARY.map((m) => m.id).join(', ');
const labels = (files) => buildModelLibrary(files).map((m) => m.label).join(', ');

// -------------------------------------------------------------- respaldo ----
// Fuera de Vite no hay ni ruta del servidor ni modulo virtual: la lectura
// devuelve vacio y la biblioteca se queda como estaba en vez de vaciarse.
check('sin Vite la carpeta no se puede leer', (await readModelFolder()).length === 0);
check('el respaldo es solo el modelo por defecto',
  MODEL_LIBRARY.length === 1 && DEFAULT_MODEL_URL.endsWith(MODEL_LIBRARY[0].file), ids());
check('sin carpeta legible se conserva lo que hubiera',
  (await refreshModelLibrary()) === MODEL_LIBRARY && MODEL_LIBRARY.length === 1, ids());

// --------------------------------------- el nombre es el del archivo --------
check('el nombre es el archivo sin extension, sin retocar nada',
  labels(['Untitled.glb', 'character.glb', 'mi_figura-RARA.fbx', 'ch43.glb'])
  === 'ch43, character, mi_figura-RARA, Untitled',
  labels(['Untitled.glb', 'character.glb', 'mi_figura-RARA.fbx', 'ch43.glb']));
check('el orden es alfabetico como en el explorador',
  labels(['ybot.glb', 'ch50.glb', 'character.glb', 'ch43.glb', 'xbot.glb'])
  === 'ch43, ch50, character, xbot, ybot');
check('los numeros se ordenan como numeros',
  labels(['pose10.glb', 'pose2.glb', 'pose1.glb']) === 'pose1, pose2, pose10');

// ---------------------------------------------------- lectura de carpeta ----
await refreshModelLibrary(['ybot.glb', 'zorro.fbx', 'Untitled.glb', 'ch43.glb',
  'character.glb', 'character.fbx', 'notas.txt', 'escena.blend']);
check('se muta el mismo array que ya tienen importado los paneles',
  MODEL_LIBRARY === (await refreshModelLibrary(['ybot.glb', 'zorro.fbx', 'Untitled.glb',
    'ch43.glb', 'character.glb', 'character.fbx', 'notas.txt', 'escena.blend'])));
check('la lista es la de la carpeta', ids() === 'ch43, character, Untitled, ybot, zorro', ids());
check('lo que no es un modelo se descarta',
  !MODEL_LIBRARY.some((m) => /notas|escena/.test(m.id)));
check('la url apunta a la carpeta models con el nombre exacto',
  MODEL_LIBRARY.find((m) => m.id === 'Untitled')?.url === 'models/Untitled.glb');
check('con el mismo nombre en dos formatos gana el .glb',
  MODEL_LIBRARY.find((m) => m.id === 'character')?.file === 'character.glb');
check('se admite tambien .fbx cuando no hay glb',
  MODEL_LIBRARY.find((m) => m.id === 'zorro')?.url === 'models/zorro.fbx');

// Renombrar el archivo renombra la figura: es todo el objetivo.
await refreshModelLibrary(['character.glb', 'la_misma_con_otro_nombre.glb']);
check('renombrar el archivo renombra la figura',
  ids() === 'character, la_misma_con_otro_nombre', ids());

// Nombres con espacios o acentos: el titulo se ve tal cual y la url va codificada.
await refreshModelLibrary(['Mi Figura Ñ.glb']);
check('un nombre con espacios se muestra tal cual', MODEL_LIBRARY[0].label === 'Mi Figura Ñ');
check('y su url va codificada para el cargador',
  MODEL_LIBRARY[0].url === 'models/Mi%20Figura%20%C3%91.glb', MODEL_LIBRARY[0].url);
await refreshModelLibrary(['character.glb', 'la_misma_con_otro_nombre.glb']);

// Carpeta vacia o con archivos ajenos: mejor la lista de antes que un panel sin nada.
await refreshModelLibrary([]);
check('una carpeta vacia no deja la biblioteca a cero', MODEL_LIBRARY.length === 2, ids());
await refreshModelLibrary(['leeme.md']);
check('una carpeta con solo archivos ajenos tampoco', MODEL_LIBRARY.length === 2, ids());

console.log('');
console.log(oks.length + ' correctas / ' + fails.length + ' fallos');
if (fails.length) { console.log('FALLOS:'); for (const f of fails) console.log(' - ' + f); process.exit(1); }
