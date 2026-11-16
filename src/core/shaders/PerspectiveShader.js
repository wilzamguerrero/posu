/**
 * ATOM · Shaders de proyeccion de perspectiva
 * ---------------------------------------------------------------------------
 * Traduce las proyecciones de la reticula de guias a una deformacion real del
 * render 3D:
 *
 *   - CurvilinearPerspectiveShader: toma un mapa cubico de 360 grados (via
 *     CubeCamera) y lo reproyecta por rayo inverso en tiempo real a:
 *       · 4 puntos (cilindrica / panoramica con compresion vertical)
 *       · 5 puntos (ojo de pez hemisferico, de equisolida a estereografica)
 *       · 6 puntos (esfera completa de 360 grados, frente + lados + espalda)
 *   - LinearPerspectiveWarpShader: aplica curvatura optica de barril o corsete
 *     sobre las vistas rectilineas (1, 2 y 3 puntos), compensando el encuadre
 *     con el factor de relleno (`uPad`) para no recortar las esquinas.
 */
import * as THREE from 'three';

const FULLSCREEN_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`;

export const CurvilinearPerspectiveShader = {
  name: 'CurvilinearPerspectiveShader',
  uniforms: {
    tDiffuse: { value: null },
    uCube: { value: null },
    uCamBasis: { value: new THREE.Matrix3() },
    uMode: { value: 6 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uFu: { value: 400 },
    uUMax: { value: Math.PI },
    uVScale: { value: 1 },
    uFr: { value: 300 },
    uK: { value: 0 },
    uThetaMax: { value: Math.PI },
    uRMax: { value: 400 },
  },
  vertexShader: FULLSCREEN_VERT,
  fragmentShader: /* glsl */ `
    precision highp float;

    uniform samplerCube uCube;
    uniform mat3 uCamBasis;
    uniform int uMode;
    uniform vec2 uResolution;
    uniform float uFu;
    uniform float uUMax;
    uniform float uVScale;
    uniform float uFr;
    uniform float uK;
    uniform float uThetaMax;
    uniform float uRMax;

    varying vec2 vUv;

    const float HALF_PI = 1.57079632679;
    const float PI = 3.14159265359;

    void main() {
      vec2 delta = ( vUv - 0.5 ) * uResolution;
      vec3 camDir = vec3( 0.0, 0.0, -1.0 );
      float inside = 1.0;

      if ( uMode == 4 ) {
        float u = delta.x / max( 1.0, uFu );
        float v = delta.y / max( 1.0, uFu );
        float phi = abs( uVScale - 1.0 ) < 1e-4
          ? atan( v )
          : atan( v * uVScale ) / uVScale;
        float edgeU = 1.0 - smoothstep( uUMax - 0.008, uUMax + 0.002, abs( u ) );
        float edgePhi = 1.0 - smoothstep( HALF_PI - 0.008, HALF_PI - 0.001, abs( phi ) );
        inside = edgeU * edgePhi;
        float cphi = cos( phi );
        camDir = vec3( sin( u ) * cphi, sin( phi ), -cos( u ) * cphi );
      } else {
        float r = length( delta );
        inside = 1.0 - smoothstep( uRMax - 1.5, uRMax + 0.5, r );
        float u = r / max( 1.0, uFr );
        float theta = u;
        if ( uK > 1e-4 ) {
          theta = ( 2.0 / uK ) * atan( uK * u * 0.5 );
        } else if ( uK < -1e-4 ) {
          float ak = -uK;
          theta = ( 2.0 / ak ) * asin( clamp( ak * u * 0.5, -1.0, 1.0 ) );
        }
        theta = clamp( theta, 0.0, PI );
        float st = sin( theta );
        float ct = cos( theta );
        vec2 dir2 = r > 1e-5 ? delta / r : vec2( 0.0, 0.0 );
        camDir = vec3( dir2.x * st, dir2.y * st, -ct );
      }

      vec3 worldDir = normalize( uCamBasis * camDir );
      vec4 col = textureCube( uCube, worldDir );
      gl_FragColor = vec4( col.rgb * inside, col.a * inside );
    }
  `,
};

export const LinearPerspectiveWarpShader = {
  name: 'LinearPerspectiveWarpShader',
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uDiag: { value: 1 },
    uBendK: { value: 0 },
    uPad: { value: 1 },
  },
  vertexShader: FULLSCREEN_VERT,
  fragmentShader: /* glsl */ `
    precision highp float;

    uniform sampler2D tDiffuse;
    uniform vec2 uResolution;
    uniform float uDiag;
    uniform float uBendK;
    uniform float uPad;

    varying vec2 vUv;

    void main() {
      vec2 centered = vUv - 0.5;
      vec2 delta = centered * uResolution;
      float r2 = dot( delta, delta ) / max( 1.0, uDiag * uDiag );
      float f = 1.0 + uBendK * r2;
      vec2 srcUv = 0.5 + ( centered * f ) / max( 0.05, uPad );
      float inside = step( 0.0, srcUv.x ) * step( srcUv.x, 1.0 )
                   * step( 0.0, srcUv.y ) * step( srcUv.y, 1.0 );
      vec4 col = texture2D( tDiffuse, clamp( srcUv, 0.0, 1.0 ) );
      gl_FragColor = vec4( col.rgb * inside, col.a * inside );
    }
  `,
};
