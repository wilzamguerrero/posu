/**
 * ManualPosing
 * ============
 * Posado manual del maniqui: manejadores esfericos sobre cada articulacion,
 * seleccion con el raton y un giroscopio (TransformControls en modo rotacion)
 * para orientar el hueso elegido. Es el complemento del mocap: se captura una
 * pose con la camara, se congela y luego se retoca a mano.
 *
 * Detalles que importan:
 *   - Los manejadores viven en su propio grupo, no dentro del esqueleto, y se
 *     sincronizan por fotograma con la posicion de mundo de cada hueso. Asi el
 *     raycast no depende de la piel deformada.
 *   - El giroscopio trabaja en coordenadas de mundo; la rotacion se convierte a
 *     local con  local = padreMundo⁻¹ * mundo, que es la misma algebra que usan
 *     los motores de retargeting.
 *   - Los ejes del giro son ajuste propio del posado (`pose.space`, tecla `Alt+X`),
 *     aparte del de la escena: "Mundo" gira el hueso sobre los ejes de la escena y
 *     "Hueso" sobre los suyos, que es lo comodo para doblar un codo. El imantado
 *     (`scene.snap`) si es el mismo. El giroscopio de deformar va siempre por los
 *     ejes del hueso, que son los unicos que significan algo al engordarlo.
 *   - Cada gesto completo (pointerdown -> pointerup) es un paso de deshacer.
 *
 * Encima de todo eso vive la cinematica inversa (`ik.enabled`), que es la otra
 * forma de posar: en vez de girar hombro y codo se arrastra la mano y el brazo se
 * acomoda solo. Los controles nuevos son de tres clases y se distinguen por forma
 * y color para no confundirlos con las esferas de articulacion:
 *
 *   - **Rombo** en manos, pies, pecho y cabeza: el objetivo de una cadena. Se
 *     arrastra con `W` y con `E` gira el hueso de la punta (la muñeca, el pie),
 *     porque el solucionador nunca escribe en ese hueso y los dos usos no chocan.
 *   - **Cubo pequeño** al lado del codo o la rodilla: el polo, que decide hacia
 *     donde se dobla el miembro sin mover la mano.
 *   - **Bola morada** en el codo o la rodilla: el pliegue. Se lleva la articulacion
 *     a un punto y los dos eslabones se alargan lo justo para llegar, con la mano
 *     quieta en su objetivo. Es el «pin» del codo de un rig de dibujo animado: la
 *     deformacion se hace **por posicion**, no con el giroscopio.
 *   - **Pico verde** a media altura de cada hueso de una cadena: su volumen. Se
 *     aparta del hueso y engorda, se corre a lo largo y alarga.
 *   - **Cubo grande** en la cadera: el peso del cuerpo. Mientras se arrastra, las
 *     piernas en cinematica inversa sujetan los pies, que es como se hace una
 *     sentadilla en un rig de verdad.
 *
 * En modo inverso **desaparecen las esferas de giro de los huesos que manda el
 * solucionador**: el hombro y el codo de un brazo encendido, la columna si el torso
 * esta encendido. Girarlos a mano peleaba con la solucion —se movian y volvian al
 * fotograma siguiente, deformando la figura por el camino—, y es justo lo que no
 * hace un rig de produccion. Lo que se quiera girar hueso a hueso se apaga en
 * **Cadenas** y vuelve a la cinematica directa; lo que se quiera deformar se hace
 * con los tiradores de posicion, que estan para eso.
 *
 * Y por encima de las dos formas de posar esta `pose.proximity`: con ella solo se
 * ven los manejadores que caen junto al puntero (la cuenta esta en
 * `proximity.js`). Mas de cuarenta esferas y rombos en una figura de espaldas se
 * tapan entre si; asi el visor queda limpio y siempre se pincha el que se buscaba.
 * Dos se quedan a la vista pase lo que pase: el elegido, que tiene el giroscopio
 * puesto, y el objetivo de una cadena fijada, que con su color dice que ese pie
 * esta clavado: eso es estado de la pose, no solo algo que agarrar.
 */

import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { IKRig } from './IKRig.js';
import { nearFactor, viewAspect } from './proximity.js';
import { BONE_LABELS } from '../model/boneMap.js';
import { worldOf } from '../pose/ik.js';

const HANDLE_GEO = new THREE.SphereGeometry(1, 14, 10);
/** Rombo para los objetivos: se reconoce de un vistazo entre las esferas. */
const GOAL_GEO = new THREE.OctahedronGeometry(1.15, 0);
/** Cubo para el polo y para el peso del cuerpo. */
const CUBE_GEO = new THREE.BoxGeometry(1.5, 1.5, 1.5);
/** Pico para el tirador de volumen: no se confunde con ninguna de las otras. */
const TWEAK_GEO = new THREE.TetrahedronGeometry(1.35, 0);
/** Tope de segmentos de la guia: polo, tirante y palanca de volumen por cadena. */
const MAX_HINTS = 28;
/** Tamaño relativo de cada clase de manejador. */
const SIZES = { joint: 1, effector: 1.3, pole: 0.62, body: 1.55, bend: 1.15, tweak: 0.55 };
/**
 * Brazo del tirador de volumen, en largos del hueso: a que distancia del eje flota
 * cuando el hueso no esta engordado. Tambien es su ganancia, porque el grosor sale
 * de dividir por el: apartarlo ese brazo de mas es engordar el hueso al doble.
 */
const TWEAK_OFF = 0.3;
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _pq = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _t = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _e = new THREE.Vector3();
const _n = new THREE.Vector3();
const _d = new THREE.Vector3();
/** Cuanto se suaviza el arrastre de deformar. 1 seria el crudo del giroscopio. */
const DEFORM_SUAVE = 0.55;
/** Paso del imantado al deformar: 1,15 de grosor, no 1,1473. */
const DEFORM_PASO = 0.05;

/**
 * De lo que pide el giroscopio a lo que se le escribe al hueso. Dos correcciones,
 * las dos medidas desde el tamano que tenia el hueso al empezar el arrastre (no
 * desde el fotograma anterior, que se iria acumulando):
 *
 *   - **Suavizado.** El gizmo de escala de three casi duplica el tamano por cada
 *     radio arrastrado, que en un hueso es un salto brusco: se va al tope antes de
 *     que el ojo vea lo que esta pasando. Elevar el factor a `DEFORM_SUAVE` obliga
 *     a arrastrar mas para el mismo grosor, asi que la deformacion crece despacio
 *     y se puede afinar sin pelearse con el raton.
 *   - **Volumen.** Aplastar y estirar de dibujo animado conserva el bulto: al
 *     alargar un hueso se adelgaza y al acortarlo se ensancha. Es la misma cuenta
 *     que el squash de las cadenas de IK (`u = 1/√k`), y por eso un hueso estirado
 *     a mano y uno estirado por el rig se ven igual.
 *
 * Esto trabaja con los dos numeros —largo y grosor—, que es lo que arrastran los
 * tiradores de posicion. El giroscopio va por ejes y pasa por `ajustarEjes`, que
 * hace las mismas dos correcciones.
 *
 * @param {{k:number,g:number}} inicio  largo y grosor al empezar el arrastre
 * @param {{k:number,g:number}} pedido  largo y grosor que sale del tirador
 * @returns {{k:number,g:number}} lo que hay que escribirle al hueso
 */
export function ajustarDeform(inicio, pedido, { volumen = true, suave = DEFORM_SUAVE, paso = 0 } = {}) {
  const k0 = inicio?.k > 0 ? inicio.k : 1;
  const g0 = inicio?.g > 0 ? inicio.g : 1;
  const k = k0 * ((pedido?.k > 0 ? pedido.k : k0) / k0) ** suave;
  let g = g0 * ((pedido?.g > 0 ? pedido.g : g0) / g0) ** suave;
  // El volumen se descuenta sobre lo que ha cambiado el largo en este arrastre, no
  // sobre el largo total: si no, tocar un hueso ya estirado lo adelgazaria otra vez.
  if (volumen) g /= Math.sqrt(k / k0);
  const red = (v) => (paso > 0 ? Math.round(v / paso) * paso : v);
  return { k: red(k), g: red(g) };
}

/**
 * Lo mismo pero eje a eje, que es como arrastra el giroscopio de escala: sus tres
 * manejadores son los tres ejes del hueso, y cada uno va por su cuenta. Tirar del
 * de arriba lo alarga, tirar de uno de lado lo engorda **solo por ese lado** —una
 * seccion ovalada es lo que se pide para un antebrazo o una pantorrilla—, y tirar
 * del centro le cambia las tres medidas a la vez.
 *
 * El volumen se descuenta **solo en los ejes que el usuario no ha tocado**: alargar
 * un hueso lo adelgaza (el squash de dibujo animado), pero arrastrar el centro para
 * hacerlo todo mas grande no tiene por que adelgazar nada, que ahi el usuario esta
 * pidiendo las tres medidas y no hay nada que repartir.
 *
 * @param {{x:number,y:number,z:number}} inicio  los tres factores al empezar
 * @param {{x:number,y:number,z:number}} pedido  los tres que salen del giroscopio
 * @returns {{x:number,y:number,z:number}} lo que hay que escribirle al hueso
 */
export function ajustarEjes(inicio, pedido, { eje = -1, volumen = true, suave = DEFORM_SUAVE, paso = 0 } = {}) {
  const i0 = [inicio?.x, inicio?.y, inicio?.z].map((v) => (v > 0 ? v : 1));
  const p0 = [pedido?.x, pedido?.y, pedido?.z].map((v, j) => (v > 0 ? v : i0[j]));
  const out = i0.map((v, j) => v * (p0[j] / v) ** suave);
  // Lo que ha cambiado el largo en este arrastre es lo que se le descuenta al
  // grosor, y solo a los ejes que no se estan arrastrando.
  const r = eje >= 0 ? out[eje] / i0[eje] : 1;
  if (volumen && Math.abs(r - 1) > 1e-6) {
    for (let j = 0; j < 3; j++) {
      if (j === eje || Math.abs(p0[j] / i0[j] - 1) > 1e-3) continue;
      out[j] /= Math.sqrt(r);
    }
  }
  const red = (v) => (paso > 0 ? Math.round(v / paso) * paso : v);
  return { x: red(out[0]), y: red(out[1]), z: red(out[2]) };
}

/**
 * Donde flota el tirador de volumen de un hueso, y al reves: que largo y grosor
 * esta pidiendo un punto. Las dos cuentas van juntas porque son la inversa una de
 * la otra, y es eso lo que mantiene el tirador pegado al raton mientras se
 * arrastra: se dibuja exactamente donde el punto lo pondria.
 *
 * El marco es el del eslabon: `a` es la articulacion de arriba, `eje` la direccion
 * al hueso siguiente, `perp` el lado por el que se aparta, y `base` el largo que
 * tendria el eslabon sin deformar (el natural por el estirado de la cadena). El
 * tirador va a **media altura** del eslabon, asi que el largo sale por dos; y de
 * lado se mide en brazos de palanca, asi que apartarlo un brazo mas es engordar el
 * hueso al doble.
 * @param {{a:THREE.Vector3,eje:THREE.Vector3,perp:THREE.Vector3,base:number,k?:number,g?:number}} m
 */
export function tweakPoint(m, out = new THREE.Vector3()) {
  return out.copy(m.a)
    .addScaledVector(m.eje, m.base * (m.k ?? 1) * 0.5)
    .addScaledVector(m.perp, m.base * (m.g ?? 1) * TWEAK_OFF);
}

/**
 * La inversa de `tweakPoint`: el largo y el grosor que pide un punto de mundo.
 * @param {{a:THREE.Vector3,eje:THREE.Vector3,base:number}} m
 * @param {THREE.Vector3} punto
 * @returns {{k:number,g:number}}
 */
export function tweakFactors(m, punto) {
  const base = Math.max(1e-6, m.base);
  _d.copy(punto).sub(m.a);
  const largo = _d.dot(m.eje);
  const grueso = _d.addScaledVector(m.eje, -largo).length();
  return { k: 2 * largo / base, g: grueso / (base * TWEAK_OFF) };
}

export class ManualPosing {
  /**
   * @param {object} deps
   * @param {import('../core/Settings.js').Settings} deps.settings
   * @param {import('../core/Viewport.js').Viewport} deps.viewport
   * @param {import('../model/Character.js').Character} deps.character
   * @param {(info: {key: string, label: string}|null) => void} [deps.onSelect]
   */
  constructor({ settings, viewport, character, onSelect }) {
    this.settings = settings;
    this.viewport = viewport;
    this.character = character;
    this.onSelect = onSelect ?? null;

    this.enabled = false;
    this.selected = null;      // { key, label, bone, kind, chain }
    this.handles = new THREE.Group();
    this.handles.name = 'PosingHandles';
    this.handles.visible = false;
    this.entries = [];         // { key, label, bone, mesh, kind, chain, finger }
    this.history = [];
    this.dragging = false;
    /** Largo y grosor del hueso al empezar a deformar; null si no se esta. */
    this.deformStart = null;
    /** Marco congelado del tirador de posicion que se arrastra; null si no hay. */
    this.posStart = null;
    /** Paso del imantado al deformar (0 = libre). */
    this.deformStep = 0;

    /** Cinematica inversa: cadenas, objetivos y fijaciones. */
    this.rig = new IKRig(character ?? null, settings);
    /** Huesos que ya tienen control de cinematica inversa (su esfera se esconde). */
    this.taken = new Set();
    /** Mallas visibles, que son las unicas que aceptan el raycast. */
    this.pickable = [];
    /** Ensenar solo los manejadores que hay junto al puntero. */
    this.proximity = settings.get('pose.proximity') === true;
    /** Radio de ese entorno, en alturas de visor. */
    this.proxRadius = this.#radius(settings.get('pose.proximityRadius'));

    this.material = new THREE.MeshBasicMaterial({
      color: 0x4fc1ff, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false,
    });
    this.materialHover = this.material.clone();
    this.materialHover.color.set(0x9cdcfe);
    this.materialHover.opacity = 0.85;
    this.materialActive = this.material.clone();
    this.materialActive.color.set(0xffd479);
    this.materialActive.opacity = 0.95;
    // Un material por papel: el color dice que hace el manejador y la forma lo
    // confirma, asi que se distingue tambien a contraluz o con la figura oscura.
    this.matGoal = this.material.clone();
    this.matGoal.color.set(0x4ec9b0);
    this.matGoal.opacity = 0.8;
    this.matPinned = this.material.clone();
    this.matPinned.color.set(0xce9178);
    this.matPinned.opacity = 0.92;
    this.matPole = this.material.clone();
    this.matPole.color.set(0xc586c0);
    this.matPole.opacity = 0.7;
    this.matBody = this.material.clone();
    this.matBody.color.set(0xdcdcaa);
    this.matBody.opacity = 0.75;
    // El pliegue lleva el morado del polo, que es su vecino y su primo: los dos
    // deciden por donde pasa el codo, solo que este ademas da de si los huesos.
    this.matBend = this.material.clone();
    this.matBend.color.set(0xc586c0);
    this.matBend.opacity = 0.85;
    this.matTweak = this.material.clone();
    this.matTweak.color.set(0xb5cea8);
    this.matTweak.opacity = 0.72;

    // Guias: del polo al codo, del objetivo a la punta cuando no alcanza, y del
    // hueso a su tirador de volumen, que si no parece flotar sin dueño.
    this.hintMat = new THREE.LineBasicMaterial({
      color: 0xc586c0, transparent: true, opacity: 0.45, depthTest: false, depthWrite: false,
    });
    this.hintGeo = new THREE.BufferGeometry();
    this.hintGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_HINTS * 6), 3));
    this.hints = new THREE.LineSegments(this.hintGeo, this.hintMat);
    this.hints.name = 'PosingHints';
    this.hints.renderOrder = 998;
    this.hints.frustumCulled = false;
    this.hints.visible = false;
    this.handles.add(this.hints);

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.hovered = null;

    this.proxy = new THREE.Object3D();
    this.proxy.name = 'PosingProxy';

    this.gizmo = new TransformControls(viewport.cameras.active, viewport.renderer.domElement);
    this.gizmo.setMode('rotate');
    this.gizmo.size = 0.85;
    // Los ejes del giro son los del panel de poses, no los del editor de escena: en
    // un hueso "sobre si mismo" quiere decir otra cosa que en una caja, y con dos
    // ajustes cada cosa se deja como se quiera tener.
    this.gizmo.setSpace(settings.get('pose.space') === 'local' ? 'local' : 'world');
    this.#applySnap(settings.get('scene.snap'));
    this.offs = [
      settings.on('pose.space', (v) => this.gizmo.setSpace(v === 'local' ? 'local' : 'world')),
      settings.on('scene.snap', (v) => this.#applySnap(v)),
      // Mover o girar es el mismo ajuste que en el editor de escena (teclas W/E),
      // asi que el control de una mano sirve para las dos cosas sin botones nuevos.
      settings.on('scene.tool', () => { if (this.selected) this.#applyMode(this.selected); }),
      settings.on('ik.*', (_v, _p, path) => this.#onIKSetting(path)),
      settings.on('pose.*', () => this.#onPoseSetting()),
    ];
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.dragging = e.value;
      viewport.cameras.controls.enabled = !e.value;
      if (e.value) {
        this.#pushHistory();
        this.#holdStart();
        // Punto de partida del deformado: el suavizado y el volumen se miden desde
        // aqui, que es tambien de donde parte el giroscopio (`_scaleStart`), asi que
        // arrastrar es una funcion del raton y no se va acumulando por fotograma.
        this.deformStart = this.#deformable(this.selected)
          ? this.character.boneDeform(this.selected.boneKey, new THREE.Vector3())
          : null;
        // Y los tiradores de posicion se miden contra el esqueleto tal como estaba
        // al empezar. Releer el marco en cada evento es una realimentacion: alargar
        // un hueso hace que el solucionador gire la cadena, con la cadena gira el
        // eje contra el que se mide, y el tirador se va solo aunque el raton este
        // parado. Congelado, cada evento es una funcion del raton y nada acumula.
        this.posStart = this.#posStart(this.selected);
      } else {
        this.rig.hold.clear();
        this.deformStart = null;
        this.posStart = null;
      }
    });
    this.gizmo.addEventListener('objectChange', () => this.#applyProxy());

    viewport.add(this.handles, this.proxy);
    this.helper = this.gizmo.getHelper?.() ?? this.gizmo;
    viewport.add(this.helper);
    this.helper.visible = false;

    this._onPointerDown = (e) => this.#onPointerDown(e);
    this._onPointerMove = (e) => this.#onPointerMove(e);
    viewport.renderer.domElement.addEventListener('pointerdown', this._onPointerDown);
    viewport.renderer.domElement.addEventListener('pointermove', this._onPointerMove);

    this.unsubscribe = viewport.onFrame(() => this.#sync());
  }

  /**
   * Imantado de la rotacion: el mismo valor que usa el gizmo de la escena. Con
   * imantado activo los huesos giran de 15 en 15 grados, que es como se ajusta un
   * maniqui de madera de verdad.
   */
  #applySnap(v) {
    const n = Number(v) || 0;
    this.gizmo.rotationSnap = n > 0 ? 15 * Math.PI / 180 : null;
    // El mismo paso que el gizmo de la escena: arrastrar un objetivo imantado se
    // mueve de 10 en 10 cm, comodo para plantar los pies en una linea.
    this.gizmo.translationSnap = n > 0 ? n : null;
    // Deformar se imanta al final, sobre el largo y el grosor ya suavizados: si lo
    // hiciera el giroscopio, el suavizado desharia el redondeo y saldrian numeros
    // como 1,1473 con el imantado puesto.
    this.gizmo.scaleSnap = null;
    this.deformStep = n > 0 ? DEFORM_PASO : 0;
  }

  /** Reconstruye los manejadores a partir de los huesos posables del modelo. */
  rebuild() {
    // La geometria es compartida por todos los manejadores: no se destruye.
    for (const entry of this.entries) this.handles.remove(entry.mesh);
    this.entries.length = 0;
    this.select(null);
    this.rig.character = this.character ?? null;
    this.rig.rebuild();
    if (!this.character?.loaded) { this.#refresh(); return; }

    // Las falanges solo se ofrecen si el usuario las pide: son 30 esferas mas.
    const fingers = this.settings.get('hands.fingers') === true;
    for (const { key, label, bone, finger } of this.character.posableBones({ fingers })) {
      this.#addHandle({ key, label, bone, finger: !!finger, kind: 'joint', geo: HANDLE_GEO });
    }
    for (const chain of this.rig.chains) {
      this.#addHandle({
        key: `ik:${chain.id}`, label: chain.def.handle ?? chain.def.label, bone: chain.tip,
        boneKey: chain.tipKey, kind: 'effector', chain, geo: GOAL_GEO,
      });
      if (chain.mid) {
        this.#addHandle({
          key: `pole:${chain.id}`, label: chain.def.pole ?? chain.def.label, bone: chain.mid,
          boneKey: chain.midKey, kind: 'pole', chain, geo: CUBE_GEO,
        });
        // El pliegue va sobre la misma articulacion que el polo, pero manda otra
        // cosa: el polo gira el miembro alrededor del eje mano-hombro y este saca
        // la articulacion de la linea alargando los dos eslabones.
        this.#addHandle({
          key: `bend:${chain.id}`, label: `Pliegue de ${chain.def.pole ?? chain.def.label}`,
          bone: chain.mid, kind: 'bend', chain, geo: HANDLE_GEO,
        });
      }
      // Un tirador de volumen por hueso de la cadena, y solo si el siguiente del
      // camino cuelga de el: el largo se hace moviendo al hijo, asi que sin hijo
      // en la cadena no hay eslabon que estirar.
      const camino = [...chain.bones, chain.tip];
      for (let i = 0; i < chain.bones.length; i++) {
        const hueso = chain.bones[i];
        const clave = chain.keys[i];
        if (!clave || camino[i + 1]?.parent !== hueso) continue;
        this.#addHandle({
          key: `tweak:${chain.id}:${i}`, label: `Volumen · ${BONE_LABELS[clave] ?? clave}`,
          bone: hueso, boneKey: clave, kind: 'tweak', chain, index: i, geo: TWEAK_GEO,
        });
      }
    }
    if (this.character.bones?.hips) {
      this.#addHandle({
        key: 'ik:body', label: 'Peso del cuerpo', bone: this.character.bones.hips,
        boneKey: 'hips', kind: 'body', geo: CUBE_GEO,
      });
    }
    this.#refresh();
  }

  /** Crea una malla de manejador y la registra. */
  #addHandle({ key, label, bone, mesh, finger = false, kind, chain = null, boneKey = '', index = -1, geo }) {
    const malla = mesh ?? new THREE.Mesh(geo, this.material);
    malla.name = `handle:${key}`;
    malla.renderOrder = 999;
    malla.frustumCulled = false;
    malla.userData.key = key;
    this.handles.add(malla);
    const entry = {
      key, label, bone, mesh: malla, finger, kind, chain, index,
      boneKey: boneKey || (kind === 'joint' ? key : ''),
      // `shown` es lo que dicen las reglas y `near` (0..1) lo que dice el puntero:
      // el manejador se ve cuando las dos cosas estan de acuerdo.
      shown: false,
      near: 1,
    };
    malla.material = this.#materialFor(entry);
    this.entries.push(entry);
    return entry;
  }

  /**
   * Que manejadores se ven y cuales aceptan el clic. Se recalcula al cambiar de
   * modelo o de ajuste, nunca por fotograma: leer el almacen 40 veces en cada
   * cuadro no aporta nada.
   */
  #refresh() {
    const ik = this.rig.on;
    this.taken.clear();
    if (ik) {
      // Todos los huesos de una cadena encendida, no solo su punta. Girar a mano el
      // hombro de un brazo en cinematica inversa es pelear con el solucionador: el
      // hueso se mueve y vuelve al fotograma siguiente, deformando la figura por el
      // camino. Un rig de produccion tampoco los ofrece. Quien quiera girarlos
      // apaga esa cadena en **Cadenas** y recupera la cinematica directa entera.
      for (const chain of this.rig.chains) {
        if (!this.rig.live(chain)) continue;
        for (const hueso of chain.bones) this.taken.add(hueso);
        this.taken.add(chain.tip);
      }
      if (this.settings.get('ik.body') !== false && this.character?.bones?.hips) {
        this.taken.add(this.character.bones.hips);
      }
    }
    for (const entry of this.entries) {
      entry.shown = this.#visible(entry, ik);
      if (entry !== this.selected) entry.mesh.material = this.#materialFor(entry);
    }
    this.hints.visible = ik;
    // El elegido se suelta si las reglas lo apagan, no si el puntero se ha ido
    // lejos: por proximidad se esconde, pero sigue siendo el elegido.
    if (this.selected && !this.selected.shown) this.select(null);
    this.#visibilityPass();
  }

  /**
   * Que se ve y que acepta el clic, a partir de las reglas (`shown`) y de la
   * cercania al puntero (`near`). Las dos listas se rehacen juntas a proposito: el
   * raycast de three no mira `visible`, asi que en cuanto se separan aparece el
   * manejador invisible que roba el clic.
   */
  #visibilityPass() {
    this.pickable.length = 0;
    for (const entry of this.entries) {
      const near = entry.shown ? (this.proximity ? entry.near : 1) : 0;
      entry.mesh.visible = near > 0;
      if (entry.mesh.visible) this.pickable.push(entry.mesh);
    }
  }

  /** Reglas de visibilidad de un manejador. */
  #visible(entry, ik = this.rig.on) {
    if (entry.kind === 'joint') return !ik || !this.taken.has(entry.bone);
    if (!ik) return false;
    if (entry.kind === 'body') return this.settings.get('ik.body') !== false;
    if (!this.rig.live(entry.chain)) return false;
    if (entry.kind === 'pole') return this.settings.get('ik.poles') !== false;
    // El pliegue y los tiradores de volumen son lo que sustituye a la esfera de
    // giro: en modo inverso se deforma por posicion, y por eso van juntos en un
    // solo interruptor.
    if (entry.kind === 'bend' || entry.kind === 'tweak') {
      return this.settings.get('ik.deform') !== false;
    }
    return true;
  }

  /** Material de reposo segun el papel del manejador. */
  #materialFor(entry) {
    if (entry.kind === 'effector') return entry.chain?.pinned ? this.matPinned : this.matGoal;
    if (entry.kind === 'pole') return this.matPole;
    if (entry.kind === 'body') return this.matBody;
    if (entry.kind === 'bend') return this.matBend;
    if (entry.kind === 'tweak') return this.matTweak;
    return this.material;
  }

  /**
   * Cambio de ajuste de cinematica inversa. Al encenderla los objetivos se toman
   * de la pose que haya, que es lo unico que no mueve nada al activar el modo.
   */
  #onIKSetting(path = '') {
    // Cambiar de directa a inversa no es cambiar de pose: el estirado que hubiera
    // puesto el squash se queda, para que la silueta sea la misma a los dos lados
    // del interruptor. En cinematica directa ese largo se maneja a mano, con la
    // escala de los huesos, que es la otra cara del mismo aplastado.
    if (path === 'ik.enabled') this.rig.syncAll({ stretch: false });
    else if (path.startsWith('ik.pins.')) this.rig.readPins();
    // La reserva de estirado cambia el resultado sin mover nada: hay que pedir
    // expresamente que las cadenas fijadas se rehagan.
    else if (path === 'ik.margin') this.rig.invalidate();
    else if (path === 'ik.stretch' || path === 'ik.stretchMax') {
      // Al apagarlo los miembros recuperan su largo en el acto, y los objetivos
      // sueltos bajan con la punta: el manejador de una mano es su objetivo, asi
      // que sin esto se quedaria colgado donde llegaba el brazo estirado. Encendido
      // no mueve nada por si mismo, pero las cadenas sujetas se rehacen para que la
      // que no alcanzaba llegue ya, sin esperar a que se arrastre otra vez.
      if (!this.rig.stretchOn && this.rig.resetStretch()) this.rig.syncLoose();
      this.rig.invalidate();
      this.rig.solveHeld();
      this.character?.tick?.();
      this.viewport.invalidateShadows?.();
    }
    this.#refresh();
  }

  /**
   * Cambio de ajuste del posado. Los dos valores viven en campos porque el paso de
   * proximidad los consulta por manejador y por fotograma, y leer el almacen
   * cuarenta veces en cada cuadro no aporta nada.
   */
  #onPoseSetting() {
    this.proximity = this.settings.get('pose.proximity') === true;
    this.proxRadius = this.#radius(this.settings.get('pose.proximityRadius'));
    // Al apagarla vuelven todos de golpe; al encenderla los aparta el paso del
    // fotograma siguiente, que es el primero que sabe donde esta el puntero.
    if (!this.proximity) for (const entry of this.entries) entry.near = 1;
    this.#visibilityPass();
  }

  /** Radio del entorno del puntero, en alturas de visor y con topes sanos. */
  #radius(v) {
    const n = Number(v);
    return Number.isFinite(n) ? THREE.MathUtils.clamp(n, 0.04, 0.6) : 0.16;
  }

  /**
   * Cambia la figura que se posa a mano. El historial de deshacer se vacia: sus
   * poses son de otro esqueleto.
   */
  setCharacter(character) {
    if (this.character === character) return this;
    this.character = character;
    this.clearHistory();
    this.rebuild();
    return this;
  }

  setEnabled(on) {
    this.enabled = !!on;
    this.handles.visible = this.enabled;
    this.rig.hold.clear();
    if (!this.enabled) {
      this.select(null);
      this.gizmo.enabled = false;
    } else {
      this.gizmo.enabled = true;
      if (!this.entries.length) this.rebuild();
      else this.#refresh();
    }
  }

  select(key) {
    const entry = key ? this.entries.find((e) => e.key === key) : null;
    for (const e of this.entries) e.mesh.material = this.#materialFor(e);
    this.selected = entry ?? null;

    if (!entry) {
      this.gizmo.detach();
      this.helper.visible = false;
      this.#reportDeform(null);
      this.onSelect?.(null);
      return;
    }
    entry.mesh.material = this.materialActive;
    this.#applyMode(entry);
    this.#placeProxy(entry);
    this.gizmo.attach(this.proxy);
    this.helper.visible = true;
    this.#reportDeform(entry);
    this.onSelect?.({ key: entry.key, label: entry.label, boneKey: entry.boneKey });
  }

  /**
   * Que hace el giroscopio con este manejador. El polo solo se mueve y las
   * articulaciones solo giran; los objetivos y la cadera hacen lo que diga
   * `scene.tool`, de modo que `W` coloca la mano y `E` gira la muñeca sin salir
   * del modo. `R` deforma, y esa vale en todos menos en el polo: el tirador que va a
   * lo largo del hueso lo alarga y los otros dos lo engordan, que es lo que convierte
   * el maniqui en un rig de dibujo animado.
   */
  #applyMode(entry) {
    const tool = this.settings.get('scene.tool');
    const libre = entry.kind === 'effector' || entry.kind === 'body';
    // El pliegue y el volumen deforman por posicion: siempre se mueven, tambien con
    // `E` o `R` puestos. Son justamente lo que sustituye al giroscopio.
    const modo = this.#positional(entry) || entry.kind === 'pole' ? 'translate'
      : (tool === 'scale' && this.#deformable(entry)) ? 'scale'
        : entry.kind === 'joint' ? 'rotate'
          : (libre && tool === 'rotate') ? 'rotate' : 'translate';
    if (this.gizmo.mode !== modo) this.gizmo.setMode(modo);
  }

  /** ¿Este manejador deforma arrastrando su posicion en vez de con el gizmo? */
  #positional(entry) {
    return entry?.kind === 'bend' || entry?.kind === 'tweak';
  }

  /** Que hueso deforma este manejador; '' si ninguno. */
  #deformKey(entry) {
    // El polo solo gira el plano y el pliegue toca dos huesos a la vez, asi que
    // ninguno de los dos tiene un hueso propio que ensenar ni que limpiar.
    if (!entry || entry.kind === 'pole' || entry.kind === 'bend' || !entry.boneKey) return '';
    return this.character?.bones?.[entry.boneKey] ? entry.boneKey : '';
  }

  /** ¿Se puede deformar el hueso de este manejador con el gizmo de escala (`R`)? */
  #deformable(entry) {
    return !this.#positional(entry) && !!this.#deformKey(entry);
  }

  /** Coloca el objeto que arrastra el giroscopio donde toca segun el manejador. */
  #placeProxy(entry) {
    const p = this.proxy;
    // La escala arranca en la deformacion que ya lleva el hueso: asi el gizmo de
    // escalar sigue desde donde se dejo en vez de saltar a 1.
    if (this.#deformable(entry)) this.character.boneDeform(entry.boneKey, p.scale);
    else p.scale.set(1, 1, 1);
    if (entry.kind === 'pole' || this.#positional(entry)) {
      // Sin orientacion: son puntos, y el giroscopio de mover con ejes de mundo es
      // lo unico que hace falta para llevarlos a donde se quiere.
      if (this.#pointOf(entry, _v)) p.position.copy(_v);
      p.quaternion.identity();
      p.scale.set(1, 1, 1);
      return;
    }
    if (entry.kind === 'effector') {
      // La posicion la manda el objetivo y la orientacion el hueso de la punta:
      // asi el modo girar trabaja sobre los ejes de la muñeca o del pie.
      this.rig.targetWorld(entry.chain, p.position);
      entry.bone.updateWorldMatrix(true, false);
      entry.bone.matrixWorld.decompose(_v, p.quaternion, _s);
      return;
    }
    entry.bone.updateWorldMatrix(true, false);
    entry.bone.matrixWorld.decompose(p.position, p.quaternion, _s);
  }

  /**
   * Que cadenas sujetan su objetivo mientras dura este arrastre. Arrastrar el peso
   * del cuerpo con las piernas en cinematica inversa planta los pies: es el gesto
   * de la sentadilla, y no hace falta fijar nada a mano para conseguirlo.
   */
  #holdStart() {
    this.rig.hold.clear();
    const entry = this.selected;
    if (!entry || !this.rig.on) return;
    // El pliegue sujeta su cadena por la misma razon que el objetivo: la mano se
    // queda donde esta y lo que cede es el largo de los huesos.
    if (entry.kind === 'effector' || entry.kind === 'bend') this.rig.hold.add(entry.chain.id);
    if (entry.kind === 'body') {
      for (const chain of this.rig.chains) {
        if (chain.def.group === 'legs' && this.rig.live(chain)) this.rig.hold.add(chain.id);
      }
    }
  }

  /** Traslada lo que hace el giroscopio al hueso o a la cadena seleccionada. */
  #applyProxy() {
    const entry = this.selected;
    if (!entry) return;
    const girando = this.gizmo.mode === 'rotate';
    if (this.gizmo.mode === 'scale') {
      // Deformar es lo mismo en directa que en inversa: se escribe la escala del
      // hueso, no un objetivo, asi que vale para la rodilla de un rig de dibujo
      // animado con la cadena resolviendose encima.
      this.#deformBone(entry);
    } else if (entry.kind === 'pole') {
      // El polo gira el plano del pliegue con la punta clavada: el tercer paso del
      // solucionador gira sobre el eje hombro-objetivo, que no puede mover la mano.
      this.rig.solve(entry.chain, this.proxy.position);
    } else if (entry.kind === 'bend') {
      this.#bendLimb(entry);
    } else if (entry.kind === 'tweak') {
      this.#tweakBone(entry);
    } else if (entry.kind === 'effector' && !girando) {
      this.rig.setTargetWorld(entry.chain, this.proxy.position);
    } else if (entry.kind === 'body' && !girando) {
      this.#moveBone(entry.bone);
    } else {
      this.#rotateBone(entry.bone);
    }
    // Las cadenas sujetas (fijadas o retenidas por este arrastre) se rehacen en
    // orden de dependencia, asi que la que se arrastra se resuelve tambien aqui.
    this.rig.solveHeld();
    this.character?.tick?.();
    // La figura se ha movido: su sombra ya no vale.
    this.viewport.invalidateShadows?.();
    // El posado manual manda: se congela la captura para que no lo sobrescriba.
    if (this.settings.get('mocap.frozen') !== true) this.settings.set('mocap.frozen', true);
  }

  /** Escribe en el hueso el giro de mundo del giroscopio. */
  #rotateBone(bone) {
    const parent = bone.parent;
    if (parent) {
      parent.updateWorldMatrix(true, false);
      parent.matrixWorld.decompose(_v, _pq, _s);
      bone.quaternion.copy(_pq.invert()).multiply(this.proxy.quaternion);
    } else {
      bone.quaternion.copy(this.proxy.quaternion);
    }
    bone.updateMatrix();
    bone.updateWorldMatrix(false, true);
  }

  /**
   * Deforma el hueso del manejador con lo que arrastra el giroscopio, pasado antes
   * por `ajustarEjes`: eje a eje, suavizado para que no se dispare y con el volumen
   * puesto si esta pedido. En modo escala el giroscopio de three orienta sus
   * manejadores con el giro de mundo del objeto, y el proxy lleva el del hueso, asi
   * que sus tres ejes son ya los tres ejes del hueso: lo que se arrastra es lo que
   * se engorda. La deformacion vive en el personaje, asi que viaja con la pose y se
   * deshace con ella; el estirado del IK se vuelve a poner encima, que es lo que
   * compone las tres capas.
   */
  #deformBone(entry) {
    if (!this.#deformable(entry)) return;
    const key = entry.boneKey;
    const f = ajustarEjes(this.deformStart ?? this.character.boneDeform(key, _s),
      this.proxy.scale, {
        eje: this.character.lengthAxis(this.character.bones[key]),
        volumen: this.settings.get('pose.deformVolume') !== false,
        paso: this.deformStep,
      });
    this.character.setBoneScale(key, f);
    // Y de vuelta al giroscopio lo que el hueso tiene de verdad, con los topes y el
    // suavizado ya puestos, para que no quede apuntando a un tamano que no existe.
    this.character.boneDeform(key, this.proxy.scale);
    this.rig.applyStretch();
    this.#reportDeform(entry);
  }

  /**
   * Marco de referencia de un tirador de posicion, tomado al empezar el arrastre.
   *
   * El largo de mundo de un eslabon es `natural × k × estirado`, donde `k` es el
   * largo que el usuario le ha puesto al hueso de arriba (deformar mueve al hijo) y
   * el estirado es el de la cadena entera. Midiendo el eslabon ahora y dividiendo
   * por lo que ya lleva puesto sale su largo natural, que es la unidad en la que
   * hay que traducir la distancia del raton. Se guarda una sola vez porque el
   * esqueleto se mueve mientras se arrastra: ver mas arriba, en `dragging-changed`.
   *
   * @returns {{kind:string}|null} `null` si este manejador no deforma por posicion
   */
  #posStart(entry) {
    if (!this.#positional(entry) || !this.character?.loaded) return null;
    const chain = entry.chain;
    if (!chain) return null;
    const s = chain.stretch || 1;
    const camino = [...chain.bones, chain.tip];
    const factores = (clave) => (this.character.bones?.[clave]
      ? this.character.boneFactors(clave)
      : { k: 1, g: 1 });
    if (entry.kind === 'bend') {
      if (!chain.mid) return null;
      const keys = [chain.keys[0], chain.keys[1]];
      const f = keys.map(factores);
      const nat = [0, 1].map((i) => worldOf(camino[i], _a).distanceTo(worldOf(camino[i + 1], _b))
        / Math.max(1e-6, f[i].k * s));
      if (nat.some((v) => !(v > 1e-6))) return null;
      return { kind: 'bend', keys, f, nat };
    }
    const hijo = this.#tweakChild(entry);
    if (!hijo) return null;
    const f = factores(entry.boneKey);
    const a = worldOf(entry.bone, new THREE.Vector3());
    const eje = worldOf(hijo, new THREE.Vector3()).sub(a);
    const largo = eje.length();
    if (largo < 1e-6) return null;
    return { kind: 'tweak', a, eje: eje.divideScalar(largo), f, nat: largo / Math.max(1e-6, f.k * s) };
  }

  /**
   * El pliegue: lleva el codo o la rodilla a un punto y los dos eslabones dan de si
   * lo justo para llegar, con la mano quieta en su objetivo. Es el gesto de un rig
   * de dibujo animado —deformar **por posicion**, no con el giroscopio— y es lo que
   * sustituye a girar los huesos a mano cuando la cadena esta encendida.
   *
   * La cuenta es directa: el eslabon de arriba tiene que medir `|hombro − raton|` y
   * el de abajo `|raton − objetivo|`. Se escriben esos dos largos y se resuelve la
   * cadena usando el propio tirador como polo, asi que la articulacion aterriza
   * justo debajo del raton: el punto pedido cumple las dos distancias y el polo
   * elige de que lado del eje se dobla. La desigualdad triangular garantiza que
   * llega siempre, y lo unico que separa la articulacion del raton es la holgura
   * que el solucionador reserva para no bloquear la articulacion del todo.
   */
  #bendLimb(entry) {
    const st = this.posStart;
    if (!st || st.kind !== 'bend') return;
    const chain = entry.chain;
    const p = this.proxy.position;
    const a = this.rig.rootWorld(chain, _a);
    const t = this.rig.targetWorld(chain, _b);
    // El estirado de la cadena se lee ahora, no al empezar: con squash y stretch
    // encendido el solucionador lo retoca al resolver, y en las poses casi rectas
    // deja al raton un par de puntos por ciento por delante del codo.
    const s = chain.stretch || 1;
    const dist = [a.distanceTo(p), p.distanceTo(t)];
    const volumen = this.settings.get('pose.deformVolume') !== false;
    for (let i = 0; i < 2; i++) {
      const clave = st.keys[i];
      if (!clave || !this.character.bones?.[clave]) continue;
      // `suave: 1` deja pasar el largo tal cual: el tirador no es un gizmo de
      // escala, es un punto, y suavizarlo lo desengancharia del raton.
      const f = ajustarDeform(st.f[i], { k: dist[i] / Math.max(1e-6, st.nat[i] * s), g: st.f[i].g },
        { volumen, suave: 1, paso: this.deformStep });
      this.character.setBoneFactors(clave, f.k, f.g);
    }
    this.rig.applyStretch();
    this.rig.solve(chain, p);
    this.#reportDeform(entry);
  }

  /** El hueso siguiente en el camino de la cadena; `null` si el tirador no vale. */
  #tweakChild(entry) {
    const chain = entry.chain;
    if (!chain || entry.index < 0) return null;
    const hijo = entry.index + 1 < chain.bones.length ? chain.bones[entry.index + 1] : chain.tip;
    return hijo?.parent === entry.bone ? hijo : null;
  }

  /**
   * El tirador de volumen: un punto que flota a media altura del hueso y apartado
   * de su eje. Correrlo a lo largo alarga el hueso y apartarlo lo engorda, las dos
   * cosas a la vez y sin tocar el giroscopio.
   *
   * La cuenta es la inversa exacta de donde se dibuja (`#tweakPoint`), que es lo que
   * lo mantiene pegado al raton: la parte del arrastre que va sobre el eje es medio
   * hueso, y de ahi el 2; la que va de lado se mide en brazos de palanca, asi que
   * apartarlo un brazo mas es engordar el hueso al doble. El volumen automatico se
   * queda fuera a proposito: aqui la posicion ya dice las dos cosas, y descontar el
   * grosor por el largo pelearia con lo que el raton esta pidiendo.
   */
  #tweakBone(entry) {
    const st = this.posStart;
    if (!st || st.kind !== 'tweak') return;
    const key = entry.boneKey;
    if (!this.character?.bones?.[key]) return;
    const base = st.nat * (entry.chain?.stretch || 1);
    const f = ajustarDeform(st.f, tweakFactors({ a: st.a, eje: st.eje, base }, this.proxy.position),
      { volumen: false, suave: 1, paso: this.deformStep });
    this.character.setBoneFactors(key, f.k, f.g);
    this.rig.applyStretch();
    this.#reportDeform(entry);
  }

  /**
   * Donde se dibuja el tirador de volumen de un hueso: a media altura de su eslabon
   * y apartado hacia el lado por el que se dobla el miembro, que es el lado por el
   * que la figura no lo tapa. El brazo crece con el grosor y se divide por el largo
   * porque el eslabon ya viene multiplicado por el, y sin eso el tirador se
   * despegaria del raton en cuanto el hueso cambiara de tamano.
   */
  #tweakPoint(entry, out) {
    const hijo = this.#tweakChild(entry);
    if (!hijo) return false;
    const a = worldOf(entry.bone, _a);
    const largo = a.distanceTo(worldOf(hijo, _b));
    if (largo < 1e-6) return false;
    const eje = _e.copy(_b).sub(a).divideScalar(largo);
    const perp = this.rig.bendWorld(entry.chain, _n);
    perp.addScaledVector(eje, -perp.dot(eje));
    // Hueso alineado con la direccion del pliegue (pasa en la columna): cualquier
    // perpendicular sirve, con tal de que no cambie de fotograma a fotograma.
    if (perp.lengthSq() < 1e-8) perp.set(0, 1, 0).addScaledVector(eje, -eje.y);
    if (perp.lengthSq() < 1e-8) perp.set(1, 0, 0).addScaledVector(eje, -eje.x);
    perp.normalize();
    const f = this.character?.bones?.[entry.boneKey]
      ? this.character.boneFactors(entry.boneKey)
      : null;
    const k = f ? Math.max(0.05, f.k) : 1;
    // El largo de mundo del eslabon ya viene multiplicado por `k`, asi que dividir
    // por el devuelve la base con la que se hizo la cuenta al arrastrarlo.
    tweakPoint({ a, eje, perp, base: largo / k, k, g: f ? f.g : 1 }, out);
    return true;
  }

  /** Deja a la vista del panel cuanto se ha deformado el hueso elegido. */
  #reportDeform(entry = this.selected) {
    let txt = '';
    if (entry?.kind === 'bend') {
      // El pliegue no tiene un hueso: tiene los dos eslabones del miembro, y lo que
      // interesa ver mientras se arrastra es cuanto ha dado de si cada uno.
      const ks = (entry.chain?.keys ?? []).slice(0, 2)
        .map((k) => (this.character?.bones?.[k] ? this.character.boneFactors(k).k : 1));
      if (ks.length === 2) txt = 'largos ' + ks[0].toFixed(2) + ' + ' + ks[1].toFixed(2);
    } else {
      const key = this.#deformKey(entry);
      if (key) {
        // Los tres ejes tal cual, que es lo que se esta arrastrando: el largo y
        // luego el grosor, un numero si los dos lados van iguales y dos si no.
        const a = this.character.boneDeform(key, _s).toArray();
        const i = this.character.lengthAxis(this.character.bones[key]);
        const g = i >= 0 ? [a[(i + 1) % 3], a[(i + 2) % 3]] : a;
        txt = a.every((v) => Math.abs(v - 1) < 1e-4) ? 'sin deformar'
          : 'largo ' + (i >= 0 ? a[i] : 1).toFixed(2) + ' · grosor '
            + [...new Set(g.map((v) => v.toFixed(2)))].join(' × ');
      }
    }
    if (this.settings.get('ui.boneDeform') !== txt) this.settings.set('ui.boneDeform', txt);
  }

  /** Lleva un hueso a un punto de mundo (solo la cadera: es la raiz de la pose). */
  #moveBone(bone) {
    const parent = bone.parent;
    if (parent) {
      parent.updateWorldMatrix(true, false);
      bone.position.copy(parent.worldToLocal(_p.copy(this.proxy.position)));
    } else {
      bone.position.copy(this.proxy.position);
    }
    bone.updateMatrix();
    bone.updateWorldMatrix(false, true);
  }

  /** Coloca los manejadores sobre las articulaciones y sigue a la camara. */
  #sync() {
    if (!this.enabled || !this.entries.length) return;
    const cam = this.viewport.cameras.active;
    if (this.gizmo.camera !== cam) this.gizmo.camera = cam;

    if (this.rig.on) {
      // Los objetivos que nadie sujeta siguen a la pose: mientras no se fije ni se
      // arrastre nada, la cinematica inversa no manda y convive con el mocap, con
      // la biblioteca de poses y con el posado hueso a hueso.
      this.rig.syncLoose();
      // Y los sujetos se rehacen si algo de arriba los ha movido. El anclaje al
      // suelo se recalcula en el acto para que no vaya un fotograma por detras.
      if (this.rig.solveHeld()) {
        this.character?.tick?.();
        this.viewport.invalidateShadows?.();
      }
    }

    // La altura es propia de cada figura, no un ajuste global.
    const height = Math.max(0.4, this.character?.placement?.height ?? 1.75);
    const base = height * 0.013;
    const prox = this.proximity;
    for (const entry of this.entries) {
      if (!entry.shown) continue;
      // Si de pronto no hay punto donde dibujar, el manejador se apaga aqui mismo,
      // y con el su turno en el raycast: una malla escondida no se puede pinchar.
      if (!this.#pointOf(entry, _v)) { this.#hide(entry); continue; }
      entry.mesh.position.copy(_v);
      // Tamaño constante en pantalla: crece con la distancia a la camara.
      const dist = cam.isOrthographicCamera
        ? (cam.top - cam.bottom) * 0.5
        : cam.position.distanceTo(_v);
      // Las falanges llevan manejadores mas finos para no tapar la mano; los
      // objetivos van algo mas gordos porque son los que se buscan con el raton.
      const f = entry.finger ? 0.4 : SIZES[entry.kind] ?? 1;
      const r = THREE.MathUtils.clamp(base * dist * 0.55 * f, base * 0.5 * f, base * 3 * f);
      // Con la proximidad encendida el manejador entra creciendo por el borde del
      // entorno en vez de encenderse de golpe: asi se ve de donde ha salido.
      entry.mesh.scale.setScalar(prox ? r * (0.55 + 0.45 * entry.near) : r);
    }
    // La cercania se repasa con las posiciones recien escritas, y antes de las
    // guias, que solo se dibujan para los objetivos que se ven.
    if (prox) this.#proximityPass();
    if (this.rig.on) this.#syncHints();
    if (this.selected && !this.dragging) this.#placeProxy(this.selected);
  }

  /** Esconde un manejador sin dejarlo en la lista de lo que acepta el raycast. */
  #hide(entry) {
    // Tambien para la proximidad: sin punto donde dibujarlo no esta cerca de nada.
    entry.near = 0;
    entry.mesh.visible = false;
    const i = this.pickable.indexOf(entry.mesh);
    if (i >= 0) this.pickable.splice(i, 1);
    if (this.selected === entry) this.select(null);
  }

  /**
   * Repasa la cercania de cada manejador al puntero y rehace la visibilidad. Se
   * llama por fotograma y tambien justo antes de mirar que hay debajo del raton:
   * el paso del fotograma va un cuadro por detras del puntero, y sin ese repaso el
   * manejador que acaba de entrar en el entorno todavia no aceptaria el clic.
   */
  #proximityPass() {
    const cam = this.viewport.cameras.active;
    // La relacion de aspecto sale de la camara una vez, no por manejador.
    const aspect = viewAspect(cam);
    for (const entry of this.entries) {
      if (entry.shown) entry.near = this.#nearOf(entry, entry.mesh.position, cam, aspect);
    }
    this.#visibilityPass();
  }

  /**
   * Cuanto asoma un manejador. Las dos excepciones que se quedan siempre a la
   * vista son el elegido, porque perder de vista lo que tiene puesto el giroscopio
   * desconcierta, y el objetivo de una cadena fijada, que avisa de que ese pie
   * esta clavado.
   */
  #nearOf(entry, point, cam, aspect) {
    if (entry === this.selected) return 1;
    if (entry.kind === 'effector' && entry.chain?.pinned) return 1;
    return nearFactor(point, cam, this.pointer, this.proxRadius, aspect);
  }

  /** Donde va el manejador de una entrada; `false` si ahora mismo no hay punto. */
  #pointOf(entry, out) {
    if (entry.kind === 'effector') return !!this.rig.targetWorld(entry.chain, out);
    if (entry.kind === 'pole') return !!this.rig.poleWorld(entry.chain, out);
    // El pliegue se dibuja en la articulacion misma, que es donde lo deja el
    // solucionador al resolver con el propio tirador como polo: asi el codo queda
    // debajo del raton en vez de a un lado.
    if (entry.kind === 'bend') return !!this.rig.midWorld(entry.chain, out);
    if (entry.kind === 'tweak') return this.#tweakPoint(entry, out);
    entry.bone.updateWorldMatrix(true, false);
    out.setFromMatrixPosition(entry.bone.matrixWorld);
    return true;
  }

  /**
   * Guias de lectura: una del polo al codo, para ver de que lado se dobla, y otra
   * del objetivo a la punta cuando el miembro no alcanza, que es la unica forma de
   * enterarse de que el brazo esta pidiendo mas largo del que tiene.
   */
  #syncHints() {
    const attr = this.hintGeo.getAttribute('position');
    const arr = attr.array;
    const holgura = Math.max(0.4, this.character?.placement?.height ?? 1.75) * 0.02;
    const polos = this.settings.get('ik.poles') !== false;
    let n = 0;
    const seg = (a, b) => {
      if (n >= MAX_HINTS) return;
      arr.set([a.x, a.y, a.z, b.x, b.y, b.z], n * 6);
      n++;
    };
    for (const entry of this.entries) {
      if (entry.kind !== 'effector' || !entry.mesh.visible) continue;
      const chain = entry.chain;
      this.rig.targetWorld(chain, _v);
      this.rig.tipWorld(chain, _p);
      // Un pelo de margen: el solucionador siempre deja un resto minimo.
      if (_v.distanceToSquared(_p) > holgura * holgura) seg(_p, _v);
      if (chain.mid && polos) {
        const polo = this.rig.poleWorld(chain, _v);
        if (polo) seg(this.rig.midWorld(chain, _p), polo);
      }
    }
    // La palanca del tirador de volumen: sin ella parece una mota suelta en el aire
    // y no se ve de que hueso cuelga ni por donde se aparta.
    for (const entry of this.entries) {
      if (entry.kind !== 'tweak' || !entry.mesh.visible) continue;
      const hijo = this.#tweakChild(entry);
      if (!hijo) continue;
      seg(worldOf(entry.bone, _v).add(worldOf(hijo, _p)).multiplyScalar(0.5), entry.mesh.position);
    }
    attr.needsUpdate = true;
    this.hintGeo.setDrawRange(0, n * 2);
    this.hints.visible = n > 0;
  }

  #pointerTo(event) {
    const rect = this.viewport.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    return this.pointer;
  }

  #pick(event) {
    if (!this.enabled || !this.pickable.length) return null;
    this.raycaster.setFromCamera(this.#pointerTo(event), this.viewport.cameras.active);
    // Solo las mallas visibles: el raycast de three no mira `visible`, y las
    // esferas escondidas debajo de un objetivo le robarian el clic.
    const hits = this.raycaster.intersectObjects(this.pickable, false);
    return hits.length ? hits[0].object.userData.key : null;
  }

  /**
   * ¿Este puntero cae sobre un manejador de articulacion? Lo consulta el editor
   * de escena para no robarle el clic al posado (y viceversa: si no hay ningun
   * manejador debajo, se puede seleccionar un solido aunque el modo pose siga
   * encendido).
   */
  picks(event) {
    return this.#pick(event) !== null;
  }

  #onPointerDown(event) {
    if (!this.enabled || this.dragging || event.button !== 0) return;
    const key = this.#pick(event);
    if (key) {
      this.select(key);
      event.stopPropagation();
    } else if (this.selected && !event.shiftKey) {
      // Clic al vacio: deselecciona, pero no si se esta arrastrando la camara.
      this.select(null);
    }
  }

  #onPointerMove(event) {
    if (!this.enabled || this.dragging) return;
    // El puntero ya esta donde estara al soltar el clic: la proximidad se repasa
    // aqui para que el manejador que acaba de entrar se pueda pinchar ahora mismo.
    if (this.proximity) { this.#pointerTo(event); this.#proximityPass(); }
    const key = this.#pick(event);
    if (key === this.hovered) return;
    for (const e of this.entries) {
      if (e === this.selected) continue;
      e.mesh.material = e.key === key ? this.materialHover : this.#materialFor(e);
    }
    this.hovered = key;
    // El cursor lo comparten el posado y el editor de escena: cada uno borra
    // solo el suyo para no pisarse.
    const dom = this.viewport.renderer.domElement;
    if (key) dom.style.cursor = 'grab';
    else if (dom.style.cursor === 'grab') dom.style.cursor = '';
  }

  // --------------------------------------------------- cinematica inversa ---

  /** La cadena del manejador seleccionado, si es de cinematica inversa. */
  get selectedChain() {
    return this.selected?.chain ?? null;
  }

  // ------------------------------------------------------------ deformacion ---

  /** El hueso que deformaria el manejador seleccionado ('' si no hay ninguno). */
  get selectedBoneKey() {
    return this.#deformKey(this.selected);
  }

  /**
   * Quita la deformacion de un hueso, o de todos si no se pasa clave. Vuelve a
   * poner el estirado del IK encima y anota el paso, para que se pueda deshacer
   * igual que un arrastre. Devuelve `false` si no habia nada que quitar.
   */
  clearDeform(key = null) {
    if (!this.character?.loaded) return false;
    this.#pushHistory();
    if (!this.character.clearDeform(key)) {
      this.history.pop();
      return false;
    }
    this.rig.applyStretch();
    this.rig.syncLoose();
    this.character.tick?.();
    this.viewport.invalidateShadows?.();
    this.#reportDeform();
    return true;
  }

  /** Cuantas cadenas hay fijadas ahora mismo. */
  get pinnedCount() {
    return this.rig.chains.reduce((n, c) => n + (c.pinned ? 1 : 0), 0);
  }

  /**
   * Vuelve a tomar los objetivos de la pose que hay. Hay que llamarlo tras
   * cualquier cambio que no venga de estos manejadores (biblioteca de poses,
   * preajustes, deshacer, una captura nueva): sin esto una cadena fijada
   * devolveria el miembro a donde estaba antes.
   */
  syncRig() {
    this.rig.syncAll();
    return this;
  }

  /** Fija o suelta la cadena del manejador seleccionado. */
  togglePin() {
    const chain = this.selectedChain;
    if (!chain) return '';
    this.rig.togglePin(chain.id);
    return chain.id;
  }

  /** Clava los dos pies donde estan: el primer gesto de casi cualquier pose. */
  pinFeet(on = true) {
    return this.rig.pinFeet(on);
  }

  /** Suelta todas las fijaciones. */
  unpinAll() {
    return this.rig.unpinAll();
  }

  // ------------------------------------------------------------- deshacer ---

  #pushHistory() {
    if (!this.character?.loaded) return;
    // La pose guarda giros y escalas de hueso, pero el estirado de las cadenas es
    // del rig y viaja al lado: sin el, deshacer devolveria los giros y dejaria el
    // brazo largo.
    this.history.push({ pose: this.character.getPose(), stretch: this.rig.stretchState() });
    if (this.history.length > 40) this.history.shift();
  }

  /** Guarda el estado actual antes de un cambio externo (poses, presets). */
  mark() {
    this.#pushHistory();
  }

  /** Olvida el historial: las poses guardadas son de otro esqueleto. */
  clearHistory() {
    this.history.length = 0;
  }

  undo() {
    const paso = this.history.pop();
    if (!paso) return false;
    this.character?.setPose(paso.pose, 1);
    // La pose de vuelta manda sobre los objetivos: si no, una cadena fijada
    // volveria a llevar el miembro a donde acabamos de deshacer. `syncAll` deshace
    // el estirado, asi que el que hubiera se vuelve a poner justo despues.
    this.rig.syncAll();
    if (paso.stretch) this.rig.setStretchState(paso.stretch);
    // Y los objetivos sueltos vuelven a la punta ya estirada, para que el
    // manejador de la mano no se quede donde llegaba el brazo sin estirar.
    this.rig.syncLoose();
    this.#reportDeform();
    this.viewport.invalidateShadows?.();
    return true;
  }

  get canUndo() {
    return this.history.length > 0;
  }

  dispose() {
    this.unsubscribe?.();
    for (const off of this.offs ?? []) off?.();
    this.offs = [];
    const dom = this.viewport.renderer.domElement;
    dom.removeEventListener('pointerdown', this._onPointerDown);
    dom.removeEventListener('pointermove', this._onPointerMove);
    this.gizmo.detach();
    this.gizmo.dispose();
    this.viewport.remove(this.handles, this.proxy, this.helper);
    this.material.dispose();
    this.materialHover.dispose();
    this.materialActive.dispose();
    this.matGoal.dispose();
    this.matPinned.dispose();
    this.matPole.dispose();
    this.matBody.dispose();
    this.matBend.dispose();
    this.matTweak.dispose();
    this.hintMat.dispose();
    this.hintGeo.dispose();
  }
}
