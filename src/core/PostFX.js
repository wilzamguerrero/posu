/**
 * POSU · Cadena de post-proceso
 * ---------------------------------------------------------------------------
 * La cadena se reconstruye solo cuando cambia la combinacion de efectos
 * activos, no en cada fotograma. Si no hay ningun efecto encendido se dibuja
 * directo a pantalla, sin buffers intermedios, para no pagar el coste.
 *
 * Orden:  escena -> oclusion ambiental -> desenfoque -> destello
 *         -> mapeo de tonos -> lente (distorsion, aberracion, vineta, grano)
 *
 * El desenfoque va antes del mapeo de tonos porque la mezcla de luces debe
 * hacerse en espacio lineal; la lente va despues porque el vinetado y el grano
 * son defectos de la imagen final.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js';
import { LensShader } from './shaders/LensShader.js';

export class PostFX {
  constructor(renderer, scene, cameraRig, settings) {
    this.renderer = renderer;
    this.scene = scene;
    this.rig = cameraRig;
    this.settings = settings;
    this.size = new THREE.Vector2(1, 1);
    this.composer = null;
    this.signature = '';
    this.passes = {};

    settings.on(
      ['camera.dof', 'camera.bloom', 'camera.distortion', 'camera.distortion2', 'camera.chromatic',
        'camera.vignette', 'camera.grain', 'camera.projection', 'quality.ssao', 'quality.antialias'],
      () => this.invalidate(),
    );
  }

  invalidate() {
    this.signature = '';
  }

  /** Cadena de efectos deseada segun los ajustes actuales. */
  #wanted() {
    const s = this.settings;
    const lens =
      Math.abs(s.get('camera.distortion')) > 0.001 ||
      Math.abs(s.get('camera.distortion2')) > 0.001 ||
      s.get('camera.chromatic') > 0.001 ||
      s.get('camera.vignette') > 0.001 ||
      s.get('camera.grain') > 0.001;
    return {
      // La profundidad de campo no tiene sentido en proyeccion ortografica:
      // esa camara no tiene plano focal fisico.
      dof: s.get('camera.dof') && s.get('camera.projection') === 'perspectiva',
      bloom: s.get('camera.bloom') > 0.001,
      ssao: s.get('quality.ssao'),
      lens,
    };
  }

  #build() {
    const want = this.#wanted();
    this.signature = JSON.stringify(want);
    this.composer?.dispose();
    this.passes = {};

    if (!want.dof && !want.bloom && !want.ssao && !want.lens) {
      this.composer = null;
      return;
    }

    const composer = new EffectComposer(
      this.renderer,
      new THREE.WebGLRenderTarget(Math.max(1, this.size.x), Math.max(1, this.size.y), {
        type: THREE.HalfFloatType, // Rango alto: las luces fuertes no se recortan antes del mapeo de tonos.
        samples: this.settings.get('quality.antialias') ? 4 : 0,
      }),
    );
    composer.addPass(new RenderPass(this.scene, this.rig.active));

    if (want.ssao) {
      const ssao = new SSAOPass(this.scene, this.rig.active, this.size.x, this.size.y);
      ssao.kernelRadius = 0.14;
      ssao.minDistance = 0.0008;
      ssao.maxDistance = 0.08;
      composer.addPass(ssao);
      this.passes.ssao = ssao;
    }
    if (want.dof) {
      const bokeh = new BokehPass(this.scene, this.rig.active, { focus: 3, aperture: 0.0002, maxblur: 0.01 });
      composer.addPass(bokeh);
      this.passes.bokeh = bokeh;
    }
    if (want.bloom) {
      const bloom = new UnrealBloomPass(this.size.clone(), 0.4, 0.7, 0.92);
      composer.addPass(bloom);
      this.passes.bloom = bloom;
    }

    composer.addPass(new OutputPass());

    if (want.lens) {
      const lens = new ShaderPass(LensShader);
      composer.addPass(lens);
      this.passes.lens = lens;
    }

    composer.setSize(this.size.x, this.size.y);
    this.composer = composer;
  }

  setSize(width, height) {
    this.size.set(width, height);
    this.composer?.setSize(width, height);
    this.passes.bloom?.setSize(width, height);
  }

  /** Traduce los ajustes fotograficos a los uniformes de cada pase. */
  #sync(dt) {
    const s = this.settings;
    const cam = this.rig.active;

    if (this.passes.ssao) this.passes.ssao.camera = cam;

    if (this.passes.bokeh) {
      const mat = this.passes.bokeh.materialBokeh;
      this.passes.bokeh.camera = cam;
      mat.uniforms.nearClip.value = cam.near;
      mat.uniforms.farClip.value = cam.far;

      // Circulo de confusion real: c = f^2 / (N * D^2). Se divide por el ancho
      // del sensor para expresarlo como fraccion del encuadre, que es la
      // unidad que espera el pase de desenfoque.
      const f = s.get('camera.focalLength') / 1000;
      const N = Math.max(0.7, s.get('camera.fStop'));
      const D = Math.max(0.1, s.get('camera.focusDistance'));
      const sensor = Math.max(1, s.get('camera.filmGauge')) / 1000;
      mat.uniforms.focus.value = D;
      mat.uniforms.aperture.value = (f * f) / (N * D * D * sensor);
      mat.uniforms.maxblur.value = s.get('camera.maxBlur');
    }

    if (this.passes.bloom) {
      this.passes.bloom.strength = s.get('camera.bloom');
      this.passes.bloom.threshold = 0.9;
      this.passes.bloom.radius = 0.7;
    }

    if (this.passes.lens) {
      const u = this.passes.lens.uniforms;
      u.uK1.value = s.get('camera.distortion');
      u.uK2.value = s.get('camera.distortion2');
      u.uChromatic.value = s.get('camera.chromatic');
      u.uVignette.value = s.get('camera.vignette');
      u.uGrain.value = s.get('camera.grain');
      u.uAspect.value = this.size.x / Math.max(1, this.size.y);
      u.uTime.value += dt;
    }
  }

  render(dt = 0.016) {
    const want = this.#wanted();
    const sig = JSON.stringify(want);
    if (sig !== this.signature) this.#build();
    this.#sync(dt);

    if (this.composer) {
      // El RenderPass es siempre el primero: se le reasigna la camara activa
      // para que el interruptor perspectiva/ortografica no exija reconstruir.
      const first = this.composer.passes[0];
      if (first?.isRenderPass || first instanceof RenderPass) first.camera = this.rig.active;
      this.composer.render(dt);
    } else {
      this.renderer.render(this.scene, this.rig.active);
    }
  }

  dispose() {
    this.composer?.dispose();
    this.composer = null;
    this.passes = {};
  }
}
