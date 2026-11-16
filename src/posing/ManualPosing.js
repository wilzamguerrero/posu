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
 *
 * La otra salida al mismo problema es `pose.handleScale`: encogerlos todos a la
 * vez, del 100 % al 1 %, sin que ninguno pierda su proporcion con los demas. Se
 * multiplica en la cota de la que salen los tres tamanos de un manejador —el
 * minimo, el maximo y lo que crece con la distancia a la camara—, asi que un
 * manejador al 40 % se porta igual que al 100 %, solo mas pequeno. De fabrica
 * viene a la mitad.
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
const _ray = new THREE.Ray();
const _plane = new THREE.Plane();
const _hit = new THREE.Vector3();
const _axX = new THREE.Vector3();
const _axY = new THREE.Vector3();
const _axZ = new THREE.Vector3();
const _axU = new THREE.Vector3();
const _axV = new THREE.Vector3();
const _cR = new THREE.Vector3();
const _cU = new THREE.Vector3();
const _cF = new THREE.Vector3();
const _qDelta = new THREE.Quaternion();
const _projNdc = { x: 0, y: 0 };

const HANDLE_COLORS = {
  joint: '#4fc1ff',
  effector: '#4ec9b0',
  pinned: '#ff8a5b',
  pole: '#c586c0',
  bend: '#d58ae0',
  tweak: '#b5cea8',
  body: '#dcdcaa',
  active: '#ffd479',
  hover: '#9cdcfe',
};
const AXIS_COLORS = { X: '#ff5c5c', Y: '#6be272', Z: '#58a6ff', XYZ: '#e8edf5', E: '#ffd479' };

/** Distancia minima en pantalla entre el punto `(px,py)` y el segmento `(ax,ay)-(bx,by)`. */
function distSeg2D(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const len2 = vx * vx + vy * vy;
  if (len2 < 1e-6) return Math.hypot(wx, wy);
  const t = THREE.MathUtils.clamp((wx * vx + wy * vy) / len2, 0, 1);
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}

/** Punto mas cercano de una recta 3D `(p0 + t*dir)` respecto a un rayo de pantalla. */
function axisParamFromRay(p0, dir, ray) {
  _d.copy(ray.origin).sub(p0);
  const b = dir.dot(ray.direction);
  const denom = 1 - b * b;
  if (Math.abs(denom) < 1e-4) return null;
  const c = dir.dot(_d);
  const f = ray.direction.dot(_d);
  return (b * f - c) / denom;
}

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

/**
 * Radio de un manejador, en unidades de mundo.
 *
 * `base` es la cota de la figura —su alto por el tamano global pedido— y `dist` lo
 * que hay de la camara al punto: un manejador crece con la distancia para ocupar
 * siempre lo mismo en pantalla, entre un suelo y un techo que salen de la misma
 * cota. Como los tres tamanos son esa cota por el mismo peso de clase, encoger
 * `base` encoge el juego entero sin cambiar ninguna proporcion ni cual es mas gordo
 * que cual, y sin importar en cual de los tres tramos caiga cada manejador.
 * @param {number} base cota de la figura, ya multiplicada por `pose.handleScale`
 * @param {number} dist de la camara al punto (o el medio alto si es ortografica)
 * @param {string} kind clase de manejador, de `SIZES`
 * @param {boolean} [finger] las falanges van mas finas para no tapar la mano
 */
export function handleRadius(base, dist, kind, finger = false) {
  const f = finger ? 0.4 : SIZES[kind] ?? 1;
  return THREE.MathUtils.clamp(base * dist * 0.55 * f, base * 0.5 * f, base * 3 * f);
}

export class ManualPosing {
  /**
   * @param {object} deps
   * @param {import('../core/Settings.js').Settings} deps.settings
   * @param {import('../core/Viewport.js').Viewport} deps.viewport
   * @param {import('../model/Character.js').Character} deps.character
   * @param {import('../guides/Perspective.js').Perspective} [deps.perspective]
   * @param {(info: {key: string, label: string}|null) => void} [deps.onSelect]
   */
  constructor({ settings, viewport, character, perspective = null, onSelect }) {
    this.settings = settings;
    this.viewport = viewport;
    this.character = character;
    this.perspective = perspective;
    this.onSelect = onSelect ?? null;

    this.enabled = false;
    this.selected = null;      // { key, label, bone, kind, chain }
    this.handles = new THREE.Group();
    this.handles.name = 'PosingHandles';
    this.handles.visible = false;
    this.entries = [];         // { key, label, bone, mesh, kind, chain, finger }
    this.history = [];
    this.dragging = false;
    /** Arrastre directo (en plano de vista o sobre el gizmo proyectado). */
    this.directDrag = null;
    /** Eje apuntado sobre el gizmo 2D cuando la perspectiva esta deformada. */
    this.warpedAxis = null;
    this._warpedGizmo = null;
    this._emptyDown = null;
    this.pointerPx = { x: 0, y: 0 };
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
    /** Tamano de todos los manejadores, en fraccion del suyo (1 = el de siempre). */
    this.handleScale = this.#handleScale(settings.get('pose.handleScale'));

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
    this.gizmo.size = 0.95;
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
    this._onPointerUpWindow = (e) => this.#onPointerUpWindow(e);
    this._onPointerMoveWindow = (e) => this.#onPointerMoveWindow(e);
    const dom = viewport.renderer.domElement;
    dom.addEventListener('pointerdown', this._onPointerDown, true);
    dom.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup', this._onPointerUpWindow);
    window.addEventListener('pointercancel', this._onPointerUpWindow);

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
   * Cambio de ajuste del posado. Los tres valores viven en campos porque el paso de
   * proximidad y el de colocar los manejadores los consultan por manejador y por
   * fotograma, y leer el almacen cuarenta veces en cada cuadro no aporta nada.
   */
  #onPoseSetting() {
    this.proximity = this.settings.get('pose.proximity') === true;
    this.proxRadius = this.#radius(this.settings.get('pose.proximityRadius'));
    this.handleScale = this.#handleScale(this.settings.get('pose.handleScale'));
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

  /** Tamano global de los manejadores: del 1 % al 100 %, y el de fabrica si llega basura. */
  #handleScale(v) {
    const n = Number(v);
    return Number.isFinite(n) ? THREE.MathUtils.clamp(n, 0.01, 1) : 0.5;
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

  /** ¿La perspectiva actual deforma el lienzo (requiere proyeccion 2D y rayo curvo)? */
  #isWarped() {
    return this.perspective?.warped === true;
  }

  setEnabled(on) {
    this.enabled = !!on;
    this.handles.visible = this.enabled && !this.perspective;
    this.rig.hold.clear();
    if (!this.enabled) {
      this.#cancelDirectDrag();
      this.select(null);
      this.gizmo.enabled = false;
    } else {
      this.gizmo.enabled = !this.#isWarped();
      if (!this.entries.length) this.rebuild();
      else this.#refresh();
    }
  }

  select(key) {
    const entry = key ? this.entries.find((e) => e.key === key) : null;
    for (const e of this.entries) e.mesh.material = this.#materialFor(e);
    this.selected = entry ?? null;
    this.warpedAxis = null;

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
    const warped = this.#isWarped();
    this.gizmo.enabled = this.enabled && !warped;
    this.helper.visible = !warped;
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

    const warped = this.#isWarped();
    this.handles.visible = !this.perspective;
    this.gizmo.enabled = !warped;
    this.helper.visible = !warped && !!this.selected;

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

    // La altura es propia de cada figura, no un ajuste global. El tamano global se
    // multiplica aqui, en la cota de la que salen las tres del manejador —el minimo,
    // el maximo y lo que crece con la distancia—, que es lo que hace que encogerlos
    // no cambie ni sus proporciones ni cual es mas gordo que cual.
    const height = Math.max(0.4, this.character?.placement?.height ?? 1.75);
    const base = height * 0.013 * this.handleScale;
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
      const r = handleRadius(base, dist, entry.kind, entry.finger);
      // Con la proximidad encendida el manejador entra creciendo por el borde del
      // entorno en vez de encenderse de golpe: asi se ve de donde ha salido.
      entry.mesh.scale.setScalar(prox ? r * (0.55 + 0.45 * entry.near) : r);
    }
    // La cercania se repasa con las posiciones recien escritas, y antes de las
    // guias, que solo se dibujan para los objetivos que se ven.
    if (prox) this.#proximityPass();
    if (this.rig.on && !this.perspective) this.#syncHints();
    if (this.selected && !this.dragging && !this.directDrag) this.#placeProxy(this.selected);
  }

  /** Esconde un manejador sin dejarlo en la lista de lo que acepta el raycast. */
  #hide(entry) {
    // Tambien para la proximidad: sin punto donde dibujarlo no esta cerca de nada.
    entry.near = 0;
    entry.mesh.visible = false;
    entry.screen = null;
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
    const dom = this.viewport.renderer.domElement;
    const W = Math.max(1, dom.clientWidth || 100);
    const H = Math.max(1, dom.clientHeight || 100);
    const projector = this.#isWarped()
      ? (pt) => {
        const s = this.perspective.projectWorld(pt, W, H);
        if (!s) return null;
        _projNdc.x = (s.x / W) * 2 - 1;
        _projNdc.y = -(s.y / H) * 2 + 1;
        return _projNdc;
      }
      : null;
    for (const entry of this.entries) {
      if (entry.shown) entry.near = this.#nearOf(entry, entry.mesh.position, cam, aspect, projector);
    }
    this.#visibilityPass();
  }

  /**
   * Cuanto asoma un manejador. Las dos excepciones que se quedan siempre a la
   * vista son el elegido, porque perder de vista lo que tiene puesto el giroscopio
   * desconcierta, y el objetivo de una cadena fijada, que avisa de que ese pie
   * esta clavado.
   */
  #nearOf(entry, point, cam, aspect, projector = null) {
    if (entry === this.selected) return 1;
    if (entry.kind === 'effector' && entry.chain?.pinned) return 1;
    return nearFactor(point, cam, this.pointer, this.proxRadius, aspect, projector);
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
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    this.pointerPx.x = event.clientX - rect.left;
    this.pointerPx.y = event.clientY - rect.top;
    this.pointer.set(
      (this.pointerPx.x / w) * 2 - 1,
      -(this.pointerPx.y / h) * 2 + 1,
    );
    return this.pointer;
  }

  /** Calcula las posiciones en pantalla (pixeles CSS) y radios de cada manejador visible. */
  #syncScreenPositions(W = 0, H = 0, dpr = 1) {
    const dom = this.viewport.renderer.domElement;
    const cssW = W > 0 ? W / dpr : Math.max(1, dom.clientWidth || dom.getBoundingClientRect().width || 1);
    const cssH = H > 0 ? H / dpr : Math.max(1, dom.clientHeight || dom.getBoundingClientRect().height || 1);
    const cam = this.viewport.cameras.active;
    const minDim = Math.max(240, Math.min(cssW, cssH));
    const scaleBias = 0.2 + 1.4 * this.handleScale;
    const minBaseCss = Math.max(2.0, minDim * 0.0052 * scaleBias);
    const maxBaseCss = Math.max(3.5, minDim * 0.0105 * scaleBias);
    const weights = { joint: 1, effector: 1.35, pole: 0.85, body: 1.5, bend: 1.15, tweak: 0.82 };
    const prox = this.proximity;
    const fpxApprox = cam.isOrthographicCamera
      ? cssH / Math.max(0.05, cam.top - cam.bottom)
      : (cssH * 0.5) / Math.tan(THREE.MathUtils.degToRad(cam.fov || 45) * 0.5);

    for (const entry of this.entries) {
      if (!entry.shown || !entry.mesh.visible) { entry.screen = null; continue; }
      const p = entry.mesh.position;
      let sx, sy, dist;
      if (this.perspective) {
        const s = this.perspective.projectWorld(p, cssW, cssH);
        if (!s) { entry.screen = null; continue; }
        sx = s.x; sy = s.y; dist = s.dist;
      } else {
        _v.copy(p).project(cam);
        if (!Number.isFinite(_v.x) || !Number.isFinite(_v.y) || _v.z < -1 || _v.z > 1) {
          entry.screen = null;
          continue;
        }
        sx = (_v.x * 0.5 + 0.5) * cssW;
        sy = (-_v.y * 0.5 + 0.5) * cssH;
        dist = cam.position.distanceTo(p);
      }
      // Tamano adaptativo acotado: encoge suavemente si la figura queda muy lejos
      // (para no apelmazar los controles) pero nunca baja de `minBaseCss` px.
      const pxPerM = cam.isOrthographicCamera ? fpxApprox : fpxApprox / Math.max(0.2, dist);
      const baseCss = THREE.MathUtils.clamp(pxPerM * 0.018 * scaleBias, minBaseCss, maxBaseCss);
      const f = entry.finger ? 0.52 : (weights[entry.kind] ?? 1);
      const rCss = baseCss * f * (prox ? (0.55 + 0.45 * entry.near) : 1);
      entry.screen = { x: sx, y: sy, r: rCss, dist };
    }
    return { cssW, cssH };
  }

  /** Rayo 3D para un punto de puntero en ventana, respetando cualquier deformacion. */
  #rayAtClient(clientX, clientY, ray = _ray) {
    const dom = this.viewport.renderer.domElement;
    const rect = dom.getBoundingClientRect();
    if (this.perspective) return this.perspective.rayFromClient(clientX, clientY, rect, ray);
    const w = Math.max(1, rect.width), h = Math.max(1, rect.height);
    _projNdc.x = ((clientX - rect.left) / w) * 2 - 1;
    _projNdc.y = -((clientY - rect.top) / h) * 2 + 1;
    this.raycaster.setFromCamera(_projNdc, this.viewport.cameras.active);
    ray.copy(this.raycaster.ray);
    return true;
  }

  #pick(event) {
    if (!this.enabled || !this.pickable.length) return null;
    this.#pointerTo(event);
    if (!this.perspective) {
      this.raycaster.setFromCamera(this.pointer, this.viewport.cameras.active);
      const hits = this.raycaster.intersectObjects(this.pickable, false);
      return hits.length ? hits[0].object.userData.key : null;
    }
    this.#syncScreenPositions();
    const px = this.pointerPx.x, py = this.pointerPx.y;
    let best = null, bestScore = Infinity, bestDist = Infinity;
    for (const entry of this.entries) {
      const s = entry.screen;
      if (!s || !entry.mesh.visible) continue;
      const hitR = Math.max(s.r + 4.5, entry.finger ? 8.5 : 11.5);
      const d = Math.hypot(px - s.x, py - s.y);
      if (d > hitR) continue;
      // Las articulaciones principales y los tiradores IK ganan sobre falanges superpuestas.
      const score = (d / hitR) + (entry.finger ? 0.35 : 0) + (entry === this.selected ? -0.08 : 0);
      if (score < bestScore - 1e-4 || (Math.abs(score - bestScore) <= 1e-4 && s.dist < bestDist)) {
        best = entry.key;
        bestScore = score;
        bestDist = s.dist;
      }
    }
    return best;
  }

  /**
   * ¿Este puntero cae sobre un manejador de articulacion? Lo consulta el editor
   * de escena para no robarle el clic al posado (y viceversa: si no hay ningun
   * manejador debajo, se puede seleccionar un solido aunque el modo pose siga
   * encendido).
   */
  picks(event) {
    if (!this.enabled) return false;
    if (this.#isWarped() && this.selected && this.#pickWarpedGizmo(event) !== null) return true;
    return this.#pick(event) !== null;
  }

  /**
   * ¿Manda el giroscopio del posado sobre este puntero? Es cierto mientras se
   * arrastra y tambien cuando el puntero esta sobre uno de sus ejes. Lo consulta
   * el editor de escena para no robarle el clic.
   */
  gizmoBusy() {
    if (!this.enabled) return false;
    if (this.dragging || !!this.directDrag) return true;
    if (this.#isWarped()) return !!this.selected && !!this.warpedAxis;
    return !!this.gizmo.object && !!this.gizmo.axis;
  }

  #onPointerDown(event) {
    if (!this.enabled || this.dragging || this.directDrag || event.button !== 0) return;
    this.#pointerTo(event);
    const warped = this.#isWarped();
    if (warped && this.selected) {
      const axis = this.#pickWarpedGizmo(event);
      if (axis) {
        event.stopPropagation();
        event.preventDefault();
        this.#startGizmoDrag(axis, event);
        return;
      }
    } else if (!warped && this.gizmo.object && this.gizmo.axis) {
      // TransformControls ya tiene un eje apuntado: bloqueamos la orbita desde
      // captura para que OrbitControls no capture el mismo gesto.
      this.viewport.cameras.controls.enabled = false;
      this._emptyDown = { releaseControls: true };
      return;
    }

    const key = this.#pick(event);
    if (key) {
      event.stopPropagation();
      event.preventDefault();
      this.select(key);
      if (this.selected) this.#startHandleDrag(this.selected, event);
    } else if (this.selected && !event.shiftKey) {
      // Clic al vacio: solo deselecciona si al soltar no hubo arrastre de orbita.
      this._emptyDown = { x: event.clientX, y: event.clientY };
    }
  }

  #onPointerMove(event) {
    if (!this.enabled || this.dragging || this.directDrag) return;
    this.#pointerTo(event);
    // El puntero ya esta donde estara al soltar el clic: la proximidad se repasa
    // aqui para que el manejador que acaba de entrar se pueda pinchar ahora mismo.
    if (this.proximity) this.#proximityPass();

    const dom = this.viewport.renderer.domElement;
    if (this.#isWarped() && this.selected) {
      const axis = this.#pickWarpedGizmo(event);
      if (axis !== this.warpedAxis) this.warpedAxis = axis;
      if (axis) {
        if (this.hovered) {
          this.hovered = null;
          for (const e of this.entries) if (e !== this.selected) e.mesh.material = this.#materialFor(e);
        }
        dom.style.cursor = 'grab';
        return;
      }
    } else {
      this.warpedAxis = null;
    }

    const key = this.#pick(event);
    if (key !== this.hovered) {
      for (const e of this.entries) {
        if (e === this.selected) continue;
        e.mesh.material = e.key === key ? this.materialHover : this.#materialFor(e);
      }
      this.hovered = key;
    }
    // El cursor lo comparten el posado y el editor de escena: cada uno borra
    // solo el suyo para no pisarse.
    if (key) dom.style.cursor = 'grab';
    else if (dom.style.cursor === 'grab') dom.style.cursor = '';
  }

  /* ---------------------------------------- arrastre directo y gizmo 2D --- */

  #gizmoAxes(mode = this.gizmo.mode) {
    const local = mode === 'scale' || this.settings.get('pose.space') === 'local';
    if (local) {
      _axX.set(1, 0, 0).applyQuaternion(this.proxy.quaternion).normalize();
      _axY.set(0, 1, 0).applyQuaternion(this.proxy.quaternion).normalize();
      _axZ.set(0, 0, 1).applyQuaternion(this.proxy.quaternion).normalize();
    } else {
      _axX.set(1, 0, 0);
      _axY.set(0, 1, 0);
      _axZ.set(0, 0, 1);
    }
  }

  /** Largo en mundo que corresponde a ~58 px en la posicion actual del proxy. */
  #gizmoWorldLen(cssW, cssH) {
    const p0 = this.proxy.position;
    const s0 = this.perspective.projectWorld(p0, cssW, cssH);
    if (!s0) return 0.25;
    const cam = this.viewport.cameras.active;
    _cR.set(1, 0, 0).applyQuaternion(cam.quaternion);
    const eps = Math.max(0.04, s0.dist * 0.06);
    _hit.copy(p0).addScaledVector(_cR, eps);
    let s1 = this.perspective.projectWorld(_hit, cssW, cssH);
    if (!s1) {
      _cU.set(0, 1, 0).applyQuaternion(cam.quaternion);
      _hit.copy(p0).addScaledVector(_cU, eps);
      s1 = this.perspective.projectWorld(_hit, cssW, cssH);
    }
    const px = s1 ? Math.hypot(s1.x - s0.x, s1.y - s0.y) : 0;
    const len = px > 1 ? eps * (58 / px) : Math.max(0.15, s0.dist * 0.14);
    return THREE.MathUtils.clamp(len, 0.04, Math.max(1.8, s0.dist * 0.45));
  }

  /** Construye y guarda la geometria 2D del gizmo deformado en pixeles CSS. */
  #buildWarpedGizmoScreen(cssW, cssH) {
    this._warpedGizmo = null;
    if (!this.selected || !this.perspective) return null;
    const mode = this.gizmo.mode;
    const p0 = this.proxy.position;
    const center = this.perspective.projectWorld(p0, cssW, cssH);
    if (!center) return null;
    const L = this.#gizmoWorldLen(cssW, cssH);
    this.#gizmoAxes(mode);
    const axes = { X: _axX.clone(), Y: _axY.clone(), Z: _axZ.clone() };
    const cam = this.viewport.cameras.active;
    _cF.copy(p0).sub(cam.position).normalize();
    if (_cF.lengthSq() < 1e-6) _cF.set(0, 0, -1).applyQuaternion(cam.quaternion);

    if (mode === 'rotate') {
      const rings = {};
      const sampleRing = (u, v, rad) => {
        const pts = [];
        const steps = 48;
        for (let i = 0; i <= steps; i++) {
          const a = (i / steps) * Math.PI * 2;
          _hit.copy(p0).addScaledVector(u, Math.cos(a) * rad).addScaledVector(v, Math.sin(a) * rad);
          const s = this.perspective.projectWorld(_hit, cssW, cssH);
          pts.push(s ? { x: s.x, y: s.y } : null);
        }
        return pts;
      };
      for (const name of ['X', 'Y', 'Z']) {
        const n = axes[name];
        const ref = Math.abs(n.y) < 0.9 ? _cU.set(0, 1, 0) : _cR.set(1, 0, 0);
        _axU.crossVectors(n, ref).normalize();
        _axV.crossVectors(n, _axU).normalize();
        rings[name] = sampleRing(_axU, _axV, L);
      }
      _cR.set(1, 0, 0).applyQuaternion(cam.quaternion);
      _cU.set(0, 1, 0).applyQuaternion(cam.quaternion);
      rings.E = sampleRing(_cR, _cU, L * 1.18);
      this._warpedGizmo = { mode, center, L, axes, rings };
      return this._warpedGizmo;
    }

    const lines = {};
    for (const name of ['X', 'Y', 'Z']) {
      _hit.copy(p0).addScaledVector(axes[name], L);
      const tip = this.perspective.projectWorld(_hit, cssW, cssH);
      if (tip) lines[name] = { x: tip.x, y: tip.y };
    }
    this._warpedGizmo = { mode, center, L, axes, lines };
    return this._warpedGizmo;
  }

  #pickWarpedGizmo(event) {
    if (!this.selected || !this.perspective) return null;
    this.#pointerTo(event);
    const dom = this.viewport.renderer.domElement;
    const cssW = Math.max(1, dom.clientWidth || dom.getBoundingClientRect().width || 1);
    const cssH = Math.max(1, dom.clientHeight || dom.getBoundingClientRect().height || 1);
    const g = this.#buildWarpedGizmoScreen(cssW, cssH);
    if (!g) return null;
    const px = this.pointerPx.x, py = this.pointerPx.y;

    if (g.mode === 'rotate') {
      let best = null, bestD = 10;
      for (const name of ['X', 'Y', 'Z', 'E']) {
        const pts = g.rings[name];
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1], b = pts[i];
          if (!a || !b) continue;
          const d = distSeg2D(px, py, a.x, a.y, b.x, b.y);
          if (d > 140) continue; // salto de costura en 6 puntos
          const segLen = Math.hypot(b.x - a.x, b.y - a.y);
          if (segLen > 120) continue;
          if (d < bestD) { bestD = d; best = name; }
        }
      }
      return best;
    }

    const dCenter = Math.hypot(px - g.center.x, py - g.center.y);
    if (dCenter <= 12) return 'XYZ';
    let best = null, bestD = 11;
    for (const name of ['X', 'Y', 'Z']) {
      const tip = g.lines[name];
      if (!tip) continue;
      const d = distSeg2D(px, py, g.center.x, g.center.y, tip.x, tip.y);
      if (d < bestD) { bestD = d; best = name; }
    }
    return best;
  }

  #beginDragSession(drag) {
    this.directDrag = drag;
    this.viewport.cameras.controls.enabled = false;
    window.addEventListener('pointermove', this._onPointerMoveWindow);
  }

  #cancelDirectDrag() {
    if (!this.directDrag) return;
    window.removeEventListener('pointermove', this._onPointerMoveWindow);
    if (this.directDrag.started) {
      this.dragging = false;
      this.rig.hold.clear();
      this.deformStart = null;
      this.posStart = null;
    }
    this.directDrag = null;
    this.viewport.cameras.controls.enabled = true;
  }

  #startHandleDrag(entry, event) {
    const cam = this.viewport.cameras.active;
    const startPos = this.proxy.position.clone();
    const planeNormal = new THREE.Vector3().copy(startPos).sub(cam.position).normalize();
    if (planeNormal.lengthSq() < 1e-6) cam.getWorldDirection(planeNormal);
    this.#beginDragSession({
      kind: 'handle',
      entry,
      downX: event.clientX,
      downY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      started: false,
      startPos,
      startQuat: this.proxy.quaternion.clone(),
      planeNormal,
      startHit: null,
    });
  }

  #startGizmoDrag(axis, event) {
    const dom = this.viewport.renderer.domElement;
    const cssW = Math.max(1, dom.clientWidth || dom.getBoundingClientRect().width || 1);
    const cssH = Math.max(1, dom.clientHeight || dom.getBoundingClientRect().height || 1);
    const g = this.#buildWarpedGizmoScreen(cssW, cssH);
    if (!g) return;
    const entry = this.selected;
    this.warpedAxis = axis;
    this.dragging = true;
    this.#pushHistory();
    this.#holdStart();
    this.deformStart = this.#deformable(entry)
      ? this.character.boneDeform(entry.boneKey, new THREE.Vector3())
      : null;
    this.posStart = this.#posStart(entry);

    const startPos = this.proxy.position.clone();
    const startQuat = this.proxy.quaternion.clone();
    const startScale = this.proxy.scale.clone();
    const cam = this.viewport.cameras.active;
    const viewDir = new THREE.Vector3().copy(startPos).sub(cam.position).normalize();
    if (viewDir.lengthSq() < 1e-6) cam.getWorldDirection(viewDir);

    let axisVec = null, axisScreen = { x: 1, y: 0 }, startParam = 0, startAngle = 0;
    let ringU = null, ringV = null, startHit = null;
    if (axis === 'X' || axis === 'Y' || axis === 'Z') {
      axisVec = g.axes[axis].clone();
      if (g.lines?.[axis]) {
        const dx = g.lines[axis].x - g.center.x;
        const dy = g.lines[axis].y - g.center.y;
        const n = Math.hypot(dx, dy) || 1;
        axisScreen = { x: dx / n, y: dy / n, len: n };
      }
      if (g.mode === 'translate' && this.#rayAtClient(event.clientX, event.clientY, _ray)) {
        const t = axisParamFromRay(startPos, axisVec, _ray);
        if (t !== null) startParam = t;
      } else if (g.mode === 'rotate') {
        const ref = Math.abs(axisVec.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
        ringU = new THREE.Vector3().crossVectors(axisVec, ref).normalize();
        ringV = new THREE.Vector3().crossVectors(axisVec, ringU).normalize();
        if (this.#rayAtClient(event.clientX, event.clientY, _ray)) {
          _plane.setFromNormalAndCoplanarPoint(axisVec, startPos);
          if (_ray.intersectPlane(_plane, _hit)) {
            _d.copy(_hit).sub(startPos);
            startAngle = Math.atan2(_d.dot(ringV), _d.dot(ringU));
          }
        }
      }
    } else if (axis === 'E' && g.mode === 'rotate') {
      axisVec = viewDir.clone().negate();
      startAngle = Math.atan2(this.pointerPx.y - g.center.y, this.pointerPx.x - g.center.x);
    } else if (axis === 'XYZ' && g.mode === 'translate') {
      if (this.#rayAtClient(event.clientX, event.clientY, _ray)) {
        _plane.setFromNormalAndCoplanarPoint(viewDir, startPos);
        if (_ray.intersectPlane(_plane, _hit)) startHit = _hit.clone();
      }
    }

    this.#beginDragSession({
      kind: 'gizmo',
      mode: g.mode,
      axis,
      entry,
      started: true,
      downX: event.clientX,
      downY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      centerPx: { x: g.center.x, y: g.center.y },
      axisVec,
      axisScreen,
      viewDir,
      ringU,
      ringV,
      startPos,
      startQuat,
      startScale,
      startParam,
      startAngle,
      startHit,
    });
  }

  #onPointerMoveWindow(event) {
    const d = this.directDrag;
    if (!d) return;
    if (d.kind === 'handle') {
      if (!d.started) {
        if (Math.hypot(event.clientX - d.downX, event.clientY - d.downY) < 4) return;
        d.started = true;
        this.dragging = true;
        this.#pushHistory();
        this.#holdStart();
        this.deformStart = null;
        this.posStart = this.#posStart(d.entry);
        if (d.entry.kind !== 'joint' && this.#rayAtClient(d.downX, d.downY, _ray)) {
          _plane.setFromNormalAndCoplanarPoint(d.planeNormal, d.startPos);
          if (_ray.intersectPlane(_plane, _hit)) d.startHit = _hit.clone();
        }
        d.lastX = d.downX;
        d.lastY = d.downY;
      }
      if (d.entry.kind === 'joint') {
        const dx = event.clientX - d.lastX;
        const dy = event.clientY - d.lastY;
        d.lastX = event.clientX;
        d.lastY = event.clientY;
        const cam = this.viewport.cameras.active;
        _cR.set(1, 0, 0).applyQuaternion(cam.quaternion).normalize();
        _cU.set(0, 1, 0).applyQuaternion(cam.quaternion).normalize();
        _qDelta.setFromAxisAngle(_cU, dx * 0.0085);
        this.proxy.quaternion.premultiply(_qDelta);
        _qDelta.setFromAxisAngle(_cR, dy * 0.0085);
        this.proxy.quaternion.premultiply(_qDelta).normalize();
        this.#rotateBone(d.entry.bone);
        this.rig.solveHeld();
        this.character?.tick?.();
        this.viewport.invalidateShadows?.();
        if (this.settings.get('mocap.frozen') !== true) this.settings.set('mocap.frozen', true);
      } else if (d.startHit && this.#rayAtClient(event.clientX, event.clientY, _ray)) {
        _plane.setFromNormalAndCoplanarPoint(d.planeNormal, d.startPos);
        if (_ray.intersectPlane(_plane, _hit)) {
          this.proxy.position.copy(d.startPos).add(_hit).sub(d.startHit);
          this.#applyProxy();
        }
      }
      return;
    }

    // Gizmo 2D proyectado en modos deformados
    const snapT = this.gizmo.translationSnap;
    const snapR = this.gizmo.rotationSnap;
    if (d.mode === 'translate') {
      if (d.axis === 'XYZ') {
        if (d.startHit && this.#rayAtClient(event.clientX, event.clientY, _ray)) {
          _plane.setFromNormalAndCoplanarPoint(d.viewDir, d.startPos);
          if (_ray.intersectPlane(_plane, _hit)) {
            this.proxy.position.copy(d.startPos).add(_hit).sub(d.startHit);
            this.#applyProxy();
          }
        }
      } else if (d.axisVec) {
        let delta = null;
        if (this.#rayAtClient(event.clientX, event.clientY, _ray)
            && Math.abs(d.axisVec.dot(_ray.direction)) < 0.96) {
          const t = axisParamFromRay(d.startPos, d.axisVec, _ray);
          if (t !== null) delta = t - d.startParam;
        }
        if (delta === null) {
          const pxDelta = (event.clientX - d.downX) * d.axisScreen.x + (event.clientY - d.downY) * d.axisScreen.y;
          delta = (pxDelta / Math.max(20, d.axisScreen.len || 58)) * 0.4;
        }
        if (snapT) delta = Math.round(delta / snapT) * snapT;
        this.proxy.position.copy(d.startPos).addScaledVector(d.axisVec, delta);
        this.#applyProxy();
      }
    } else if (d.mode === 'scale') {
      let factor = 1;
      if (d.axis === 'XYZ') {
        const pxDelta = (event.clientX - d.downX) - (event.clientY - d.downY);
        factor = Math.exp(pxDelta / 90);
      } else {
        const pxDelta = (event.clientX - d.downX) * d.axisScreen.x + (event.clientY - d.downY) * d.axisScreen.y;
        factor = Math.exp(pxDelta / Math.max(36, d.axisScreen.len || 58));
      }
      this.proxy.scale.copy(d.startScale);
      if (d.axis === 'XYZ') this.proxy.scale.multiplyScalar(factor);
      else if (d.axis === 'X') this.proxy.scale.x *= factor;
      else if (d.axis === 'Y') this.proxy.scale.y *= factor;
      else if (d.axis === 'Z') this.proxy.scale.z *= factor;
      this.#applyProxy();
    } else if (d.mode === 'rotate' && d.axisVec) {
      let angle = 0;
      if (d.axis === 'E') {
        this.#pointerTo(event);
        const cur = Math.atan2(this.pointerPx.y - d.centerPx.y, this.pointerPx.x - d.centerPx.x);
        angle = -(cur - d.startAngle);
      } else if (d.ringU && d.ringV && this.#rayAtClient(event.clientX, event.clientY, _ray)
          && Math.abs(_ray.direction.dot(d.axisVec)) > 0.08) {
        _plane.setFromNormalAndCoplanarPoint(d.axisVec, d.startPos);
        if (_ray.intersectPlane(_plane, _hit)) {
          _d.copy(_hit).sub(d.startPos);
          angle = Math.atan2(_d.dot(d.ringV), _d.dot(d.ringU)) - d.startAngle;
        }
      } else {
        angle = ((event.clientX - d.downX) - (event.clientY - d.downY)) * 0.012;
      }
      if (snapR) angle = Math.round(angle / snapR) * snapR;
      _qDelta.setFromAxisAngle(d.axisVec, angle);
      this.proxy.quaternion.copy(d.startQuat).premultiply(_qDelta).normalize();
      this.#applyProxy();
    }
  }

  #onPointerUpWindow(event) {
    if (this._emptyDown) {
      const ed = this._emptyDown;
      this._emptyDown = null;
      if (ed.releaseControls) {
        if (!this.dragging) this.viewport.cameras.controls.enabled = true;
      } else if (this.selected && Math.hypot(event.clientX - ed.x, event.clientY - ed.y) < 5) {
        this.select(null);
      }
    }
    if (this.directDrag) this.#cancelDirectDrag();
  }

  /* ------------------------------------------- dibujo nitido en lienzo 2D --- */

  /**
   * Dibuja en el lienzo 2D superpuesto los manipuladores (FK e IK), sus lineas
   * de lectura y el gizmo proyectado cuando la perspectiva esta deformada.
   * Al ir por encima de los shaders y en pixeles reales de pantalla, nunca se
   * difuminan, nunca desaparecen tras la malla ni se quedan diminutos al alejar.
   */
  drawOverlay(ctx, W, H, dpr = 1) {
    if (!this.enabled || !this.entries.length) return;
    const { cssW, cssH } = this.#syncScreenPositions(W, H, dpr);
    const ik = this.rig.on;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // 1. Lineas de esqueleto FK y guias IK (con borde oscuro para leer sobre cualquier tono).
    const jointByBone = new Map();
    for (const e of this.entries) {
      if (e.kind === 'joint' && e.mesh.visible && e.screen) jointByBone.set(e.bone, e);
    }
    const drawLink = (ax, ay, bx, by, color, width, dash = null) => {
      if (!Number.isFinite(ax) || !Number.isFinite(bx)) return;
      if (Math.hypot(bx - ax, by - ay) > Math.max(W, H) * 0.75) return; // costura 360°
      ctx.save();
      if (dash) ctx.setLineDash(dash);
      ctx.strokeStyle = 'rgba(8, 12, 18, 0.55)';
      ctx.lineWidth = (width + 1.6) * dpr;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = width * dpr;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      ctx.restore();
    };

    for (const e of jointByBone.values()) {
      let p = e.bone?.parent;
      while (p && !jointByBone.has(p)) p = p.parent;
      const pe = p ? jointByBone.get(p) : null;
      if (!pe) continue;
      if (e.finger && e !== this.selected && e.key !== this.hovered && pe !== this.selected) continue;
      const active = e === this.selected || pe === this.selected || e.key === this.hovered;
      drawLink(pe.screen.x * dpr, pe.screen.y * dpr, e.screen.x * dpr, e.screen.y * dpr,
        active ? 'rgba(156, 220, 254, 0.72)' : 'rgba(79, 193, 255, 0.34)', active ? 1.8 : 1.25);
    }

    if (ik && this.perspective) {
      const holgura = Math.max(0.4, this.character?.placement?.height ?? 1.75) * 0.02;
      const polos = this.settings.get('ik.poles') !== false;
      for (const e of this.entries) {
        if (e.kind !== 'effector' || !e.mesh.visible) continue;
        const c = e.chain;
        const rW = this.rig.rootWorld(c, _a);
        const mW = c.mid ? this.rig.midWorld(c, _b) : null;
        const tW = this.rig.tipWorld(c, _p);
        const sR = rW ? this.perspective.projectWorld(rW, cssW, cssH) : null;
        const sM = mW ? this.perspective.projectWorld(mW, cssW, cssH) : null;
        const sT = tW ? this.perspective.projectWorld(tW, cssW, cssH) : null;
        if (sR && sM) drawLink(sR.x * dpr, sR.y * dpr, sM.x * dpr, sM.y * dpr, 'rgba(78, 201, 176, 0.34)', 1.35);
        if (sM && sT) drawLink(sM.x * dpr, sM.y * dpr, sT.x * dpr, sT.y * dpr, 'rgba(78, 201, 176, 0.34)', 1.35);
        if (this.rig.targetWorld(c, _v) && tW && _v.distanceToSquared(tW) > holgura * holgura) {
          const sGoal = this.perspective.projectWorld(_v, cssW, cssH);
          if (sT && sGoal) {
            drawLink(sT.x * dpr, sT.y * dpr, sGoal.x * dpr, sGoal.y * dpr,
              'rgba(78, 201, 176, 0.75)', 1.5, [5 * dpr, 4 * dpr]);
          }
        }
        if (c.mid && polos && this.rig.poleWorld(c, _v)) {
          const sPole = this.perspective.projectWorld(_v, cssW, cssH);
          if (sM && sPole) {
            drawLink(sM.x * dpr, sM.y * dpr, sPole.x * dpr, sPole.y * dpr,
              'rgba(197, 134, 192, 0.72)', 1.4, [4 * dpr, 4 * dpr]);
          }
        }
      }
      for (const e of this.entries) {
        if (e.kind !== 'tweak' || !e.mesh.visible || !e.screen) continue;
        const hijo = this.#tweakChild(e);
        if (!hijo) continue;
        worldOf(e.bone, _v).add(worldOf(hijo, _p)).multiplyScalar(0.5);
        const sMid = this.perspective.projectWorld(_v, cssW, cssH);
        if (sMid) {
          drawLink(sMid.x * dpr, sMid.y * dpr, e.screen.x * dpr, e.screen.y * dpr,
            'rgba(181, 206, 168, 0.7)', 1.25);
        }
      }
    }

    // 2. Orden de pintor (lejos -> cerca, seleccionado y apuntado encima de todo).
    const order = this.entries.filter((e) => e.mesh.visible && e.screen).sort((a, b) => {
      const pa = a === this.selected ? 2 : a.key === this.hovered ? 1 : 0;
      const pb = b === this.selected ? 2 : b.key === this.hovered ? 1 : 0;
      if (pa !== pb) return pa - pb;
      return b.screen.dist - a.screen.dist;
    });

    for (const e of order) {
      const x = e.screen.x * dpr;
      const y = e.screen.y * dpr;
      const isSel = e === this.selected;
      const isHov = e.key === this.hovered;
      const r = e.screen.r * dpr * (isSel ? 1.18 : isHov ? 1.15 : 1);
      const pinned = e.kind === 'effector' && e.chain?.pinned;
      const col = isSel ? HANDLE_COLORS.active
        : isHov ? HANDLE_COLORS.hover
        : pinned ? HANDLE_COLORS.pinned
        : (HANDLE_COLORS[e.kind] ?? HANDLE_COLORS.joint);

      ctx.save();
      ctx.globalAlpha = isSel || isHov ? 0.96 : (e.finger ? 0.74 : 0.88);
      ctx.fillStyle = col;
      ctx.strokeStyle = 'rgba(10, 14, 20, 0.92)';
      ctx.lineWidth = Math.max(1.4, 2.1 * dpr);

      if (isSel || isHov) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, r + 4.5 * dpr, 0, Math.PI * 2);
        ctx.strokeStyle = isSel ? 'rgba(255, 212, 121, 0.75)' : 'rgba(156, 220, 254, 0.7)';
        ctx.lineWidth = 1.6 * dpr;
        ctx.stroke();
        ctx.restore();
      }

      if (e.kind === 'effector') {
        const pathDiamond = (rad) => {
          ctx.beginPath();
          ctx.moveTo(x, y - rad);
          ctx.lineTo(x + rad, y);
          ctx.lineTo(x, y + rad);
          ctx.lineTo(x - rad, y);
          ctx.closePath();
        };
        if (pinned) {
          pathDiamond(r * 1.42);
          ctx.strokeStyle = HANDLE_COLORS.pinned;
          ctx.lineWidth = 1.6 * dpr;
          ctx.stroke();
          ctx.strokeStyle = 'rgba(10, 14, 20, 0.92)';
          ctx.lineWidth = Math.max(1.4, 2.1 * dpr);
        }
        pathDiamond(r);
        ctx.fill();
        ctx.stroke();
      } else if (e.kind === 'pole') {
        const s = r * 0.92;
        ctx.beginPath();
        ctx.rect(x - s, y - s, s * 2, s * 2);
        ctx.fill();
        ctx.stroke();
      } else if (e.kind === 'body') {
        const s = r * 0.95;
        ctx.beginPath();
        ctx.rect(x - s, y - s, s * 2, s * 2);
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x - s * 0.5, y); ctx.lineTo(x + s * 0.5, y);
        ctx.moveTo(x, y - s * 0.5); ctx.lineTo(x, y + s * 0.5);
        ctx.strokeStyle = 'rgba(10, 14, 20, 0.85)';
        ctx.lineWidth = 1.4 * dpr;
        ctx.stroke();
      } else if (e.kind === 'tweak') {
        const h = r * 1.15;
        ctx.beginPath();
        ctx.moveTo(x, y - h);
        ctx.lineTo(x + h * 0.92, y + h * 0.72);
        ctx.lineTo(x - h * 0.92, y + h * 0.72);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        if (e.kind === 'bend') {
          ctx.beginPath();
          ctx.moveTo(x - r * 0.5, y); ctx.lineTo(x + r * 0.5, y);
          ctx.moveTo(x, y - r * 0.5); ctx.lineTo(x, y + r * 0.5);
          ctx.strokeStyle = 'rgba(10, 14, 20, 0.9)';
          ctx.lineWidth = 1.4 * dpr;
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    // 3. Gizmo proyectado en 2D cuando hay deformacion de perspectiva.
    if (this.#isWarped() && this.selected) {
      this.#drawWarpedGizmo(ctx, cssW, cssH, dpr);
    }

    // 4. Etiqueta discreta del control apuntado o seleccionado.
    const tagEntry = (this.hovered ? this.entries.find((e) => e.key === this.hovered) : null)
      ?? (!this.dragging ? this.selected : null);
    if (tagEntry?.screen && tagEntry.mesh.visible) {
      const tx = tagEntry.screen.x * dpr;
      const ty = tagEntry.screen.y * dpr - (tagEntry.screen.r * dpr + 14 * dpr);
      const fontPx = Math.round(11 * dpr);
      ctx.font = `600 ${fontPx}px ui-sans-serif, system-ui, sans-serif`;
      const tw = ctx.measureText(tagEntry.label).width;
      const padX = 7 * dpr, boxH = 18 * dpr;
      const bx = THREE.MathUtils.clamp(tx - tw * 0.5 - padX, 8 * dpr, W - tw - padX * 2 - 8 * dpr);
      const by = THREE.MathUtils.clamp(ty - boxH * 0.5, 8 * dpr, H - boxH - 8 * dpr);
      ctx.fillStyle = 'rgba(10, 14, 20, 0.86)';
      ctx.strokeStyle = tagEntry === this.selected ? 'rgba(255, 212, 121, 0.7)' : 'rgba(156, 220, 254, 0.5)';
      ctx.lineWidth = dpr;
      ctx.beginPath();
      ctx.roundRect?.(bx, by, tw + padX * 2, boxH, 4 * dpr);
      if (!ctx.roundRect) ctx.rect(bx, by, tw + padX * 2, boxH);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#f3f6fc';
      ctx.textBaseline = 'middle';
      ctx.fillText(tagEntry.label, bx + padX, by + boxH * 0.5 + 0.5 * dpr);
    }
    ctx.restore();
  }

  #drawWarpedGizmo(ctx, cssW, cssH, dpr) {
    const g = this.#buildWarpedGizmoScreen(cssW, cssH);
    if (!g) return;
    const cx = g.center.x * dpr, cy = g.center.y * dpr;
    ctx.save();
    if (g.mode === 'rotate') {
      for (const name of ['X', 'Y', 'Z', 'E']) {
        const pts = g.rings[name];
        const active = this.warpedAxis === name;
        ctx.strokeStyle = active ? '#ffd479' : AXIS_COLORS[name];
        ctx.globalAlpha = name === 'E' ? (active ? 0.95 : 0.45) : (active ? 1 : 0.88);
        ctx.lineWidth = (active ? 3.0 : (name === 'E' ? 1.5 : 2.1)) * dpr;
        ctx.beginPath();
        let pen = false;
        let prev = null;
        for (const p of pts) {
          if (!p) { pen = false; prev = null; continue; }
          const x = p.x * dpr, y = p.y * dpr;
          if (pen && prev && Math.hypot(x - prev.x, y - prev.y) > 120 * dpr) pen = false;
          if (!pen) { ctx.moveTo(x, y); pen = true; }
          else ctx.lineTo(x, y);
          prev = { x, y };
        }
        ctx.stroke();
      }
      ctx.restore();
      return;
    }

    for (const name of ['X', 'Y', 'Z']) {
      const tip = g.lines[name];
      if (!tip) continue;
      const tx = tip.x * dpr, ty = tip.y * dpr;
      const active = this.warpedAxis === name;
      const col = active ? '#ffd479' : AXIS_COLORS[name];
      ctx.strokeStyle = 'rgba(10, 14, 20, 0.85)';
      ctx.lineWidth = (active ? 5 : 4) * dpr;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(tx, ty); ctx.stroke();

      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.lineWidth = (active ? 3 : 2.2) * dpr;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(tx, ty); ctx.stroke();

      const ang = Math.atan2(ty - cy, tx - cx);
      if (g.mode === 'scale') {
        const s = 4.5 * dpr;
        ctx.fillRect(tx - s, ty - s, s * 2, s * 2);
      } else {
        const ah = 9 * dpr;
        ctx.beginPath();
        ctx.moveTo(tx + Math.cos(ang) * 2 * dpr, ty + Math.sin(ang) * 2 * dpr);
        ctx.lineTo(tx - Math.cos(ang - 0.45) * ah, ty - Math.sin(ang - 0.45) * ah);
        ctx.lineTo(tx - Math.cos(ang + 0.45) * ah, ty - Math.sin(ang + 0.45) * ah);
        ctx.closePath();
        ctx.fill();
      }
    }
    const cActive = this.warpedAxis === 'XYZ';
    ctx.beginPath();
    ctx.arc(cx, cy, 8.5 * dpr, 0, Math.PI * 2);
    ctx.strokeStyle = cActive ? '#ffd479' : 'rgba(240, 245, 255, 0.9)';
    ctx.fillStyle = cActive ? 'rgba(255, 212, 121, 0.25)' : 'rgba(16, 22, 30, 0.45)';
    ctx.lineWidth = 1.8 * dpr;
    ctx.fill();
    ctx.stroke();
    ctx.restore();
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
    this.#cancelDirectDrag();
    this.unsubscribe?.();
    for (const off of this.offs ?? []) off?.();
    this.offs = [];
    const dom = this.viewport.renderer.domElement;
    dom.removeEventListener('pointerdown', this._onPointerDown, true);
    dom.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUpWindow);
    window.removeEventListener('pointercancel', this._onPointerUpWindow);
    window.removeEventListener('pointermove', this._onPointerMoveWindow);
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
