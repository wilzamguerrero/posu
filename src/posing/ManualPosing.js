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
 *   - Cada gesto completo (pointerdown -> pointerup) es un paso de deshacer.
 */

import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';

const HANDLE_GEO = new THREE.SphereGeometry(1, 14, 10);
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _pq = new THREE.Quaternion();
const _s = new THREE.Vector3();

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
    this.selected = null;      // { key, label, bone }
    this.handles = new THREE.Group();
    this.handles.name = 'PosingHandles';
    this.handles.visible = false;
    this.entries = [];         // { key, label, bone, mesh }
    this.history = [];
    this.dragging = false;

    this.material = new THREE.MeshBasicMaterial({
      color: 0x4fc1ff, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false,
    });
    this.materialHover = this.material.clone();
    this.materialHover.color.set(0x9cdcfe);
    this.materialHover.opacity = 0.85;
    this.materialActive = this.material.clone();
    this.materialActive.color.set(0xffd479);
    this.materialActive.opacity = 0.95;

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.hovered = null;

    this.proxy = new THREE.Object3D();
    this.proxy.name = 'PosingProxy';

    this.gizmo = new TransformControls(viewport.cameras.active, viewport.renderer.domElement);
    this.gizmo.setMode('rotate');
    this.gizmo.setSpace('local');
    this.gizmo.size = 0.85;
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.dragging = e.value;
      viewport.cameras.controls.enabled = !e.value;
      if (e.value) this.#pushHistory();
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

  /** Reconstruye los manejadores a partir de los huesos posables del modelo. */
  rebuild() {
    // La geometria es compartida por todos los manejadores: no se destruye.
    for (const entry of this.entries) this.handles.remove(entry.mesh);
    this.entries.length = 0;
    this.select(null);
    if (!this.character?.loaded) return;

    // Las falanges solo se ofrecen si el usuario las pide: son 30 esferas mas.
    const fingers = this.settings.get('hands.fingers') === true;
    for (const { key, label, bone, finger } of this.character.posableBones({ fingers })) {
      const mesh = new THREE.Mesh(HANDLE_GEO, this.material);
      mesh.name = `handle:${key}`;
      mesh.renderOrder = 999;
      mesh.userData.key = key;
      this.handles.add(mesh);
      this.entries.push({ key, label, bone, mesh, finger: !!finger });
    }
  }

  setEnabled(on) {
    this.enabled = !!on;
    this.handles.visible = this.enabled;
    if (!this.enabled) {
      this.select(null);
      this.gizmo.enabled = false;
    } else {
      this.gizmo.enabled = true;
      if (!this.entries.length) this.rebuild();
    }
  }

  select(key) {
    const entry = key ? this.entries.find((e) => e.key === key) : null;
    for (const e of this.entries) e.mesh.material = this.material;
    this.selected = entry ?? null;

    if (!entry) {
      this.gizmo.detach();
      this.helper.visible = false;
      this.onSelect?.(null);
      return;
    }
    entry.mesh.material = this.materialActive;
    entry.bone.updateWorldMatrix(true, false);
    entry.bone.matrixWorld.decompose(this.proxy.position, this.proxy.quaternion, _s);
    this.proxy.scale.set(1, 1, 1);
    this.gizmo.attach(this.proxy);
    this.helper.visible = true;
    this.onSelect?.({ key: entry.key, label: entry.label });
  }

  /** Traslada la rotacion del giroscopio al hueso seleccionado. */
  #applyProxy() {
    const entry = this.selected;
    if (!entry) return;
    const bone = entry.bone;
    const parent = bone.parent;
    if (parent) {
      parent.updateWorldMatrix(true, false);
      parent.matrixWorld.decompose(_v, _pq, _s);
      bone.quaternion.copy(_pq.invert()).multiply(this.proxy.quaternion);
    } else {
      bone.quaternion.copy(this.proxy.quaternion);
    }
    // El posado manual manda: se congela la captura para que no lo sobrescriba.
    if (this.settings.get('mocap.frozen') !== true) this.settings.set('mocap.frozen', true);
  }

  /** Coloca los manejadores sobre las articulaciones y sigue a la camara. */
  #sync() {
    if (!this.enabled || !this.entries.length) return;
    const cam = this.viewport.cameras.active;
    if (this.gizmo.camera !== cam) this.gizmo.camera = cam;

    const height = Math.max(0.4, this.settings.get('figure.height') ?? 1.75);
    const base = height * 0.013;
    for (const entry of this.entries) {
      entry.bone.updateWorldMatrix(true, false);
      entry.bone.matrixWorld.decompose(_v, _q, _s);
      entry.mesh.position.copy(_v);
      // Tamaño constante en pantalla: crece con la distancia a la camara.
      const dist = cam.isOrthographicCamera
        ? (cam.top - cam.bottom) * 0.5
        : cam.position.distanceTo(_v);
      // Las falanges llevan manejadores mas finos para no tapar la mano.
      const f = entry.finger ? 0.4 : 1;
      const r = THREE.MathUtils.clamp(base * dist * 0.55 * f, base * 0.5 * f, base * 3 * f);
      entry.mesh.scale.setScalar(r);
    }
    if (this.selected && !this.dragging) {
      this.selected.bone.matrixWorld.decompose(this.proxy.position, this.proxy.quaternion, _s);
      this.proxy.scale.set(1, 1, 1);
    }
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
    if (!this.enabled || !this.entries.length) return null;
    this.raycaster.setFromCamera(this.#pointerTo(event), this.viewport.cameras.active);
    const hits = this.raycaster.intersectObjects(this.handles.children, false);
    return hits.length ? hits[0].object.userData.key : null;
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
      e.mesh.material = e.key === key ? this.materialHover : this.material;
    }
    this.hovered = key;
    this.viewport.renderer.domElement.style.cursor = key ? 'grab' : '';
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

  undo() {
    const pose = this.history.pop();
    if (!pose) return false;
    this.character?.setPose(pose, 1);
    return true;
  }

  get canUndo() {
    return this.history.length > 0;
  }

  dispose() {
    this.unsubscribe?.();
    const dom = this.viewport.renderer.domElement;
    dom.removeEventListener('pointerdown', this._onPointerDown);
    dom.removeEventListener('pointermove', this._onPointerMove);
    this.gizmo.detach();
    this.gizmo.dispose();
    this.viewport.remove(this.handles, this.proxy, this.helper);
    this.material.dispose();
    this.materialHover.dispose();
    this.materialActive.dispose();
  }
}
