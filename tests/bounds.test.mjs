/**
 * Volumen envolvente y anclaje del personaje.
 *
 * La caja se calcula uniendo una caja por hueso (barato, se puede hacer en cada
 * fotograma) en vez de recorrer los vertices de la piel. Aqui se comprueba que
 * esa caja contiene de verdad la malla deformada, que la altura pedida no
 * depende de la pose y que el anclaje al suelo sigue a la pose.
 *
 * Como figure.test.mjs: GLB real servido por un http local, sin WebGL.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import * as THREE from 'three';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

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
const tmpDir = path.join(process.cwd(), '.tmp-bounds');
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

const { Settings } = await import('../src/core/Settings.js');
const { DEFAULTS } = await import('../src/config.js');
const { Character } = await import('../src/model/Character.js');

const settings = new Settings(DEFAULTS, null);
const ch = new Character(settings);
await ch.load(base + 'character.glb');
const scene = new THREE.Scene();
scene.add(ch.root);
check('el GLB carga', ch.loaded === true);
check('hay piel repartida por hueso', ch.skinBounds.length > 20, ch.skinBounds.length + ' huesos con piel');

/**
 * Caja exacta de la malla visible, recorriendo vertices (la lenta). Es la
 * medida con la que se compara la barata.
 */
function cajaExacta() {
  ch.root.updateMatrixWorld(true);
  const caja = new THREE.Box3();
  for (const mesh of ch.visibleMeshes) {
    mesh.boundingBox = null;
    caja.union(new THREE.Box3().setFromObject(mesh));
  }
  return caja;
}

/** Holgura de la caja rapida en cada cara: negativa = la piel se sale. */
function caras(rapida, exacta) {
  return [
    exacta.min.x - rapida.min.x, exacta.min.y - rapida.min.y, exacta.min.z - rapida.min.z,
    rapida.max.x - exacta.max.x, rapida.max.y - exacta.max.y, rapida.max.z - exacta.max.z,
  ];
}

/** Cuanto se sale la piel de la caja calculada, en metros (0 = contenida). */
const fuga = (rapida, exacta) => Math.max(0, -Math.min(...caras(rapida, exacta)));

/** Lo que sobra por la cara mas holgada, en metros. */
const holgura = (rapida, exacta) => Math.max(...caras(rapida, exacta));

settings.set('scene.figures', []);
ch.setPlacement({ height: 1.75, anchor: 'suelo' });

// ------------------------------------------------------- 1 · reposo y altura ---
const alto = ch.box.max.y - ch.box.min.y;
check('la altura pedida se respeta', Math.abs(alto - 1.75) < 0.02, alto.toFixed(3) + ' m');
check('los pies quedan en el suelo', Math.abs(ch.box.min.y) < 0.005, ch.box.min.y.toFixed(4));
{
  const exacta = cajaExacta();
  check('la caja rapida contiene la piel en reposo', fuga(ch.box, exacta) < 0.004,
    'se sale ' + (fuga(ch.box, exacta) * 1000).toFixed(1) + ' mm');
  check('y le queda pegada', holgura(ch.box, exacta) < 0.02,
    'sobran ' + (holgura(ch.box, exacta) * 1000).toFixed(0) + ' mm por la cara mas suelta');
}

// ------------------------------------------------ 2 · la caja sigue la pose ---
// Brazo izquierdo arriba: la caja tiene que subir con la mano.
const antes = ch.box.clone();
ch.bones.leftArm.rotateZ(-1.2);
ch.bones.leftForeArm.rotateZ(-0.6);
ch.tick();
const mano = ch.bones.leftHand.getWorldPosition(new THREE.Vector3());
check('la caja acompana al brazo movido',
  !antes.equals(ch.box) && ch.box.containsPoint(mano),
  'mano ' + mano.toArray().map((v) => v.toFixed(2)).join(' / '));
{
  const exacta = cajaExacta();
  check('la caja rapida contiene la piel posada', fuga(ch.box, exacta) < 0.006,
    'se sale ' + (fuga(ch.box, exacta) * 1000).toFixed(1) + ' mm');
  check('y sigue pegada a la piel posada', holgura(ch.box, exacta) < 0.05,
    'sobran ' + (holgura(ch.box, exacta) * 1000).toFixed(0) + ' mm');
}

// La altura NO cambia por posar: se mide la figura en reposo.
const escala = ch.holder.scale.y;
ch.bones.leftUpLeg.rotateX(1.1);
ch.bones.leftLeg.rotateX(-1.4);
ch.bones.rightUpLeg.rotateX(1.1);
ch.bones.rightLeg.rotateX(-1.4);
ch.tick();
check('agacharse no reescala la figura', Math.abs(ch.holder.scale.y - escala) < 1e-9,
  escala.toFixed(5) + ' -> ' + ch.holder.scale.y.toFixed(5));
check('agachada mide menos que de pie', ch.box.max.y - ch.box.min.y < 1.7,
  (ch.box.max.y - ch.box.min.y).toFixed(3) + ' m');
check('y sigue apoyada en el suelo', Math.abs(ch.box.min.y) < 0.005, ch.box.min.y.toFixed(4));

// ------------------------------------------------------------ 3 · anclajes ---
ch.setPlacement({ anchor: 'centro' });
ch.tick();
const centro = ch.box.getCenter(new THREE.Vector3());
check('centrado deja el volumen en el origen', Math.abs(centro.y) < 0.005, centro.y.toFixed(4));
ch.setPlacement({ anchor: 'libre' });
ch.tick();
check('libre no toca el contenido', Math.abs(ch.holder.position.y) < 1e-9, ch.holder.position.y.toFixed(4));
ch.setPlacement({ anchor: 'suelo' });
ch.tick();
check('volver al suelo re-apoya la figura', Math.abs(ch.box.min.y) < 0.005, ch.box.min.y.toFixed(4));

// ------------------------------------------ 4 · caja del root y de la pose ---
ch.root.position.set(1.5, 0, -0.5);
ch.root.rotation.y = Math.PI / 4;
ch.root.updateMatrixWorld(true);
ch.tick();
{
  const exacta = cajaExacta();
  check('la caja de mundo acompana al root', fuga(ch.box, exacta) < 0.006,
    'se sale ' + (fuga(ch.box, exacta) * 1000).toFixed(1) + ' mm');
  const local = ch.bounds({ space: 'objeto' });
  const rehecha = local.box.clone().applyMatrix4(local.matrix);
  check('la caja de objeto, llevada a mundo, coincide',
    rehecha.min.distanceTo(ch.box.min) < 0.06 && rehecha.max.distanceTo(ch.box.max) < 0.06,
    rehecha.min.distanceTo(ch.box.min).toFixed(3) + ' / ' + rehecha.max.distanceTo(ch.box.max).toFixed(3));
}
{
  // Con `live` apagado se mide el modelo en reposo, no la pose de ahora.
  const quieta = ch.bounds({ live: false, space: 'objeto' }).box.clone();
  const viva = ch.bounds({ live: true, space: 'objeto' }).box.clone();
  check('la caja en reposo mide la figura de pie',
    Math.abs((quieta.max.y - quieta.min.y) - 1.75) < 0.03 && (viva.max.y - viva.min.y) < 1.7,
    'reposo=' + (quieta.max.y - quieta.min.y).toFixed(3) + ' pose=' + (viva.max.y - viva.min.y).toFixed(3));
}

// ------------------------------------------------------ 5 · coste del tick ---
const t0 = performance.now();
for (let i = 0; i < 200; i++) ch.tick();
const porTick = (performance.now() - t0) / 200;
check('medir la pose cuesta menos de 1 ms', porTick < 1, porTick.toFixed(3) + ' ms por fotograma');

ch.dispose();
server.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('');
console.log(oks.length + ' correctas / ' + fails.length + ' fallos');
if (fails.length) { console.log('FALLOS:'); for (const f of fails) console.log(' - ' + f); process.exit(1); }
process.exit(0);
