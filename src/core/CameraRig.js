/**
 * ATOM · Sistema de camaras
 * ---------------------------------------------------------------------------
 * Dos camaras que comparten posicion y objetivo:
 *
 *   - Perspectiva, parametrizada como una camara real: distancia focal en mm
 *     sobre un sensor de ancho configurable, descentrado de lente (tilt-shift)
 *     para trabajar la perspectiva de dos puntos, giro de horizonte y foco.
 *   - Ortografica, sin convergencia, para medir proporciones a escala.
 *
 * Al cambiar de proyeccion se conserva el encuadre: la altura visible de la
 * ortografica se calcula a partir del angulo y la distancia de la perspectiva,
 * de modo que la figura no salta de tamano.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { VIEW_PRESETS } from '../config.js';

const DEG = Math.PI / 180;

/** Vectores de trabajo: el bucle de camara no debe generar basura. */
const _offset = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _focus = new THREE.Vector3();

/** Cada cuantos milisegundos puede el autofoco escribir en los ajustes. */
const FOCUS_INTERVAL = 120;

export class CameraRig {
  /**
   * @param {Settings} settings
   * @param {HTMLElement} domElement Elemento sobre el que se capturan los gestos.
   */
  constructor(settings, domElement) {
    this.settings = settings;
    this.aspect = 1;

    this.perspective = new THREE.PerspectiveCamera(40, 1, 0.05, 200);
    this.perspective.filmGauge = settings.get('camera.filmGauge');
    this.perspective.position.set(1.6, 1.35, 3.4);

    this.orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1, -50, 200);
    this.orthographic.position.copy(this.perspective.position);

    this.active = this.perspective;

    this.controls = new OrbitControls(this.perspective, domElement);
    this.controls.target.set(0, 0.95, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.minDistance = 0.25;
    this.controls.maxDistance = 40;
    this.controls.maxPolarAngle = Math.PI * 0.99;
    this.controls.zoomToCursor = true;
    this.controls.panSpeed = 0.9;

    /** Proveedor de puntos de interes de la figura (lo inyecta la app). */
    this.focusProvider = null;
    /** Altura visible de la ortografica, en metros, antes del multiplicador. */
    this.orthoBaseHeight = 2.6;

    this.#bind();
    this.applyFocalLength();
    this.applyProjection();
  }

  /* -- Suscripciones al almacen ---------------------------------------- */

  #bind() {
    const s = this.settings;
    s.on('camera.projection', () => this.applyProjection());
    s.on('camera.focalLength', () => this.applyFocalLength());
    s.on('camera.filmGauge', (v) => {
      this.perspective.filmGauge = v;
      this.applyFocalLength();
    });
    s.on('camera.orthoZoom', () => this.applyOrtho());
    s.on(['camera.shiftH', 'camera.shiftV'], () => this.applyShift());
    s.on('camera.damping', (v) => {
      this.controls.enableDamping = v;
    });
  }

  /* -- Parametros opticos ---------------------------------------------- */

  /** Traduce mm de focal a angulo de vision usando el ancho de sensor real. */
  applyFocalLength() {
    const mm = this.settings.get('camera.focalLength');
    this.perspective.filmGauge = this.settings.get('camera.filmGauge');
    this.perspective.setFocalLength(mm);
    this.applyShift();
    this.applyOrtho();
  }

  /** Angulo vertical de vision resultante, en grados. */
  get fov() {
    return this.perspective.fov;
  }

  /**
   * Descentrado de lente. Desplaza el tronco de vision sin girar la camara:
   * es lo que permite dibujar un edificio o una figura en contrapicado
   * manteniendo las verticales paralelas.
   *
   * El desplazamiento se hace con `setViewOffset`, que tiene una trampa: deduce
   * el aspecto de la ventana que se le pasa (`fullWidth / fullHeight`) y lo
   * escribe encima del de la camara, y `clearViewOffset` no lo devuelve. Con la
   * base cuadrada de antes, tocar el descentrado dejaba la perspectiva en 1:1 y
   * la figura salia estirada; encima `setFocalLength` divide el sensor por el
   * aspecto, asi que la focal efectiva tampoco era la del panel. Por eso la base
   * va en la proporcion del lienzo y el aspecto se restablece al terminar.
   */
  applyShift() {
    const h = this.settings.get('camera.shiftH');
    const v = this.settings.get('camera.shiftV');
    // Base arbitraria: solo importan la proporcion y que los desplazamientos
    // vayan en la misma escala (una unidad = un encuadre entero).
    const H = 1000;
    const W = H * this.aspect;
    const desplazada = Math.abs(h) > 1e-4 || Math.abs(v) > 1e-4;
    for (const cam of [this.perspective, this.orthographic]) {
      if (desplazada) cam.setViewOffset(W, H, h * W, v * H, W, H);
      else cam.clearViewOffset();
    }
    // El aspecto de la perspectiva lo manda el lienzo (`setAspect`), nunca el
    // descentrado.
    this.perspective.aspect = this.aspect;
    this.perspective.updateProjectionMatrix();
    this.orthographic.updateProjectionMatrix();
  }

  /** Recalcula el tronco ortografico a partir del encuadre en perspectiva. */
  applyOrtho() {
    const dist = this.perspective.position.distanceTo(this.controls.target);
    this.orthoBaseHeight = 2 * dist * Math.tan(this.perspective.fov * 0.5 * DEG);
    const height = Math.max(0.08, this.orthoBaseHeight * this.settings.get('camera.orthoZoom'));
    const halfH = height / 2;
    const halfW = halfH * this.aspect;
    const o = this.orthographic;
    o.left = -halfW;
    o.right = halfW;
    o.top = halfH;
    o.bottom = -halfH;
    o.updateProjectionMatrix();
  }

  /** Cambia la camara activa manteniendo posicion, objetivo y encuadre. */
  applyProjection() {
    const next = this.settings.get('camera.projection') === 'ortografica' ? this.orthographic : this.perspective;
    if (next !== this.active) {
      // Transportar el transform en los dos sentidos evita que la figura salte
      // de sitio al alternar entre perspectiva y ortografica.
      next.position.copy(this.active.position);
      next.quaternion.copy(this.active.quaternion);
      this.active = next;
      this.controls.object = next;
    }
    this.applyOrtho();
    this.controls.update();
  }

  setAspect(aspect) {
    // Un lienzo de altura cero (pestana oculta, panel replegado) daria un
    // aspecto sin sentido y con el se irian al garete el descentrado y la
    // ortografica: se ignora y se conserva el ultimo bueno.
    this.aspect = Number.isFinite(aspect) && aspect > 0 ? aspect : this.aspect;
    this.perspective.aspect = this.aspect;
    this.applyFocalLength();
  }

  /* -- Bucle ------------------------------------------------------------ */

  /**
   * Se llama una vez por fotograma. Aplica el giro automatico (turntable), el
   * amortiguado de OrbitControls, el giro de horizonte y el autofoco.
   * @param {number} dt Segundos desde el fotograma anterior.
   */
  update(dt) {
    const spin = this.settings.get('camera.turntable');
    if (spin) {
      // Girar el acimut alrededor del objetivo equivale a poner la figura en
      // una plataforma giratoria, sin mover el punto de interes.
      _offset.copy(this.active.position).sub(this.controls.target);
      _offset.applyAxisAngle(_up, spin * DEG * dt);
      this.active.position.copy(this.controls.target).add(_offset);
    }

    this.controls.update();

    const roll = this.settings.get('camera.roll');
    if (roll) this.active.rotateZ(roll * DEG);

    this.refreshFocus();
  }

  /**
   * Distancia al punto de interes elegido, para la profundidad de campo.
   *
   * Escribe en los ajustes, asi que no puede hacerse en cada fotograma: cada
   * escritura notifica a los suscriptores, mueve el deslizador del panel y
   * reprograma el guardado en localStorage. Al orbitar eso se traducia en
   * sesenta reflows por segundo. Se limita en el tiempo y solo se calcula
   * cuando la profundidad de campo esta encendida, que es lo unico que consume
   * este valor.
   */
  refreshFocus() {
    if (!this.settings.get('camera.autoFocus') || !this.settings.get('camera.dof')) return;
    const now = performance.now();
    if (now - (this._focusStamp ?? 0) < FOCUS_INTERVAL) return;
    this._focusStamp = now;

    const point = this.focusProvider?.(this.settings.get('camera.focusTarget'), _focus);
    const distance = point
      ? this.active.position.distanceTo(point)
      : this.active.position.distanceTo(this.controls.target);
    if (Math.abs(distance - this.settings.get('camera.focusDistance')) > 0.005) {
      this.settings.set('camera.focusDistance', Math.round(distance * 1000) / 1000);
    }
  }

  /* -- Encuadre --------------------------------------------------------- */

  /**
   * Coloca la camara en una vista predefinida conservando la distancia actual.
   * @param {keyof typeof VIEW_PRESETS} name
   */
  setView(name) {
    const preset = VIEW_PRESETS[name];
    if (!preset) return;
    const [azimuth, elevation] = preset;
    const distance = this.active.position.distanceTo(this.controls.target);
    const phi = (90 - elevation) * DEG;
    const theta = azimuth * DEG;
    this.active.position.set(
      this.controls.target.x + distance * Math.sin(phi) * Math.sin(theta),
      this.controls.target.y + distance * Math.cos(phi),
      this.controls.target.z + distance * Math.sin(phi) * Math.cos(theta),
    );
    this.active.lookAt(this.controls.target);
    this.controls.update();
    this.applyOrtho();
  }

  /**
   * Ajusta la camara para que una caja quepa en el encuadre.
   * @param {THREE.Box3} box
   * @param {number} fill Fraccion de la altura del visor que ocupara la caja.
   */
  frameBox(box, fill = 0.82) {
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const halfFov = this.perspective.fov * 0.5 * DEG;
    const heightNeeded = Math.max(size.y, size.x / Math.max(this.aspect, 0.4)) / fill;
    const distance = heightNeeded * 0.5 / Math.tan(halfFov);
    const direction = this.active.position.clone().sub(this.controls.target);
    if (direction.lengthSq() < 1e-6) direction.set(0.6, 0.25, 1);
    direction.normalize().multiplyScalar(Math.max(distance, 0.35));
    this.controls.target.copy(center);
    this.active.position.copy(center).add(direction);
    this.active.lookAt(center);
    this.controls.update();
    this.settings.set('camera.orthoZoom', 1);
    this.applyOrtho();
  }

  /** Lleva el objetivo de orbita a un punto concreto (cabeza, manos…). */
  lookAtPoint(point, { keepDistance = true } = {}) {
    const distance = keepDistance ? this.active.position.distanceTo(this.controls.target) : null;
    const direction = this.active.position.clone().sub(this.controls.target).normalize();
    this.controls.target.copy(point);
    if (distance) this.active.position.copy(point).add(direction.multiplyScalar(distance));
    this.controls.update();
  }

  /** Estado serializable de la camara, para guardar y recuperar vistas. */
  snapshot() {
    return {
      position: this.active.position.toArray(),
      target: this.controls.target.toArray(),
      focalLength: this.settings.get('camera.focalLength'),
      projection: this.settings.get('camera.projection'),
      orthoZoom: this.settings.get('camera.orthoZoom'),
      roll: this.settings.get('camera.roll'),
      shiftH: this.settings.get('camera.shiftH'),
      shiftV: this.settings.get('camera.shiftV'),
    };
  }

  restore(snap) {
    if (!snap) return;
    this.settings.batch((s) => {
      s.set('camera.projection', snap.projection ?? 'perspectiva');
      s.set('camera.focalLength', snap.focalLength ?? 50);
      s.set('camera.orthoZoom', snap.orthoZoom ?? 1);
      s.set('camera.roll', snap.roll ?? 0);
      s.set('camera.shiftH', snap.shiftH ?? 0);
      s.set('camera.shiftV', snap.shiftV ?? 0);
    });
    this.active.position.fromArray(snap.position);
    this.controls.target.fromArray(snap.target);
    this.controls.update();
    this.applyOrtho();
  }

  dispose() {
    this.controls.dispose();
  }
}
