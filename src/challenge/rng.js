/**
 * ATOM · Azar con semilla para el reto del cubo
 * ---------------------------------------------------------------------------
 * El reto tiene que ser reproducible: la misma semilla debe dar exactamente la
 * misma tanda de problemas en cualquier maquina y en cualquier tamano de
 * ventana. Con `Math.random` eso es imposible, asi que se usa un generador
 * propio (mulberry32) sembrado por un hash del texto de la semilla.
 *
 * La reproducibilidad no es un adorno: es lo que permite comparar una nota con
 * la de ayer, o con la de otra persona, y saber que el problema era el mismo.
 */

/** Hash de 32 bits de una cadena (FNV-1a). Estable entre navegadores. */
export function hashSeed(text) {
  let h = 2166136261 >>> 0;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * Generador mulberry32: rapido, sin estado compartido y con periodo de sobra
 * para lo que aqui se pide (unos cientos de tiradas por tanda).
 * @param {number} seed
 * @returns {() => number} funcion que devuelve un flotante en [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fuente de azar con las comodidades que usa la generacion de problemas. */
export class Random {
  /** @param {string|number} seed */
  constructor(seed) {
    this.seed = String(seed);
    this.hash = typeof seed === 'number' ? seed >>> 0 : hashSeed(seed);
    this.next = mulberry32(this.hash);
  }

  /** Flotante en [a, b). */
  range(a, b) { return a + (b - a) * this.next(); }

  /** Entero en [a, b]. */
  int(a, b) { return Math.floor(this.range(a, b + 1)); }

  /** 1 o -1. */
  sign() { return this.next() < 0.5 ? -1 : 1; }

  /** Un elemento de la lista. */
  pick(list) { return list[Math.min(list.length - 1, Math.floor(this.next() * list.length))]; }
}

/** Semilla del reto diario: la misma para todo el mundo, en hora local. */
export function todaySeed(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `diario-${y}${m}${d}`;
}

/** Semilla aleatoria para una partida libre, corta y legible en voz alta. */
export function randomSeed() {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += abc[Math.floor(Math.random() * abc.length)];
  return out;
}
