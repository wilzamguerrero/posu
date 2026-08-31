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

const TONE_MAPPING = {
  agx: THREE.AgXToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  neutral: THREE.NeutralToneMapping,
  reinhard: THREE.ReinhardToneMapping,
  linear: THREE.LinearToneMapping,
};

export class Viewport {
  constructor(canvas, settings) {
    this.canvas = canvas;
    this.settings = settings;
    this.callbacks = new Set();
    this.clock = new THREE.Clock();
    this.frameAccum = 0;
    this.stats = { fps: 0, ms: 0, triangles: 0, calls: 0 };
    this.running = false;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: settings.get('quality.antialias'),
      alpha: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false, // Las capturas se hacen leyendo justo tras dibujar.
      stencil: false,
    });
    this.renderer.shadowMap.enabled = true;
    // VSM: unico filtro donde `shadow.radius` cambia de verdad la penumbra.
    this.renderer.shadowMap.type = THREE.VSMShadowMap;
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();
    this.cameras = new CameraRig(settings, canvas);
    this.lighting = new Lighting(this.scene, this.renderer, settings);
    this.stage = new Stage(this.scene, settings);
    this.postfx = new PostFX(this.renderer, this.scene, this.cameras, settings);

    this.#bind();
    this.applyTone();
    this.applyPixelRatio();
    this.resize();

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas.parentElement ?? canvas);
  }

  #bind() {
    const s = this.settings;
    s.on(['camera.toneMapping', 'camera.exposure'], () => this.applyTone());
    s.on('quality.pixelRatio', () => {
      this.applyPixelRatio();
      this.resize();
    });
  }

  applyTone() {
    this.renderer.toneMapping = TONE_MAPPING[this.settings.get('camera.toneMapping')] ?? THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = this.settings.get('camera.exposure');
  }

  applyPixelRatio() {
    const raw = this.settings.get('quality.pixelRatio');
    const auto = Math.min(window.devicePixelRatio || 1, 2);
    this.basePixelRatio = raw === 'auto' ? auto : Number(raw) || 1;
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
    this.renderer.setAnimationLoop(() => this.#tick());
  }

  stop() {
    this.running = false;
    this.renderer.setAnimationLoop(null);
  }

  #tick() {
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

    this.postfx.render(dt);

    const info = this.renderer.info.render;
    this.stats.ms = performance.now() - t0;
    this.stats.fps = this.stats.fps * 0.9 + (1 / Math.max(dt, 1e-4)) * 0.1;
    this.stats.triangles = info.triangles;
    this.stats.calls = info.calls;
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

    this.postfx.render(0);
    const blob = await new Promise((resolve) => this.canvas.toBlob(resolve, 'image/png'));

    if (transparent) this.stage.setVisible(prevStage);
    this.renderer.setPixelRatio(prevRatio);
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
