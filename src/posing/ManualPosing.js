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
 *   - Los ejes del giroscopio y el imantado son los mismos ajustes del editor de
 *     escena (`scene.space` y `scene.snap`): "Mundo" gira el hueso sobre los ejes
 *     de la escena y "Local" sobre los del propio hueso.
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
 *   - **Cubo grande** en la cadera: el peso del cuerpo. Mientras se arrastra, las
 *     piernas en cinematica inversa sujetan los pies, que es como se hace una
 *     sentadilla en un rig de verdad.
 *
 * La esfera de un hueso que ya tiene control de cinematica inversa se esconde: dos
 * manejadores concentricos se robarian el clic entre ellos.
 */

import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { IKRig } from './IKRig.js';

const HANDLE_GEO = new THREE.SphereGeometry(1, 14, 10);
/** Rombo para los objetivos: se reconoce de un vistazo entre las esferas. */
const GOAL_GEO = new THREE.OctahedronGeometry(1.15, 0);
/** Cubo para el polo y para el peso del cuerpo. */
const CUBE_GEO = new THREE.BoxGeometry(1.5, 1.5, 1.5);
/** Tope de segmentos de la guia: un polo y un tirante por cadena. */
const MAX_HINTS = 12;
/** Tamaño relativo de cada clase de manejador. */
const SIZES = { joint: 1, effector: 1.3, pole: 0.62, body: 1.55 };
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _pq = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

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

    /** Cinematica inversa: cadenas, objetivos y fijaciones. */
    this.rig = new IKRig(character ?? null, settings);
    /** Huesos que ya tienen control de cinematica inversa (su esfera se esconde). */
    this.taken = new Set();
    /** Mallas visibles, que son las unicas que aceptan el raycast. */
    this.pickable = [];

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

    // Guias: del polo al codo, y del objetivo a la punta cuando no alcanza.
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
    // Ejes e imantado compartidos con el gizmo de la escena: girar un hueso "en
    // el mundo" es lo que se espera al haber elegido esos ejes en el panel.
    this.gizmo.setSpace(settings.get('scene.space') === 'local' ? 'local' : 'world');
    this.#applySnap(settings.get('scene.snap'));
    this.offs = [
      settings.on('scene.space', (v) => this.gizmo.setSpace(v === 'local' ? 'local' : 'world')),
      settings.on('scene.snap', (v) => this.#applySnap(v)),
      // Mover o girar es el mismo ajuste que en el editor de escena (teclas W/E),
      // asi que el control de una mano sirve para las dos cosas sin botones nuevos.
      settings.on('scene.tool', () => { if (this.selected) this.#applyMode(this.selected); }),
      settings.on('ik.*', (_v, _p, path) => this.#onIKSetting(path)),
    ];
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.dragging = e.value;
      viewport.cameras.controls.enabled = !e.value;
      if (e.value) {
        this.#pushHistory();
        this.#holdStart();
      } else {
        this.rig.hold.clear();
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
  #addHandle({ key, label, bone, mesh, finger = false, kind, chain = null, boneKey = '', geo }) {
    const malla = mesh ?? new THREE.Mesh(geo, this.material);
    malla.name = `handle:${key}`;
    malla.renderOrder = 999;
    malla.frustumCulled = false;
    malla.userData.key = key;
    this.handles.add(malla);
    const entry = { key, label, bone, mesh: malla, finger, kind, chain, boneKey: boneKey || (kind === 'joint' ? key : '') };
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
      for (const chain of this.rig.chains) if (this.rig.live(chain)) this.taken.add(chain.tip);
      if (this.settings.get('ik.body') !== false && this.character?.bones?.hips) {
        this.taken.add(this.character.bones.hips);
      }
    }
    this.pickable.length = 0;
    for (const entry of this.entries) {
      entry.mesh.visible = this.#visible(entry, ik);
      if (entry.mesh.visible) this.pickable.push(entry.mesh);
      if (entry !== this.selected) entry.mesh.material = this.#materialFor(entry);
    }
    this.hints.visible = ik;
    if (this.selected && !this.selected.mesh.visible) this.select(null);
  }

  /** Reglas de visibilidad de un manejador. */
  #visible(entry, ik = this.rig.on) {
    if (entry.kind === 'joint') return !ik || !this.taken.has(entry.bone);
    if (!ik) return false;
    if (entry.kind === 'body') return this.settings.get('ik.body') !== false;
    if (!this.rig.live(entry.chain)) return false;
    if (entry.kind === 'pole') return this.settings.get('ik.poles') !== false;
    return true;
  }

  /** Material de reposo segun el papel del manejador. */
  #materialFor(entry) {
    if (entry.kind === 'effector') return entry.chain?.pinned ? this.matPinned : this.matGoal;
    if (entry.kind === 'pole') return this.matPole;
    if (entry.kind === 'body') return this.matBody;
    return this.material;
  }

  /**
   * Cambio de ajuste de cinematica inversa. Al encenderla los objetivos se toman
   * de la pose que haya, que es lo unico que no mueve nada al activar el modo.
   */
  #onIKSetting(path = '') {
    if (path === 'ik.enabled') this.rig.syncAll();
    else if (path.startsWith('ik.pins.')) this.rig.readPins();
    // La reserva de estirado cambia el resultado sin mover nada: hay que pedir
    // expresamente que las cadenas fijadas se rehagan.
    else if (path === 'ik.margin') this.rig.invalidate();
    this.#refresh();
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
      this.onSelect?.(null);
      return;
    }
    entry.mesh.material = this.materialActive;
    this.#applyMode(entry);
    this.#placeProxy(entry);
    this.gizmo.attach(this.proxy);
    this.helper.visible = true;
    this.onSelect?.({ key: entry.key, label: entry.label, boneKey: entry.boneKey });
  }

  /**
   * Que hace el giroscopio con este manejador. Las articulaciones solo giran y el
   * polo solo se mueve; los objetivos y la cadera hacen lo que diga `scene.tool`,
   * de modo que `W` coloca la mano y `E` gira la muñeca sin salir del modo.
   */
  #applyMode(entry) {
    const libre = entry.kind === 'effector' || entry.kind === 'body';
    const modo = entry.kind === 'joint' ? 'rotate'
      : entry.kind === 'pole' ? 'translate'
        : (libre && this.settings.get('scene.tool') === 'rotate') ? 'rotate' : 'translate';
    if (this.gizmo.mode !== modo) this.gizmo.setMode(modo);
  }

  /** Coloca el objeto que arrastra el giroscopio donde toca segun el manejador. */
  #placeProxy(entry) {
    const p = this.proxy;
    p.scale.set(1, 1, 1);
    if (entry.kind === 'pole') {
      const polo = this.rig.poleWorld(entry.chain, _v);
      if (polo) p.position.copy(polo);
      p.quaternion.identity();
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
    if (entry.kind === 'effector') this.rig.hold.add(entry.chain.id);
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
    if (entry.kind === 'pole') {
      // El polo gira el plano del pliegue con la punta clavada: el tercer paso del
      // solucionador gira sobre el eje hombro-objetivo, que no puede mover la mano.
      this.rig.solve(entry.chain, this.proxy.position);
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
    for (const entry of this.entries) {
      if (!entry.mesh.visible) continue;
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
      entry.mesh.scale.setScalar(r);
    }
    if (this.rig.on) this.#syncHints();
    if (this.selected && !this.dragging) this.#placeProxy(this.selected);
  }

  /** Esconde un manejador sin dejarlo en la lista de lo que acepta el raycast. */
  #hide(entry) {
    entry.mesh.visible = false;
    const i = this.pickable.indexOf(entry.mesh);
    if (i >= 0) this.pickable.splice(i, 1);
    if (this.selected === entry) this.select(null);
  }

  /** Donde va el manejador de una entrada; `false` si ahora mismo no hay punto. */
  #pointOf(entry, out) {
    if (entry.kind === 'effector') return !!this.rig.targetWorld(entry.chain, out);
    if (entry.kind === 'pole') return !!this.rig.poleWorld(entry.chain, out);
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
    this.history.push(this.character.getPose());
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
    const pose = this.history.pop();
    if (!pose) return false;
    this.character?.setPose(pose, 1);
    // La pose de vuelta manda sobre los objetivos: si no, una cadena fijada
    // volveria a llevar el miembro a donde acabamos de deshacer.
    this.rig.syncAll();
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
    this.hintMat.dispose();
    this.hintGeo.dispose();
  }
}
