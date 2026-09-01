/**
 * ATOM · Almacen de configuracion reactivo
 * ---------------------------------------------------------------------------
 * Un unico objeto de estado con acceso por ruta ("camera.focalLength"),
 * suscripciones y persistencia automatica en localStorage.
 *
 * Los modulos (camara, luces, figura…) se suscriben a las rutas que les
 * afectan y los paneles de UI leen y escriben por esa misma ruta, de forma que
 * la interfaz nunca guarda estado propio y "restablecer" siempre funciona.
 */

/** Lee una ruta con puntos dentro de un objeto anidado. */
export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Escribe una ruta con puntos creando los objetos intermedios. */
export function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  let node = obj;
  for (const k of keys) {
    if (typeof node[k] !== 'object' || node[k] === null) node[k] = {};
    node = node[k];
  }
  node[last] = value;
}

/** Clon profundo suficiente para estado plano (objetos, arrays y primitivas). */
const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

/** Mezcla `src` sobre `dst` conservando solo las claves conocidas por `dst`. */
function mergeKnown(dst, src) {
  if (!src || typeof src !== 'object') return dst;
  for (const key of Object.keys(dst)) {
    if (!(key in src)) continue;
    const a = dst[key];
    const b = src[key];
    if (a && typeof a === 'object' && !Array.isArray(a)) mergeKnown(a, b);
    else if (b !== undefined && b !== null && typeof b !== 'object') dst[key] = b;
    else if (Array.isArray(a) && Array.isArray(b)) dst[key] = b;
  }
  return dst;
}

export class Settings {
  /**
   * @param {object} defaults Estructura completa con los valores iniciales.
   * @param {string} storageKey Clave de localStorage; `null` desactiva persistencia.
   */
  constructor(defaults, storageKey = null) {
    this.defaults = clone(defaults);
    this.storageKey = storageKey;
    this.state = clone(defaults);
    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
    this.suspended = 0;
    this.dirty = new Set();
    this._saveTimer = 0;
    this.load();
  }

  get(path) {
    return getPath(this.state, path);
  }

  /**
   * Escribe un valor y notifica. `silent` evita disparar suscriptores (util al
   * sincronizar la UI con un cambio que ya se aplico en otro sitio).
   */
  set(path, value, { silent = false } = {}) {
    const prev = getPath(this.state, path);
    if (prev === value) return false;
    setPath(this.state, path, value);
    if (!silent) this.emit(path, value, prev);
    this.scheduleSave();
    return true;
  }

  /** Suscribe a una ruta exacta o a un prefijo terminado en `.*`. */
  on(path, fn) {
    if (Array.isArray(path)) {
      const offs = path.map((p) => this.on(p, fn));
      return () => offs.forEach((off) => off());
    }
    if (!this.listeners.has(path)) this.listeners.set(path, new Set());
    this.listeners.get(path).add(fn);
    return () => this.listeners.get(path)?.delete(fn);
  }

  /** Suscribe y ejecuta inmediatamente con el valor actual. */
  bind(path, fn) {
    fn(this.get(path), undefined, path);
    return this.on(path, fn);
  }

  emit(path, value = this.get(path), prev = undefined) {
    if (this.suspended > 0) {
      this.dirty.add(path);
      return;
    }
    this.listeners.get(path)?.forEach((fn) => fn(value, prev, path));
    // Notificaciones por prefijo: "light.*" recibe "light.key.intensity".
    const parts = path.split('.');
    for (let i = parts.length - 1; i > 0; i--) {
      const wildcard = parts.slice(0, i).join('.') + '.*';
      this.listeners.get(wildcard)?.forEach((fn) => fn(value, prev, path));
    }
    this.listeners.get('*')?.forEach((fn) => fn(value, prev, path));
  }

  /**
   * Aplica varios cambios y emite una sola tanda de notificaciones. Acepta una
   * funcion o un mapa {ruta: valor}, comodo para escribir una transformacion
   * completa (posicion, rotacion y escala) de una sola vez.
   */
  batch(fn) {
    this.suspended++;
    try {
      if (typeof fn === 'function') fn(this);
      else for (const [path, value] of Object.entries(fn ?? {})) this.set(path, value);
    } finally {
      this.suspended--;
      if (this.suspended === 0) {
        const paths = [...this.dirty];
        this.dirty.clear();
        paths.forEach((p) => this.emit(p));
      }
    }
  }

  /** Sustituye el estado completo (por ejemplo al cargar un preajuste). */
  replace(partial) {
    this.batch(() => {
      const flat = [];
      const walk = (obj, prefix) => {
        for (const [k, v] of Object.entries(obj)) {
          const p = prefix ? `${prefix}.${k}` : k;
          if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, p);
          else flat.push([p, v]);
        }
      };
      walk(partial, '');
      for (const [p, v] of flat) if (getPath(this.defaults, p) !== undefined || getPath(this.state, p) !== undefined) this.set(p, v);
    });
  }

  /** Restablece todo (o una rama) a los valores por defecto. */
  reset(prefix = null) {
    const source = prefix ? getPath(this.defaults, prefix) : this.defaults;
    if (source === undefined) return;
    this.replace(prefix ? { [prefix]: clone(source) } : clone(source));
  }

  load() {
    if (!this.storageKey) return;
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (raw) mergeKnown(this.state, JSON.parse(raw));
    } catch {
      /* Configuracion corrupta: seguimos con los valores por defecto. */
    }
  }

  scheduleSave() {
    if (!this.storageKey) return;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.save(), 400);
  }

  save() {
    if (!this.storageKey) return;
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.state));
    } catch {
      /* Cuota agotada o modo privado: la sesion sigue funcionando. */
    }
  }
}
