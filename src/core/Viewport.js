/**
 * POSU · Visor 3D
 * ---------------------------------------------------------------------------
 * Dueno del renderizador, la escena y el bucle de dibujo. Reune el resto de
 * piezas graficas (camaras, luces, escenario, post-proceso) y expone dos
 * puntos de extension: `onFrame(cb)` para logica por fotograma y
 * `screenshot()` para exportar la lamina en alta resolucion.
 */
import * as THREE from 'three';
import { CameraRig } from './CameraRig.js';
import { Lighting } from './Lighting.js';
import { Stage } from './Stage.js';
import { PostFX } from './PostFX.js';
import { RenderWatchdog } from './RenderWatchdog.js';
import { graphicsProfile, describeRenderer, isSoftwareRenderer } from './capabilities.js';

const TONE_MAPPING = {
  agx: THREE.AgXToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  neutral: THREE.NeutralToneMapping,
  reinhard: THREE.ReinhardToneMapping,
  linear: THREE.LinearToneMapping,
};

/** Filtro de sombra segun el perfil del equipo. */
const SHADOW_TYPE = {
  vsm: THREE.VSMShadowMap,
  pcf: THREE.PCFSoftShadowMap,
};

/**
 * Refresco de seguridad del mapa de sombras, en milisegundos. Las sombras se
 * redibujan cuando algo cambia (ver `invalidateShadows`); este intervalo solo
 * cubre el caso de que algun cambio se nos escape, a un coste despreciable.
 */
const SHADOW_HEARTBEAT = 1000;

export class Viewport {
  constructor(canvas, settings) {
    this.canvas = canvas;
    this.settings = settings;
    this.callbacks = new Set();
    this.clock = new THREE.Clock();
    this.frameAccum = 0;
    this.stats = { fps: 0, ms: 0, triangles: 0, calls: 0 };
    this.running = false;

    /** Techo de calidad de este equipo; el modo compatible lo baja al minimo. */
    this.profile = graphicsProfile(settings.get('quality.compat') === true);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: settings.get('quality.antialias') && !this.profile.compat,
      alpha: true,
      powerPreference: this.profile.powerPreference,
      preserveDrawingBuffer: false, // Las capturas se hacen leyendo justo tras dibujar.
      stencil: false,
    });

    // Si el equipo dibuja por software, ningun ajuste alto tiene sentido.
    this.gpuName = describeRenderer(this.renderer.getContext());
    if (isSoftwareRenderer(this.gpuName)) this.profile = graphicsProfile(true);
    // Queda en la consola para poder identificar el equipo cuando algo falla.
    console.info('[Visor] GPU:', this.gpuName || 'desconocida',
      '· perfil:', this.profile.tier, '· powerPreference:', this.profile.powerPreference);

    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = SHADOW_TYPE[this.profile.shadow] ?? THREE.PCFSoftShadowMap;
    // Las sombras no se recalculan en cada fotograma: solo cuando algo cambia.
    // Orbitar la camara no mueve ni la luz ni la figura, asi que el mapa de
    // sombra anterior sigue siendo valido y se ahorra la pasada de profundidad
    // mas los dos difuminados del filtro VSM.
    this.renderer.shadowMap.autoUpdate = false;
    this.shadowDirty = true;
    this.shadowStamp = 0;
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();
    this.cameras = new CameraRig(settings, canvas);
    this.lighting = new Lighting(this.scene, this.renderer, settings, this.profile);
    this.stage = new Stage(this.scene, settings);
    this.postfx = new PostFX(this.renderer, this.scene, this.cameras, settings, this.profile);

    this.#bind();
    this.applyTone();
    this.applyPixelRatio();
    this.resize();

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas.parentElement ?? canvas);

    // Vigilante del bucle: avisa (y reengancha) si el navegador deja de pedir
    // fotogramas sin decir nada.
    this.watchdog = new RenderWatchdog({ onStall: (ms, veces) => this.#onStall(ms, veces) });
    this.#watchContext();
    this.#watchVisibility();
  }

  /**
   * Al volver a la pestana el navegador reanuda `requestAnimationFrame`, pero el
   * mapa de sombras y el vigilante arrastran el tiempo que ha pasado: se pone el
   * contador a cero para no dar por parado un bucle que acaba de despertar.
   */
  #watchVisibility() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') return;
      this.watchdog.beat();
      this.invalidateShadows();
      this.resize();
    });
  }

  /**
   * El bucle de dibujo se ha parado solo. Se vuelve a pedir el bucle (basta en
   * la mayoria de los casos: el navegador tenia la peticion de fotograma
   * colgada) y se avisa a la aplicacion, que ademas empuja a repintar la pagina.
   */
  #onStall(ms, veces) {
    console.warn(`[Visor] el navegador ha dejado de dibujar durante ${Math.round(ms)} ms`
      + ` (${veces}º aviso) · GPU: ${this.gpuName || 'desconocida'}`);
    if (this.contextLost || !this.running) return;
    this.renderer.setAnimationLoop(null);
    this.renderer.setAnimationLoop(() => this.#tick());
    this.invalidateShadows();
    this.postfx.invalidate();
    this.resize();
    this.onRenderStall?.(ms, veces);
  }

  /**
   * Vigilancia del contexto WebGL. Cuando el controlador se cae, el navegador
   * avisa con `webglcontextlost`; sin `preventDefault` no vuelve a restaurarlo
   * nunca. Se para el bucle y se delega en la aplicacion, que decide si puede
   * recuperarse (normalmente reintentando en modo compatible).
   */
  #watchContext() {
    this.canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.contextLost = true;
      this.stop();
      console.warn('[Visor] contexto WebGL perdido · GPU:', this.gpuName || 'desconocida');
      this.onContextLost?.(this.gpuName);
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this.invalidateShadows();
      this.postfx.invalidate();
      this.onContextRestored?.();
    });
  }

  /**
   * Marca el mapa de sombras como caducado: se redibujara en el siguiente
   * fotograma. Lo llaman los cambios de ajustes, la captura de pose y el posado
   * manual; orbitar la camara, en cambio, no lo necesita.
   */
  invalidateShadows() {
    this.shadowDirty = true;
  }

  #bind() {
    const s = this.settings;
    s.on(['camera.toneMapping', 'camera.exposure'], () => this.applyTone());
    s.on('quality.pixelRatio', () => {
      this.applyPixelRatio();
      this.resize();
    });
    // Cualquier ajuste puede mover una luz, la figura o el escenario: es mas
    // barato repintar la sombra que llevar la cuenta de cada ruta que influye.
    // La excepcion es el autofoco, que reescribe la distancia de enfoque varias
    // veces por segundo mientras se orbita sin tocar nada que arroje sombra.
    s.on('*', (_v, _p, path) => {
      if (path === 'camera.focusDistance') return;
      this.invalidateShadows();
    });
  }

  applyTone() {
    this.renderer.toneMapping = TONE_MAPPING[this.settings.get('camera.toneMapping')] ?? THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = this.settings.get('camera.exposure');
  }

  applyPixelRatio() {
    const raw = this.settings.get('quality.pixelRatio');
    const techo = this.profile.pixelRatio;
    // En «auto» se respeta el techo del perfil: un telefono con dpr 3 pintaria
    // nueve veces los pixeles necesarios y se queda en la mitad de fotogramas.
    // Si el usuario elige un valor a mano se le hace caso, salvo en modo
    // compatible, donde el objetivo es que funcione, no que luzca.
    if (raw === 'auto') this.basePixelRatio = Math.min(window.devicePixelRatio || 1, techo);
    else this.basePixelRatio = this.profile.compat ? Math.min(Number(raw) || 1, techo) : Number(raw) || 1;
    this.renderer.setPixelRatio(this.basePixelRatio);
  }

  get size() {
    const host = this.canvas.parentElement ?? this.canvas;
    return {
      width: Math.max(1, host.clientWidth || window.innerWidth),
      height: Math.max(1, host.clientHeight || window.innerHeight),
    };
  }

  resize() {
    const { width, height } = this.size;
    // updateStyle = false: el tamano visual lo decide la maqueta CSS.
    this.renderer.setSize(width, height, false);
    this.cameras.setAspect(width / height);
    const pr = this.renderer.getPixelRatio();
    this.postfx.setSize(Math.round(width * pr), Math.round(height * pr));
  }

  add(...objects) {
    this.scene.add(...objects);
  }

  remove(...objects) {
    this.scene.remove(...objects);
  }

  /** Registra una funcion que se ejecuta antes de dibujar cada fotograma. */
  onFrame(cb) {
    this.callbacks.add(cb);
    return () => this.callbacks.delete(cb);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.watchdog.start();
    this.renderer.setAnimationLoop(() => this.#tick());
  }

  stop() {
    this.running = false;
    this.watchdog.stop();
    this.renderer.setAnimationLoop(null);
  }

  #tick() {
    this.watchdog.beat();
    const dt = Math.min(0.1, this.clock.getDelta());

    // Limitador opcional de fotogramas: libera GPU para la inferencia de pose.
    const cap = Number(this.settings.get('quality.fpsCap')) || 0;
    if (cap > 0) {
      this.frameAccum += dt;
      if (this.frameAccum < 1 / cap) return;
      this.frameAccum = 0;
    }

    const t0 = performance.now();
    for (const cb of this.callbacks) cb(dt);

    // El propio equipo de camara aplica el giro automatico y el autofoco.
    this.cameras.update(dt);

    this.#updateShadows(t0);
    this.postfx.render(dt);

    const info = this.renderer.info.render;
    this.stats.ms = performance.now() - t0;
    this.stats.fps = this.stats.fps * 0.9 + (1 / Math.max(dt, 1e-4)) * 0.1;
    this.stats.triangles = info.triangles;
    this.stats.calls = info.calls;
  }

  /** Redibuja el mapa de sombras solo si hace falta (ver `invalidateShadows`). */
  #updateShadows(now) {
    if (!this.shadowDirty && now - this.shadowStamp < SHADOW_HEARTBEAT) {
      this.renderer.shadowMap.needsUpdate = false;
      return;
    }
    this.renderer.shadowMap.needsUpdate = true;
    this.shadowDirty = false;
    this.shadowStamp = now;
  }

  /**
   * Exporta la vista actual como PNG. `scale` multiplica la resolucion real
   * (2 o 4 para imprimir la lamina) y `transparent` oculta el escenario para
   * quedarse solo con la figura.
   */
  async screenshot({ scale = 2, transparent = false } = {}) {
    const { width, height } = this.size;
    const prevRatio = this.renderer.getPixelRatio();
    const prevStage = this.stage.root.visible;
    const ratio = Math.min(8, prevRatio * scale);

    if (transparent) this.stage.setVisible(false);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(width, height, false);
    this.postfx.setSize(Math.round(width * ratio), Math.round(height * ratio));

    // La lamina se exporta con la sombra recien calculada, no con la del ultimo
    // fotograma: a esta resolucion la diferencia se ve.
    this.renderer.shadowMap.needsUpdate = true;
    this.postfx.render(0);
    const blob = await new Promise((resolve) => this.canvas.toBlob(resolve, 'image/png'));

    if (transparent) this.stage.setVisible(prevStage);
    this.renderer.setPixelRatio(prevRatio);
    this.invalidateShadows();
    this.resize();
    return blob;
  }

  /** Encaja la camara sobre un volumen (se usa al cargar un modelo nuevo). */
  frame(box) {
    this.cameras.frameBox(box);
  }

  dispose() {
    this.stop();
    this.observer?.disconnect();
    this.postfx.dispose();
    this.stage.dispose();
    this.lighting.dispose();
    this.cameras.dispose();
    this.renderer.dispose();
  }
}
