/**
 * Varias figuras en la escena: `FigureSet` como dueno de los personajes vivos.
 * Se comprueba el papeleo (`scene.figures` / `figure.active`), que cada figura
 * tenga su propio esqueleto y su propia colocacion, que duplicar herede la pose
 * y que al "recargar" (otro almacen con los mismos datos) vuelvan posadas.
 *
 * Como en figure.test.mjs: GLB real servido por un http local, sin WebGL.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import * as THREE from 'three';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

// ---------------------------------------------------------------- entorno ---
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.ProgressEvent ??= class ProgressEvent {
  constructor(type, init = {}) { Object.assign(this, init); this.type = type; }
};

const fails = [];
const oks = [];
const check = (name, cond, extra = '') => {
  (cond ? oks : fails).push(name + (extra ? ' :: ' + extra : ''));
  console.log((cond ? 'OK   ' : 'FALLA') + ' ' + name + (extra ? '  (' + extra + ')' : ''));
};

// -------------------------------------- GLB sin texturas (no hay decoder) ---
const tmpDir = path.join(process.cwd(), '.tmp-figuras');
fs.mkdirSync(tmpDir, { recursive: true });
{
  const b = fs.readFileSync('public/models/character.glb');
  const jlen = b.readUInt32LE(12);
  const json = JSON.parse(b.toString('utf8', 20, 20 + jlen));
  delete json.images; delete json.textures; delete json.samplers;
  json.extensionsUsed = []; json.extensionsRequired = [];
  for (const m of json.materials ?? []) {
    delete m.normalTexture; delete m.occlusionTexture; delete m.emissiveTexture;
    if (m.pbrMetallicRoughness) {
      delete m.pbrMetallicRoughness.baseColorTexture;
      delete m.pbrMetallicRoughness.metallicRoughnessTexture;
    }
  }
  let js = JSON.stringify(json);
  while (js.length % 4 !== 0) js += ' ';
  const jb = Buffer.from(js, 'utf8');
  const bin = b.subarray(20 + jlen);
  const head = Buffer.alloc(20);
  head.write('glTF', 0, 'ascii');
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + jb.length + bin.length, 8);
  head.writeUInt32LE(jb.length, 12);
  head.write('JSON', 16, 'ascii');
  fs.writeFileSync(path.join(tmpDir, 'character.glb'), Buffer.concat([head, jb, bin]));
}

const server = http.createServer((req, res) => {
  const f = path.join(tmpDir, path.basename(req.url.split('?')[0]));
  if (!fs.existsSync(f)) { res.statusCode = 404; res.end(); return; }
  res.setHeader('content-type', 'model/gltf-binary');
  res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port + '/';

// ------------------------------------------------------------------ carga ---
const { Settings } = await import('../src/core/Settings.js');
const { DEFAULTS, MODEL_LIBRARY } = await import('../src/config.js');
const { FigureSet, MAX_FIGURAS } = await import('../src/model/FigureSet.js');

// Toda la biblioteca apunta al GLB local: asi cualquier `model` es cargable.
for (const m of MODEL_LIBRARY) m.url = base + 'character.glb';

// Visor simulado: solo hace falta que recoja y suelte objetos.
const escena = new THREE.Group();
const viewport = {
  add: (...objs) => escena.add(...objs.filter(Boolean)),
  remove: (...objs) => escena.remove(...objs.filter(Boolean)),
  invalidateShadows() {},
};

const nuevoJuego = (ajustes) => {
  const errores = [];
  const set = new FigureSet({
    settings: ajustes, viewport,
    onError: (id, err) => errores.push(id + ': ' + err.message),
  });
  set.errores = errores;
  return set;
};

const settings = new Settings(DEFAULTS, null);
const figures = nuevoJuego(settings);

// ------------------------------------------------------- 1 · una sola figura ---
const id0 = figures.seed();
await figures.sync();
const a = figures.get(id0);
check('seed siembra una figura y la activa', figures.count === 1 && figures.activeId === id0);
check('la figura sembrada carga', a?.loaded === true, figures.errores.join(' | ') || 'sin errores');
check('su root cuelga del visor', a.root.parent === escena);
check('hereda los ajustes viejos de colocacion',
  Math.abs(figures.activeDef.height - settings.get('figure.height')) < 1e-9,
  'altura=' + figures.activeDef.height);
check('locate y pathOf apuntan a su hueco', figures.pathOf(id0) === 'scene.figures.0');
check('no se puede quedar sin figuras', figures.remove(id0) === false && figures.count === 1);

// ------------------------------------------------- 2 · alta de una segunda ---
const id1 = await figures.add({});
const b = figures.get(id1);
check('add escribe la figura nueva en el almacen',
  figures.count === 2 && (settings.get('scene.figures') ?? []).length === 2);
check('add pasa a ser la figura activa', figures.activeId === id1);
check('la figura nueva carga su propio modelo', b?.loaded === true,
  figures.errores.join(' | ') || 'sin errores');
check('los nombres no se repiten',
  figures.defs[0].name !== figures.defs[1].name,
  figures.defs.map((d) => d.name).join(' / '));
check('nace separada de la anterior', b.root.position.x > a.root.position.x,
  'x=' + b.root.position.x.toFixed(2));
check('cada figura tiene su esqueleto', a.skeleton !== b.skeleton);

// Girar un hueso de A no puede mover a B.
const antesB = b.bones.leftArm.quaternion.clone();
a.bones.leftArm.rotateZ(0.7);
check('los esqueletos son independientes',
  b.bones.leftArm.quaternion.angleTo(antesB) < 1e-9
  && a.bones.leftArm.quaternion.angleTo(antesB) > 0.5,
  'B se movio ' + (b.bones.leftArm.quaternion.angleTo(antesB) * 57.3).toFixed(2) + ' grados');

// La pose se guarda y se pone por figura, con las mismas claves de hueso.
const poseA = a.getPose();
b.setPose(poseA, 1);
check('getPose/setPose funcionan figura a figura',
  b.bones.leftArm.quaternion.angleTo(a.bones.leftArm.quaternion) < 1e-6);
b.resetToRest();

// ----------------------------------------- 3 · colocacion propia de cada una ---
const p1 = figures.pathOf(id1);
settings.batch({
  [p1 + '.height']: 1.4,
  [p1 + '.anchor']: 'centro',
  [p1 + '.position.z']: 1.25,
  [p1 + '.rotation.y']: 90,
  [p1 + '.name']: 'La otra',
});
check('la altura es propia de cada figura', Math.abs(a.holder.scale.x - b.holder.scale.x) > 1e-6,
  'A=' + a.holder.scale.x.toFixed(4) + ' B=' + b.holder.scale.x.toFixed(4));
check('el anclaje centrado baja el contenido respecto al de suelo',
  b.holder.position.y < a.holder.position.y - 0.2,
  'suelo=' + a.holder.position.y.toFixed(3) + ' centro=' + b.holder.position.y.toFixed(3));
check('la posicion del def llega al root', Math.abs(b.root.position.z - 1.25) < 1e-9);
check('la rotacion del def llega al root en radianes',
  Math.abs(b.root.rotation.y - Math.PI / 2) < 1e-6, b.root.rotation.y.toFixed(4));
check('el nombre llega al objeto de la escena', b.root.name === 'La otra');
settings.set(p1 + '.visible', false);
check('ocultar una figura no toca a la otra', b.root.visible === false && a.root.visible === true);
settings.set(p1 + '.visible', true);

// El aspecto, en cambio, es comun: una sola escritura cambia las dos.
settings.set('figure.variant', 'maniqui');
check('la malla visible es comun a todas las figuras',
  [a, b].every((ch) => ch.meshes.maniqui.every((m) => m.visible)));

// ------------------------------------------------ 4 · duplicar con su pose ---
const id2 = await figures.duplicate(id0);
const c = figures.get(id2);
check('duplicate anade una figura mas', figures.count === 3 && !!c?.loaded);
check('la copia tiene su propio esqueleto', c.skeleton !== a.skeleton);
check('la copia hereda la pose del original',
  c.bones.leftArm.quaternion.angleTo(a.bones.leftArm.quaternion) < 1e-6,
  (c.bones.leftArm.quaternion.angleTo(a.bones.leftArm.quaternion) * 57.3).toFixed(3) + ' grados');
check('la copia nace en un hueco libre, no encima de otra figura',
  figures.defs.every((d) => d.id === id2 || Math.abs((d.position?.x ?? 0) - c.root.position.x) > 0.3),
  'x=' + figures.defs.map((d) => d.position.x).join(' / '));
const antesA = a.bones.leftArm.quaternion.clone();
c.bones.leftArm.rotateZ(-0.5);
check('mover la copia no mueve al original', a.bones.leftArm.quaternion.angleTo(antesA) < 1e-9);
check('duplicate hereda tambien la colocacion',
  figures.locate(id2).def.height === figures.locate(id0).def.height);

// --------------------------------------------- 5 · cambiar de modelo y pose ---
const brazoC = c.bones.leftArm.quaternion.clone();
settings.set(figures.pathOf(id2) + '.model', 'xbot');
await figures.sync();
const c2 = figures.get(id2);
check('cambiar el modelo recarga esa figura', c2?.loaded === true,
  figures.errores.join(' | ') || 'sin errores');
check('al recargar el modelo se conserva la pose',
  c2.bones.leftArm.quaternion.angleTo(brazoC) < 1e-6,
  (c2.bones.leftArm.quaternion.angleTo(brazoC) * 57.3).toFixed(3) + ' grados de error');
check('y se vuelve a aplicar su colocacion',
  Math.abs(c2.root.position.x - figures.locate(id2).def.position.x) < 1e-9);

// ------------------------------------------ 6 · volcado de poses y recarga ---
figures.snapshotPoses();
const guardado = structuredClone(settings.get('scene.figures'));
check('snapshotPoses deja la pose de cada figura en su def',
  guardado.every((d) => Object.keys(d.pose?.rotations ?? {}).length > 20),
  guardado.map((d) => Object.keys(d.pose?.rotations ?? {}).length).join('/') + ' huesos');

// "Recargar la pagina": otro almacen con los mismos datos guardados.
const settings2 = new Settings(DEFAULTS, null);
settings2.batch({ 'scene.figures': guardado, 'figure.active': guardado[1].id });
const figures2 = nuevoJuego(settings2);
await figures2.sync();
check('al recargar vuelven todas las figuras', figures2.count === guardado.length
  && figures2.all().length === guardado.length, figures2.errores.join(' | ') || 'sin errores');
check('vuelve cada una en su sitio',
  Math.abs(figures2.get(guardado[1].id).root.position.z - guardado[1].position.z) < 1e-9);
check('y con su pose puesta',
  figures2.get(guardado[0].id).bones.leftArm.quaternion.angleTo(a.bones.leftArm.quaternion) < 1e-6,
  (figures2.get(guardado[0].id).bones.leftArm.quaternion
    .angleTo(a.bones.leftArm.quaternion) * 57.3).toFixed(3) + ' grados de error');
check('respeta la figura activa guardada', figures2.activeId === guardado[1].id);
figures2.dispose();

// --------------------------------------------------- 7 · bajas y tope de 8 ---
const activaAntes = figures.activeId;
check('remove quita la figura y traspasa la activa',
  figures.remove(activaAntes) === true && figures.count === 2 && figures.activeId !== activaAntes,
  'activa=' + figures.activeId);
check('la baja se escribe en el almacen',
  (settings.get('scene.figures') ?? []).every((d) => d.id !== activaAntes));

while (figures.count < MAX_FIGURAS) {
  const nuevo = await figures.add({});
  if (!nuevo) break;
}
check('se llega al tope sin errores', figures.count === MAX_FIGURAS,
  figures.count + ' figuras · ' + (figures.errores.join(' | ') || 'sin errores'));
check('pasado el tope no se anade nada', (await figures.add({})) === null && figures.count === MAX_FIGURAS);

// ------------------------------------------------------------------- final ---
figures.dispose();
check('dispose suelta los personajes del visor', escena.children.length === 0,
  escena.children.length + ' objetos sueltos');

server.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('');
console.log(oks.length + ' correctas / ' + fails.length + ' fallos');
if (fails.length) { console.log('FALLOS:'); for (const f of fails) console.log(' - ' + f); process.exit(1); }
process.exit(0);
