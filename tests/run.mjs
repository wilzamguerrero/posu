/**
 * Lanzador de las pruebas de ejecucion. Cada archivo corre en su propio proceso
 * (comparten globales simulados que no conviene mezclar) con el hook de
 * resolucion que kalidokit necesita.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
// --import exige una URL: en Windows una ruta absoluta como "e:\..." se
// interpretaria como esquema "e:".
const loader = new URL('./loader.mjs', import.meta.url).href;
const suites = ['figure.test.mjs', 'figures.test.mjs', 'stage.test.mjs', 'perspective.test.mjs', 'hands.test.mjs', 'mocap.test.mjs', 'graphics.test.mjs', 'watchdog.test.mjs', 'scene.test.mjs', 'ui.test.mjs'];

let fallos = 0;
for (const suite of suites) {
  console.log(`\n\u2500\u2500\u2500 ${suite} \u2500\u2500\u2500`);
  const r = spawnSync(process.execPath, ['--import', loader, dir + suite], { stdio: 'inherit' });
  if (r.status !== 0) fallos++;
}

console.log(fallos ? `\n${fallos} de ${suites.length} pruebas con fallos` : `\nlas ${suites.length} pruebas pasan`);
process.exit(fallos ? 1 : 0);
