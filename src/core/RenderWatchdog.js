/**
 * POSU · Vigilante del bucle de dibujo
 * ---------------------------------------------------------------------------
 * Hay equipos (sobre todo Linux con Wayland y GPU hibrida) en los que el
 * navegador deja de pedir fotogramas sin dar ningun error: el visor se queda
 * congelado, la pagina no se repinta y la consola esta limpia. Este vigilante
 * lo detecta con un temporizador, que sigue corriendo aunque
 * `requestAnimationFrame` no vuelva a llamar.
 *
 * Para no confundir un paron de dibujo con un simple atasco del hilo principal
 * (compilar el modelo de deteccion bloquea medio segundo o mas, y durante ese
 * rato tampoco hay fotogramas) se mira si el propio temporizador llego puntual:
 * si tambien se retraso, el hilo estaba ocupado y no hay nada que avisar.
 */

const AHORA = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const VISIBLE = () => (typeof document === 'undefined' ? true : document.visibilityState !== 'hidden');

export class RenderWatchdog {
  /**
   * @param {object} [opciones]
   * @param {number} [opciones.every] cada cuanto se comprueba, en ms
   * @param {number} [opciones.stall] tiempo sin fotogramas que se considera paron
   * @param {(ms: number, veces: number) => void} [opciones.onStall] aviso
   * @param {() => number} [opciones.now] reloj (inyectable para las pruebas)
   * @param {() => boolean} [opciones.visible] si la pestana esta a la vista
   */
  constructor({ every = 800, stall = 2500, onStall = null, now = AHORA, visible = VISIBLE } = {}) {
    this.every = every;
    this.stall = stall;
    this.onStall = onStall;
    this.now = now;
    this.visible = visible;
    /** Marca del ultimo fotograma dibujado. */
    this.stamp = 0;
    /** Marca de la ultima comprobacion, para medir el retraso del temporizador. */
    this.checked = 0;
    /** Cuantos parones se han detectado en esta sesion. */
    this.stalls = 0;
    this.timer = null;
  }

  /** Arranca la vigilancia. Idempotente. */
  start() {
    this.stamp = this.now();
    this.checked = this.now();
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.check(), this.every);
  }

  stop() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Lo llama el visor en cada fotograma dibujado. */
  beat() {
    this.stamp = this.now();
  }

  /**
   * Una comprobacion. La llama el temporizador; es publica para poder probarla
   * con un reloj de mentira.
   * @returns {boolean} true si se ha dado por parado el dibujo
   */
  check() {
    const t = this.now();
    const retraso = t - this.checked - this.every;
    const parado = t - this.stamp;
    this.checked = t;
    // Pestana en segundo plano: el navegador deja de pedir fotogramas a
    // proposito. Hilo principal atascado: el temporizador llega igual de tarde.
    if (!this.visible() || retraso > this.every) {
      this.stamp = t;
      return false;
    }
    if (parado < this.stall) return false;
    this.stalls++;
    this.stamp = t;
    this.onStall?.(parado, this.stalls);
    return true;
  }
}
