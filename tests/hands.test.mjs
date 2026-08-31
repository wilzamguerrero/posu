/**
 * Rig de manos: comprueba que los ejes de flexion deducidos del esqueleto real
 * de Mixamo doblan los dedos hacia la palma (y no al reves), que el abanico
 * separa los dedos y que los gestos y el espejo escriben lo que dicen.
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

// --- GLB sin texturas: en Node no hay decodificador de imagenes -------------
const tmpDir = path.join(process.cwd(), '.tmp-hands');
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
const { HandRig, HAND_PRESET_BY_ID, HAND_VALUES } = await import('../src/model/HandRig.js');
const { FINGERS } = await import('../src/model/boneMap.js');

const settings = new Settings(DEFAULTS, null);
const character = new Character(settings);
await character.load(base + 'character.glb');
const rig = new HandRig(character, settings);

check('el rig encuentra las dos manos', rig.rebuild() === true);
check('controla las 30 falanges', rig.count() === 30, rig.count() + ' falanges');

// --- utilidades de medida ---------------------------------------------------
const wp = (key) => {
  character.root.updateMatrixWorld(true);
  return character.bones[key].getWorldPosition(new THREE.Vector3());
};
const dist = (a, b) => wp(a).distanceTo(wp(b));
const recta = (side) => {
  for (const f of FINGERS) settings.set(`hands.${side}.${f}`, 0);
  settings.set(`hands.${side}.spread`, 0);
  settings.set(`hands.${side}.thumbOut`, 0);
  rig.apply(side);
};
const poner = (side, values) => {
  for (const [k, v] of Object.entries(values)) settings.set(`hands.${side}.${k}`, v);
  rig.apply(side);
};

// --- la normal de la palma mira al suelo en la pose T de Mixamo ------------
for (const side of ['left', 'right']) {
  const r = rig.sides[side];
  check(`${side}: la palma mira hacia abajo en reposo (pose T)`, r.palma.y < -0.5,
    'palma=' + r.palma.toArray().map((n) => n.toFixed(2)).join(','));
  check(`${side}: el eje de la mano es casi horizontal`, Math.abs(r.eje.y) < 0.5,
    'eje=' + r.eje.toArray().map((n) => n.toFixed(2)).join(','));
}

// --- flexion: los dedos se cierran hacia la palma, no hacia el dorso -------
for (const side of ['left', 'right']) {
  recta(side);
  const abierto = dist(`${side}Index3`, `${side}Hand`);
  const punta0 = wp(`${side}Index3`).clone();
  // Con poca flexion el desplazamiento es casi perpendicular al dedo: es la
  // medida limpia del sentido de giro. En un puno cerrado la cuerda del arco
  // apunta sobre todo hacia la muneca y el coseno ya no dice nada.
  poner(side, { index: 0.25 });
  const avance = wp(`${side}Index3`).clone().sub(punta0).normalize();
  check(`${side}: la punta viaja hacia el lado palmar`, avance.dot(rig.sides[side].palma) > 0.7,
    'coseno=' + avance.dot(rig.sides[side].palma).toFixed(2));
  poner(side, { thumb: 1, index: 1, middle: 1, ring: 1, pinky: 1 });
  const cerrado = dist(`${side}Index3`, `${side}Hand`);
  check(`${side}: cerrar el puno acerca la punta a la muneca`, cerrado < abierto * 0.7,
    'abierto=' + abierto.toFixed(3) + ' cerrado=' + cerrado.toFixed(3));
  const dedos = FINGERS.filter((f) => f !== 'thumb')
    .every((f) => dist(`${side}${f[0].toUpperCase()}${f.slice(1)}3`, `${side}Hand`) < abierto * 0.95);
  check(`${side}: los cuatro dedos largos se cierran`, dedos);
  recta(side);
  const vuelta = dist(`${side}Index3`, `${side}Hand`);
  check(`${side}: con flexion 0 se vuelve al reposo`, Math.abs(vuelta - abierto) < 1e-6,
    'd=' + Math.abs(vuelta - abierto).toExponential(1));
}

// --- abanico y pulgar ------------------------------------------------------
recta('left');
const juntos = dist('leftIndex3', 'leftPinky3');
poner('left', { spread: 1 });
const separados = dist('leftIndex3', 'leftPinky3');
check('el abanico separa indice y menique', separados > juntos * 1.15,
  'juntos=' + juntos.toFixed(3) + ' separados=' + separados.toFixed(3));

recta('left');
const pegado = dist('leftThumb3', 'leftIndex1');
poner('left', { thumbOut: 1 });
const fuera = dist('leftThumb3', 'leftIndex1');
check('el pulgar se separa de la mano', fuera > pegado * 1.1,
  'pegado=' + pegado.toFixed(3) + ' fuera=' + fuera.toFixed(3));

// --- gestos, espejo e interpolacion ---------------------------------------
rig.applyPreset(null, 'abierta');
const abiertaTip = dist('leftIndex3', 'leftHand');
rig.applyPreset(null, 'puno');
const punoTip = dist('leftIndex3', 'leftHand');
check('el gesto «puno» cierra mucho mas que «abierta»', punoTip < abiertaTip * 0.6,
  'abierta=' + abiertaTip.toFixed(3) + ' puno=' + punoTip.toFixed(3));
check('el gesto queda anotado en los ajustes',
  settings.get('hands.left.preset') === 'puno' && settings.get('hands.right.preset') === 'puno');
check('el gesto escribe los siete valores',
  HAND_VALUES.every((k) => settings.get('hands.left.' + k) === HAND_PRESET_BY_ID.puno.values[k]));

// El puno es simetrico: la misma medida en las dos manos.
const izq = dist('leftIndex3', 'leftHand');
const der = dist('rightIndex3', 'rightHand');
// El personaje no tiene las manos exactamente en espejo: se admite un 10 %.
check('las dos manos cierran igual', Math.abs(izq - der) < izq * 0.1,
  'izq=' + izq.toFixed(4) + ' der=' + der.toFixed(4));

rig.applyPreset('left', 'abierta');
rig.mirror('left');
check('el espejo copia los valores en la otra mano',
  HAND_VALUES.every((k) => rig.values('right')[k] === rig.values('left')[k]),
  JSON.stringify(rig.values('right')));

// Camino de la captura: angulos en radianes con suavizado.
recta('left');
const p0 = wp('leftIndex3').clone();
const angulos = { index: [0.9, 1.1, 0.7] };
rig.applyAngles('left', angulos, 1);
const pFinal = wp('leftIndex3').clone();
recta('left');
rig.applyAngles('left', angulos, 0.5);
const pMedio = wp('leftIndex3').clone();
const total = p0.distanceTo(pFinal);
const medio = p0.distanceTo(pMedio);
check('applyAngles dobla el dedo indicado', total > 0.02, 'd=' + total.toFixed(3));
check('el suavizado se queda a medio camino', medio > total * 0.3 && medio < total * 0.75,
  'medio=' + medio.toFixed(3) + ' total=' + total.toFixed(3));

// Los angulos fuera de rango se recortan en lugar de romper la mano.
rig.applyAngles('left', { index: [9, -9, 9] }, 1);
const sano = ['leftIndex1', 'leftIndex2', 'leftIndex3']
  .every((k) => Number.isFinite(wp(k).x) && Number.isFinite(wp(k).y));
check('los angulos disparatados no producen NaN', sano);

rig.reset();
check('reset devuelve las falanges a su reposo',
  Math.abs(dist('leftIndex3', 'leftHand') - abiertaTip) < 1e-3,
  'd=' + Math.abs(dist('leftIndex3', 'leftHand') - abiertaTip).toExponential(1));

character.dispose();
server.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('');
console.log(oks.length + ' correctas / ' + fails.length + ' fallos');
if (fails.length) { console.log('FALLOS:'); for (const f of fails) console.log(' - ' + f); process.exit(1); }
process.exit(0);
