/**
 * ATOM · Caja envolvente
 * ---------------------------------------------------------------------------
 * Dibuja el volumen de los elementos de la escena: el contorno que avisa de lo
 * que hay bajo el raton y la caja fija del elemento seleccionado, con su huella
 * en el suelo si se pide.
 *
 * Dos cosas la separan de un `THREE.BoxHelper`, que es lo que habia antes:
 *
 *   - Se recalcula en cada fotograma, asi que sigue a la pose del personaje y no
 *     se queda con la medida que tenia al aparecer. Para una figura la medida la
 *     da `Character.bounds()`, que une la piel repartida por huesos y cuesta
 *     centesimas de milisegundo.
 *   - Puede alinearse con los ejes del propio objeto (la caja se pega a la forma
 *     aunque este girada) o con los del mundo, como en cualquier programa 3D.
 *
 * Lo que se muestra lo mandan los ajustes `scene.bounds.*`.
 */
import * as THREE from 'three';

/** Las 12 aristas de un cubo, por pares de esquinas (bits x/y/z del indice). */
const EDGES = [
  [0, 1], [1, 3], [3, 2], [2, 0],
  [4, 5], [5, 7], [7, 6], [6, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

const _box = new THREE.Box3();
const _v = new THREE.Vector3();
const _min = new THREE.Vector3();
const _max = new THREE.Vector3();

/**
 * Caja de 12 aristas cuyo tamano se reescribe sin recrear la geometria. El
 * material no hace prueba de profundidad: la caja tiene que verse aunque quede
 * dentro de la malla.
 */
class BoxLines {
  constructor(color, { opacity = 0.9, order = 997 } = {}) {
    this.positions = new Float32Array(EDGES.length * 2 * 3);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.material = new THREE.LineBasicMaterial({
      color, transparent: true, opacity, depthTest: false, depthWrite: false,
    });
    this.object = new THREE.LineSegments(this.geometry, this.material);
    this.object.name = 'CajaEnvolvente';
    this.object.renderOrder = order;
    this.object.frustumCulled = false;
    this.object.visible = false;
    this.object.matrixAutoUpdate = false;
  }

  /**
   * Coloca la caja. `matrix` es el sistema en el que estan sus coordenadas
   * (la matriz de mundo del objeto, o nada si la caja ya viene en coordenadas de
   * mundo).
   * @param {THREE.Box3} box
   * @param {THREE.Matrix4|null} [matrix]
   */
  set(box, matrix = null) {
    if (!box || box.isEmpty()) { this.object.visible = false; return false; }
    _min.copy(box.min);
    _max.copy(box.max);
    const p = this.positions;
    let i = 0;
    for (const [a, b] of EDGES) {
      for (const esquina of [a, b]) {
        p[i++] = (esquina & 1) ? _max.x : _min.x;
        p[i++] = (esquina & 2) ? _max.y : _min.y;
        p[i++] = (esquina & 4) ? _max.z : _min.z;
      }
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.computeBoundingSphere();
    if (matrix) this.object.matrix.copy(matrix);
    else this.object.matrix.identity();
    this.object.matrixWorld.copy(this.object.matrix);
    this.object.visible = true;
    return true;
  }

  hide() { this.object.visible = false; }

  dispose() {
    this.object.parent?.remove(this.object);
    this.geometry.dispose();
    this.material.dispose();
  }
}

/** Rectangulo de la huella en el suelo (y = 0), en coordenadas de mundo. */
class FloorLines {
  constructor(color) {
    this.positions = new Float32Array(6 * 2 * 3);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.material = new THREE.LineBasicMaterial({
      color, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false,
    });
    this.object = new THREE.LineSegments(this.geometry, this.material);
    this.object.name = 'HuellaEnvolvente';
    this.object.renderOrder = 996;
    this.object.frustumCulled = false;
    this.object.visible = false;
  }

  /** @param {THREE.Box3} world caja en coordenadas de mundo */
  set(world) {
    if (!world || world.isEmpty()) { this.object.visible = false; return; }
    const { min, max } = world;
    const y = 0.001;                       // justo encima del suelo, sin coserse
    const cx = (min.x + max.x) / 2;
    const cz = (min.z + max.z) / 2;
    const p = [
      min.x, y, min.z, max.x, y, min.z,
      max.x, y, min.z, max.x, y, max.z,
      max.x, y, max.z, min.x, y, max.z,
      min.x, y, max.z, min.x, y, min.z,
      // Cruz en el centro de la huella: el punto de apoyo de un vistazo.
      cx, y, min.z, cx, y, max.z,
      min.x, y, cz, max.x, y, cz,
    ];
    this.positions.set(p);
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.computeBoundingSphere();
    this.object.visible = true;
  }

  hide() { this.object.visible = false; }

  dispose() {
    this.object.parent?.remove(this.object);
    this.geometry.dispose();
    this.material.dispose();
  }
}

export class Bounds {
  /**
   * @param {object} deps
   * @param {import('../core/Viewport.js').Viewport} deps.viewport
   * @param {import('../core/Settings.js').Settings} deps.settings
   */
  constructor({ viewport, settings }) {
    this.viewport = viewport;
    this.settings = settings;
    this.hover = new BoxLines(0x4fc1ff, { opacity: 0.85 });
    this.selected = new BoxLines(0xffd479, { opacity: 0.95, order: 998 });
    this.floor = new FloorLines(0xffd479);
    /**
     * Cajas del modo «todos los elementos». Se crean segun se necesitan y se
     * reutilizan: la escena tiene un tope de elementos, asi que el grupo no
     * crece sin freno.
     * @type {BoxLines[]}
     */
    this.pool = [];
    viewport.add(this.hover.object, this.selected.object, this.floor.object);
  }

  /** ¿Se deja la caja puesta en todos los elementos de la escena? */
  get allOn() { return this.settings.get('scene.bounds.all') === true; }

  /** Caja reutilizable del modo «todos», por indice. */
  #pooled(i) {
    if (!this.pool[i]) {
      // Tono apagado: las cajas de fondo no deben competir con la seleccion.
      const caja = new BoxLines(0x8b98ab, { opacity: 0.5, order: 996 });
      this.pool[i] = caja;
      this.viewport.add(caja.object);
    }
    return this.pool[i];
  }

  /** ¿Se dibuja el contorno al pasar el raton? */
  get hoverOn() { return this.settings.get('scene.bounds.hover') !== false; }

  /** ¿Se deja la caja puesta sobre el elemento seleccionado? */
  get selectedOn() { return this.settings.get('scene.bounds.selected') === true; }

  /**
   * Vuelve a dibujar las dos cajas. Se llama en cada fotograma: es lo que hace
   * que la caja siga a la pose, al gizmo y a la camara.
   * @param {{hover?: object|null, selected?: object|null, all?: Iterable<object>}} items
   *   fichas de `SceneEditor.items`
   */
  update({ hover = null, selected = null, all = null } = {}) {
    let usadas = 0;
    if (all && this.allOn) {
      for (const item of all) {
        // Lo apuntado y lo elegido ya llevan su propia caja, con su color.
        if (item === hover || item === selected) continue;
        const m = this.measure(item);
        if (m && this.#pooled(usadas).set(m.box, m.matrix)) usadas++;
      }
    }
    for (let i = usadas; i < this.pool.length; i++) this.pool[i].hide();

    if (hover && this.hoverOn) {
      const m = this.measure(hover);
      this.hover.set(m?.box, m?.matrix);
    } else this.hover.hide();

    if (selected && this.selectedOn) {
      const m = this.measure(selected);
      if (this.selected.set(m?.box, m?.matrix) && this.settings.get('scene.bounds.floor') === true) {
        this.floor.set(this.worldBox(selected, _box));
      } else this.floor.hide();
    } else {
      this.selected.hide();
      this.floor.hide();
    }
  }

  /**
   * Volumen de un elemento en el espacio elegido.
   * @param {object} item ficha de `SceneEditor.items`
   * @returns {{box: THREE.Box3, matrix: THREE.Matrix4|null}|null}
   */
  measure(item) {
    if (!item?.object || item.object.visible === false) return null;
    const espacio = this.settings.get('scene.bounds.space') === 'mundo' ? 'mundo' : 'objeto';
    const live = this.settings.get('scene.bounds.live') !== false;

    // Una figura la mide su propio personaje: la piel deformada no se puede
    // medir con la caja de la geometria, que es la de la pose de enlace.
    if (item.character?.loaded && typeof item.character.bounds === 'function') {
      return item.character.bounds({ live, space: espacio });
    }

    const objeto = item.object.isLight ? (item.pick ?? item.object) : item.object;
    if (espacio === 'mundo') return { box: this.worldBox(item, _box), matrix: null };

    const geo = objeto.geometry;
    if (!geo) return { box: this.worldBox(item, _box), matrix: null };
    if (!geo.boundingBox) geo.computeBoundingBox();
    objeto.updateWorldMatrix(true, false);
    return { box: _box.copy(geo.boundingBox), matrix: objeto.matrixWorld };
  }

  /** Caja en coordenadas de mundo, alineada con los ejes del mundo. */
  worldBox(item, out) {
    if (item.character?.loaded && typeof item.character.bounds === 'function') {
      const m = item.character.bounds({
        live: this.settings.get('scene.bounds.live') !== false, space: 'mundo',
      });
      return out === m.box ? out : out.copy(m.box);
    }
    const objeto = item.object.isLight ? (item.pick ?? item.object) : item.object;
    out.setFromObject(objeto);
    return out;
  }

  /**
   * Medidas del elemento en metros, para escribirlas en el panel. Se dan en el
   * espacio del propio objeto: son las de la forma, no las de su sombra sobre
   * los ejes del mundo.
   * @returns {THREE.Vector3|null}
   */
  size(item) {
    const m = this.measure(item);
    if (!m?.box || m.box.isEmpty()) return null;
    const size = m.box.getSize(new THREE.Vector3());
    if (m.matrix) {
      // La matriz puede llevar escala: las medidas son las del objeto ya escalado.
      _v.setFromMatrixScale(m.matrix);
      size.multiply(_v);
    }
    return size;
  }

  dispose() {
    this.hover.dispose();
    this.selected.dispose();
    this.floor.dispose();
    for (const caja of this.pool) caja.dispose();
    this.pool = [];
  }
}
