/**
 * ATOM · Atom reactivo minimo para configuracion del asistente IA
 */
export function atom(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    get() { return value; },
    set(next) {
      value = next;
      for (const fn of [...listeners]) fn(value);
    },
    update(fn) {
      this.set(fn(value));
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
