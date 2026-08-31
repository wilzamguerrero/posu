/**
 * Prueba de ejecucion de la cadena 3D + retargeting sin WebGL:
 *   GLB real -> Character -> PoseEngine (directo y kalidokit) -> huesos.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import * as THREE from 'three';
import { fileURLToPath } from 'node:url';

// Las rutas de archivo se resuelven desde la raiz del proyecto, sea desde donde
// sea que se lance la prueba.
process.chdir(fileURLToPath(new URL('..', import.meta.url)));

// ---------------------------------------------------------------- entorno ---
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

// three usa ProgressEvent al descargar (no existe en Node).
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
const tmpDir = path.join(process.cwd(), '.tmp-rig');
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
const { DEFAULTS } = await import('../src/config.js');
const { Character } = await import('../src/model/Character.js');
const { PoseEngine } = await import('../src/pose/PoseEngine.js');
const { LM } = await import('../src/pose/landmarks.js');

const settings = new Settings(DEFAULTS, null);
settings.set('mocap.frozen', false, { silent: true });
settings.set('mocap.smoothing', 0);
settings.set('mocap.oneEuro', false);

const character = new Character(settings);
await character.load(base + 'character.glb');
check('el GLB carga en Node', character.loaded === true);
check('esqueleto con huesos', !!character.skeleton && character.skeleton.bones.length > 40,
  (character.skeleton?.bones.length ?? 0) + ' huesos');
check('sin huesos obligatorios ausentes', character.missingRequired.length === 0,
  'requeridos=' + (character.missingRequired.join(',') || 'ninguno') + ' opcionales=' + (character.missing.join(',') || 'ninguno'));
check('tres variantes con el mismo esqueleto',
  ['anatomia', 'maniqui', 'esqueleto'].every((k) => character.meshes[k]?.[0]?.skeleton === character.skeleton),
  Object.entries(character.meshes).map(([k, v]) => k + ':' + v.length).join(' '));
check('reposo capturado', character.rest.world.size === character.skeleton.bones.length);

// ------------------------------------------- fotogramas sinteticos (33 pts) ---
// Convencion MediaPipe: metros, origen en la cadera, Y hacia abajo,
// X positivo = izquierda del sujeto, Z creciente al alejarse de la camara.
function frameFrom(pts) {
  const lm = [];
  for (let i = 0; i < 33; i++) {
    const p = pts[i] ?? { x: 0, y: 0, z: 0 };
    lm.push({ x: p.x, y: p.y, z: p.z, visibility: 1 });
  }
  const norm = lm.map((p) => ({ x: 0.5 + p.x * 0.4, y: 0.5 + p.y * 0.4, z: p.z, visibility: 1 }));
  return { landmarks: norm, worldLandmarks: lm };
}

function bodyPose(opts) {
  const leftArmUp = !!(opts && opts.leftArmUp);
  const p = [];
  const set = (i, x, y, z) => { p[i] = { x: x, y: y, z: z || 0 }; };
  set(LM.LEFT_HIP, 0.10, 0, 0); set(LM.RIGHT_HIP, -0.10, 0, 0);
  set(LM.LEFT_SHOULDER, 0.18, -0.50, 0); set(LM.RIGHT_SHOULDER, -0.18, -0.50, 0);
  if (leftArmUp) { set(LM.LEFT_ELBOW, 0.26, -0.78, 0); set(LM.LEFT_WRIST, 0.30, -1.05, 0); }
  else { set(LM.LEFT_ELBOW, 0.46, -0.50, 0); set(LM.LEFT_WRIST, 0.74, -0.50, 0); }
  set(LM.RIGHT_ELBOW, -0.46, -0.50, 0); set(LM.RIGHT_WRIST, -0.74, -0.50, 0);
  set(LM.LEFT_PINKY, p[LM.LEFT_WRIST].x + 0.06, p[LM.LEFT_WRIST].y + 0.02, -0.02);
  set(LM.LEFT_INDEX, p[LM.LEFT_WRIST].x + 0.07, p[LM.LEFT_WRIST].y, 0.02);
  set(LM.LEFT_THUMB, p[LM.LEFT_WRIST].x + 0.03, p[LM.LEFT_WRIST].y + 0.01, 0.03);
  set(LM.RIGHT_PINKY, p[LM.RIGHT_WRIST].x - 0.06, p[LM.RIGHT_WRIST].y + 0.02, -0.02);
  set(LM.RIGHT_INDEX, p[LM.RIGHT_WRIST].x - 0.07, p[LM.RIGHT_WRIST].y, 0.02);
  set(LM.RIGHT_THUMB, p[LM.RIGHT_WRIST].x - 0.03, p[LM.RIGHT_WRIST].y + 0.01, 0.03);
  set(LM.LEFT_KNEE, 0.11, 0.45, 0.01); set(LM.RIGHT_KNEE, -0.11, 0.45, 0.01);
  set(LM.LEFT_ANKLE, 0.11, 0.90, 0); set(LM.RIGHT_ANKLE, -0.11, 0.90, 0);
  set(LM.LEFT_HEEL, 0.11, 0.94, 0.04); set(LM.RIGHT_HEEL, -0.11, 0.94, 0.04);
  set(LM.LEFT_FOOT_INDEX, 0.11, 0.94, -0.12); set(LM.RIGHT_FOOT_INDEX, -0.11, 0.94, -0.12);
  set(LM.NOSE, 0, -0.70, -0.10);
  set(LM.LEFT_EYE, 0.03, -0.72, -0.08); set(LM.RIGHT_EYE, -0.03, -0.72, -0.08);
  set(LM.LEFT_EYE_INNER, 0.02, -0.72, -0.08); set(LM.RIGHT_EYE_INNER, -0.02, -0.72, -0.08);
  set(LM.LEFT_EYE_OUTER, 0.045, -0.72, -0.07); set(LM.RIGHT_EYE_OUTER, -0.045, -0.72, -0.07);
  set(LM.LEFT_EAR, 0.07, -0.71, 0); set(LM.RIGHT_EAR, -0.07, -0.71, 0);
  set(LM.MOUTH_LEFT, 0.025, -0.66, -0.08); set(LM.MOUTH_RIGHT, -0.025, -0.66, -0.08);
  return frameFrom(p);
}

const engine = new PoseEngine(settings, character);
const world = (key) => {
  character.root.updateMatrixWorld(true);
  const b = character.bones[key];
  return b ? b.getWorldPosition(new THREE.Vector3()) : null;
};
const feed = (frame, n) => { let ok = false; for (let i = 0; i < (n || 90); i++) ok = engine.update(frame, 1 / 60); return ok; };
const finite = (v) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
const skeletonSane = () => character.skeleton.bones.every((b) =>
  finite(b.position) && [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w].every(Number.isFinite)
  && Math.abs(b.quaternion.length() - 1) < 1e-3);
const H = character.box.getSize(new THREE.Vector3()).y || 1;

for (const motor of ['directo', 'kalidokit']) {
  const tag = '[' + motor + '] ';
  settings.set('mocap.engine', motor);
  character.resetToRest();
  engine.reset();

  const applied = feed(bodyPose());
  check(tag + 'update aplica la pose', applied === true);
  check(tag + 'confianza alta con todo visible', engine.confidence > 0.8, engine.confidence.toFixed(2));
  check(tag + 'esqueleto sin NaN y cuaterniones normalizados', skeletonSane());

  for (const espejo of [false, true]) {
    settings.set('mocap.mirror', espejo);
    const et = tag + (espejo ? 'espejo ' : 'directo ');
    character.resetToRest(); engine.reset();
    feed(bodyPose());
    const tL = world('leftHand').y, tR = world('rightHand').y, tS = world('leftShoulder').y;
    check(et + 'en T las manos quedan a la altura del hombro',
      Math.abs(tL - tS) < 0.18 * H && Math.abs(tR - tS) < 0.18 * H,
      'izq=' + (tL - tS).toFixed(3) + ' der=' + (tR - tS).toFixed(3));

    feed(bodyPose({ leftArmUp: true }));
    const uL = world('leftHand').y - tL, uR = world('rightHand').y - tR;
    const sube = espejo ? uR : uL;
    const quieta = espejo ? uL : uR;
    check(et + 'sube el brazo esperado', sube > 0.05 * H, 'sube=' + sube.toFixed(3));
    check(et + 'el otro brazo se queda quieto', Math.abs(quieta) < 0.05 * H, 'quieta=' + quieta.toFixed(3));
  }
  settings.set('mocap.mirror', false);
}

settings.set('mocap.engine', 'directo');
character.resetToRest(); engine.reset();
feed(bodyPose({ leftArmUp: true }));

const pose = character.getPose();
const poseBones = pose.rotations ?? {};
check('getPose devuelve rotaciones de los huesos posables', Object.keys(poseBones).length >= 20,
  Object.keys(poseBones).length + ' huesos');
const armQ = character.bones.leftArm.quaternion.clone();
character.resetToRest();
const restDiff = armQ.angleTo(character.bones.leftArm.quaternion);
check('resetToRest deshace la rotacion del brazo', restDiff > 0.1, (restDiff * 57.3).toFixed(1) + ' grados');
character.setPose(pose, 1);
const backErr = character.bones.leftArm.quaternion.angleTo(armQ);
check('setPose restituye la pose guardada', backErr < 1e-3, (backErr * 57.3).toFixed(3) + ' grados de error');

for (const v of ['anatomia', 'maniqui', 'esqueleto']) {
  character.cambiarGeometria(v);
  const on = character.meshes[v].every((m) => m.visible);
  const others = ['anatomia', 'maniqui', 'esqueleto'].filter((k) => k !== v);
  const off = others.every((k) => character.meshes[k].every((m) => !m.visible || m.material === character.ghostMat));
  check('cambiarGeometria(' + v + ') deja visible solo esa variante', on && off);
}
character.cambiarGeometria('anatomia');
character.setOpacity(0.4);
check('setOpacity activa transparencia en la variante visible',
  character.visibleMeshes.every((m) => m.material.transparent && Math.abs(m.material.opacity - 0.4) < 1e-6),
  'opacity=' + character.visibleMeshes[0].material.opacity);
character.setOpacity(1);

for (const t of ['figura', 'cabeza', 'torso', 'manos', 'pies']) {
  const v = character.focusPoint(t);
  check('focusPoint(' + t + ') devuelve un punto finito', !!v && finite(v));
}
check('posableBones devuelve huesos etiquetados',
  character.posableBones().length >= 20 && character.posableBones().every((e) => e.bone && e.label),
  character.posableBones().length + ' huesos');

settings.set('mocap.followPosition', true);
character.resetToRest(); engine.reset();
feed(bodyPose());
const hip0 = character.bones.hips.position.clone();
// Sujeto desplazado a la derecha de la imagen y hacia arriba.
const moved = bodyPose();
for (const l of moved.landmarks) { l.x += 0.20; l.y -= 0.10; }
feed(moved, 120);
const hip1 = character.bones.hips.position.clone();
check('followPosition desplaza la cadera', finite(hip1) && hip1.distanceTo(hip0) > 1e-3,
  'd=' + hip1.distanceTo(hip0).toFixed(4));
const hipWorld0 = new THREE.Vector3(), hipWorld1 = new THREE.Vector3();
character.root.updateMatrixWorld(true);
character.bones.hips.getWorldPosition(hipWorld1);
check('followPosition sube la figura cuando el sujeto sube', hipWorld1.y > 0,
  'y=' + hipWorld1.y.toFixed(3));
settings.set('mocap.followPosition', false);
feed(bodyPose(), 120);
check('sin followPosition la cadera vuelve al reposo',
  character.bones.hips.position.distanceTo(character.restHipsLocal) < 1e-3,
  'd=' + character.bones.hips.position.distanceTo(character.restHipsLocal).toFixed(5));

const bad = bodyPose();
for (const l of bad.worldLandmarks) l.visibility = 0.05;
for (const l of bad.landmarks) l.visibility = 0.05;
engine.update(bad, 1 / 60);
check('con visibilidad baja no aparecen NaN', skeletonSane(), 'confianza=' + engine.confidence.toFixed(2));

character.dispose();
server.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('');
console.log(oks.length + ' correctas / ' + fails.length + ' fallos');
if (fails.length) { console.log('FALLOS:'); for (const f of fails) console.log(' - ' + f); process.exit(1); }
process.exit(0);
