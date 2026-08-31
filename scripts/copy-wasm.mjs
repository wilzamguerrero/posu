/**
 * Copia el runtime WASM de MediaPipe a /public/wasm.
 *
 * Servir el WASM desde el propio dominio evita depender de un CDN externo en
 * produccion (mejor latencia, funciona offline y no rompe si el CDN cambia de
 * version). Se ejecuta automaticamente antes de `dev` y `build`.
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, 'node_modules/@mediapipe/tasks-vision/wasm');
const DEST = resolve(ROOT, 'public/wasm');

if (!existsSync(SRC)) {
  console.warn('[copy-wasm] No se encontro @mediapipe/tasks-vision. Ejecuta npm install.');
  process.exit(0);
}
mkdirSync(DEST, { recursive: true });
cpSync(SRC, DEST, { recursive: true });
console.log(`[copy-wasm] ${readdirSync(DEST).length} archivos -> public/wasm`);
