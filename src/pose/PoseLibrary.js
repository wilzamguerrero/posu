/**
 * PoseLibrary
 * ===========
 * Biblioteca de poses guardadas en el navegador (localStorage). Permite
 * capturar la pose actual del personaje —venga de la camara o del posado
 * manual—, volver a ella mas tarde, exportarla a un archivo .json y compartirla.
 *
 * Ademas ofrece dos poses de referencia calculadas sobre la pose de enlace del
 * propio archivo, asi que funcionan con cualquier rig:
 *   - "T": la pose de enlace tal cual (Mixamo la exporta en T).
 *   - "A": la de enlace con los brazos girados 45 grados hacia abajo.
 */

import * as THREE from 'three';

const STORE_KEY = 'posu.poses.v1';
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _axis = new THREE.Vector3();

function uid() {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export class PoseLibrary {
  /**
   * @param {import('../model/Character.js').Character} character
   * @param {{onChange?: Function}} [opts]
   */
  constructor(character, { onChange } = {}) {
    this.character = character;
    this.onChange = onChange ?? null;
    this.items = this.#read();
  }

  /** Cambia la figura sobre la que se captura y se aplican las poses. */
  setCharacter(character) {
    this.character = character;
    return this;
  }

  #read() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return Array.isArray(parsed) ? parsed.filter((p) => p && p.rotations) : [];
    } catch {
      return [];
    }
  }

  #write() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(this.items));
    } catch (err) {
      console.warn('[Poses] no se pudo guardar en localStorage:', err);
    }
    this.onChange?.(this.items);
  }

  list() {
    return this.items.map(({ id, name, created }) => ({ id, name, created }));
  }

  get(id) {
    return this.items.find((p) => p.id === id) ?? null;
  }

  /** Guarda la pose actual del personaje. */
  capture(name = '') {
    if (!this.character?.loaded) return null;
    const pose = this.character.getPose();
    const item = {
      id: uid(),
      name: name.trim() || `Pose ${this.items.length + 1}`,
      created: Date.now(),
      rotations: pose.rotations,
      hipsOffset: pose.hipsOffset,
    };
    this.items.unshift(item);
    this.#write();
    return item;
  }

  apply(id, blend = 1) {
    const item = this.get(id);
    if (!item) return false;
    this.character?.setPose(item, blend);
    return true;
  }

  rename(id, name) {
    const item = this.get(id);
    if (!item) return false;
    item.name = String(name).trim() || item.name;
    this.#write();
    return true;
  }

  remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((p) => p.id !== id);
    if (this.items.length === before) return false;
    this.#write();
    return true;
  }

  clear() {
    this.items = [];
    this.#write();
  }

  // ------------------------------------------------------ importar/exportar ---

  exportJSON(id = null) {
    const payload = id ? [this.get(id)].filter(Boolean) : this.items;
    return JSON.stringify({ app: 'posu', version: 1, poses: payload }, null, 2);
  }

  /** @returns {number} cantidad de poses importadas */
  importJSON(text) {
    let data = null;
    try { data = JSON.parse(text); } catch { return 0; }
    const list = Array.isArray(data) ? data : data?.poses;
    if (!Array.isArray(list)) return 0;
    let count = 0;
    for (const p of list) {
      if (!p?.rotations) continue;
      this.items.unshift({
        id: uid(),
        name: String(p.name ?? 'Pose importada'),
        created: p.created ?? Date.now(),
        rotations: p.rotations,
        hipsOffset: p.hipsOffset ?? null,
      });
      count++;
    }
    if (count) this.#write();
    return count;
  }

  // -------------------------------------------------------- poses de estudio ---

  /**
   * Aplica una pose de referencia. Se calcula sobre la pose de enlace del
   * archivo, de forma que no depende de nombres de huesos concretos.
   * @param {'t'|'a'} tipo
   */
  preset(tipo = 't') {
    const ch = this.character;
    if (!ch?.loaded) return false;
    ch.resetToRest();
    if (tipo === 't') return true;

    // Pose A: giro de 45 grados alrededor del eje "frente" del personaje. El
    // signo cambia por lado porque los brazos apuntan en sentidos opuestos.
    const angle = THREE.MathUtils.degToRad(45);
    for (const [key, sign] of [['leftArm', -1], ['rightArm', 1]]) {
      const bone = ch.bones[key];
      const restWorld = ch.rest.world.get(bone);
      if (!bone || !restWorld) continue;

      // Eje frente (+Z del marco de aplicacion) llevado al espacio del modelo.
      _axis.set(0, 0, 1).applyQuaternion(ch.basis);
      const delta = _q1.setFromAxisAngle(_axis, sign * angle);
      const world = _q2.copy(delta).multiply(restWorld);

      const parent = bone.parent;
      const parentWorld = ch.rest.world.has(parent)
        ? _q3.copy(ch.rest.world.get(parent))
        : _q3.copy(restWorld).multiply(new THREE.Quaternion().copy(ch.rest.local.get(bone)).invert());
      bone.quaternion.copy(parentWorld.invert()).multiply(world);
    }
    return true;
  }
}
