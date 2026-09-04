/**
 * ATOM · Rig de cinematica inversa
 * ---------------------------------------------------------------------------
 * La capa que convierte los solucionadores de `pose/ik.js` en algo que se puede
 * manejar con el raton: seis cadenas con nombre (dos brazos, dos piernas, torso
 * y cabeza), un objetivo por cadena y la posibilidad de fijarlas. Aqui no hay
 * escena ni punteros, solo huesos y vectores, para poder probarlo en Node.
 *
 * Decisiones que no son obvias:
 *
 *   - Los objetivos viven en el **espacio del `holder`**, no en el del mundo.
 *     Cada fotograma `Character.tick()` sube o baja el `holder` para que la
 *     figura apoye en el suelo; si el objetivo de un pie estuviera en
 *     coordenadas de mundo, levantar ese pie moveria el anclaje, que moveria el
 *     objetivo, que volveria a mover el anclaje... En el espacio del `holder`
 *     ese lazo no existe, y ademas los objetivos aguantan que se gire, se mueva
 *     o se cambie de altura la figura entera.
 *   - Un objetivo **suelto sigue a su punta**: mientras no se fije ni se
 *     arrastre, la cinematica inversa no manda nada. Asi convive con el mocap,
 *     con la biblioteca de poses y con el posado hueso a hueso en vez de pelear
 *     con ellos. Fijar una cadena es lo contrario: el objetivo se queda quieto y
 *     la cadena se rehace sola cada vez que algo de mas arriba se mueve —es lo
 *     que permite hundir la cadera y que los pies no se despeguen del suelo.
 *   - Se recuerda donde quedo la punta tras cada solucion (`solved`). Si nadie
 *     la ha movido no se vuelve a resolver: una cadena fijada cuesta cero
 *     mientras la figura esta quieta, y un objetivo fuera de alcance no se pasa
 *     el rato reintentando lo imposible.
 *   - El squash y stretch (`ik.stretch`) se aplica **antes** de resolver: se
 *     cambia el largo de los eslabones y el solucionador, que mide los huesos tal
 *     como estan, llega al objetivo sin forzar nada. El factor se mide siempre
 *     sobre el largo natural apuntado al construir la cadena, nunca sobre el
 *     estirado de ahora; medirlo sobre lo que hay alargaria el miembro un poco mas
 *     en cada solucion. El grosor se compensa con una escala uniforme en la raiz,
 *     que por ser uniforme no cizalla la piel de un miembro doblado.
 *   - El polo (codo, rodilla) **no se guarda**: se deduce de la postura de ahora,
 *     de modo que su manejador aparece siempre al lado del codo actual y no da
 *     un salto al soltarlo. Con el miembro estirado del todo no hay plano que
 *     medir, y entonces manda la anatomia —codos hacia atras, rodillas hacia
 *     delante— leida de `character.basis`, la base corporal medida sobre la pose
 *     de reposo del propio modelo.
 */

import * as THREE from 'three';
import { solveTwoBone, solveChain, worldOf } from '../pose/ik.js';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _u = new THREE.Vector3();
const _t = new THREE.Vector3();
const _l = new THREE.Vector3();
const _e = new THREE.Vector3();
const _f = new THREE.Vector3();
const _g = new THREE.Vector3();
const _q = new THREE.Quaternion();

/** Tope de seguridad del estirado, por si llega un valor guardado disparatado. */
const K_MIN = 0.2;
const K_MAX = 3;
const pinza = (v, min, max) => Math.max(min, Math.min(max, v));

/** Grupos que se encienden por separado: `ik.arms`, `ik.legs`, `ik.torso`, `ik.head`. */
export const IK_GROUPS = ['arms', 'legs', 'torso', 'head'];

/**
 * Las cadenas, en orden de dependencia: primero lo que arrastra a lo demas. Si
 * se resolviera el torso despues de los brazos, mover el pecho descolocaria las
 * manos que acabamos de colocar.
 *
 * `bend` es la direccion anatomica del codo o la rodilla en la base corporal del
 * modelo (X a la izquierda, Y arriba, Z al frente); solo entra en juego cuando el
 * miembro esta tan estirado que no define ningun plano.
 */
export const IK_CHAINS = [
  {
    id: 'torso', group: 'torso', kind: 'chain',
    label: 'Pecho', handle: 'Pecho',
    bones: ['spine', 'spine1', 'spine2'], tips: ['neck', 'head'],
  },
  {
    id: 'head', group: 'head', kind: 'chain',
    label: 'Cabeza', handle: 'Cabeza',
    bones: ['neck', 'head'], tips: ['headTop', 'head'],
  },
  {
    id: 'leftLeg', group: 'legs', kind: 'twoBone',
    label: 'Pie izquierdo', handle: 'Pie izq.', pole: 'Rodilla izq.',
    root: 'leftUpLeg', mid: 'leftLeg', tip: 'leftFoot', bend: [0, 0, 1],
  },
  {
    id: 'rightLeg', group: 'legs', kind: 'twoBone',
    label: 'Pie derecho', handle: 'Pie der.', pole: 'Rodilla der.',
    root: 'rightUpLeg', mid: 'rightLeg', tip: 'rightFoot', bend: [0, 0, 1],
  },
  {
    id: 'leftArm', group: 'arms', kind: 'twoBone',
    label: 'Mano izquierda', handle: 'Mano izq.', pole: 'Codo izq.',
    root: 'leftArm', mid: 'leftForeArm', tip: 'leftHand', bend: [0, 0, -1],
  },
  {
    id: 'rightArm', group: 'arms', kind: 'twoBone',
    label: 'Mano derecha', handle: 'Mano der.', pole: 'Codo der.',
    root: 'rightArm', mid: 'rightForeArm', tip: 'rightHand', bend: [0, 0, -1],
  },
];

/** Cadena de dos huesos: los tres tienen que estar, no hay recambio posible. */
function armarDos(def, bones) {
  const root = bones[def.root];
  const mid = bones[def.mid];
  const tip = bones[def.tip];
  if (!root || !mid || !tip) return null;
  return {
    def, id: def.id, kind: 'twoBone', root, mid, tip, bones: [root, mid],
    rootKey: def.root, midKey: def.mid, tipKey: def.tip, keys: [def.root, def.mid],
  };
}

/**
 * Cadena de varios huesos. Se aprovecha lo que el modelo traiga: la punta es la
 * primera de `tips` que exista y los huesos que giran son los declarados que
 * esten y queden por encima de ella. Asi la cabeza se apunta con cuello y craneo
 * si hay coronilla, y solo con el cuello si el modelo no la trae.
 */
function armarVarios(def, bones) {
  const tipKey = def.tips.find((k) => bones[k]);
  if (!tipKey) return null;
  const corte = def.bones.indexOf(tipKey);
  // Las claves viajan al lado de los huesos porque el modelo puede no traerlos
  // todos: quien quiera deformar el tercero de la cadena necesita saber cual es.
  const claves = (corte >= 0 ? def.bones.slice(0, corte) : def.bones).filter((k) => bones[k]);
  const usados = claves.map((k) => bones[k]);
  if (!usados.length) return null;
  return {
    def, id: def.id, kind: 'chain', root: usados[0], mid: null, tip: bones[tipKey], bones: usados,
    rootKey: claves[0], midKey: '', tipKey, keys: claves,
  };
}

/**
 * Apunta los largos y las escalas naturales de una cadena, que es de donde se mide
 * el squash y stretch. Si el factor se midiera sobre el estirado de ahora, el
 * miembro se iria alargando un poco mas en cada solucion hasta quedar absurdo.
 *
 * Devuelve `null` si la cadena no es un camino padre-hijo seguido: entonces no hay
 * eslabones que alargar y esa cadena se queda sin estirado, sin mas.
 */
function medirReposo(chain, character = null) {
  // Los largos y los tamanos se leen del reposo del personaje, no del hueso tal
  // como esta ahora: si se remide con un brazo estirado o con una rodilla
  // deformada, esa deformacion se quedaria dentro del «largo natural» y volveria
  // a multiplicarse en la pasada siguiente.
  const reposo = character?.rest ?? null;
  const sitio = (b) => reposo?.offset?.get(b) ?? b.position;
  const tam = (b) => reposo?.scale?.get(b) ?? b.scale;

  const path = [...chain.bones, chain.tip];
  const links = [];
  for (let i = 1; i < path.length; i++) {
    const hueso = path[i];
    if (hueso.parent !== path[i - 1]) return null;
    const local = sitio(hueso);
    const len = local.length();
    if (len < 1e-6) return null;
    links.push({ bone: hueso, dir: local.clone().divideScalar(len), len });
  }
  if (!links.length) return null;
  // Lo que cuelga de la cadena sin ser la cadena lleva la escala contraria: al
  // estirarse el brazo adelgaza, pero la mano que hay al final no, ni los hombros
  // que cuelgan del pecho, ni los dedos del pie.
  const dentro = new Set(path);
  const comp = [];
  for (let i = 0; i < path.length; i++) {
    const hueso = path[i];
    // La punta entera se compensa a si misma: asi se arregla de una vez su grosor
    // y el tamano de todo lo que lleve debajo.
    if (i === path.length - 1) { comp.push({ bone: hueso, scale: tam(hueso).clone() }); continue; }
    for (const hijo of hueso.children) {
      if (!dentro.has(hijo)) comp.push({ bone: hijo, scale: tam(hijo).clone() });
    }
  }
  return { path, links, comp, root: { bone: path[0], scale: tam(path[0]).clone() } };
}

export class IKRig {
  /**
   * @param {import('../model/Character.js').Character|null} character
   * @param {import('../core/Settings.js').Settings|null} settings
   */
  constructor(character = null, settings = null) {
    this.character = character;
    this.settings = settings;
    /** @type {Array<object>} */
    this.chains = [];
    this.byId = new Map();
    /** Cadenas que aguantan su objetivo solo mientras dura un arrastre. */
    this.hold = new Set();
    this.rebuild();
  }

  setCharacter(character) {
    if (this.character === character) return this;
    this.character = character;
    this.rebuild();
    return this;
  }

  /** Esta encendida la cinematica inversa? Sin almacen se da por encendida. */
  get on() {
    return this.settings ? this.settings.get('ik.enabled') === true : true;
  }

  /** Cuanto se prohibe estirar el miembro, en tanto por uno de su largo total. */
  get margin() {
    const v = Number(this.settings?.get('ik.margin'));
    return Number.isFinite(v) ? Math.max(0, Math.min(0.2, v)) : 0.02;
  }

  /** Squash y stretch: sin almacen se da por apagado, que es lo de siempre. */
  get stretchOn() {
    return this.settings ? this.settings.get('ik.stretch') === true : false;
  }

  /** Cuanto puede dar de si una cadena, en tanto por uno de su largo natural. */
  get stretchMax() {
    const v = Number(this.settings?.get('ik.stretchMax'));
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.25;
  }

  /** Rehace las cadenas a partir de los huesos que traiga el modelo. */
  rebuild() {
    // Se deshace el estirado de las cadenas viejas antes de tirarlas: si no, los
    // eslabones se quedarian largos y la medida nueva los tomaria por naturales.
    this.resetStretch();
    this.chains.length = 0;
    this.byId.clear();
    this.hold.clear();
    const bones = this.character?.bones;
    if (!this.character?.loaded || !bones) return this;
    for (const def of IK_CHAINS) {
      const chain = def.kind === 'twoBone' ? armarDos(def, bones) : armarVarios(def, bones);
      if (!chain) continue;
      chain.target = new THREE.Vector3();
      chain.solved = new THREE.Vector3();
      chain.goal = new THREE.Vector3();
      chain.dirty = false;
      chain.pinned = this.settings?.get('ik.pins.' + def.id) === true;
      /** Factor de estirado aplicado ahora mismo; 1 es el largo natural. */
      chain.stretch = 1;
      chain.rest = medirReposo(chain, this.character);
      this.chains.push(chain);
      this.byId.set(def.id, chain);
    }
    this.syncAll();
    return this;
  }

  get(id) {
    return this.byId.get(id) ?? null;
  }

  /** Ha encendido el usuario el grupo al que pertenece esta cadena? */
  live(chain) {
    if (!chain || !this.on) return false;
    if (!this.settings) return true;
    return this.settings.get('ik.' + chain.def.group) !== false;
  }

  /** Las cadenas con las que se puede trabajar ahora mismo. */
  active() {
    return this.chains.filter((c) => this.live(c));
  }

  /** Manda esta cadena sobre su punta en este momento? */
  held(chain) {
    return !!chain && this.live(chain) && (chain.pinned || this.hold.has(chain.id));
  }

  // ------------------------------------------------------- espacio y puntas ---

  /** Del mundo al espacio del `holder`, que es donde viven los objetivos. */
  toLocal(world, out) {
    const holder = this.character?.holder;
    out.copy(world);
    if (!holder) return out;
    holder.updateWorldMatrix(true, false);
    return holder.worldToLocal(out);
  }

  /** Del espacio del `holder` al del mundo. */
  toWorld(local, out) {
    const holder = this.character?.holder;
    out.copy(local);
    if (!holder) return out;
    holder.updateWorldMatrix(true, false);
    return holder.localToWorld(out);
  }

  /** Posicion de mundo del objetivo de una cadena. */
  targetWorld(chain, out) {
    return this.toWorld(chain.target, out);
  }

  /** Mueve el objetivo de una cadena a un punto de mundo. */
  setTargetWorld(chain, world) {
    this.toLocal(world, chain.target);
    return this;
  }

  /** Posicion de mundo de la punta (mano, pie, cuello, coronilla). */
  tipWorld(chain, out) {
    return worldOf(chain.tip, out);
  }

  /** Posicion de mundo de la raiz (hombro, muslo, primera vertebra). */
  rootWorld(chain, out) {
    return worldOf(chain.root, out);
  }

  /** Posicion de mundo del codo o la rodilla; `null` en las cadenas FABRIK. */
  midWorld(chain, out) {
    if (!chain.mid) return null;
    return worldOf(chain.mid, out);
  }

  // ------------------------------------------------------------------ polos ---

  /**
   * Direccion anatomica del pliegue en coordenadas de mundo: se lee de la base
   * corporal del modelo y se pasa por el giro del objeto cargado, para que siga a
   * la figura cuando esta girada en la escena.
   */
  bendWorld(chain, out) {
    const [x, y, z] = chain.def.bend ?? [0, 0, -1];
    out.set(x, y, z);
    const ch = this.character;
    if (ch?.basis) out.applyQuaternion(ch.basis);
    if (ch?.source) out.applyQuaternion(ch.source.getWorldQuaternion(_q));
    if (out.lengthSq() < 1e-12) out.set(0, 0, -1);
    return out.normalize();
  }

  /**
   * Punto de mundo donde flota el manejador del codo o la rodilla: separado del
   * codo de ahora en la direccion en la que ya esta doblado. Asi arrastrarlo gira
   * el plano del pliegue y soltarlo no mueve nada.
   */
  poleWorld(chain, out) {
    if (!chain.mid) return null;
    const a = worldOf(chain.root, _a);
    const b = worldOf(chain.mid, _b);
    const t = worldOf(chain.tip, _c);
    const largo = a.distanceTo(b) + b.distanceTo(t);
    _u.copy(t).sub(a);
    const eje = _u.length();
    out.copy(b).sub(a);
    if (eje > 1e-6) {
      _u.divideScalar(eje);
      out.addScaledVector(_u, -out.dot(_u));
    }
    // Miembro estirado: no hay plano que medir, manda la anatomia.
    if (out.lengthSq() < (largo * 0.02) * (largo * 0.02)) this.bendWorld(chain, out);
    else out.normalize();
    return out.multiplyScalar(Math.max(1e-4, largo * 0.4)).add(b);
  }

  // ------------------------------------------------------ squash y stretch ---

  /**
   * Vuelve a montar el estirado de todas las cadenas partiendo de sus largos
   * naturales. Se rehace entero a proposito, en vez de retocar lo que hay: el
   * cuello es a la vez la punta del torso y la raiz de la cabeza, asi que dos
   * cadenas pueden tocar el mismo hueso y sus factores tienen que multiplicarse
   * sin arrastrar lo que quedo de la pasada anterior.
   *
   * El largo se cambia en la posicion local de cada eslabon y el grosor con una
   * escala **uniforme** en el hueso raiz: `u = 1/raiz(k)` adelgaza el miembro
   * justo lo que se ha estirado, y por ser uniforme no cizalla la piel cuando la
   * cadena esta doblada, que es lo que pasaria con una escala por ejes.
   *
   * La escala de cada hueso sale de tres capas: `reposo x usuario x estirado`.
   * Las dos primeras las escribe el personaje (`applyDeform()`), y este metodo
   * multiplica la tercera encima. Por eso todo pasa por aqui: es el unico sitio
   * que escribe `bone.scale`, y asi ninguna capa borra a las otras.
   */
  applyStretch() {
    // Capas 1 y 2. Si no hay personaje (o aun no hay esqueleto) se vuelve a las
    // medidas de reposo propias de cada cadena, que es como corren las pruebas.
    const base = this.character?.applyDeform?.() === true;
    // Lo que la deformacion a mano ha alargado la traslacion de cada hueso. Va
    // dentro del largo natural del eslabon en vez de encima: las dos capas se
    // multiplican, asi que una rodilla alargada a mano sigue alargada dentro de una
    // cadena estirada, y ninguna de las dos pisa a la otra.
    const largos = base ? this.character.deformLength : null;
    for (const chain of this.chains) {
      const rest = chain.rest;
      if (!rest) continue;
      if (!base) {
        rest.root.bone.scale.copy(rest.root.scale);
        for (const c of rest.comp) c.bone.scale.copy(c.scale);
      }
      for (const l of rest.links) {
        l.bone.position.copy(l.dir).multiplyScalar(l.len * (largos?.get(l.bone) ?? 1));
      }
    }
    for (const chain of this.chains) {
      const rest = chain.rest;
      if (!rest || chain.stretch === 1) continue;
      const k = chain.stretch;
      const u = 1 / Math.sqrt(k);
      rest.root.bone.scale.multiplyScalar(u);
      // El largo se multiplica dividido por `u` porque la escala de la raiz ya
      // multiplica por `u` todo lo que cuelga: asi el eslabon acaba midiendo
      // `len * k` de mundo, ni mas ni menos. Se multiplica sobre lo que dejo la
      // pasada anterior, no se rehace desde `l.len`, que es lo que conserva el
      // largo que el usuario haya puesto a mano en ese hueso.
      for (const l of rest.links) l.bone.position.multiplyScalar(k / u);
      for (const c of rest.comp) c.bone.scale.multiplyScalar(1 / u);
    }
    return this;
  }

  /**
   * Cuanto habria que estirar o aplastar una cadena para que su punta llegue al
   * objetivo. Devuelve 1 si llega por sus propios medios, y por eso encender el
   * squash y stretch no cambia ninguna pose que ya alcanzaba: solo entra en juego
   * en los dos extremos, cuando el objetivo esta mas lejos de lo que da el miembro
   * o mas cerca de lo que puede plegarse.
   *
   * Los largos se miden en mundo y se dividen por el estirado que ya lleva puesto,
   * de modo que el factor sale siempre del largo natural.
   */
  stretchFactor(chain, targetWorld) {
    const rest = chain?.rest;
    if (!rest || !targetWorld) return 1;
    const k = chain.stretch || 1;
    let total = 0;
    let mayor = 0;
    worldOf(rest.path[0], _g);
    _e.copy(_g);
    for (let i = 1; i < rest.path.length; i++) {
      const d = _e.distanceTo(worldOf(rest.path[i], _f)) / k;
      total += d;
      if (d > mayor) mayor = d;
      _e.copy(_f);
    }
    if (total < 1e-6) return 1;
    const dos = chain.kind === 'twoBone';
    // Los mismos topes que usa el solucionador: la holgura de la articulacion solo
    // existe en la cadena de dos huesos, y el minimo es lo que sobra del eslabon
    // mas largo cuando los demas se plieguen contra el.
    const max = dos ? total * (1 - this.margin) : total;
    const min = Math.max(0, 2 * mayor - total) + (dos ? total * 0.02 : 0);
    const d = _g.distanceTo(targetWorld);
    let f = 1;
    if (d > max && max > 1e-6) f = d / max;
    else if (d < min && min > 1e-6) f = d / min;
    const a = this.stretchMax;
    return pinza(f, 1 / (1 + a), 1 + a);
  }

  /** Deja una cadena con este factor de estirado; 1 es su largo natural. */
  setStretch(chain, k) {
    if (!chain?.rest) return false;
    const v = Number.isFinite(k) ? pinza(k, K_MIN, K_MAX) : 1;
    if (Math.abs(v - chain.stretch) < 1e-4) return false;
    chain.stretch = v;
    this.applyStretch();
    return true;
  }

  /** Devuelve todas las cadenas a su largo natural. */
  resetStretch() {
    let cambio = false;
    for (const chain of this.chains) {
      if (chain.stretch === 1) continue;
      chain.stretch = 1;
      cambio = true;
    }
    if (cambio) this.applyStretch();
    return cambio;
  }

  /**
   * El estirado de cada cadena. Hace falta guardarlo aparte porque una pose solo
   * lleva giros (ver `Character.getPose()`): sin esto, deshacer devolveria los
   * giros y dejaria el brazo largo.
   */
  stretchState() {
    const out = {};
    for (const chain of this.chains) if (chain.stretch !== 1) out[chain.id] = chain.stretch;
    return out;
  }

  /** Restaura un estirado guardado y deja los objetivos sobre las puntas nuevas. */
  setStretchState(state) {
    for (const chain of this.chains) {
      const v = Number(state?.[chain.id]);
      chain.stretch = Number.isFinite(v) ? pinza(v, K_MIN, K_MAX) : 1;
    }
    this.applyStretch();
    for (const chain of this.chains) this.sync(chain);
    return this;
  }

  // ------------------------------------------------------------ soluciones ---

  /**
   * Rehace una cadena para que su punta llegue al objetivo.
   * @param {object} chain
   * @param {THREE.Vector3|null} [pole] polo en coordenadas de mundo; si no se da
   *   se deduce del pliegue actual
   * @returns {boolean}
   */
  solve(chain, pole = null) {
    if (!chain) return false;
    const target = this.targetWorld(chain, _t);
    // El estirado se decide antes de resolver, porque el solucionador mide los
    // huesos tal como estan: con la cadena ya alargada llega sin forzar nada, y
    // el resultado sigue siendo una solucion de giros.
    if (this.stretchOn) this.setStretch(chain, this.stretchFactor(chain, target));
    else if (chain.stretch !== 1) this.setStretch(chain, 1);
    let ok = false;
    if (chain.kind === 'twoBone') {
      const p = pole ?? this.poleWorld(chain, _l);
      ok = solveTwoBone({
        root: chain.root, mid: chain.mid, tip: chain.tip, target, pole: p, margin: this.margin,
      });
    } else {
      ok = solveChain({ bones: chain.bones, tip: chain.tip, target, iterations: 12 });
    }
    this.toLocal(worldOf(chain.tip, _a), chain.solved);
    chain.goal.copy(chain.target);
    chain.dirty = false;
    return ok;
  }

  /**
   * Deja el objetivo de una cadena pegado a su punta. Es lo que hace que la
   * cinematica inversa no estorbe: si nadie fija nada, no manda nada.
   */
  sync(chain) {
    this.toLocal(worldOf(chain.tip, _a), chain.target);
    chain.solved.copy(chain.target);
    chain.goal.copy(chain.target);
    chain.dirty = false;
    return this;
  }

  /**
   * Sincroniza todas (tras cargar una pose, aplicar un preset o deshacer). El
   * estirado se deshace primero: una pose de la biblioteca lleva solo giros, asi
   * que aplicarla con un brazo largo de otra pose dejaria la figura deforme sin
   * que se hubiera pedido.
   *
   * Con `{ stretch: false }` se respeta el estirado que haya puesto. Es lo que
   * hace falta al cambiar entre cinematica directa e inversa: la figura no ha
   * cambiado de pose, solo de modo de manejarla, y perder ahi el aplastado
   * dejaria una silueta distinta a cada lado del interruptor.
   */
  syncAll({ stretch = true } = {}) {
    if (stretch) this.resetStretch();
    for (const chain of this.chains) this.sync(chain);
    return this;
  }

  /** Sincroniza las que nadie sujeta; las sujetas conservan su objetivo. */
  syncLoose({ skip = null } = {}) {
    for (const chain of this.chains) {
      if (chain === skip || this.held(chain)) continue;
      this.sync(chain);
    }
    return this;
  }

  /**
   * Rehace las cadenas sujetas cuya punta haya movido otro (girar el pecho,
   * hundir la cadera, cargar una pose). Se recorren en orden de dependencia y se
   * salta lo que ya esta en su sitio, de modo que con la figura quieta esto no
   * cuesta nada.
   * @returns {boolean} si algo se ha movido
   */
  solveHeld({ skip = null } = {}) {
    if (!this.on || !this.chains.length) return false;
    const tol = this.tolerance();
    let movido = false;
    for (const chain of this.chains) {
      if (chain === skip || !this.held(chain)) continue;
      this.toLocal(worldOf(chain.tip, _a), _l);
      // Se salta si la punta sigue donde la dejamos y el objetivo no ha cambiado:
      // comparar solo la punta daria por resuelto un objetivo recien movido.
      const quieta = _l.distanceToSquared(chain.solved) <= tol * tol;
      const mismoObjetivo = chain.target.distanceToSquared(chain.goal) <= tol * tol;
      if (!chain.dirty && quieta && mismoObjetivo) continue;
      this.solve(chain);
      movido = true;
    }
    return movido;
  }

  /**
   * Marca las soluciones guardadas como caducadas, para que las cadenas sujetas
   * se rehagan en la proxima pasada aunque nadie haya movido ni la punta ni el
   * objetivo. Lo necesita cualquier ajuste que cambie el resultado por su cuenta,
   * como la reserva de estirado.
   */
  invalidate() {
    for (const chain of this.chains) chain.dirty = true;
    return this;
  }

  /**
   * Cuanto puede haberse movido una punta antes de merecer una solucion nueva.
   * Se mide en unidades del `holder`, que son las del modelo en reposo.
   */
  tolerance() {
    return Math.max(1e-6, (this.character?.restHeight || 1) * 2e-4);
  }

  // ------------------------------------------------------------ fijaciones ---

  isPinned(id) {
    return this.byId.get(id)?.pinned === true;
  }

  /**
   * Fija o suelta una cadena. Fijar toma nota de donde esta la punta ahora mismo,
   * asi que fijar no mueve nada: solo impide que se mueva de aqui en adelante.
   */
  pin(id, on = true) {
    const chain = this.byId.get(id);
    if (!chain) return false;
    const valor = on === true;
    if (valor) this.sync(chain);
    chain.pinned = valor;
    this.settings?.set('ik.pins.' + id, valor);
    return true;
  }

  togglePin(id) {
    return this.pin(id, !this.isPinned(id));
  }

  /** Suelta todas las fijaciones. */
  unpinAll() {
    const cambio = this.chains.some((c) => c.pinned);
    for (const chain of this.chains) chain.pinned = false;
    this.settings?.batch((s) => {
      for (const chain of this.chains) s.set('ik.pins.' + chain.id, false);
    });
    return cambio;
  }

  /** Fija los dos pies: el gesto con el que empieza casi cualquier pose de pie. */
  pinFeet(on = true) {
    let hecho = false;
    const hacer = () => {
      for (const id of ['leftLeg', 'rightLeg']) hecho = this.pin(id, on) || hecho;
    };
    if (this.settings) this.settings.batch(hacer);
    else hacer();
    return hecho;
  }

  /** Relee las fijaciones del almacen (al cargar ajustes o al restablecer). */
  readPins() {
    for (const chain of this.chains) {
      const valor = this.settings?.get('ik.pins.' + chain.id) === true;
      if (valor && !chain.pinned) this.sync(chain);
      chain.pinned = valor;
    }
    return this;
  }
}
