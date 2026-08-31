/**
 * POSU · Pipeline de preparacion del modelo
 * ------------------------------------------------------------------
 * Convierte el FBX de Mixamo a un .glb ligero y apto para la web:
 *
 *   1. FBX  -> GLB           (FBX2glTF, conserva skin + esqueleto mixamorig)
 *   2. resize texturas       (4096 -> 2048 / 1024 para el mapa metal-rough)
 *   3. PNG/JPEG -> WebP      (reduce ~29 MB a ~3 MB, por debajo del limite
 *                             de 25 MiB por archivo de Cloudflare Pages)
 *   4. dedup + prune         (limpia accessors y nodos huerfanos)
 *
 * Uso:  npm run convert -- <origen.fbx|glb> [--out nombre.glb] [--dir carpeta]
 *                         [--max 2048]
 *
 * Sin --out el nombre se deduce del archivo de origen ("tpose" -> character.glb).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, copyFileSync } from 'node:fs';
import { dirname, resolve, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// --- Argumentos -------------------------------------------------------------
const ARGS = process.argv.slice(2);
/** Lee una bandera "--nombre valor" y devuelve su valor o el predeterminado. */
const flag = (name, fallback) => {
  const i = ARGS.indexOf(`--${name}`);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : fallback;
};
// Los positivos son todo lo que no es bandera ni valor de bandera.
const POSITIONAL = ARGS.filter((v, i) => !v.startsWith('--') && !ARGS[i - 1]?.startsWith('--'));

const SOURCE = resolve(ROOT, POSITIONAL[0] ?? 'mixamo/tpose.fbx');
const STEM = basename(SOURCE, extname(SOURCE));
// "tpose" es la figura principal de la app; el resto conserva su nombre.
const DEFAULT_NAME = /^tpose$/i.test(STEM)
  ? 'character.glb'
  : STEM.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.glb';

const OUT_DIR = resolve(ROOT, flag('dir', 'public/models'));
const OUT = resolve(OUT_DIR, flag('out', DEFAULT_NAME));
const MAX_TEX = String(Number(flag('max', '2048')) || 2048);

const FBX2GLTF = resolve(ROOT, 'node_modules/fbx2gltf/bin/Windows_NT/FBX2glTF.exe');
const FBX2GLTF_NIX = resolve(ROOT, 'node_modules/fbx2gltf/bin/Linux/FBX2glTF');
const GLTF_CLI = resolve(ROOT, 'node_modules/@gltf-transform/cli/bin/cli.js');

const mb = (p) => (statSync(p).size / 1048576).toFixed(2) + ' MB';
const step = (n, msg) => console.log(`\x1b[36m[${n}/4]\x1b[0m ${msg}`);

/** Ejecuta la CLI de gltf-transform con salida silenciosa salvo errores. */
function gltf(...args) {
  execFileSync(process.execPath, [GLTF_CLI, ...args], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

if (!existsSync(SOURCE)) {
  console.error(`No se encontro el modelo de origen: ${SOURCE}`);
  process.exit(1);
}
mkdirSync(OUT_DIR, { recursive: true });

const work = resolve(tmpdir(), `posu-${Date.now()}`);
mkdirSync(work, { recursive: true });
const a = resolve(work, 'a.glb');
const b = resolve(work, 'b.glb');
const c = resolve(work, 'c.glb');

try {
  if (extname(SOURCE).toLowerCase() === '.fbx') {
    step(1, `FBX -> GLB  (${basename(SOURCE)}, ${mb(SOURCE)})`);
    const bin = existsSync(FBX2GLTF) ? FBX2GLTF : FBX2GLTF_NIX;
    execFileSync(bin, ['-i', SOURCE, '-o', resolve(work, 'a'), '--binary', '--pbr-metallic-roughness'], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
  } else {
    step(1, `Copiando GLB de origen (${mb(SOURCE)})`);
    copyFileSync(SOURCE, a);
  }

  step(2, `Reescalando texturas a ${MAX_TEX} px`);
  gltf('resize', a, b, '--width', MAX_TEX, '--height', MAX_TEX);

  step(3, 'Recomprimiendo texturas a WebP');
  // El normal map necesita mas calidad: la compresion agresiva genera bandas
  // visibles en el sombreado de la musculatura.
  gltf('webp', b, c, '--slots', 'normalTexture', '--quality', '94');
  gltf('webp', c, b, '--slots', '!normalTexture', '--quality', '86');

  step(4, 'Limpieza (dedup + prune)');
  gltf('dedup', b, c);
  gltf('prune', c, OUT);

  console.log(`\n\x1b[32mListo\x1b[0m  ${OUT}  ->  ${mb(OUT)}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
