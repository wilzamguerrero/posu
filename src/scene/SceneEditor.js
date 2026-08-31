/**
 * POSU · Editor de escena
 * ---------------------------------------------------------------------------
 * Añade, selecciona y transforma los elementos que el usuario mete en la
 * escena: figuras, primitivas geometricas y luces. Todo el estado vive en el
 * almacen de ajustes (`scene.figures`, `scene.objects` y `scene.lights`), de
 * modo que la escena montada se conserva al recargar la pagina y se puede
 * exportar con el resto de ajustes.
 *
 * Reparto de responsabilidades:
 *   - El almacen manda: cada propiedad editable se escribe en su ruta
 *     (`scene.objects.2.material.color`) y este modulo la aplica al Object3D.
 *   - El gizmo (TransformControls) es la excepcion: mientras se arrastra, el
 *     Object3D va por delante y el almacen se actualiza al soltar.
 *   - Las figuras no las construye este modulo: son de `FigureSet`. Aqui solo
 *     se seleccionan y se mueven, tomando prestado su `root`.
 *   - W / E / R cambian de herramienta (mover, girar, escalar), como en
 *     cualquier programa 3D.
 */
import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { buildGeometry, PRIMITIVE_BY_ID, PRIMITIVES } from './primitives.js';
import { LIGHT_BY_ID, LIGHT_TYPES, lightDefaults } from './lights.js';
import { crearMaterial, aplicarParametros, materialDefaults, proyectaSombra } from '../model/MaterialLibrary.js';
import { nuevoId } from '../core/ids.js';

const DEG = Math.PI / 180;
const vec = (x = 0, y = 0, z = 0) => ({ x, y, z });
const _p = new THREE.Vector3();

export class SceneEditor {
  /**
   * @param {object} deps
   * @param {import('../core/Settings.js').Settings} deps.settings
   * @param {import('../core/Viewport.js').Viewport} deps.viewport
   * @param {import('../model/FigureSet.js').FigureSet} [deps.figures] Dueno de
   *   las figuras: este modulo las selecciona y las mueve, pero no las crea.
   * @param {(event?: PointerEvent) => boolean} [deps.blocked] Devuelve true si
   *   otro modulo manda sobre ese clic (por ejemplo un manejador de pose).
   * @param {(id: string) => void} [deps.onSelect]
   * @param {(id: string) => void} [deps.onPick] Seleccion hecha en el visor, no
   *   en la lista: la interfaz aprovecha para mostrar la seccion de escena.
   */
  constructor({ settings, viewport, figures, blocked, onSelect, onPick } = {}) {
    this.settings = settings;
    this.viewport = viewport;
    this.figures = figures ?? null;
    this.blocked = blocked ?? (() => false);
    this.onSelect = onSelect ?? null;
    this.onPick = onPick ?? null;

    this.group = new THREE.Group();
    this.group.name = 'EscenaDelUsuario';
    this.helpers = new THREE.Group();
    this.helpers.name = 'AyudantesDeLuz';
    /** @type {Map<string, {def: object, object: THREE.Object3D, helper?: THREE.Object3D, target?: THREE.Object3D, pick?: THREE.Mesh, material?: THREE.Material}>} */
    this.items = new Map();
    this.dragging = false;

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    /** Id del elemento bajo el raton, para el contorno de aviso. */
    this.hovered = '';

    // Contorno del elemento apuntado: hace visible que la escena se puede
    // seleccionar pinchando, sin tocar los materiales del usuario.
    this.outline = new THREE.BoxHelper(new THREE.Object3D(), 0x4fc1ff);
    this.outline.material.depthTest = false;
    this.outline.material.transparent = true;
    this.outline.material.opacity = 0.9;
    this.outline.renderOrder = 997;
    this.outline.visible = false;

    this.gizmo = new TransformControls(viewport.cameras.active, viewport.renderer.domElement);
    this.gizmo.size = 0.9;
    this.gizmo.setMode(settings.get('scene.tool') ?? 'translate');
    this.gizmo.setSpace(settings.get('scene.space') ?? 'world');
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.dragging = e.value;
      viewport.cameras.controls.enabled = !e.value;
      if (!e.value) this.#writeTransform();
    });
    this.gizmoHelper = this.gizmo.getHelper?.() ?? this.gizmo;
    this.gizmoHelper.visible = false;

    viewport.add(this.group, this.helpers, this.gizmoHelper, this.outline);

    this._onPointerDown = (e) => this.#onPointerDown(e);
    this._onPointerMove = (e) => this.#onPointerMove(e);
    this._onPointerLeave = () => this.#setHover('');
    const dom = viewport.renderer.domElement;
    dom.addEventListener('pointerdown', this._onPointerDown);
    dom.addEventListener('pointermove', this._onPointerMove);
    dom.addEventListener('pointerleave', this._onPointerLeave);
    this.unsubscribe = viewport.onFrame(() => this.#sync());

    this.#bind();
    this.rebuild();
  }

  /* ── Suscripciones ──────────────────────────────────────────────────── */

  #bind() {
    const s = this.settings;
    s.on('scene.tool', () => this.#applyTool());
    s.on('scene.space', (v) => this.gizmo.setSpace(v));
    s.on('scene.snap', (v) => this.#applySnap(v));
    s.on('scene.selected', (id) => this.#attach(id));
    s.on('scene.helpers', () => this.#refreshHelpers());
    // Alta y baja de elementos: llegan como sustitucion completa de la lista.
    s.on('scene.objects', () => this.rebuild());
    s.on('scene.lights', () => this.rebuild());
    s.on('scene.figures', () => this.rebuild());
    // Edicion de una propiedad concreta: "scene.lights.1.intensity".
    s.on('scene.*', (_v, _p, path) => this.#onPath(path));
    this.#applySnap(s.get('scene.snap'));
  }

  #applySnap(v) {
    const n = Number(v) || 0;
    this.gizmo.translationSnap = n > 0 ? n : null;
    this.gizmo.rotationSnap = n > 0 ? 15 * DEG : null;
    this.gizmo.scaleSnap = n > 0 ? 0.1 : null;
  }

  /* ── Lectura del almacen ────────────────────────────────────────────── */

  get objectDefs() { return this.settings.get('scene.objects') ?? []; }
  get lightDefs() { return this.settings.get('scene.lights') ?? []; }
  get figureDefs() { return this.settings.get('scene.figures') ?? []; }

  /** Indice y rama de un id, para poder componer rutas de ajustes. */
  locate(id) {
    let i = this.objectDefs.findIndex((d) => d.id === id);
    if (i >= 0) return { branch: 'objects', index: i, def: this.objectDefs[i] };
    i = this.lightDefs.findIndex((d) => d.id === id);
    if (i >= 0) return { branch: 'lights', index: i, def: this.lightDefs[i] };
    i = this.figureDefs.findIndex((d) => d.id === id);
    if (i >= 0) return { branch: 'figures', index: i, def: this.figureDefs[i] };
    return null;
  }

  /** Ruta base de un elemento: "scene.objects.2". */
  pathOf(id) {
    const at = this.locate(id);
    return at ? `scene.${at.branch}.${at.index}` : null;
  }

  /** Elementos para la lista de la interfaz. Las figuras van primero. */
  list() {
    return [
      ...(this.figures?.list() ?? []),
      ...this.objectDefs.map((d) => ({
        id: d.id, label: d.name, icon: PRIMITIVE_BY_ID[d.type]?.icon ?? 'box',
        meta: d.visible === false ? 'oculto' : '', kind: 'objeto',
      })),
      ...this.lightDefs.map((d) => ({
        id: d.id, label: d.name, icon: LIGHT_BY_ID[d.type]?.icon ?? 'lightbulb',
        meta: d.visible === false ? 'apagada' : `${Math.round(d.intensity)}`, kind: 'luz',
      })),
    ];
  }

  /* ── Alta, baja y duplicado ─────────────────────────────────────────── */

  /** Nombre libre del tipo: "Cubo", "Cubo 2"… */
  #nombre(base) {
    const usados = new Set([...this.objectDefs, ...this.lightDefs, ...this.figureDefs].map((d) => d.name));
    if (!usados.has(base)) return base;
    for (let n = 2; n < 999; n++) if (!usados.has(`${base} ${n}`)) return `${base} ${n}`;
    return base;
  }

  /**
   * Coloca el elemento nuevo delante de la camara, a la altura del pecho: es
   * mas util que dejarlo siempre en el origen, donde queda dentro de la figura.
   */
  #spawn(alto = 0.4) {
    const cam = this.viewport.cameras.active;
    const target = this.viewport.cameras.controls.target;
    const dir = new THREE.Vector3().subVectors(target, cam.position).setY(0);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    dir.normalize();
    const p = new THREE.Vector3().copy(target).addScaledVector(dir, 0.9);
    return vec(Number(p.x.toFixed(3)), Math.max(alto / 2, 0.2), Number(p.z.toFixed(3)));
  }

  /** Inserta una primitiva y la deja seleccionada con el gizmo puesto. */
  addObject(type = 'cubo') {
    const preset = PRIMITIVE_BY_ID[type] ?? PRIMITIVES[0];
    const slot = this.settings.get('materials.objeto') ?? {};
    const def = {
      id: nuevoId(),
      type: preset.id,
      name: this.#nombre(preset.label),
      visible: true,
      position: this.#spawn(preset.p.alto ?? preset.p.radio ?? 0.4),
      rotation: vec(),
      scale: vec(1, 1, 1),
      params: { ...preset.p },
      material: { ...materialDefaults(slot.preset ?? 'yeso'), ...slot },
      castShadow: true,
      receiveShadow: true,
    };
    this.settings.set('scene.objects', [...this.objectDefs, def]);
    this.select(def.id);
    return def.id;
  }

  /** Inserta una luz. */
  addLight(type = 'punto') {
    const preset = LIGHT_BY_ID[type] ?? LIGHT_TYPES[0];
    const def = {
      id: nuevoId(),
      type: preset.id,
      name: this.#nombre(preset.label),
      visible: true,
      position: this.#spawn(1.6),
      ...lightDefaults(preset.id),
    };
    def.position.y = 1.9;
    this.settings.set('scene.lights', [...this.lightDefs, def]);
    this.select(def.id);
    return def.id;
  }

  /** Copia un elemento con un pequeño desplazamiento para verlo. */
  duplicate(id) {
    const at = this.locate(id);
    if (!at) return null;
    // Las figuras se clonan con su esqueleto y su pose: es cosa de FigureSet.
    if (at.branch === 'figures') return this.figures?.duplicate(id) ?? null;
    const def = structuredClone(at.def);
    def.id = nuevoId();
    def.name = this.#nombre(def.name.replace(/ \d+$/, ''));
    def.position = { ...def.position, x: def.position.x + 0.25 };
    const branch = `scene.${at.branch}`;
    this.settings.set(branch, [...(this.settings.get(branch) ?? []), def]);
    this.select(def.id);
    return def.id;
  }

  remove(id) {
    const at = this.locate(id);
    if (!at) return;
    if (at.branch === 'figures') { this.figures?.remove(id); return; }
    const branch = `scene.${at.branch}`;
    this.settings.set(branch, (this.settings.get(branch) ?? []).filter((d) => d.id !== id));
    if (this.settings.get('scene.selected') === id) this.select('');
  }

  /** Vacia lo que el usuario ha insertado. Las figuras no se tocan. */
  clearAll() {
    this.settings.batch({ 'scene.objects': [], 'scene.lights': [], 'scene.selected': '' });
  }

  select(id) {
    this.settings.set('scene.selected', id ?? '');
  }

  setTool(tool) {
    if (!['translate', 'rotate', 'scale'].includes(tool)) return;
    this.settings.set('scene.tool', tool);
  }

  /* ── Construccion de la escena ──────────────────────────────────────── */

  /** Reconstruye todos los Object3D a partir de las definiciones guardadas. */
  rebuild() {
    const vivos = new Set([...this.objectDefs, ...this.lightDefs, ...this.figureDefs].map((d) => d.id));
    for (const [id, item] of this.items) {
      if (!vivos.has(id)) { this.#destroy(item); this.items.delete(id); }
    }
    for (const def of this.figureDefs) this.#ensureFigure(def);
    for (const def of this.objectDefs) this.#ensureObject(def);
    for (const def of this.lightDefs) this.#ensureLight(def);
    if (this.hovered && !this.items.has(this.hovered)) this.#setHover('');
    this.#attach(this.settings.get('scene.selected'));
    this.#refreshHelpers();
  }

  #destroy(item) {
    // Una figura es de FigureSet: aqui solo se olvida la ficha.
    if (item.kind === 'figura') return;
    item.object.parent?.remove(item.object);
    item.helper?.parent?.remove(item.helper);
    item.helper?.dispose?.();
    item.target?.parent?.remove(item.target);
    item.object.geometry?.dispose?.();
    item.material?.dispose?.();
    item.pick?.geometry?.dispose?.();
  }

  /**
   * Ficha de una figura: toma prestado el `root` que ya tiene su `Character`.
   * Mientras el modelo se esta cargando no hay nada que seleccionar; FigureSet
   * avisa al terminar y se vuelve a construir.
   */
  #ensureFigure(def) {
    const character = this.figures?.get(def.id) ?? null;
    if (!character?.loaded) { this.items.delete(def.id); return null; }
    let item = this.items.get(def.id);
    if (!item || item.object !== character.root) {
      item = { def, object: character.root, character, kind: 'figura', box: new THREE.Box3() };
      this.items.set(def.id, item);
    }
    item.def = def;
    item.character = character;
    return item;
  }

  /** Crea o actualiza la malla de una primitiva. */
  #ensureObject(def) {
    let item = this.items.get(def.id);
    if (item && item.def.type !== def.type) { this.#destroy(item); this.items.delete(def.id); item = null; }
    if (!item) {
      const geo = buildGeometry(def);
      const mat = crearMaterial(def.material?.preset ?? 'yeso', def.material) ?? crearMaterial('yeso');
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = def.name;
      mesh.userData.itemId = def.id;
      this.group.add(mesh);
      item = { def, object: mesh, material: mat };
      this.items.set(def.id, item);
    }
    item.def = def;
    this.#applyObject(item);
    return item;
  }

  #applyObject(item) {
    const { def, object } = item;
    object.name = def.name;
    object.visible = def.visible !== false;
    object.position.set(def.position.x, def.position.y, def.position.z);
    object.rotation.set(def.rotation.x * DEG, def.rotation.y * DEG, def.rotation.z * DEG);
    object.scale.set(def.scale.x || 1, def.scale.y || 1, def.scale.z || 1);

    const presetId = def.material?.preset ?? 'yeso';
    if (object.material?.userData?.presetId !== presetId) {
      const nuevo = crearMaterial(presetId, def.material);
      if (nuevo) {
        object.material?.dispose?.();
        object.material = nuevo;
        item.material = nuevo;
      }
    } else {
      aplicarParametros(object.material, def.material);
    }
    const doble = PRIMITIVE_BY_ID[def.type]?.doubleSide;
    if (doble && object.material) object.material.side = THREE.DoubleSide;
    object.castShadow = def.castShadow !== false && proyectaSombra(presetId);
    object.receiveShadow = def.receiveShadow !== false;
  }

  /** Rehace la geometria cuando cambian los parametros (radio, segmentos…). */
  #rebuildGeometry(item) {
    const geo = buildGeometry(item.def);
    item.object.geometry?.dispose?.();
    item.object.geometry = geo;
  }

  /** Crea o actualiza una luz con su ayudante y su objetivo. */
  #ensureLight(def) {
    let item = this.items.get(def.id);
    if (item && item.def.type !== def.type) { this.#destroy(item); this.items.delete(def.id); item = null; }
    if (!item) {
      const preset = LIGHT_BY_ID[def.type] ?? LIGHT_TYPES[0];
      const light = preset.make();
      light.name = def.name;
      light.userData.itemId = def.id;
      // Cuerpo visible y "clicable": las luces no tienen geometria propia.
      const pick = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.055),
        new THREE.MeshBasicMaterial({ color: 0xffd479, transparent: true, opacity: 0.9, depthTest: false }),
      );
      pick.name = 'luz:cuerpo';
      pick.renderOrder = 998;
      pick.userData.itemId = def.id;
      light.add(pick);
      this.group.add(light);

      let target;
      if (light.target && preset.fields.includes('target')) {
        target = light.target;
        target.name = `${def.name}:objetivo`;
        this.group.add(target);
      }
      const helper = preset.helper?.(light) ?? null;
      if (helper) { helper.userData.itemId = def.id; this.helpers.add(helper); }
      item = { def, object: light, helper, target, pick };
      this.items.set(def.id, item);
    }
    item.def = def;
    this.#applyLight(item);
    return item;
  }

  #applyLight(item) {
    const { def, object: light } = item;
    const campos = LIGHT_BY_ID[def.type]?.fields ?? [];
    light.name = def.name;
    light.visible = def.visible !== false;
    light.position.set(def.position.x, def.position.y, def.position.z);
    light.color.set(def.color ?? '#ffffff');
    light.intensity = Number(def.intensity) || 0;

    if (light.isHemisphereLight) light.groundColor.set(def.groundColor ?? '#40382e');
    if (campos.includes('distance')) light.distance = Number(def.distance) || 0;
    if (campos.includes('decay')) light.decay = Number(def.decay) || 0;
    if (campos.includes('angle')) light.angle = (Number(def.angle) || 26) * DEG;
    if (campos.includes('penumbra')) light.penumbra = Number(def.penumbra) || 0;
    if (light.isRectAreaLight) {
      light.width = Number(def.width) || 1;
      light.height = Number(def.height) || 1;
    }
    if (item.target) {
      const t = def.target ?? vec(0, 0.95, 0);
      item.target.position.set(t.x, t.y, t.z);
      item.target.updateMatrixWorld();
    }
    if (light.shadow) {
      light.castShadow = def.shadow !== false;
      const lado = this.settings.get('quality.shadowMap') ?? 1024;
      if (light.shadow.mapSize.width !== lado) {
        light.shadow.mapSize.set(lado, lado);
        light.shadow.map?.dispose();
        light.shadow.map = null;
      }
      light.shadow.radius = Number(def.radius) || 0;
      light.shadow.bias = Number(def.bias) || 0;
      if (light.isDirectionalLight) {
        const c = light.shadow.camera;
        c.left = -4; c.right = 4; c.top = 4; c.bottom = -4; c.near = 0.1; c.far = 40;
        c.updateProjectionMatrix();
      }
    }
    // Las luces de area no admiten sombras en WebGL: el ayudante lo aclara.
    item.pick.visible = this.settings.get('scene.helpers') !== false && light.visible;
    item.helper?.update?.();
  }

  #refreshHelpers() {
    const on = this.settings.get('scene.helpers') !== false;
    this.helpers.visible = on;
    for (const item of this.items.values()) {
      if (item.pick) item.pick.visible = on && item.object.visible;
    }
  }

  /* ── Reaccion a los cambios de ruta ─────────────────────────────────── */

  /**
   * Traduce una ruta del almacen ("scene.lights.1.angle") al elemento afectado
   * y aplica solo lo necesario, sin reconstruir la escena entera.
   */
  #onPath(path) {
    const m = /^scene\.(objects|lights|figures)\.(\d+)\.(.+)$/.exec(path ?? '');
    if (!m) return;
    const [, branch, idx, resto] = m;
    const def = (this.settings.get(`scene.${branch}`) ?? [])[Number(idx)];
    if (!def) return;
    const item = this.items.get(def.id);
    if (!item) { this.rebuild(); return; }
    item.def = def;
    if (branch === 'figures') {
      // La colocacion de una figura la aplica FigureSet, dueno del personaje.
    } else if (branch === 'objects') {
      if (resto.startsWith('params')) this.#rebuildGeometry(item);
      this.#applyObject(item);
    } else {
      this.#applyLight(item);
    }
    // Un cambio de nombre o de visibilidad cambia la lista de la interfaz.
    if (resto === 'name' || resto === 'visible') this.onSelect?.(this.settings.get('scene.selected'));
    // Si se esta editando justo lo que el raton senala, el contorno le sigue.
    if (this.hovered === def.id) this.outline.setFromObject(item.object);
  }

  /* ── Gizmo y seleccion ──────────────────────────────────────────────── */

  #attach(id) {
    const item = id ? this.items.get(id) : null;
    if (!item) {
      this.gizmo.detach();
      this.gizmoHelper.visible = false;
      this.onSelect?.('');
      return;
    }
    this.gizmo.attach(item.object);
    // El contorno de aviso sobra sobre lo ya seleccionado: manda el gizmo.
    if (this.hovered === id) this.#setHover('');
    this.gizmo.showX = this.gizmo.showY = this.gizmo.showZ = true;
    this.gizmo.setMode(this.#modeFor(item));
    this.gizmoHelper.visible = true;
    // Seleccionar una figura tambien la hace la activa (la que recibe camara,
    // poses y manos). Al contrario no: pinchar un cubo no cambia la activa.
    if (item.kind === 'figura') this.figures?.setActive(id);
    this.onSelect?.(id);
  }

  /**
   * Modo del gizmo para lo que hay seleccionado: no todo se gira o se escala.
   * Se consulta tambien al cambiar de herramienta, para que elegir "escalar"
   * con una figura delante no la deforme.
   */
  #modeFor(item) {
    const modo = this.settings.get('scene.tool') ?? 'translate';
    // Girar o escalar una luz puntual no significa nada: solo se mueve.
    if (item?.object?.isLight && !item.object.isRectAreaLight) return 'translate';
    // Una figura no se escala: su tamano es el deslizador de Altura.
    if (item?.kind === 'figura' && modo === 'scale') return 'translate';
    return modo;
  }

  /** Herramienta nueva: la seleccion actual puede no admitirla. */
  #applyTool() {
    this.gizmo.setMode(this.#modeFor(this.items.get(this.settings.get('scene.selected'))));
  }

  /** Al soltar el gizmo: el Object3D manda y el almacen se pone al dia. */
  #writeTransform() {
    const id = this.settings.get('scene.selected');
    const item = this.items.get(id);
    const at = this.locate(id);
    if (!item || !at) return;
    const o = item.object;
    const base = `scene.${at.branch}.${at.index}`;
    const cambios = {
      [`${base}.position.x`]: round(o.position.x),
      [`${base}.position.y`]: round(o.position.y),
      [`${base}.position.z`]: round(o.position.z),
    };
    if (!o.isLight) {
      cambios[`${base}.rotation.x`] = round(o.rotation.x / DEG, 1);
      cambios[`${base}.rotation.y`] = round(o.rotation.y / DEG, 1);
      cambios[`${base}.rotation.z`] = round(o.rotation.z / DEG, 1);
      // Las figuras no guardan escala: la altura es su deslizador.
      if (at.branch !== 'figures') {
        cambios[`${base}.scale.x`] = round(o.scale.x);
        cambios[`${base}.scale.y`] = round(o.scale.y);
        cambios[`${base}.scale.z`] = round(o.scale.z);
      }
    }
    this.settings.batch(cambios);
  }

  #pointerTo(event) {
    const r = this.viewport.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((event.clientX - r.left) / r.width) * 2 - 1, -((event.clientY - r.top) / r.height) * 2 + 1);
    return this.pointer;
  }

  /** Lo que se puede pinchar: los solidos visibles y el cuerpo de las luces. */
  #pickables() {
    const lista = [];
    for (const item of this.items.values()) {
      if (item.kind === 'figura' || !item.object.visible) continue;
      if (item.object.isLight) { if (item.pick?.visible) lista.push(item.pick); }
      else lista.push(item.object);
    }
    return lista;
  }

  /**
   * Id del elemento que hay bajo el puntero, o '' si no hay ninguno.
   *
   * Las figuras se apuntan por su caja envolvente, no por su malla: la anatomia
   * son decenas de miles de triangulos con esqueleto y esto se llama en cada
   * movimiento del raton. Es lo mismo que dibuja el contorno azul, asi que se
   * selecciona exactamente lo que se resalta.
   */
  #pickAt(event) {
    const cam = this.viewport.cameras.active;
    this.raycaster.setFromCamera(this.#pointerTo(event), cam);
    const objetos = this.#pickables();
    const hits = objetos.length ? this.raycaster.intersectObjects(objetos, false) : [];
    let mejor = hits[0]?.object?.userData?.itemId ?? '';
    let cerca = hits[0]?.distance ?? Infinity;

    for (const item of this.items.values()) {
      if (item.kind !== 'figura' || !item.object.visible) continue;
      const caja = item.box.setFromObject(item.object);
      if (caja.isEmpty()) continue;
      if (!this.raycaster.ray.intersectBox(caja, _p)) continue;
      const d = this.raycaster.ray.origin.distanceTo(_p);
      if (d < cerca) { cerca = d; mejor = item.def.id; }
    }
    return mejor;
  }

  /**
   * ¿Manda el gizmo sobre este puntero? Se comprueba que siga atado a algo: al
   * soltar la seleccion, TransformControls deja su ultimo eje apuntado puesto, y
   * sin esta condicion el visor se quedaba sordo a los clics.
   */
  #gizmoBusy() {
    return this.dragging || (!!this.gizmo.object && !!this.gizmo.axis);
  }

  /** Seleccion con el raton en el visor. El gizmo y el posado tienen prioridad. */
  #onPointerDown(event) {
    if (event.button !== 0 || this.#gizmoBusy() || this.blocked(event)) return;
    const id = this.#pickAt(event);
    // Pinchar en el vacio deselecciona, que es lo esperado en un editor 3D.
    if (!id && !this.settings.get('scene.selected')) return;
    this.select(id);
    if (id) {
      this.#setHover('');
      this.onPick?.(id);
    }
  }

  /**
   * Aviso de que hay algo seleccionable debajo: contorno azul y cursor de mano.
   * Sin esto la seleccion en el visor no se descubre, y hay que ir a la lista.
   */
  #onPointerMove(event) {
    if (this.#gizmoBusy() || this.blocked(event)) { this.#setHover(''); return; }
    this.#setHover(this.#pickAt(event));
  }

  #setHover(id) {
    const marcado = id && id !== this.settings.get('scene.selected') ? id : '';
    const dom = this.viewport.renderer.domElement;
    // El cursor se comparte con el posado manual: solo se limpia el propio.
    if (marcado) dom.style.cursor = 'pointer';
    else if (dom.style.cursor === 'pointer') dom.style.cursor = '';
    if (marcado === this.hovered) return;
    this.hovered = marcado;

    const item = marcado ? this.items.get(marcado) : null;
    if (item) this.outline.setFromObject(item.object);
    this.outline.visible = !!item;
  }

  /** Por fotograma: la camara del gizmo y los ayudantes que siguen a la luz. */
  #sync() {
    const cam = this.viewport.cameras.active;
    if (this.gizmo.camera !== cam) this.gizmo.camera = cam;
    // Mientras se arrastra el gizmo, el elemento se mueve fuera del almacen: hay
    // que pedir el repintado de la sombra en cada fotograma.
    if (this.dragging) this.viewport.invalidateShadows?.();
    if (!this.helpers.visible) return;
    for (const item of this.items.values()) {
      if (item.helper?.update) item.helper.update();
    }
  }

  /* ── Teclado ────────────────────────────────────────────────────────── */

  /**
   * Atajos del editor. Devuelve true si consumio la tecla, para que la UI no la
   * use tambien.  W = mover · E = girar · R = escalar · Supr = borrar.
   */
  handleKey(event) {
    const k = event.key.toLowerCase();
    if (k === 'w') { this.setTool('translate'); return true; }
    if (k === 'e') { this.setTool('rotate'); return true; }
    if (k === 'r') { this.setTool('scale'); return true; }
    const id = this.settings.get('scene.selected');
    if (!id) return false;
    if (k === 'delete' || k === 'supr') { this.remove(id); return true; }
    if (k === 'escape') { this.select(''); return true; }
    if (k === 'x' && event.altKey) { this.settings.set('scene.space', this.settings.get('scene.space') === 'world' ? 'local' : 'world'); return true; }
    return false;
  }

  dispose() {
    this.unsubscribe?.();
    const dom = this.viewport.renderer.domElement;
    dom.removeEventListener('pointerdown', this._onPointerDown);
    dom.removeEventListener('pointermove', this._onPointerMove);
    dom.removeEventListener('pointerleave', this._onPointerLeave);
    for (const item of this.items.values()) this.#destroy(item);
    this.items.clear();
    this.gizmo.detach();
    this.gizmo.dispose?.();
    this.gizmoHelper.parent?.remove(this.gizmoHelper);
    this.outline.parent?.remove(this.outline);
    this.outline.geometry.dispose();
    this.outline.material.dispose();
    this.group.parent?.remove(this.group);
    this.helpers.parent?.remove(this.helpers);
  }
}

/** Redondeo corto: evita guardar 0.30000000000000004 en los ajustes. */
function round(v, dec = 3) {
  const f = 10 ** dec;
  return Math.round(v * f) / f;
}
