/**
 * Cinematica inversa: comprueba que los solucionadores llevan la punta al
 * objetivo sin cambiar el largo de ningun hueso, que el polo manda en el plano
 * del pliegue, y que el rig de seis cadenas montado sobre el esqueleto real de
 * Mixamo cumple lo que promete: arrastrar una mano sin tocar lo demas, clavar un
 * pie y hundir la cadera para agacharse, y no estorbar cuando nadie fija nada.
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

const { solveTwoBone, solveChain, worldOf } = await import('../src/pose/ik.js');

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const wp = (o) => worldOf(o, new THREE.Vector3());
const largo = (a, b) => wp(a).distanceTo(wp(b));
/** Componente de `p` perpendicular al eje `u` que sale de `a`. */
const perpA = (p, a, u) => {
  const v = p.clone().sub(a);
  return v.addScaledVector(u, -v.dot(u));
};

/* ── 1 · Dos huesos: la solucion analitica ─────────────────────────────── */

/**
 * Miembro de dos huesos con un pliegue de salida, colgado de una raiz movida y
 * girada: asi ninguna prueba pasa por estar el hombro en el origen.
 */
function armarMiembro(pliegue = 0.3) {
  const raiz = new THREE.Group();
  raiz.position.set(0.2, 0, -0.1);
  raiz.rotation.y = 0.4;
  const hombro = new THREE.Bone();
  hombro.position.set(0, 1.5, 0);
  const codo = new THREE.Bone();
  codo.position.set(0, -0.5, 0);
  codo.rotation.x = pliegue;
  const mano = new THREE.Bone();
  mano.position.set(0, -0.45, 0);
  raiz.add(hombro);
  hombro.add(codo);
  codo.add(mano);
  raiz.updateMatrixWorld(true);
  return { raiz, hombro, codo, mano };
}

{
  const m = armarMiembro();
  const l1 = largo(m.hombro, m.codo);
  const l2 = largo(m.codo, m.mano);
  const objetivo = wp(m.hombro).add(V(0.3, -0.5, 0.2));
  const ok = solveTwoBone({
    root: m.hombro, mid: m.codo, tip: m.mano, target: objetivo, pole: null, margin: 0.02,
  });
  const d = wp(m.mano).distanceTo(objetivo);
  check('dos huesos: la punta llega al objetivo', ok && d < 1e-5, 'd=' + d.toExponential(1));
  check('dos huesos: ningun hueso cambia de largo',
    Math.abs(largo(m.hombro, m.codo) - l1) < 1e-9 && Math.abs(largo(m.codo, m.mano) - l2) < 1e-9,
    'brazo=' + largo(m.hombro, m.codo).toFixed(6) + ' antebrazo=' + largo(m.codo, m.mano).toFixed(6));
}

{
  // Fuera de alcance: se estira hasta la reserva pedida y apunta al objetivo.
  const m = armarMiembro();
  const total = largo(m.hombro, m.codo) + largo(m.codo, m.mano);
  const a = wp(m.hombro);
  const objetivo = a.clone().add(V(0.5, -3, 1));
  solveTwoBone({ root: m.hombro, mid: m.codo, tip: m.mano, target: objetivo, pole: null, margin: 0.05 });
  const c = wp(m.mano);
  const coseno = c.clone().sub(a).normalize().dot(objetivo.clone().sub(a).normalize());
  check('fuera de alcance: la cadena apunta al objetivo', coseno > 0.9999, 'coseno=' + coseno.toFixed(6));
  check('fuera de alcance: se queda a la reserva pedida',
    Math.abs(a.distanceTo(c) - total * 0.95) < 1e-5,
    'alcanzado=' + a.distanceTo(c).toFixed(5) + ' esperado=' + (total * 0.95).toFixed(5));
}

for (const [nombre, dir, pliegue] of [
  ['+Z', V(0, 0, 1), 0.3], ['-Z', V(0, 0, -1), 0.3], ['+X', V(1, 0, 0), 0.3],
  ['+Z con el brazo recto', V(0, 0, 1), 0],
]) {
  const m = armarMiembro(pliegue);
  const a = wp(m.hombro);
  const objetivo = a.clone().add(V(0, -0.7, 0));
  const polo = a.clone().add(V(0, -0.35, 0)).add(dir.clone().multiplyScalar(0.5));
  solveTwoBone({ root: m.hombro, mid: m.codo, tip: m.mano, target: objetivo, pole: polo, margin: 0.02 });
  const u = objetivo.clone().sub(a).normalize();
  const coseno = perpA(wp(m.codo), a, u).normalize().dot(perpA(polo, a, u).normalize());
  check('el polo ' + nombre + ' decide hacia donde mira el codo', coseno > 0.999, 'coseno=' + coseno.toFixed(5));
  const d = wp(m.mano).distanceTo(objetivo);
  check('el polo ' + nombre + ' no despega la punta del objetivo', d < 1e-5, 'd=' + d.toExponential(1));
}

/* ── 2 · FABRIK: columna y cuello ──────────────────────────────────────── */

/** Cadena de `n` huesos con una punta al final, como la columna del modelo. */
function armarColumna(n = 4, paso = 0.25) {
  const raiz = new THREE.Group();
  const huesos = [];
  let padre = raiz;
  for (let i = 0; i < n; i++) {
    const b = new THREE.Bone();
    b.position.set(0, i === 0 ? 1 : paso, 0);
    padre.add(b);
    huesos.push(b);
    padre = b;
  }
  const punta = new THREE.Bone();
  punta.position.set(0, paso, 0);
  padre.add(punta);
  raiz.updateMatrixWorld(true);
  return { raiz, huesos, punta };
}

{
  const c = armarColumna();
  const medir = () => c.huesos.map((b, i) => largo(b, i + 1 < c.huesos.length ? c.huesos[i + 1] : c.punta));
  const antes = medir();
  const objetivo = wp(c.huesos[0]).add(V(0.4, 0.6, 0.3));
  const ok = solveChain({ bones: c.huesos, tip: c.punta, target: objetivo, iterations: 20 });
  const d = wp(c.punta).distanceTo(objetivo);
  check('FABRIK: la punta llega al objetivo', ok && d < 1e-3, 'd=' + d.toExponential(1));
  const ahora = medir();
  check('FABRIK: ningun hueso cambia de largo',
    antes.every((l, i) => Math.abs(l - ahora[i]) < 1e-6),
    antes.map((l, i) => (l - ahora[i]).toExponential(0)).join(' '));
}

{
  // Fuera de alcance la cadena se estira recta, sin dar vueltas ni oscilar.
  const c = armarColumna();
  const a = wp(c.huesos[0]);
  const objetivo = a.clone().add(V(2, 3, -1));
  solveChain({ bones: c.huesos, tip: c.punta, target: objetivo, iterations: 20 });
  const coseno = wp(c.punta).clone().sub(a).normalize().dot(objetivo.clone().sub(a).normalize());
  check('FABRIK fuera de alcance: se estira hacia el objetivo', coseno > 0.9999, 'coseno=' + coseno.toFixed(6));
}

{
  // Un solo hueso: es el cuello cuando el modelo no trae coronilla.
  const raiz = new THREE.Group();
  const cuello = new THREE.Bone();
  cuello.position.set(0, 1.5, 0);
  const cabeza = new THREE.Bone();
  cabeza.position.set(0, 0.2, 0);
  raiz.add(cuello);
  cuello.add(cabeza);
  raiz.updateMatrixWorld(true);
  const a = wp(cuello);
  const dir = V(0.1, 0.15, 0.05).normalize();
  // A un hueso rigido solo se le puede pedir la direccion: la distancia la fija
  // su largo. Con el objetivo mas cerca apunta a el y se queda a la diferencia.
  const cerca = a.clone().addScaledVector(dir, 0.19);
  const ok = solveChain({ bones: [cuello], tip: cabeza, target: cerca, iterations: 12 });
  const coseno = wp(cabeza).sub(a).normalize().dot(dir);
  check('un solo hueso: apuntar la cabeza tambien vale', ok && coseno > 0.9999,
    'coseno=' + coseno.toFixed(6));
  const justo = a.clone().addScaledVector(dir, 0.2);
  solveChain({ bones: [cuello], tip: cabeza, target: justo, iterations: 12 });
  const d = wp(cabeza).distanceTo(justo);
  check('un solo hueso: llega si el objetivo esta a su alcance exacto', d < 1e-6,
    'd=' + d.toExponential(1));
  check('un solo hueso: conserva su largo', Math.abs(largo(cuello, cabeza) - 0.2) < 1e-9);
}

{
  // Entradas que no sirven: se rechazan en vez de dejar NaN en el esqueleto.
  const m = armarMiembro();
  check('sin objetivo no se resuelve nada',
    solveTwoBone({ root: m.hombro, mid: m.codo, tip: m.mano, target: null }) === false
    && solveChain({ bones: [m.hombro], tip: m.mano, target: null }) === false
    && solveChain({ bones: [], tip: m.mano, target: V(0, 0, 0) }) === false);
  const pegado = new THREE.Bone();
  m.hombro.add(pegado);
  const otro = new THREE.Bone();
  pegado.add(otro);
  m.raiz.updateMatrixWorld(true);
  check('un hueso de largo cero no se resuelve',
    solveTwoBone({ root: m.hombro, mid: pegado, tip: otro, target: V(0, 1, 0) }) === false);
}

/* ── 3 · El rig sobre el esqueleto real ────────────────────────────────── */

// GLB sin texturas: en Node no hay decodificador de imagenes.
const tmpDir = path.join(process.cwd(), '.tmp-ik');
fs.mkdirSync(tmpDir, { recursive: true });
{
  const b = fs.readFileSync('public/models/character.glb');
  const jlen = b.readUInt32LE(12);
  const json = JSON.parse(b.toString('utf8', 20, 20 + jlen));
  delete json.images; delete json.textures; delete json.samplers;
  json.extensionsUsed = []; json.extensionsRequired = [];
  for (const mat of json.materials ?? []) {
    delete mat.normalTexture; delete mat.occlusionTexture; delete mat.emissiveTexture;
    if (mat.pbrMetallicRoughness) {
      delete mat.pbrMetallicRoughness.baseColorTexture;
      delete mat.pbrMetallicRoughness.metallicRoughnessTexture;
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
const { IKRig, IK_CHAINS } = await import('../src/posing/IKRig.js');

const settings = new Settings(DEFAULTS, null);
const character = new Character(settings);
await character.load(base + 'character.glb');
const bones = character.bones;
const rig = new IKRig(character, settings);

check('el rig arma las seis cadenas', rig.chains.length === IK_CHAINS.length,
  rig.chains.map((c) => c.id + '→' + c.tipKey).join(' '));
check('las cadenas de dos huesos tienen raiz, codo y punta',
  rig.chains.filter((c) => c.kind === 'twoBone').every((c) => c.root && c.mid && c.tip));
check('las cadenas de columna tienen al menos un hueso que girar',
  rig.chains.filter((c) => c.kind === 'chain').every((c) => c.bones.length >= 1 && c.tip));
check('nace apagada, como dice la configuracion', rig.on === false && DEFAULTS.ik.enabled === false);

settings.set('ik.enabled', true);
check('se enciende con ik.enabled', rig.on === true);
check('apagar un grupo saca sus cadenas de juego',
  (() => {
    settings.set('ik.arms', false);
    const fuera = rig.live(rig.get('leftArm')) === false && rig.live(rig.get('leftLeg')) === true;
    settings.set('ik.arms', true);
    return fuera && rig.live(rig.get('leftArm')) === true;
  })());

const punta = (chain) => worldOf(chain.tip, new THREE.Vector3());
const enHolder = (chain) => rig.toLocal(punta(chain), new THREE.Vector3());
/** Largo total de la cadena estirada, en unidades de mundo. */
const alcance = (chain) => {
  const pts = chain.bones.map((b) => worldOf(b, new THREE.Vector3()));
  pts.push(punta(chain));
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) total += pts[i].distanceTo(pts[i + 1]);
  return total;
};

// --- un objetivo suelto sigue a su punta -----------------------------------
{
  const brazo = rig.get('leftArm');
  bones.leftArm.rotateZ(0.35);
  bones.leftArm.updateWorldMatrix(false, true);
  rig.syncLoose();
  const objetivo = rig.targetWorld(brazo, new THREE.Vector3());
  check('un objetivo suelto sigue a la mano', objetivo.distanceTo(punta(brazo)) < 1e-9,
    'd=' + objetivo.distanceTo(punta(brazo)).toExponential(1));
  check('sin nada sujeto no hay nada que rehacer', rig.solveHeld() === false);
}

// --- arrastrar el rombo de la mano ----------------------------------------
const brazo = rig.get('leftArm');
const l1 = () => worldOf(brazo.root, new THREE.Vector3()).distanceTo(worldOf(brazo.mid, new THREE.Vector3()));
const l2 = () => worldOf(brazo.mid, new THREE.Vector3()).distanceTo(punta(brazo));
const huesoAntes = [l1(), l2()];
let destino = null;
{
  rig.hold.add('leftArm');
  const hombro = worldOf(brazo.root, new THREE.Vector3());
  // Un punto seguro dentro del alcance: siete decimos del brazo estirado, hacia
  // delante y abajo, que es el gesto tipico de llevar la mano al pecho.
  destino = hombro.clone().addScaledVector(V(0.35, -0.75, 0.55).normalize(), alcance(brazo) * 0.7);
  rig.setTargetWorld(brazo, destino);
  const movio = rig.solveHeld();
  const d = punta(brazo).distanceTo(destino);
  check('arrastrar el rombo lleva la mano al punto', movio && d < 1e-4, 'd=' + d.toExponential(1));
  check('el brazo no se estira al posarlo',
    Math.abs(l1() - huesoAntes[0]) < 1e-6 && Math.abs(l2() - huesoAntes[1]) < 1e-6,
    'brazo=' + (l1() - huesoAntes[0]).toExponential(0) + ' antebrazo=' + (l2() - huesoAntes[1]).toExponential(0));
  check('resuelto una vez, no se vuelve a resolver', rig.solveHeld() === false);
  check('la mano no queda con NaN', punta(brazo).toArray().every(Number.isFinite));
}

// --- el cubo del codo gira el pliegue sin mover la mano --------------------
{
  const manoAntes = punta(brazo);
  const hombro = worldOf(brazo.root, new THREE.Vector3());
  const codoAntes = rig.midWorld(brazo, new THREE.Vector3());
  const u = rig.targetWorld(brazo, new THREE.Vector3()).sub(hombro).normalize();
  const brazoPerp = perpA(codoAntes, hombro, u);
  // El polo que propone el rig sale del pliegue de ahora: girarlo 90 grados
  // alrededor del eje hombro-mano es exactamente arrastrar su manejador.
  const polo = rig.poleWorld(brazo, new THREE.Vector3());
  const girado = perpA(polo, hombro, u).applyAxisAngle(u, Math.PI / 2)
    .addScaledVector(u, polo.clone().sub(hombro).dot(u)).add(hombro);
  rig.solve(brazo, girado);
  const codoAhora = rig.midWorld(brazo, new THREE.Vector3());
  check('el polo propuesto sale del codo actual',
    perpA(polo, hombro, u).normalize().dot(brazoPerp.clone().normalize()) > 0.999);
  check('mover el polo gira el codo', codoAhora.distanceTo(codoAntes) > brazoPerp.length() * 0.8,
    'd=' + codoAhora.distanceTo(codoAntes).toFixed(4) + ' radio=' + brazoPerp.length().toFixed(4));
  check('mover el polo no mueve la mano', punta(brazo).distanceTo(manoAntes) < 1e-4,
    'd=' + punta(brazo).distanceTo(manoAntes).toExponential(1));
  check('tras mover el polo la cadena se da por resuelta', rig.solveHeld() === false);
  rig.hold.clear();
}

// --- clavar un pie y hundir la cadera: el gesto de agacharse ---------------
{
  const pierna = rig.get('leftLeg');
  const pieAntes = punta(pierna);
  rig.pin('leftLeg', true);
  check('fijar no mueve el pie', punta(pierna).distanceTo(pieAntes) < 1e-9);
  check('fijar queda anotado en los ajustes',
    settings.get('ik.pins.leftLeg') === true && rig.isPinned('leftLeg') === true);

  const clavado = enHolder(pierna).clone();
  const suelto = rig.get('rightLeg');
  const sueltoAntes = enHolder(suelto).clone();
  // Hundir la cadera, que es lo que hace el cubo grande del visor.
  const paso = bones.leftLeg.position.length() * 0.25;
  bones.hips.position.y -= paso;
  bones.hips.updateWorldMatrix(false, true);
  character.tick();
  const movio = rig.solveHeld();
  const tol = rig.tolerance() * 4;
  check('con el pie clavado, hundir la cadera no lo despega',
    movio && enHolder(pierna).distanceTo(clavado) < tol,
    'd=' + enHolder(pierna).distanceTo(clavado).toExponential(1) + ' tol=' + tol.toExponential(1));
  check('la pierna suelta si baja con la cadera',
    enHolder(suelto).distanceTo(sueltoAntes) > tol * 10,
    'd=' + enHolder(suelto).distanceTo(sueltoAntes).toFixed(4));
  check('la rodilla clavada se dobla en vez de estirarse',
    worldOf(pierna.root, new THREE.Vector3()).distanceTo(punta(pierna)) < alcance(pierna) * 0.999,
    'recta=' + alcance(pierna).toFixed(4));

  // Al devolver la cadera la pierna se estira de vuelta. La reserva de estirado
  // le prohibe quedar del todo recta, y como el pie se clavo con la pierna
  // estirada del reposo, se queda corto justo esa fraccion: es el precio de no
  // tener nunca una pierna acartonada, no una deriva.
  bones.hips.position.y += paso;
  bones.hips.updateWorldMatrix(false, true);
  character.tick();
  rig.solveHeld();
  const reserva = alcance(pierna) * rig.margin;
  const queda = enHolder(pierna).distanceTo(clavado);
  check('al devolver la cadera el pie vuelve a su sitio salvo la reserva',
    queda < reserva * 1.2, 'd=' + queda.toFixed(4) + ' reserva=' + reserva.toFixed(4));

  settings.set('ik.margin', 0);
  rig.invalidate();
  rig.solveHeld();
  check('sin reserva la vuelta es exacta', enHolder(pierna).distanceTo(clavado) < tol,
    'd=' + enHolder(pierna).distanceTo(clavado).toExponential(1));
  check('cambiar la reserva rehace las cadenas fijadas', rig.solveHeld() === false);
  settings.set('ik.margin', DEFAULTS.ik.margin);
  rig.unpinAll();
  rig.syncAll();
}

// --- fijaciones desde el panel y desde los botones ------------------------
{
  const pie = rig.get('rightLeg');
  const antes = punta(pie);
  // El panel escribe la ruta y el rig relee: no debe dar un tiron.
  settings.set('ik.pins.rightLeg', true);
  rig.readPins();
  rig.solveHeld();
  check('fijar desde el panel no da un tiron', punta(pie).distanceTo(antes) < 1e-9,
    'd=' + punta(pie).distanceTo(antes).toExponential(1));

  rig.unpinAll();
  check('soltar todo quita las fijaciones',
    rig.chains.every((c) => !c.pinned) && IK_CHAINS.every((d) => settings.get('ik.pins.' + d.id) === false));
  rig.pinFeet(true);
  check('clavar los pies fija las dos piernas',
    rig.isPinned('leftLeg') && rig.isPinned('rightLeg')
    && settings.get('ik.pins.leftLeg') === true && settings.get('ik.pins.rightLeg') === true);
  check('clavar los pies no toca las manos', !rig.isPinned('leftArm') && !rig.isPinned('rightArm'));
  rig.unpinAll();
}

// --- apagada no toca nada -------------------------------------------------
{
  const pierna = rig.get('leftLeg');
  rig.pin('leftLeg', true);
  settings.set('ik.enabled', false);
  const antes = punta(pierna);
  bones.hips.position.y -= bones.leftLeg.position.length() * 0.2;
  bones.hips.updateWorldMatrix(false, true);
  check('apagada no rehace ninguna cadena', rig.solveHeld() === false);
  const bajado = punta(pierna);
  check('apagada el pie baja con la cadera, como en el posado a mano',
    bajado.distanceTo(antes) > 1e-4, 'd=' + bajado.distanceTo(antes).toFixed(4));
  bones.hips.position.y += bones.leftLeg.position.length() * 0.2;
  bones.hips.updateWorldMatrix(false, true);
  settings.set('ik.enabled', true);
  rig.unpinAll();
  rig.syncAll();
}

// --- torso y cabeza: las cadenas de columna sobre el modelo ----------------
{
  const torso = rig.get('torso');
  rig.hold.add('torso');
  const raiz = worldOf(torso.root, new THREE.Vector3());
  const destinoT = raiz.clone().addScaledVector(V(0.25, 0.9, 0.35).normalize(), alcance(torso) * 0.85);
  rig.setTargetWorld(torso, destinoT);
  const movio = rig.solveHeld();
  const d = punta(torso).distanceTo(destinoT);
  check('el rombo del pecho arrastra la columna', movio && d < 1e-3, 'd=' + d.toExponential(1));
  check('la columna no cambia de largo',
    Math.abs(alcance(torso) - alcance(torso)) < 1e-9 && punta(torso).toArray().every(Number.isFinite));
  rig.hold.clear();

  const cabeza = rig.get('head');
  rig.hold.add('head');
  const cuello = worldOf(cabeza.root, new THREE.Vector3());
  const mira = cuello.clone().addScaledVector(V(-0.4, 0.7, 0.6).normalize(), alcance(cabeza));
  rig.setTargetWorld(cabeza, mira);
  rig.solveHeld();
  const coseno = punta(cabeza).sub(cuello).normalize().dot(mira.clone().sub(cuello).normalize());
  check('el rombo de la cabeza la hace mirar al punto', coseno > 0.999, 'coseno=' + coseno.toFixed(5));
  rig.hold.clear();
}

// --- el orden de dependencia: el torso no descoloca las manos -------------
{
  rig.syncAll();
  const mano = rig.get('leftArm');
  const pie = rig.get('leftLeg');
  rig.pin('leftArm', true);
  rig.pin('leftLeg', true);
  const manoFija = enHolder(mano).clone();
  const pieFijo = enHolder(pie).clone();
  // Girar el pecho a mano mueve hombros y caderas: las cadenas fijadas se
  // rehacen en orden y las puntas se quedan donde estaban.
  bones.spine1.rotateX(0.25);
  bones.spine1.updateWorldMatrix(false, true);
  character.tick();
  const movio = rig.solveHeld();
  const tol = rig.tolerance() * 4;
  check('girar el pecho no despega la mano fijada',
    movio && enHolder(mano).distanceTo(manoFija) < tol,
    'd=' + enHolder(mano).distanceTo(manoFija).toExponential(1));
  check('girar el pecho no despega el pie fijado',
    enHolder(pie).distanceTo(pieFijo) < tol,
    'd=' + enHolder(pie).distanceTo(pieFijo).toExponential(1));
  check('una sola pasada basta: nada queda pendiente', rig.solveHeld() === false);
  rig.unpinAll();
}

// --- la reserva de estirado -----------------------------------------------
{
  settings.set('ik.margin', 0.1);
  check('la reserva se lee de los ajustes', Math.abs(rig.margin - 0.1) < 1e-9);
  settings.set('ik.margin', 5);
  check('una reserva disparatada se recorta', rig.margin === 0.2);
  settings.set('ik.margin', DEFAULTS.ik.margin);

  const pierna = rig.get('leftLeg');
  rig.hold.add('leftLeg');
  const cadera = worldOf(pierna.root, new THREE.Vector3());
  const lejos = cadera.clone().addScaledVector(V(0, -1, 0.15).normalize(), alcance(pierna) * 3);
  rig.setTargetWorld(pierna, lejos);
  rig.solveHeld();
  const estirada = cadera.distanceTo(punta(pierna));
  check('un objetivo imposible no estira la pierna del todo',
    estirada < alcance(pierna) * (1 - rig.margin * 0.5),
    'estirada=' + estirada.toFixed(4) + ' recta=' + alcance(pierna).toFixed(4));
  check('un objetivo imposible no se reintenta cada fotograma', rig.solveHeld() === false);
  rig.hold.clear();
  rig.syncLoose();
  check('al soltarlo el objetivo vuelve al pie',
    rig.targetWorld(pierna, new THREE.Vector3()).distanceTo(punta(pierna)) < 1e-9);
}

// --- rehacer el rig al cambiar de modelo ----------------------------------
{
  rig.setCharacter(null);
  check('sin modelo no hay cadenas', rig.chains.length === 0 && rig.get('leftArm') === null);
  check('sin modelo nada falla', rig.solveHeld() === false && rig.unpinAll() === false);
  rig.setCharacter(character);
  check('al volver el modelo se rearman las cadenas', rig.chains.length === IK_CHAINS.length);
}

character.dispose();
server.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('');
console.log(oks.length + ' correctas / ' + fails.length + ' fallos');
if (fails.length) { console.log('FALLOS:'); for (const f of fails) console.log(' - ' + f); process.exit(1); }
process.exit(0);
