/**
 * ATOM · Contorno (outline)
 * ---------------------------------------------------------------------------
 * Pase de post-proceso que dibuja un trazo sobre las figuras y los solidos sin
 * tocar sus materiales. Trabaja en dos tiempos:
 *
 *   1. Prepaso: se pintan SOLO los objetos marcados en un buffer aparte con
 *      `MeshNormalMaterial` (color = normal de vista) y su textura de
 *      profundidad. La seleccion se hace por capa (`OUTLINE_LAYER`): la camara
 *      solo ve esa capa, asi que el suelo, el fondo y los ayudantes no entran.
 *
 *   2. Composicion: un filtro a pantalla completa detecta los bordes de ese
 *      buffer y los pinta encima de la imagen ya revelada (`readBuffer`).
 *
 * Tres clases de borde, que se combinan segun el modo:
 *   - silueta  (mask):   donde el objeto se recorta contra el vacio o un hueco.
 *   - solape   (depth):  saltos de profundidad, p. ej. el brazo sobre el torso.
 *   - facetas  (normal): aristas donde la normal cambia de golpe (los planos).
 *
 *   mode 'objeto'     -> solo silueta: el contorno exterior de cada forma.
 *   mode 'individual' -> silueta + solape + facetas: se leen los planos.
 *
 * El pase va DESPUES del mapeo de tonos (tras `OutputPass`), sobre la imagen
 * final en rango bajo, para que el color del trazo salga tal cual se elige.
 */
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

/** Capa reservada para los objetos que llevan contorno. */
export const OUTLINE_LAYER = 11;

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`;

const FRAG = /* glsl */ `
  #include <packing>

  uniform sampler2D tDiffuse;   // imagen ya revelada
  uniform sampler2D tNormal;    // normal de vista en RGB, mascara en A
  uniform sampler2D tDepth;     // profundidad del prepaso
  uniform vec2  uResolution;
  uniform vec3  uColor;
  uniform float uThickness;     // grosor del trazo en pixeles
  uniform float uOpacity;
  uniform float uNormalWeight;  // aristas por giro de normal (0 en modo silueta)
  uniform float uDepthWeight;   // saltos de profundidad / solape (0 en silueta)
  uniform float uValleyWeight;  // pliegues concavos (0 en modo silueta)
  uniform float uThreshold;     // umbral bajo del suavizado: mas bajo = mas tenue
  uniform float uNear;
  uniform float uFar;
  uniform bool  uPerspective;

  varying vec2 vUv;

  // El trazo se compone tras el mapeo de tonos, sobre la imagen ya en sRGB, pero
  // el color llega en espacio lineal (Color de three): se pasa a sRGB para que
  // salga tal cual se elige en el panel.
  vec3 toSrgb( vec3 c ) {
    return mix( 1.055 * pow( max( c, vec3( 0.0 ) ), vec3( 1.0 / 2.4 ) ) - 0.055,
                c * 12.92, step( c, vec3( 0.0031308 ) ) );
  }

  // Profundidad lineal (en unidades de vista, negativa) para que el umbral se
  // porte igual cerca y lejos de la camara.
  float linearDepth( vec2 uv ) {
    float d = texture2D( tDepth, uv ).x;
    return uPerspective
      ? perspectiveDepthToViewZ( d, uNear, uFar )
      : orthographicDepthToViewZ( d, uNear, uFar );
  }

  void main() {
    vec4 base = texture2D( tDiffuse, vUv );
    vec2 texel = uThickness / uResolution;

    // Cruz de Roberts: cuatro vecinos alrededor del pixel.
    vec2 offN = vUv + vec2( 0.0,  texel.y );
    vec2 offS = vUv + vec2( 0.0, -texel.y );
    vec2 offE = vUv + vec2(  texel.x, 0.0 );
    vec2 offW = vUv + vec2( -texel.x, 0.0 );

    vec4 c = texture2D( tNormal, vUv );
    vec4 n = texture2D( tNormal, offN );
    vec4 s = texture2D( tNormal, offS );
    vec4 e = texture2D( tNormal, offE );
    vec4 w = texture2D( tNormal, offW );

    // Silueta: cambia la mascara (alpha) entre el objeto y lo que no lo es.
    float maskEdge = abs( c.a - n.a ) + abs( c.a - s.a )
                   + abs( c.a - e.a ) + abs( c.a - w.a );
    maskEdge = clamp( maskEdge, 0.0, 1.0 );

    // Profundidad de los cuatro vecinos, reutilizada por el solape y los valles.
    float dc = linearDepth( vUv );
    float dN = linearDepth( offN );
    float dS = linearDepth( offS );
    float dE = linearDepth( offE );
    float dW = linearDepth( offW );

    // Solape: salto de profundidad (un miembro que tapa a otro), relativo a la
    // distancia para no dispararse en toda superficie inclinada.
    float dd = abs( dc - dN ) + abs( dc - dS ) + abs( dc - dE ) + abs( dc - dW );
    float depthEdge = clamp( dd / max( 0.02, abs( dc ) * 0.08 ), 0.0, 1.0 );

    // Valles: laplaciana de la profundidad. Positiva en un pliegue concavo (el
    // centro queda mas lejos que su entorno), negativa en una cresta; nos
    // quedamos solo con lo concavo, que es lo que la normal apenas marca «hacia
    // dentro» (axilas, entre los dedos, la union brazo-torso...).
    float lap = ( dN + dS + dE + dW ) - 4.0 * dc;
    float valley = clamp( lap / max( 0.015, abs( dc ) * 0.05 ), 0.0, 1.0 );

    // Aristas: la normal (RGB) gira de golpe. Vale para cantos vivos y facetas,
    // y tambien para los pliegues cuando el giro es marcado.
    vec3 nc = c.rgb * 2.0 - 1.0;
    float nd = ( 1.0 - dot( nc, n.rgb * 2.0 - 1.0 ) )
             + ( 1.0 - dot( nc, s.rgb * 2.0 - 1.0 ) )
             + ( 1.0 - dot( nc, e.rgb * 2.0 - 1.0 ) )
             + ( 1.0 - dot( nc, w.rgb * 2.0 - 1.0 ) );
    float normalEdge = clamp( nd * 0.9, 0.0, 1.0 );

    // Todo lo interno solo cuenta dentro del objeto; la silueta manda siempre.
    // El umbral bajo del suavizado lo mueve «Sensibilidad»: mas bajo saca los
    // bordes tenues que si no no llegarian a dibujarse.
    float inside = c.a;
    float edge = maskEdge;
    edge = max( edge, uDepthWeight  * depthEdge  * inside );
    edge = max( edge, uNormalWeight * normalEdge * inside );
    edge = max( edge, uValleyWeight * valley     * inside );
    float lo = clamp( uThreshold, 0.02, 0.9 );
    edge = smoothstep( lo, min( lo + 0.5, 0.98 ), edge ) * uOpacity;

    gl_FragColor = vec4( mix( base.rgb, toSrgb( uColor ), edge ), base.a );
  }
`;

// Copia directa: cuando no hay ningun grupo con contorno hay que volcar la
// imagen de entrada en la salida para no perderla.
const COPY_FRAG = /* glsl */ `
  uniform sampler2D tDiffuse;
  varying vec2 vUv;
  void main() { gl_FragColor = texture2D( tDiffuse, vUv ); }
`;

export class OutlineFX extends Pass {
  /**
   * @param {THREE.Scene} scene
   * @param {() => THREE.Camera} getCamera  la camara activa puede cambiar
   *   (perspectiva/ortografica), asi que se pregunta en cada pasada.
   */
  constructor(scene, getCamera) {
    super();
    this.scene = scene;
    this.getCamera = getCamera;
    /**
     * Devuelve los grupos de contorno del fotograma; lo rellena quien monta el
     * pase (main.js). Cada grupo es un juego de mallas con sus propios valores,
     * de modo que cada figura puede llevar su color y sus pesos y se dibujan a la
     * vez: `[{ meshes: Mesh[], params: {color, thickness, ...} }]`.
     */
    this.collectGroups = () => [];

    this.normalMat = new THREE.MeshNormalMaterial();
    this.rtNormal = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
    });
    this.rtNormal.depthTexture = new THREE.DepthTexture(1, 1);

    // Dos buffers de ida y vuelta para encadenar un grupo tras otro sobre la
    // misma imagen (el color de cada figura se compone encima del anterior).
    const rtOpts = { type: THREE.HalfFloatType, depthBuffer: false };
    this.scratchA = new THREE.WebGLRenderTarget(1, 1, rtOpts);
    this.scratchB = new THREE.WebGLRenderTarget(1, 1, rtOpts);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tNormal: { value: this.rtNormal.texture },
        tDepth: { value: this.rtNormal.depthTexture },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uColor: { value: new THREE.Color('#12151a') },
        uThickness: { value: 1.4 },
        uOpacity: { value: 0.9 },
        uNormalWeight: { value: 1 },
        uDepthWeight: { value: 1 },
        uValleyWeight: { value: 0.7 },
        uThreshold: { value: 0.28 },
        uNear: { value: 0.1 },
        uFar: { value: 100 },
        uPerspective: { value: true },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.copyMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: VERT,
      fragmentShader: COPY_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.fsQuad = new FullScreenQuad(this.material);
  }

  /**
   * Ajustes en caliente. En modo 'objeto' solo queda la silueta; en 'individual'
   * cada fuente de borde (aristas, solape, valles) entra con el peso que le da
   * el panel, y `sensitivity` rebaja el umbral para sacar los bordes tenues.
   */
  configure({ color, thickness, opacity, mode, edges, depth, valleys, sensitivity } = {}) {
    const u = this.material.uniforms;
    const clamp = THREE.MathUtils.clamp;
    if (color !== undefined) u.uColor.value.set(color);
    if (thickness !== undefined) u.uThickness.value = Math.max(0.5, thickness);
    if (opacity !== undefined) u.uOpacity.value = clamp(opacity, 0, 1);

    // 'objeto' apaga todo lo interno; 'individual' usa los pesos del panel.
    const full = mode !== 'objeto';
    if (edges !== undefined) u.uNormalWeight.value = full ? Math.max(0, edges) : 0;
    if (depth !== undefined) u.uDepthWeight.value = full ? Math.max(0, depth) : 0;
    if (valleys !== undefined) u.uValleyWeight.value = full ? Math.max(0, valleys) : 0;

    // Sensibilidad -> umbral bajo del suavizado. De 0 a 100 % baja de 0.5 a
    // 0.06 (el tramo util normal); de 100 a 400 % sigue bajando hasta 0.008 para
    // sacar hasta los bordes mas tenues, a costa de algo de ruido.
    if (sensitivity !== undefined) {
      const s = Math.max(0, sensitivity);
      u.uThreshold.value = s <= 1
        ? THREE.MathUtils.lerp(0.5, 0.06, s)
        : THREE.MathUtils.lerp(0.06, 0.008, clamp((s - 1) / 3, 0, 1));
    }
  }

  setSize(width, height) {
    this.rtNormal.setSize(width, height);
    this.scratchA.setSize(width, height);
    this.scratchB.setSize(width, height);
    this.material.uniforms.uResolution.value.set(width, height);
  }

  /**
   * Prepaso de un grupo: pinta SOLO sus mallas en el buffer de normales +
   * profundidad. La capa se enciende y se apaga aqui mismo, asi que cada grupo
   * queda aislado de los demas del fotograma.
   */
  #renderNormals(renderer, camera, meshes) {
    const prevMask = camera.layers.mask;
    const prevOverride = this.scene.overrideMaterial;
    const prevColor = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    const prevAuto = renderer.autoClear;

    camera.layers.set(OUTLINE_LAYER);
    for (const m of meshes) m.layers.enable(OUTLINE_LAYER);
    this.scene.overrideMaterial = this.normalMat;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.rtNormal);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);
    renderer.render(this.scene, camera);

    this.scene.overrideMaterial = prevOverride;
    for (const m of meshes) m.layers.disable(OUTLINE_LAYER);
    camera.layers.mask = prevMask;
    renderer.setClearColor(prevColor, prevAlpha);
    renderer.autoClear = prevAuto;
  }

  render(renderer, writeBuffer, readBuffer /* , deltaTime, maskActive */) {
    const camera = this.getCamera();
    if (!camera) return;
    const groups = (this.collectGroups() ?? []).filter((g) => g?.meshes?.length);
    const out = this.renderToScreen ? null : writeBuffer;
    const prevTarget = renderer.getRenderTarget();

    // Sin ningun grupo (todo oculto): se copia la imagen tal cual a la salida.
    if (!groups.length) {
      this.copyMat.uniforms.tDiffuse.value = readBuffer.texture;
      this.fsQuad.material = this.copyMat;
      renderer.setRenderTarget(out);
      this.fsQuad.render(renderer);
      this.fsQuad.material = this.material;
      renderer.setRenderTarget(prevTarget);
      return;
    }

    const u = this.material.uniforms;
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;
    u.uPerspective.value = camera.isPerspectiveCamera === true;

    // Cada grupo compone su trazo encima del resultado del anterior; se va y se
    // vuelve entre los dos buffers de trabajo hasta el ultimo, que sale a pantalla.
    this.fsQuad.material = this.material;
    let srcTex = readBuffer.texture;
    for (let i = 0; i < groups.length; i++) {
      const last = i === groups.length - 1;
      const dst = last ? out : (i % 2 === 0 ? this.scratchA : this.scratchB);
      this.#renderNormals(renderer, camera, groups[i].meshes);
      this.configure(groups[i].params ?? {});
      u.tDiffuse.value = srcTex;
      renderer.setRenderTarget(dst);
      this.fsQuad.render(renderer);
      srcTex = dst ? dst.texture : srcTex;
    }

    renderer.setRenderTarget(prevTarget);
  }

  dispose() {
    this.rtNormal.dispose();
    this.rtNormal.depthTexture?.dispose();
    this.scratchA.dispose();
    this.scratchB.dispose();
    this.normalMat.dispose();
    this.material.dispose();
    this.copyMat.dispose();
    this.fsQuad.dispose();
  }
}
