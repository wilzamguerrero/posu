/**
 * POSU · Iluminacion de estudio
 * ---------------------------------------------------------------------------
 * Esquema clasico de tres puntos mas ambiente e iluminacion de entorno:
 *
 *   key   luz principal, direccional y con sombras (X/Y/Z por deslizadores)
 *   fill  relleno frio y suave, sin sombras, para abrir los medios tonos
 *   rim   contraluz que separa la figura del fondo
 *
 * Las sombras usan VSM porque es el unico filtro de Three.js donde el radio de
 * difuminado es un parametro real: asi el deslizador de "suavidad" se traduce
 * en penumbras mas anchas, que es justo lo que se estudia en claroscuro. En
 * equipos modestos y en modo compatible se cambia por PCF (ver
 * core/capabilities.js): cuesta mucho menos, a cambio de que la suavidad deje
 * de notarse.
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { LIGHT_PRESETS } from '../config.js';

export class Lighting {
  constructor(scene, renderer, settings, profile = null) {
    this.scene = scene;
    this.renderer = renderer;
    this.settings = settings;
    // Techo de calidad del equipo: limita el tamano del mapa de sombra y el
    // numero de muestras del difuminado (ver core/capabilities.js).
    this.profile = profile ?? { shadowMap: 2048, blurSamples: 16 };

    this.ambient = new THREE.AmbientLight(0x8fa6c4, 0.35);

    this.key = new THREE.DirectionalLight(0xfff4e2, 3.4);
    this.key.castShadow = true;
    this.key.shadow.camera.near = 0.1;
    this.key.shadow.camera.far = 24;
    this.key.shadow.blurSamples = this.profile.blurSamples;
    this.keyTarget = new THREE.Object3D();
    this.keyTarget.position.set(0, 0.95, 0);
    this.key.target = this.keyTarget;

    this.fill = new THREE.DirectionalLight(0x9fc4ff, 0.85);
    this.rim = new THREE.DirectionalLight(0xcfe4ff, 2.1);
    this.fill.target = this.keyTarget;
    this.rim.target = this.keyTarget;

    scene.add(this.ambient, this.key, this.keyTarget, this.fill, this.rim);

    this.#buildEnvironment();
    this.#bind();
    this.applyAll();
  }

  /**
   * Entorno PMREM generado en memoria: aporta reflejos y luz indirecta
   * creibles sin descargar ningun HDRI (requisito de funcionamiento local).
   */
  #buildEnvironment() {
    // Si el equipo no puede compilar el PMREM (GPU antigua o renderizado por
    // software) se sigue sin entorno: la escena queda mas plana pero funciona.
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      pmrem.compileEquirectangularShader();
      this.envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      pmrem.dispose();
      this.scene.environment = this.envMap;
    } catch (err) {
      console.warn('[Luz] no se pudo generar el entorno PMREM:', err);
      this.envMap = null;
    }
  }

  #bind() {
    const s = this.settings;
    s.on('light.preset', (v) => this.setPreset(v));
    s.on(['light.ambient.intensity', 'light.ambient.color'], () => this.applyAmbient());
    s.on('light.env.intensity', () => this.applyEnv());
    s.on('light.key.*', () => this.applyKey());
    s.on('light.fill.*', () => this.applyFill());
    s.on('light.rim.*', () => this.applyRim());
    s.on('quality.shadowMap', () => this.applyShadowMap());
  }

  applyAll() {
    this.applyAmbient();
    this.applyEnv();
    this.applyShadowMap();
    this.applyKey();
    this.applyFill();
    this.applyRim();
  }

  applyAmbient() {
    this.ambient.intensity = this.settings.get('light.ambient.intensity');
    this.ambient.color.set(this.settings.get('light.ambient.color'));
  }

  applyEnv() {
    // three >= 0.163: la intensidad del entorno es una propiedad de la escena.
    this.scene.environmentIntensity = this.settings.get('light.env.intensity');
  }

  applyShadowMap() {
    const pedido = Number(this.settings.get('quality.shadowMap')) || 2048;
    // 4096 en un telefono son 64 MiB de textura de sombra: el perfil manda.
    const size = Math.min(pedido, this.profile.shadowMap);
    if (this.key.shadow.mapSize.width === size) return;
    this.key.shadow.mapSize.set(size, size);
    // Forzar la reconstruccion del render target de sombra.
    this.key.shadow.map?.dispose();
    this.key.shadow.map = null;
  }

  applyKey() {
    const k = this.settings.get('light.key');
    this.key.position.set(k.x, k.y, k.z);
    this.key.intensity = k.intensity;
    this.key.color.set(k.color);
    this.key.castShadow = !!k.shadows;
    this.key.shadow.radius = Math.max(0.5, k.softness);
    this.key.shadow.bias = k.bias;
    this.key.shadow.normalBias = 0.02;

    // El volumen de sombra se ajusta a la distancia de la luz para no perder
    // resolucion cuando el foco se aleja.
    const dist = this.key.position.length();
    const extent = Math.max(1.6, Math.min(4.5, dist * 0.55));
    const cam = this.key.shadow.camera;
    cam.left = -extent;
    cam.right = extent;
    cam.top = extent;
    cam.bottom = -extent;
    cam.far = Math.max(12, dist * 3);
    cam.updateProjectionMatrix();
  }

  applyFill() {
    const f = this.settings.get('light.fill');
    this.fill.visible = !!f.enabled;
    this.fill.intensity = f.intensity;
    this.fill.color.set(f.color);
    this.fill.position.set(f.x, f.y, f.z);
  }

  applyRim() {
    const r = this.settings.get('light.rim');
    this.rim.visible = !!r.enabled;
    this.rim.intensity = r.intensity;
    this.rim.color.set(r.color);
    this.rim.position.set(r.x, r.y, r.z);
  }

  /** Aplica un preajuste escribiendo en el estado para que la UI se actualice. */
  setPreset(name) {
    const p = LIGHT_PRESETS[name];
    if (!p) return;
    this.settings.batch(() => {
      for (const [branch, values] of Object.entries(p)) {
        for (const [prop, value] of Object.entries(values)) {
          this.settings.set(`light.${branch}.${prop}`, value);
        }
      }
    });
    this.applyAll();
  }

  /** Altura del objetivo de las luces, para que sigan al modelo cargado. */
  setTarget(point) {
    this.keyTarget.position.copy(point);
  }

  dispose() {
    this.envMap?.dispose();
    this.scene.environment = null;
    this.scene.remove(this.ambient, this.key, this.keyTarget, this.fill, this.rim);
  }
}
