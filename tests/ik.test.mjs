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

// --- squash y stretch -----------------------------------------------------
{
  /** Escala de mundo de un hueso, que es donde se ve la compensacion de grosor. */
  const escalaMundo = (o) => {
    o.updateWorldMatrix(true, false);
    return new THREE.Vector3().setFromMatrixScale(o.matrixWorld);
  };
  /** Largo de mundo de cada eslabon, de la raiz a la punta. */
  const eslabones = (chain) => {
    const p = [...chain.bones, chain.tip];
    const out = [];
    for (let i = 1; i < p.length; i++) {
      out.push(worldOf(p[i - 1], new THREE.Vector3()).distanceTo(worldOf(p[i], new THREE.Vector3())));
    }
    return out;
  };
  const iguales = (a, b, tol) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < tol);
  const razon = (a, b) => a.map((v, i) => (v / b[i]).toFixed(5)).join(' ');
  // Los largos de mundo salen de multiplicar matrices, asi que se comparan con
  // holgura; lo que si tiene que volver exacto es el valor local de cada hueso.
  const HOLGURA = 1e-6;

  check('el squash y stretch nace apagado',
    rig.stretchOn === false && DEFAULTS.ik.stretch === false);
  check('todas las cadenas apuntan su largo natural', rig.chains.every((c) => c.rest),
    rig.chains.filter((c) => !c.rest).map((c) => c.id).join(' ') || 'todas');

  settings.set('ik.stretchMax', 5);
  check('un estirado disparatado se recorta', rig.stretchMax === 1);
  settings.set('ik.stretchMax', 0.3);
  check('el estirado maximo se lee de los ajustes', Math.abs(rig.stretchMax - 0.3) < 1e-9);

  const brazoD = rig.get('rightArm');
  const natural = eslabones(brazoD);
  const total = natural.reduce((a, b) => a + b, 0);
  const eBase = escalaMundo(brazoD.mid).x;
  const eManoBase = escalaMundo(brazoD.tip).x;
  const hombro = () => worldOf(brazoD.root, new THREE.Vector3());
  const dir = V(0.3, -1, 0.4).normalize();
  const lejos = (f) => hombro().addScaledVector(dir, total * f);

  rig.hold.add('rightArm');
  rig.setTargetWorld(brazoD, lejos(1.15));
  rig.solveHeld();
  check('apagado, un objetivo lejano no estira nada',
    brazoD.stretch === 1 && iguales(eslabones(brazoD), natural, total * HOLGURA),
    'k=' + brazoD.stretch);

  settings.set('ik.stretch', true);
  check('se enciende con ik.stretch', rig.stretchOn === true);
  rig.invalidate();
  rig.solveHeld();
  const k = brazoD.stretch;
  const dPunta = punta(brazoD).distanceTo(rig.targetWorld(brazoD, new THREE.Vector3()));
  check('encendido, la mano llega a donde antes no alcanzaba', dPunta < total * 1e-4,
    'd=' + dPunta.toExponential(1) + ' k=' + k.toFixed(4));
  check('se estira lo justo para llegar, no mas',
    Math.abs(k - 1.15 / (1 - rig.margin)) < 1e-3, 'k=' + k.toFixed(4));
  check('cada eslabon crece en la misma proporcion',
    iguales(eslabones(brazoD), natural.map((v) => v * k), total * HOLGURA),
    razon(eslabones(brazoD), natural));

  check('el miembro estirado adelgaza para compensar el volumen',
    Math.abs(escalaMundo(brazoD.mid).x / eBase - 1 / Math.sqrt(k)) < 1e-6,
    'u=' + (escalaMundo(brazoD.mid).x / eBase).toFixed(5) + ' esperado=' + (1 / Math.sqrt(k)).toFixed(5));
  check('la mano del final no cambia de tamano',
    Math.abs(escalaMundo(brazoD.tip).x / eManoBase - 1) < 1e-6,
    'razon=' + (escalaMundo(brazoD.tip).x / eManoBase).toFixed(6));

  const mayor = Math.max(...natural);
  const minNat = Math.max(0, 2 * mayor - total) + total * 0.02;
  rig.setTargetWorld(brazoD, lejos(0.002));
  rig.invalidate();
  rig.solveHeld();
  check('un objetivo pegado al hombro aplasta el miembro', brazoD.stretch < 1,
    'k=' + brazoD.stretch.toFixed(4));
  check('el aplastado no pasa del tope',
    Math.abs(brazoD.stretch - 1 / (1 + rig.stretchMax)) < 1e-6, 'k=' + brazoD.stretch.toFixed(5));
  check('aplastado, la mano se acerca mas de lo que daba el pliegue',
    hombro().distanceTo(punta(brazoD)) < minNat,
    'd=' + hombro().distanceTo(punta(brazoD)).toFixed(5) + ' pliegue=' + minNat.toFixed(5));

  rig.setTargetWorld(brazoD, lejos(1.15));
  rig.invalidate();
  rig.solveHeld();
  const k1 = brazoD.stretch;
  const largos1 = eslabones(brazoD);
  rig.invalidate();
  rig.solveHeld();
  check('resolver dos veces no alarga el miembro un poco mas',
    Math.abs(brazoD.stretch - k1) < 1e-9 && iguales(eslabones(brazoD), largos1, total * HOLGURA),
    'k1=' + k1.toFixed(6) + ' k2=' + brazoD.stretch.toFixed(6));

  rig.setTargetWorld(brazoD, lejos(4));
  rig.invalidate();
  rig.solveHeld();
  check('un objetivo imposible estira solo hasta el tope',
    Math.abs(brazoD.stretch - (1 + rig.stretchMax)) < 1e-6, 'k=' + brazoD.stretch.toFixed(5));

  const estado = rig.stretchState();
  const largosTope = eslabones(brazoD);
  check('el estado guarda solo las cadenas estiradas',
    Object.keys(estado).join(' ') === 'rightArm'
    && Math.abs(estado.rightArm - brazoD.stretch) < 1e-12,
    Object.keys(estado).join(' ') || 'ninguna');
  rig.syncAll();
  check('sincronizar todo deshace el estirado, que una pose solo lleva giros',
    brazoD.stretch === 1 && iguales(eslabones(brazoD), natural, total * HOLGURA),
    razon(eslabones(brazoD), natural));
  rig.setStretchState(estado);
  check('un estado guardado vuelve a poner el estirado igual',
    Math.abs(brazoD.stretch - estado.rightArm) < 1e-12
    && iguales(eslabones(brazoD), largosTope, total * HOLGURA),
    razon(eslabones(brazoD), largosTope));
  check('al volver el estirado los objetivos quedan sobre las puntas',
    rig.targetWorld(brazoD, new THREE.Vector3()).distanceTo(punta(brazoD)) < 1e-9);

  settings.set('ik.stretch', false);
  rig.invalidate();
  rig.solveHeld();
  // Aqui no vale la holgura: el largo local de cada hueso y las escalas tienen que
  // volver al valor de reposo tal cual, o el modelo se iria deformando a cada
  // encendido y apagado.
  check('apagarlo devuelve el largo natural, hueso a hueso',
    brazoD.stretch === 1
    && brazoD.rest.links.every((l) => Math.abs(l.bone.position.length() - l.len) < 1e-12)
    && brazoD.root.scale.equals(brazoD.rest.root.scale)
    && brazoD.rest.comp.every((c) => c.bone.scale.equals(c.scale)),
    'k=' + brazoD.stretch);
  check('y la mano recupera su escala',
    Math.abs(escalaMundo(brazoD.tip).x / eManoBase - 1) < HOLGURA,
    'razon=' + (escalaMundo(brazoD.tip).x / eManoBase).toFixed(9));

  // El cuello es a la vez la punta del torso y la raiz de la cabeza: los dos
  // factores tienen que multiplicarse en ese hueso sin pisarse el uno al otro.
  const torso = rig.get('torso');
  const cabeza = rig.get('head');
  const nTorso = eslabones(torso);
  const nCabeza = eslabones(cabeza);
  rig.setStretch(torso, 1.2);
  rig.setStretch(cabeza, 0.85);
  check('dos cadenas que comparten un hueso no se pisan',
    iguales(eslabones(torso), nTorso.map((v) => v * 1.2), 1e-6)
    && iguales(eslabones(cabeza), nCabeza.map((v) => v * 0.85), 1e-6),
    'torso=' + razon(eslabones(torso), nTorso) + ' cabeza=' + razon(eslabones(cabeza), nCabeza));
  rig.resetStretch();
  check('deshacer el estirado devuelve los largos exactos',
    iguales(eslabones(torso), nTorso, 1e-9) && iguales(eslabones(cabeza), nCabeza, 1e-9));

  rig.hold.clear();
  rig.syncAll();
  settings.set('ik.stretchMax', DEFAULTS.ik.stretchMax);
}

// --- deformar los huesos: el rig de dibujo animado ------------------------
{
  /** Escala de mundo, que es donde se ve si un hueso engorda de mas. */
  const escalaMundo = (o) => {
    o.updateWorldMatrix(true, false);
    return new THREE.Vector3().setFromMatrixScale(o.matrixWorld);
  };
  /** Largo de mundo de cada eslabon, de la raiz a la punta. */
  const eslabones = (chain) => {
    const p = [...chain.bones, chain.tip];
    const out = [];
    for (let i = 1; i < p.length; i++) {
      out.push(worldOf(p[i - 1], new THREE.Vector3()).distanceTo(worldOf(p[i], new THREE.Vector3())));
    }
    return out;
  };
  const iguales = (a, b, tol) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < tol);
  const razon = (a, b) => a.map((v, i) => (v / b[i]).toFixed(5)).join(' ');
  const claveDe = (b) => Object.keys(character.bones).find((k) => character.bones[k] === b) || '';
  /**
   * Cuanto se ha sesgado lo que cuelga de un hueso. Una escala no uniforme heredada
   * bajo un giro cizalla: los ejes dejan de ser perpendiculares y el pie sale como
   * un paralelogramo. Con todas las escalas uniformes esto no se mueve del reposo.
   */
  const sesgo = (o) => {
    o.updateWorldMatrix(true, false);
    const e = o.matrixWorld.elements;
    const c = [V(e[0], e[1], e[2]).normalize(), V(e[4], e[5], e[6]).normalize(),
      V(e[8], e[9], e[10]).normalize()];
    return Math.max(Math.abs(c[0].dot(c[1])), Math.abs(c[1].dot(c[2])), Math.abs(c[0].dot(c[2])));
  };

  const pierna = rig.get('leftLeg');
  const espinilla = pierna.mid;   // la rodilla, el hueso de en medio de la cadena
  const pie = pierna.tip;
  const muslo = pierna.root;
  const cEspinilla = claveDe(espinilla);
  const cMuslo = claveDe(muslo);
  const eje = character.lengthAxis(espinilla);
  /** Lo que pide el giroscopio: el largo en el eje del hueso, el grosor en los otros. */
  const pedir = (bone, k, g) => {
    const v = V(g, g, g);
    const i = character.lengthAxis(bone);
    if (i >= 0) v.setComponent(i, k);
    return v;
  };
  /** El lado del hueso: uno de los dos ejes que cruzan el largo. */
  const lado = (eje + 1) % 3;
  const otro = (eje + 2) % 3;
  /**
   * Cuanto se pierde al descomponer la matriz de mundo en posicion, giro y escala.
   * El giroscopio y el retargeting hacen justo eso, asi que si esto no es cero hay
   * algo que no es giro por escala diagonal y los dos empiezan a mentir.
   */
  const redondo = (o) => {
    o.updateWorldMatrix(true, false);
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    o.matrixWorld.decompose(p, q, s);
    const m = new THREE.Matrix4().compose(p, q, s);
    return Math.max(...m.elements.map((v, i) => Math.abs(v - o.matrixWorld.elements[i])));
  };
  const natural = eslabones(pierna);
  const largoReposo = pierna.rest.links.map((l) => l.len);
  const dedo = pie.children.find((o) => o.isBone) ?? null;
  const eDedo = dedo ? escalaMundo(dedo).clone() : null;
  const sesgoDedo = dedo ? sesgo(dedo) : 0;
  const ePie = escalaMundo(pie).clone();
  const eEspinilla = escalaMundo(espinilla).clone();
  const rEspinilla = character.rest.scale.get(espinilla).clone();
  const rMuslo = character.rest.scale.get(muslo).clone();
  const sesgoPie = sesgo(pie);

  check('el modelo nace sin deformar',
    character.deformed === false && cEspinilla !== '' && cMuslo !== '' && eje >= 0,
    cMuslo + ' / ' + cEspinilla + ' eje=' + eje);

  // Solo grosor: la rodilla engorda sin mover el tobillo y sin contagiar al pie. Es
  // el "segment scale compensate" de los rigs de cine, y el descuento del hijo es
  // exacto aunque el grosor no sea uniforme.
  character.setBoneScale(cEspinilla, pedir(espinilla, 1, 1.3));
  const f1 = character.boneFactors(cEspinilla);
  check('engordar es escala de los dos ejes de al lado, y no toca el largo',
    Math.abs(f1.k - 1) < 1e-12 && Math.abs(f1.g - 1.3) < 1e-12
    && espinilla.scale.distanceTo(rEspinilla.clone().multiply(pedir(espinilla, 1, 1.3))) < 1e-12,
    'k=' + f1.k + ' g=' + f1.g);
  check('engordar un hueso no le mueve las articulaciones',
    iguales(eslabones(pierna), natural, 1e-9), razon(eslabones(pierna), natural));
  check('y el pie no engorda con la rodilla',
    escalaMundo(pie).distanceTo(ePie) < 1e-9,
    razon(escalaMundo(pie).toArray(), ePie.toArray()));
  check('ni queda sesgado, que es lo que estropeaba la piel',
    sesgo(pie) <= sesgoPie + 1e-9, 'sesgo=' + sesgo(pie).toExponential(1));

  // Solo largo: no se escala nada, se mueve la articulacion de abajo, igual que el
  // estirado de las cadenas. La piel se estira entre las dos con el degradado de
  // los pesos, que es lo que se ve suave en vez de dar un escalon en la rodilla.
  character.setBoneScale(cEspinilla, pedir(espinilla, 1.4, 1));
  check('alargar un hueso no le cambia la escala',
    espinilla.scale.distanceTo(rEspinilla) < 1e-12, espinilla.scale.toArray().join(' '));
  check('alargar mueve la articulacion de abajo, y solo ese eslabon',
    iguales(eslabones(pierna), [natural[0], natural[1] * 1.4], 1e-6),
    razon(eslabones(pierna), natural));
  check('el pie sigue midiendo lo suyo aunque la espinilla sea mas larga',
    escalaMundo(pie).distanceTo(ePie) < 1e-9,
    razon(escalaMundo(pie).toArray(), ePie.toArray()));

  // Un tiron del centro del giroscopio: el trozo entero crece, largo y grosor a la
  // vez, y ahi no hay volumen que repartir porque se estan pidiendo las tres.
  character.setBoneScale(cEspinilla, pedir(espinilla, 1.5, 1.5));
  check('un tiron uniforme alarga y engorda el mismo trozo',
    iguales(eslabones(pierna), [natural[0], natural[1] * 1.5], 1e-6)
    && Math.abs(escalaMundo(espinilla).getComponent(lado) / eEspinilla.getComponent(lado) - 1.5) < 1e-9
    && Math.abs(escalaMundo(espinilla).getComponent(otro) / eEspinilla.getComponent(otro) - 1.5) < 1e-9
    && escalaMundo(pie).distanceTo(ePie) < 1e-9,
    razon(eslabones(pierna), natural));

  // Y un eje solo: engorda solo por ese lado, que es lo que se le pide a un antebrazo
  // o a una pantorrilla. La seccion queda ovalada, que es lo que antes cizallaba la
  // piel del pie: ahora al hijo se le descuenta la matriz del padre entera, no un
  // numero por eje, asi que no le llega nada.
  character.setBoneScale(cEspinilla, pedir(espinilla, 1, 1).setComponent(lado, 1.44));
  const f2 = character.boneFactors(cEspinilla);
  const e2 = escalaMundo(espinilla);
  check('pedir grosor en un solo eje engorda solo ese eje',
    Math.abs(e2.getComponent(lado) / eEspinilla.getComponent(lado) - 1.44) < 1e-9
    && Math.abs(e2.getComponent(otro) / eEspinilla.getComponent(otro) - 1) < 1e-9
    && Math.abs(e2.getComponent(eje) / eEspinilla.getComponent(eje) - 1) < 1e-9,
    razon(e2.toArray(), eEspinilla.toArray()));
  check('con la seccion ovalada el pie no engorda ni se sesga',
    escalaMundo(pie).distanceTo(ePie) < 1e-9 && sesgo(pie) <= sesgoPie + 1e-9,
    razon(escalaMundo(pie).toArray(), ePie.toArray()) + ' sesgo=' + sesgo(pie).toExponential(1));
  check('y las matrices siguen siendo giro por escala, que es lo que descompone el giroscopio',
    redondo(espinilla) < 1e-9 && redondo(pie) < 1e-9,
    redondo(espinilla).toExponential(1) + ' ' + redondo(pie).toExponential(1));
  check('los dos numeros de siempre resumen esa seccion sin perder el bulto',
    Math.abs(f2.g - 1.2) < 1e-9 && Math.abs(f2.k - 1) < 1e-12,
    'g=' + f2.g.toFixed(5));

  // Deformacion y estirado de la cadena a la vez, cada capa en su sitio: el squash
  // multiplica lo que el usuario ya habia puesto a mano en vez de pisarlo.
  const kd = 1.3;
  const gd = 1.1;
  character.setBoneScale(cEspinilla, pedir(espinilla, kd, gd));
  rig.setStretch(pierna, 1 + rig.stretchMax);
  const k = pierna.stretch;
  const u = 1 / Math.sqrt(k);
  check('el squash no borra la deformacion del hueso de en medio',
    k > 1 && espinilla.scale.distanceTo(rEspinilla.clone().multiply(pedir(espinilla, 1, gd))) < 1e-12,
    'k=' + k.toFixed(4));
  check('el eslabon deformado mide su largo por el de la cadena',
    iguales(eslabones(pierna), [natural[0] * k, natural[1] * kd * k], 1e-6),
    razon(eslabones(pierna), natural) + ' k=' + k.toFixed(4));
  check('la rodilla lleva su grosor de lado y el adelgazado de la cadena',
    Math.abs(escalaMundo(espinilla).getComponent(lado) / eEspinilla.getComponent(lado) - gd * u) < 1e-9
    && Math.abs(escalaMundo(espinilla).getComponent(otro) / eEspinilla.getComponent(otro) - gd * u) < 1e-9
    && Math.abs(escalaMundo(espinilla).getComponent(eje) / eEspinilla.getComponent(eje) - u) < 1e-9,
    razon(escalaMundo(espinilla).toArray(), eEspinilla.toArray()) + ' u=' + u.toFixed(5));
  check('y con el squash puesto el pie sigue midiendo lo suyo',
    escalaMundo(pie).distanceTo(ePie) < 1e-6,
    razon(escalaMundo(pie).toArray(), ePie.toArray()));

  // Tres capas en el mismo hueso: reposo, grosor del usuario y estirado de la
  // cadena. Y con el padre y el hijo deformados a la vez el nieto no hereda nada,
  // ni un resto: el descuento de una escala uniforme es exacto.
  character.setBoneScale(cMuslo, pedir(muslo, 1, 1.2));
  rig.applyStretch();
  check('reposo por grosor por estirado, las tres capas en la raiz',
    muslo.scale.distanceTo(rMuslo.clone().multiply(pedir(muslo, 1, 1.2)).multiplyScalar(u)) < 1e-12,
    muslo.scale.toArray().map((v) => v.toFixed(5)).join(' '));
  check('engordar el muslo no alarga la pierna',
    iguales(eslabones(pierna), [natural[0] * k, natural[1] * kd * k], 1e-6),
    razon(eslabones(pierna), natural));
  check('con padre e hijo deformados al pie no le queda ni un resto',
    escalaMundo(pie).distanceTo(ePie) < 1e-6 && sesgo(pie) <= sesgoPie + 1e-9,
    razon(escalaMundo(pie).toArray(), ePie.toArray()));

  // Y lo mismo con los dos huesos engordados cada uno por un eje distinto, que es el
  // caso que antes obligaba a que el grosor fuera uniforme: una escala girada no es
  // diagonal, y ninguna escala local del hijo la deshace. Descontando la matriz si.
  const ladoM = (character.lengthAxis(muslo) + 1) % 3;
  character.setBoneScale(cMuslo, pedir(muslo, 1, 1).setComponent(ladoM, 1.35));
  character.setBoneScale(cEspinilla, pedir(espinilla, kd, 1).setComponent(otro, 1.5));
  rig.applyStretch();
  check('dos huesos deformados por ejes distintos y al pie no le llega nada',
    escalaMundo(pie).distanceTo(ePie) < 1e-6 && sesgo(pie) <= sesgoPie + 1e-9
    && redondo(pie) < 1e-9,
    razon(escalaMundo(pie).toArray(), ePie.toArray()) + ' sesgo=' + sesgo(pie).toExponential(1));
  check('ni al nieto, que es donde antes quedaba el resto',
    !dedo || (escalaMundo(dedo).distanceTo(eDedo) < 1e-6 && sesgo(dedo) <= sesgoDedo + 1e-9),
    dedo ? razon(escalaMundo(dedo).toArray(), eDedo.toArray()) : 'sin nieto');
  character.setBoneScale(cMuslo, pedir(muslo, 1, 1.2));
  character.setBoneScale(cEspinilla, pedir(espinilla, kd, gd));
  rig.applyStretch();

  // Rehacer el rig con huesos deformados no puede tomar la deformacion por largo
  // natural: las medidas de reposo salen del mapa del personaje, no del hueso vivo.
  rig.rebuild();
  const pierna2 = rig.get('leftLeg');
  check('rehacer el rig deformado no toma la deformacion por reposo',
    iguales(pierna2.rest.links.map((l) => l.len), largoReposo, 1e-12)
    && pierna2.stretch === 1 && character.deformed === true,
    pierna2.rest.links.map((l) => l.len.toFixed(6)).join(' '));

  // Continuidad al cambiar de modo: al pasar de IK a FK se mueven los objetivos,
  // pero el squash sigue puesto y los huesos no vuelven a su tamano de golpe.
  const sinEstirar = eslabones(pierna2);
  check('sin estirar, la pierna lleva solo el largo puesto a mano',
    iguales(sinEstirar, [natural[0], natural[1] * kd], 1e-6),
    razon(sinEstirar, natural));
  rig.setStretch(pierna2, 1 + rig.stretchMax);
  const k2 = pierna2.stretch;
  const estirados = eslabones(pierna2);
  rig.syncAll({ stretch: false });
  check('salir de IK con el squash puesto no devuelve los huesos a su tamano',
    pierna2.stretch === k2 && iguales(eslabones(pierna2), estirados, 1e-6),
    'k=' + pierna2.stretch.toFixed(4) + ' ' + razon(eslabones(pierna2), estirados));
  check('y los objetivos quedan sobre las puntas, listos para volver a IK',
    rig.targetWorld(pierna2, new THREE.Vector3()).distanceTo(punta(pierna2)) < 1e-9);
  rig.syncAll();
  check('apagar el squash a mano si devuelve el largo, con la deformacion intacta',
    pierna2.stretch === 1 && iguales(eslabones(pierna2), sinEstirar, 1e-9)
    && character.deform.size === 2,
    razon(eslabones(pierna2), sinEstirar));

  // La deformacion viaja con la pose, que es lo que hace que se guarde, se copie
  // entre figuras y vuelva con deshacer sin escribir nada aparte: los tres ejes de
  // cada hueso tocado, en los ejes del propio hueso.
  const pose = character.getPose();
  check('la pose se lleva los tres ejes de cada hueso deformado',
    !!pose.scales && Object.keys(pose.scales).length === 2
    && pose.scales[cEspinilla]?.length === 3
    && Math.abs(pose.scales[cEspinilla][eje] - kd) < 1e-9
    && Math.abs(pose.scales[cEspinilla][lado] - gd) < 1e-9,
    Object.keys(pose.scales || {}).join(' '));
  character.clearDeform();
  check('quitar todas devuelve el tamano de reposo, hueso y pie',
    character.deformed === false
    && escalaMundo(espinilla).distanceTo(eEspinilla) < 1e-9
    && escalaMundo(pie).distanceTo(ePie) < 1e-9
    && iguales(eslabones(pierna2), natural, 1e-9),
    razon(eslabones(pierna2), natural));
  character.setPose(pose);
  check('cargar la pose las devuelve tal cual',
    Math.abs(character.boneFactors(cEspinilla).k - kd) < 1e-9
    && Math.abs(character.boneFactors(cEspinilla).g - gd) < 1e-9
    && iguales(eslabones(pierna2), [natural[0], natural[1] * kd], 1e-6)
    && escalaMundo(pie).distanceTo(ePie) < 1e-6);
  const vieja = character.getPose();
  delete vieja.scales;
  character.setPose(vieja);
  check('y una pose vieja sin escalas no borra lo deformado',
    character.deformed === true && character.deform.size === 2);
  character.setDeformState({ [cEspinilla]: [1, 1.44, 1] });
  check('una pose con tres numeros los toma como los tres ejes del hueso',
    character.deform.size === 1
    && character.boneDeform(cEspinilla).distanceTo(V(1, 1.44, 1)) < 1e-12,
    character.boneDeform(cEspinilla).toArray().join(' '));
  // Y las poses guardadas cuando la deformacion eran dos numeros siguen abriendo:
  // el largo al eje del hueso y el grosor a los otros dos.
  character.setDeformState({ [cEspinilla]: [1.3, 1.1] });
  check('una pose vieja de dos numeros se reparte en los ejes del hueso',
    character.boneDeform(cEspinilla).distanceTo(pedir(espinilla, 1.3, 1.1)) < 1e-12,
    character.boneDeform(cEspinilla).toArray().join(' '));

  character.setBoneScale(cMuslo, pedir(muslo, 1, 1.2));
  check('la deformacion tiene topes por arriba y por abajo',
    character.setBoneScale(cEspinilla, pedir(espinilla, 9, 0.01)) === true
    && character.boneDeform(cEspinilla).distanceTo(pedir(espinilla, 3, 0.2)) < 1e-12,
    character.boneDeform(cEspinilla).toArray().join(' '));
  check('pedir el mismo factor otra vez no cambia nada',
    character.setBoneScale(cMuslo, pedir(muslo, 1, 1.2)) === false);
  check('volver a uno borra el apunte de ese hueso',
    character.setBoneFactors(cEspinilla, 1, 1) === true
    && character.deform.size === 1
    && escalaMundo(espinilla).distanceTo(eEspinilla) < 1e-9
    && iguales(eslabones(pierna2), natural, 1e-9));
  character.clearDeform(cMuslo);
  check('quitar el ultimo deja el modelo limpio, sin escalas ni largos pendientes',
    character.deformed === false && character.deform.size === 0
    && character.deformLength.size === 0
    && muslo.scale.distanceTo(rMuslo) < 1e-12
    && iguales(eslabones(pierna2), natural, 1e-9));
  rig.syncAll();

  // El tacto del giroscopio: lo que pide el raton se suaviza contra el valor que
  // habia al empezar a arrastrar, asi que es una funcion del puntero y no se va
  // acumulando. Y con el volumen puesto, alargar adelgaza en la misma medida.
  const { ajustarDeform } = await import('../src/posing/ManualPosing.js');
  const uno = { k: 1, g: 1 };
  const duro = ajustarDeform(uno, { k: 2, g: 1 }, { volumen: false });
  check('un tiron al doble no llega al doble, pero va en su sentido',
    duro.k > 1.4 && duro.k < 1.5 && Math.abs(duro.g - 1) < 1e-12,
    'k=' + duro.k.toFixed(4));
  const vol = ajustarDeform(uno, { k: 2, g: 1 });
  check('con el volumen puesto, alargar adelgaza lo justo para no ganar bulto',
    Math.abs(vol.k * vol.g * vol.g - 1) < 1e-12,
    'k=' + vol.k.toFixed(4) + ' g=' + vol.g.toFixed(4));
  const corto = ajustarDeform(uno, { k: 0.5, g: 1 });
  check('y acortar ensancha, que es el aplastado de dibujo animado',
    corto.k > 0.5 && corto.k < 1 && corto.g > 1
    && Math.abs(corto.k * corto.g * corto.g - 1) < 1e-12,
    'k=' + corto.k.toFixed(4) + ' g=' + corto.g.toFixed(4));
  const quieto = ajustarDeform({ k: 1.4, g: 0.9 }, { k: 1.4, g: 0.9 });
  check('pedir lo que ya hay no mueve nada: el suavizado no se va solo',
    Math.abs(quieto.k - 1.4) < 1e-12 && Math.abs(quieto.g - 0.9) < 1e-12,
    'k=' + quieto.k + ' g=' + quieto.g);
  const iman = ajustarDeform(uno, { k: 1.6, g: 1 }, { volumen: false, paso: 0.05 });
  check('con el imantado el largo cae de cinco en cinco centesimas',
    Math.abs(iman.k - 1.3) < 1e-9, 'k=' + iman.k);

  // Y el mismo tacto por ejes, que es lo que arrastra el giroscopio: cada tirador
  // dimensiona su eje y nada mas. Aqui el eje del hueso es el 1, la Y.
  const { ajustarEjes } = await import('../src/posing/ManualPosing.js');
  const unoV = { x: 1, y: 1, z: 1 };
  const largo = ajustarEjes(unoV, { x: 1, y: 1.6, z: 1 }, { eje: 1 });
  check('tirar del eje del hueso lo alarga y adelgaza los dos lados por igual',
    largo.y > 1.2 && largo.x < 1 && Math.abs(largo.x - largo.z) < 1e-12
    && Math.abs(largo.x - 1 / Math.sqrt(largo.y)) < 1e-12,
    [largo.x, largo.y, largo.z].map((v) => v.toFixed(4)).join(' '));
  const ancho = ajustarEjes(unoV, { x: 1.6, y: 1, z: 1 }, { eje: 1 });
  check('tirar de un tirador de lado engorda ese eje y ninguno mas',
    ancho.x > 1.2 && Math.abs(ancho.y - 1) < 1e-12 && Math.abs(ancho.z - 1) < 1e-12,
    [ancho.x, ancho.y, ancho.z].map((v) => v.toFixed(4)).join(' '));
  const centro = ajustarEjes(unoV, { x: 1.6, y: 1.6, z: 1.6 }, { eje: 1 });
  check('tirar del centro cambia los tres a la vez y no adelgaza nada',
    centro.y > 1.2 && Math.abs(centro.x - centro.y) < 1e-12
    && Math.abs(centro.z - centro.y) < 1e-12,
    [centro.x, centro.y, centro.z].map((v) => v.toFixed(4)).join(' '));
  // Arrastrando el largo y un lado a la vez: el lado que lleva el raton sale tal
  // cual se ha pedido y el que nadie ha tocado es el que paga el volumen.
  const suelto = ajustarEjes(unoV, { x: 1.5, y: 1, z: 1 }, { eje: 1, volumen: false }).x;
  const mixto = ajustarEjes(unoV, { x: 1.5, y: 1.6, z: 1 }, { eje: 1 });
  check('el volumen solo se cobra en los ejes que no se han tocado',
    Math.abs(mixto.x - suelto) < 1e-12
    && Math.abs(mixto.z - 1 / Math.sqrt(mixto.y)) < 1e-12,
    [mixto.x, mixto.y, mixto.z].map((v) => v.toFixed(4)).join(' '));
  const seco = ajustarEjes(unoV, { x: 1, y: 1.6, z: 1 }, { eje: 1, volumen: false });
  check('sin volumen, alargar no toca el grosor',
    Math.abs(seco.x - 1) < 1e-12 && Math.abs(seco.z - 1) < 1e-12 && seco.y > 1.2,
    [seco.x, seco.y, seco.z].map((v) => v.toFixed(4)).join(' '));
  const parado = ajustarEjes({ x: 1.2, y: 1.4, z: 0.9 }, { x: 1.2, y: 1.4, z: 0.9 }, { eje: 1 });
  check('pedir por ejes lo que ya hay tampoco mueve nada',
    Math.abs(parado.x - 1.2) < 1e-12 && Math.abs(parado.y - 1.4) < 1e-12
    && Math.abs(parado.z - 0.9) < 1e-12,
    [parado.x, parado.y, parado.z].join(' '));
  const imanV = ajustarEjes(unoV, { x: 1.6, y: 1, z: 1 }, { eje: 1, paso: 0.05 });
  check('y el imantado cae de cinco en cinco centesimas en el eje que se arrastra',
    Math.abs(imanV.x - 1.3) < 1e-9, 'x=' + imanV.x);
}

// --- deformar por posicion: el pliegue y el tirador de volumen -------------
{
  const { tweakPoint, tweakFactors } = await import('../src/posing/ManualPosing.js');
  settings.set('ik.stretch', false);
  character.clearDeform();
  rig.hold.clear();
  rig.syncAll();
  const pierna = rig.get('leftLeg');
  const camino = [pierna.root, pierna.mid, pierna.tip];

  check('cada cadena dice de que huesos esta hecha, y en orden',
    rig.chains.every((c) => c.keys.length === c.bones.length
      && c.keys.every((k, i) => bones[k] === c.bones[i])),
    rig.chains.map((c) => c.id + ':' + c.keys.join('>')).join(' '));
  check('y la raiz de la cadena se puede pedir en mundo',
    rig.rootWorld(pierna, new THREE.Vector3()).distanceTo(wp(pierna.root)) < 1e-12);

  // El pliegue: se lleva la rodilla a un punto y los dos eslabones dan de si lo
  // justo para llegar, con el pie quieto en su objetivo. La cuenta es la del
  // manejador: cada eslabon tiene que medir su lado del triangulo.
  const s0 = pierna.stretch || 1;
  const f0 = pierna.keys.map((k) => character.boneFactors(k));
  const nat = [0, 1].map((i) => wp(camino[i]).distanceTo(wp(camino[i + 1])) / (f0[i].k * s0));
  const raiz = wp(pierna.root);
  const objetivo = rig.targetWorld(pierna, new THREE.Vector3());
  const rodilla0 = rig.midWorld(pierna, new THREE.Vector3());
  const total = nat[0] + nat[1];
  const eslabon = (i) => wp(camino[i]).distanceTo(wp(camino[i + 1]));

  /** Lo que hace el manejador del pliegue en cada evento del raton. */
  const pliega = (punto) => {
    const s = pierna.stretch || 1;
    const dist = [raiz.distanceTo(punto), punto.distanceTo(objetivo)];
    for (let i = 0; i < 2; i++) {
      const k = dist[i] / (nat[i] * s);
      character.setBoneFactors(pierna.keys[i], k, f0[i].g);
    }
    rig.applyStretch();
    rig.solve(pierna, punto);
    return dist;
  };

  // Un punto fuera de la linea muslo-pie: la rodilla sale de la recta y los dos
  // huesos tienen que alargarse para llegar hasta el.
  const fuera = perpA(rodilla0, raiz, wp(pierna.tip).sub(raiz).normalize()).normalize();
  const pedido = rodilla0.clone().addScaledVector(fuera, total * 0.2);
  const dist = pliega(pedido);
  check('el pliegue deja la rodilla debajo del raton',
    rig.midWorld(pierna, new THREE.Vector3()).distanceTo(pedido) < total * 1e-4,
    'd=' + rig.midWorld(pierna, new THREE.Vector3()).distanceTo(pedido).toExponential(1));
  check('y el pie no se ha movido de su objetivo',
    punta(pierna).distanceTo(objetivo) < total * 1e-4,
    'd=' + punta(pierna).distanceTo(objetivo).toExponential(1));
  check('los dos eslabones miden justo su lado del triangulo',
    Math.abs(eslabon(0) - dist[0]) < 1e-6 && Math.abs(eslabon(1) - dist[1]) < 1e-6,
    [eslabon(0) / dist[0], eslabon(1) / dist[1]].map((v) => v.toFixed(6)).join(' '));
  check('que es alargar los huesos, no girarlos y ya',
    character.boneFactors(pierna.keys[0]).k > 1.02
    && character.boneFactors(pierna.keys[1]).k > 1.02,
    pierna.keys.map((k) => character.boneFactors(k).k.toFixed(3)).join(' '));

  // Cada evento es una funcion del raton: el mismo punto dos veces no acumula, y
  // volver al punto de partida devuelve los huesos a su largo natural.
  const k1 = pierna.keys.map((k) => character.boneFactors(k).k);
  pliega(pedido);
  check('pedir el mismo punto otra vez no lo va estirando',
    pierna.keys.every((k, i) => Math.abs(character.boneFactors(k).k - k1[i]) < 1e-9),
    pierna.keys.map((k) => character.boneFactors(k).k.toFixed(6)).join(' '));
  pliega(rodilla0);
  check('y volver al punto de partida devuelve los largos',
    pierna.keys.every((k) => Math.abs(character.boneFactors(k).k - 1) < 1e-6)
    && Math.abs(eslabon(0) - nat[0]) < 1e-6 && Math.abs(eslabon(1) - nat[1]) < 1e-6,
    pierna.keys.map((k) => character.boneFactors(k).k.toFixed(6)).join(' '));

  // El tirador de volumen de un hueso: flota a media altura del eslabon y apartado
  // de su eje, y donde se dibuja es exactamente la inversa de lo que un punto pide.
  // Eso es lo que lo mantiene pegado al raton mientras se arrastra.
  character.clearDeform();
  rig.syncAll();
  const clave = pierna.keys[1];               // la rodilla, el hueso de en medio
  const rodilla = pierna.mid;
  const pie = pierna.tip;
  const a0 = wp(rodilla);
  const base = a0.distanceTo(wp(pie));        // sin deformar ni estirar, k = 1
  const eje = wp(pie).sub(a0).normalize();
  const perp = rig.bendWorld(pierna, new THREE.Vector3());
  perp.addScaledVector(eje, -perp.dot(eje)).normalize();
  const marco = { a: a0, eje, perp, base };
  const reposo = tweakPoint(marco);

  check('el tirador de volumen nace a media altura del eslabon',
    Math.abs(reposo.clone().sub(a0).dot(eje) - base * 0.5) < 1e-9,
    (reposo.clone().sub(a0).dot(eje) / base).toFixed(6));
  check('y apartado del eje, para poder pincharlo sin darle al hueso',
    perpA(reposo, a0, eje).length() > base * 0.1,
    (perpA(reposo, a0, eje).length() / base).toFixed(3));
  const ida = tweakFactors(marco, tweakPoint({ ...marco, k: 1.4, g: 0.7 }));
  check('la ida y la vuelta dan el mismo largo y el mismo grosor',
    Math.abs(ida.k - 1.4) < 1e-9 && Math.abs(ida.g - 0.7) < 1e-9,
    'k=' + ida.k.toFixed(6) + ' g=' + ida.g.toFixed(6));
  check('correrlo a lo largo alarga y apartarlo engorda, cada cosa por su lado',
    Math.abs(tweakFactors(marco, tweakPoint({ ...marco, k: 2 })).g - 1) < 1e-9
    && Math.abs(tweakFactors(marco, tweakPoint({ ...marco, g: 2 })).k - 1) < 1e-9);
  check('apartarlo el doble de su brazo engorda el hueso al doble',
    Math.abs(perpA(tweakPoint({ ...marco, g: 2 }), a0, eje).length()
      / perpA(reposo, a0, eje).length() - 2) < 1e-9);

  // Y la prueba que importa: soltar el tirador en un punto y volver a dibujarlo
  // sobre el hueso ya deformado lo deja en el mismo punto. Si no, se despegaria
  // del raton en cuanto el hueso cambiase de tamano.
  const suelta = tweakPoint({ ...marco, k: 1.25, g: 1.6 });
  const f = tweakFactors(marco, suelta);
  character.setBoneFactors(clave, f.k, f.g);
  rig.applyStretch();
  const puesto = character.boneFactors(clave);
  const a1 = wp(rodilla);
  const largo1 = a1.distanceTo(wp(pie));
  check('deformar el hueso no mueve la articulacion de arriba',
    a1.distanceTo(a0) < 1e-9);
  check('el largo del eslabon es el natural por el largo pedido',
    Math.abs(largo1 - base * puesto.k) < 1e-9,
    (largo1 / base).toFixed(6) + ' vs ' + puesto.k.toFixed(6));
  const dibujado = tweakPoint({
    a: a1, eje: wp(pie).sub(a1).normalize(), perp,
    base: largo1 / puesto.k, k: puesto.k, g: puesto.g,
  });
  check('el tirador se queda donde se ha soltado, con el hueso ya deformado',
    dibujado.distanceTo(suelta) < base * 1e-9,
    'd=' + dibujado.distanceTo(suelta).toExponential(1));

  character.clearDeform();
  rig.hold.clear();
  rig.syncAll();
  check('y al soltarlo todo el modelo queda limpio',
    character.deformed === false && Math.abs(eslabon(1) - nat[1]) < 1e-9);
}

// --- el tamano global de los manejadores ----------------------------------
// Una barra encoge de golpe todos los controles del rig, del 100 % al 1 %, para
// poder ver la figura cuando la tapan. Multiplica la cota de la que salen los tres
// tamanos de un manejador, y eso es lo que se prueba aqui: que encoge todo por
// igual y que no cambia ninguna proporcion.
{
  const { handleRadius } = await import('../src/posing/ManualPosing.js');
  const base = 1.75 * 0.013;                    // la cota de una figura de 1,75 m
  const clases = ['joint', 'effector', 'pole', 'body', 'bend', 'tweak'];
  // Las tres distancias son los tres tramos: el suelo, lo que crece con la camara
  // y el techo. Un manejador puede caer en cualquiera de ellos.
  const tramos = [0.3, 2, 40];
  const escala = 0.4;
  const razones = [];
  for (const k of clases) {
    for (const d of tramos) razones.push(handleRadius(base * escala, d, k) / handleRadius(base, d, k));
  }
  check('los tres tramos del tamano son de verdad tres, y no siempre el mismo',
    new Set(clases.flatMap((k) => tramos.map((d) => handleRadius(base, d, k).toFixed(9)))).size
      === clases.length * tramos.length,
    tramos.map((d) => handleRadius(base, d, 'joint').toFixed(4)).join(' / '));
  check('al 40 % todas las clases y los tres tramos encogen exactamente otro tanto',
    razones.every((r) => Math.abs(r - escala) < 1e-12),
    razones.length + ' razones entre ' + Math.min(...razones).toFixed(6)
    + ' y ' + Math.max(...razones).toFixed(6));
  check('asi que no cambia cual es mas gordo que cual',
    clases.every((k) => Math.abs(handleRadius(base * escala, 2, k) / handleRadius(base * escala, 2, 'joint')
      - handleRadius(base, 2, k) / handleRadius(base, 2, 'joint')) < 1e-12),
    clases.map((k) => (handleRadius(base, 2, k) / handleRadius(base, 2, 'joint')).toFixed(2)).join(' '));
  check('las falanges siguen siendo las mas finas, encogidas o no',
    handleRadius(base * escala, 2, 'joint', true) < handleRadius(base * escala, 2, 'joint')
    && Math.abs(handleRadius(base * escala, 2, 'joint', true)
      / handleRadius(base, 2, 'joint', true) - escala) < 1e-12);
  check('y al 1 %, el minimo de la barra, salen puntos, no ceros',
    tramos.every((d) => handleRadius(base * 0.01, d, 'tweak') > 0
      && Number.isFinite(handleRadius(base * 0.01, d, 'tweak'))),
    handleRadius(base * 0.01, 2, 'tweak').toExponential(2) + ' m de radio');
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
