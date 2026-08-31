/**
 * POSU · Conjunto de figuras
 * ---------------------------------------------------------------------------
 * Dueno de los `Character` vivos de la escena. Es el unico modulo que crea,
 * carga, clona y destruye figuras; el resto del programa le pregunta.
 *
 * El papeleo vive en el almacen, en `scene.figures`, con la misma forma que
 * `scene.objects` y `scene.lights` (asi persiste, se exporta y se restablece
 * sin codigo extra):
 *
 *   { id, name, model, visible, position, rotation (grados), height, anchor, pose }
 *
 * Y `figure.active` guarda el id de la figura que reciben la captura por
 * camara, las poses, el posado manual y las manos.
 *
 * Reparto de responsabilidades: el sitio y el giro van en `character.root` (los
 * escribe el gizmo de SceneEditor); la altura y el anclaje deforman el
 * contenido y los aplica el propio `Character` con `setPlacement`.
 */
import * as THREE from 'three';
import { Character } from './Character.js';
import { MODEL_LIBRARY, DEFAULT_MODEL_URL } from '../config.js';
import { nuevoId } from '../core/ids.js';

// Dos figuras del mismo modelo no deben descargar el archivo dos veces.
THREE.Cache.enabled = true;

const DEG = Math.PI / 180;

/** Tope de figuras: cada una son tres mallas con esqueleto y su sombra. */
export const MAX_FIGURAS = 8;

/** Separacion en metros al anadir o duplicar, para que no salgan encimadas. */
const PASO = 0.7;

const vec = (x = 0, y = 0, z = 0) => ({ x, y, z });
const redondea = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

/** URL del modelo de la biblioteca; el id vacio cae en el modelo por defecto. */
export const libraryUrl = (id) => MODEL_LIBRARY.find((entry) => entry.id === id)?.url ?? DEFAULT_MODEL_URL;

export class FigureSet {
  /**
   * @param {object} o
   * @param {import('../core/Settings.js').Settings} o.settings
   * @param {object} o.viewport            visor 3D (add/remove)
   * @param {(texto: string) => void} [o.onProgress]  aviso de carga en marcha
   * @param {(id: string, ch: Character) => void} [o.onLoaded]
   * @param {(id: string, err: Error) => void} [o.onError]
   * @param {() => void} [o.onChange]      la lista de figuras ha cambiado
   */
  constructor({ settings, viewport, onProgress, onLoaded, onError, onChange } = {}) {
    this.settings = settings;
    this.viewport = viewport;
    this.onProgress = onProgress ?? null;
    this.onLoaded = onLoaded ?? null;
    this.onError = onError ?? null;
    this.onChange = onChange ?? null;

    /** id -> Character */
    this.characters = new Map();
    /** id -> Character de origen, para el alta por duplicado */
    this.seeds = new Map();
    /** id -> promesa de carga en curso */
    this.pending = new Map();
    /** cola para que dos `sync()` no se pisen */
    this.queue = Promise.resolve();

    this.#bind();
  }

  #bind() {
    const s = this.settings;
    this.offs = [
      // Alta, baja y reordenacion: la lista entera se ha reemplazado.
      s.on('scene.figures', () => this.sync()),
      // Cambios dentro de una figura: sitio, giro, altura, anclaje, modelo...
      s.on('scene.figures.*', (_v, _prev, path) => this.#onPath(path)),
      s.on('figure.active', () => this.onChange?.()),
    ];
  }

  // ------------------------------------------------------------- consultas ---

  /** Definiciones tal como estan en el almacen. */
  get defs() { return this.settings.get('scene.figures') ?? []; }

  get count() { return this.defs.length; }

  get activeId() { return this.settings.get('figure.active') ?? ''; }

  /** Figura que recibe camara, poses, posado manual y manos. */
  get active() { return this.characters.get(this.activeId) ?? null; }

  get activeDef() { return this.locate(this.activeId)?.def ?? null; }

  /** `Character` vivo de una figura, si esta cargado. */
  get(id) { return this.characters.get(id) ?? null; }

  /** Todos los personajes cargados, en el orden de la lista. */
  all() { return this.defs.map((d) => this.characters.get(d.id)).filter(Boolean); }

  /** Como en SceneEditor: `{ branch, index, def }` o `null`. */
  locate(id) {
    const index = this.defs.findIndex((d) => d.id === id);
    return index < 0 ? null : { branch: 'figures', index, def: this.defs[index] };
  }

  /** Ruta base de una figura en el almacen: `scene.figures.2`. */
  pathOf(id) {
    const at = this.locate(id);
    return at ? `scene.figures.${at.index}` : '';
  }

  /** Entradas para las listas de la interfaz. */
  list() {
    const activo = this.activeId;
    return this.defs.map((def) => ({
      id: def.id,
      label: def.name || 'Figura',
      icon: 'user',
      kind: 'figura',
      meta: def.visible === false ? 'oculta' : (def.id === activo ? 'posando' : ''),
    }));
  }

  // ------------------------------------------------------ alta, baja, copia ---

  /**
   * Siembra la primera figura con los ajustes globales heredados
   * (`figure.model/height/turn/anchor`). Deja la escena lista para arrancar y
   * hace que una sesion antigua no note el cambio.
   */
  seed() {
    if (this.defs.length) {
      if (!this.locate(this.activeId)) this.settings.set('figure.active', this.defs[0].id);
      return this.defs[0].id;
    }
    const def = this.#nuevoDef({ position: vec(0, 0, 0) });
    this.settings.batch({ 'scene.figures': [def], 'figure.active': def.id });
    return def.id;
  }

  /**
   * Anade una figura. `from` es el id de la figura de origen: si se pasa, la
   * nueva nace como copia (mismo modelo y misma pose) sin volver a leer el
   * archivo. Devuelve el id, o `null` si se ha llegado al tope.
   */
  async add({ model, from = '' } = {}) {
    if (this.defs.length >= MAX_FIGURAS) return null;

    const origen = from ? this.locate(from) : null;
    const base = origen?.def ?? null;
    const def = this.#nuevoDef({ model, base });

    if (base) {
      const ch = this.get(from);
      // La copia se coloca junto a la original, en el primer hueco libre: si no
      // se buscara hueco, duplicar la primera figura la dejaria encima de la
      // segunda.
      def.position = vec(this.#huecoX((base.position?.x ?? 0) + PASO), base.position?.y ?? 0, base.position?.z ?? 0);
      // La copia nace posada como la original.
      if (ch?.loaded) {
        def.pose = ch.getPose();
        this.seeds.set(def.id, ch);
      }
    }

    this.settings.set('scene.figures', [...this.defs, def]);
    await this.sync();
    this.setActive(def.id);
    return def.id;
  }

  /** Copia de una figura, con su modelo, su colocacion y su pose. */
  duplicate(id) { return this.add({ from: id }); }

  /** Baja de una figura. Nunca deja la escena sin ninguna. */
  remove(id) {
    if (!this.locate(id) || this.defs.length <= 1) return false;
    const resto = this.defs.filter((d) => d.id !== id);
    const cambios = { 'scene.figures': resto };
    if (this.activeId === id) cambios['figure.active'] = resto[0].id;
    if (this.settings.get('scene.selected') === id) cambios['scene.selected'] = '';
    this.settings.batch(cambios);
    return true;
  }

  /** Elige la figura que recibe camara, poses, posado manual y manos. */
  setActive(id) {
    if (!this.locate(id) || this.activeId === id) return false;
    this.settings.set('figure.active', id);
    return true;
  }

  // --------------------------------------------------------- sincronizacion ---

  /**
   * Reconcilia las definiciones con los personajes vivos: da de alta las que
   * falten, destruye las que ya no estan y actualiza la colocacion del resto.
   * Se encola para que dos llamadas seguidas no carguen la misma figura dos
   * veces.
   */
  sync() {
    this.queue = this.queue
      .then(() => this.#syncOnce())
      .catch((err) => { console.error('[Figuras] sincronizacion', err); });
    return this.queue;
  }

  async #syncOnce() {
    const defs = this.defs;
    const vivos = new Set(defs.map((d) => d.id));

    for (const [id, ch] of [...this.characters]) {
      if (vivos.has(id)) continue;
      this.characters.delete(id);
      ch.dispose();
    }

    for (const [i, def] of defs.entries()) {
      if (this.pending.has(def.id)) {
        await this.pending.get(def.id).catch(() => {});
        continue;
      }
      if (this.characters.has(def.id)) { this.applyDef(def.id); continue; }
      this.onProgress?.(defs.length > 1 ? `Cargando figura ${i + 1} de ${defs.length}…` : 'Cargando figura…');
      try {
        await this.#create(def);
      } catch (err) {
        console.error('[Figuras] carga', def.id, err);
        this.onError?.(def.id, err);
      }
    }

    if (!this.locate(this.activeId) && defs.length) this.settings.set('figure.active', defs[0].id);
    this.onChange?.();
  }

  /** Crea el `Character` de una definicion y lo mete en el visor. */
  async #create(def) {
    const ch = new Character(this.settings);
    ch.root.name = def.name || 'Personaje';
    ch.root.userData.figureId = def.id;
    this.viewport?.add(ch.root);

    const origen = this.seeds.get(def.id) ?? null;
    this.seeds.delete(def.id);

    const tarea = (async () => {
      if (origen?.loaded) ch.cloneFrom(origen);
      else await ch.load(this.#sourceFor(def));
      this.characters.set(def.id, ch);
      this.applyDef(def.id);
      this.#restaurarPose(ch, def.pose);
      this.onLoaded?.(def.id, ch);
      return ch;
    })();

    this.pending.set(def.id, tarea);
    try {
      return await tarea;
    } catch (err) {
      this.characters.delete(def.id);
      ch.dispose();
      throw err;
    } finally {
      this.pending.delete(def.id);
    }
  }

  /**
   * Carga un modelo en una figura ya existente. `src` puede ser una URL o un
   * `File` soltado en la ventana; en ese caso la definicion se queda sin id de
   * biblioteca (al recargar la pagina volvera con el modelo por defecto).
   */
  async loadInto(id, src, { onProgress } = {}) {
    const ch = this.get(id);
    if (!ch) return null;
    const esArchivo = typeof File !== 'undefined' && src instanceof File;
    const entrada = esArchivo ? null : MODEL_LIBRARY.find((e) => e.url === src || e.id === src);
    const url = entrada ? entrada.url : src;

    // Todos los modelos comparten el esqueleto de Mixamo, asi que la pose de la
    // figura se puede volver a poner sobre el modelo nuevo.
    const pose = ch.loaded ? ch.getPose() : null;
    await ch.load(url, { onProgress });
    // Se escribe en silencio: el modelo ya esta puesto, no hay que recargarlo.
    const path = this.pathOf(id);
    if (path) this.settings.set(`${path}.model`, entrada?.id ?? '', { silent: true });
    this.applyDef(id);
    this.#restaurarPose(ch, pose);
    this.onLoaded?.(id, ch);
    this.onChange?.();
    return ch;
  }

  /** Vuelca al `root` y al `Character` lo que dice la definicion. */
  applyDef(id) {
    const at = this.locate(id);
    const ch = this.get(id);
    if (!at || !ch) return;
    const { def } = at;

    ch.root.name = def.name || 'Personaje';
    ch.root.visible = def.visible !== false;
    const p = def.position ?? vec();
    const r = def.rotation ?? vec();
    ch.root.position.set(p.x ?? 0, p.y ?? 0, p.z ?? 0);
    ch.root.rotation.set((r.x ?? 0) * DEG, (r.y ?? 0) * DEG, (r.z ?? 0) * DEG);
    // Recalcula la escala y el anclaje, y con ellos el volumen envolvente.
    ch.setPlacement({ height: def.height, anchor: def.anchor });
  }

  /**
   * Guarda la pose de cada figura en su definicion. Se llama antes de
   * persistir los ajustes para que al recargar la pagina vuelvan posadas.
   */
  snapshotPoses() {
    if (!this.characters.size) return;
    const defs = this.defs.map((def) => {
      const ch = this.characters.get(def.id);
      return ch?.loaded ? { ...def, pose: ch.getPose() } : def;
    });
    this.settings.set('scene.figures', defs, { silent: true });
  }

  dispose() {
    for (const off of this.offs ?? []) off?.();
    this.offs = [];
    for (const ch of this.characters.values()) ch.dispose();
    this.characters.clear();
    this.seeds.clear();
  }

  // ------------------------------------------------------------- interiores ---

  /**
   * Vuelve a poner una pose sobre un esqueleto recien cargado (o clonado). Se
   * usa al restaurar la sesion y al cambiar el modelo de una figura: la pose se
   * guarda por nombre de hueso, asi que sobrevive al cambio de archivo mientras
   * el rig sea el de Mixamo.
   */
  #restaurarPose(ch, pose) {
    if (!pose || !ch?.loaded) return;
    ch.setPose(pose, 1);
    ch.refreshBounds();
  }

  /** Reacciona a un cambio dentro de `scene.figures.N.…`. */
  #onPath(path) {
    const m = /^scene\.figures\.(\d+)\.(.+)$/.exec(path);
    if (!m) return;
    const def = this.defs[Number(m[1])];
    if (!def) return;
    const campo = m[2].split('.')[0];

    if (campo === 'model') {
      const ch = this.get(def.id);
      if (!ch || this.pending.has(def.id)) return;
      this.queue = this.queue.then(async () => {
        this.onProgress?.('Cargando figura…');
        const pose = ch.loaded ? ch.getPose() : null;
        try {
          await ch.load(this.#sourceFor(def));
          this.applyDef(def.id);
          this.#restaurarPose(ch, pose);
          this.onLoaded?.(def.id, ch);
        } catch (err) {
          console.error('[Figuras] modelo', def.id, err);
          this.onError?.(def.id, err);
        }
      });
      return;
    }

    if (campo === 'pose') return;      // solo papeleo: no toca al personaje
    this.applyDef(def.id);
    if (campo === 'name' || campo === 'visible') this.onChange?.();
  }

  /** URL del archivo de una definicion. */
  #sourceFor(def) { return libraryUrl(def?.model); }

  /** Definicion nueva: hereda de `base` si es una copia, o de los ajustes. */
  #nuevoDef({ model, base = null, position } = {}) {
    const s = this.settings;
    return {
      id: nuevoId(),
      name: this.#nombre(),
      model: model ?? base?.model ?? s.get('figure.model') ?? 'character',
      visible: true,
      position: position ?? this.#spawn(),
      rotation: vec(0, base ? (base.rotation?.y ?? 0) : (s.get('figure.turn') ?? 0), 0),
      height: base?.height ?? s.get('figure.height') ?? 1.75,
      anchor: base?.anchor ?? s.get('figure.anchor') ?? 'suelo',
      pose: null,
    };
  }

  /** "Figura 1", "Figura 2"… sin repetir los que ya hay. */
  #nombre(base = 'Figura') {
    const usados = new Set(this.defs.map((d) => d.name));
    for (let n = 1; n <= MAX_FIGURAS + 1; n++) {
      if (!usados.has(`${base} ${n}`)) return `${base} ${n}`;
    }
    return base;
  }

  /** Sitio libre a la derecha de las figuras que ya hay. */
  #spawn() {
    if (!this.defs.length) return vec(0, 0, 0);
    let x = -Infinity;
    for (const def of this.defs) x = Math.max(x, def.position?.x ?? 0);
    return vec(redondea(x + PASO), 0, 0);
  }

  /**
   * Primer hueco libre a partir de `x`, avanzando a la derecha. Solo se mira esa
   * coordenada: basta para que dos figuras no nazcan una dentro de otra.
   */
  #huecoX(x) {
    let cand = x;
    const ocupado = (v) => this.defs.some((d) => Math.abs((d.position?.x ?? 0) - v) < PASO * 0.5);
    for (let i = 0; i <= MAX_FIGURAS && ocupado(cand); i++) cand += PASO;
    return redondea(cand);
  }
}
