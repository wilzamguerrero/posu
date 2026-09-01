/**
 * ATOM · Shader de lente
 * ---------------------------------------------------------------------------
 * Emula en una sola pasada los defectos opticos que un artista puede querer
 * reproducir al elegir un objetivo concreto:
 *
 *   - Distorsion radial de barril (+) o de corsete (-), con termino de 2 orden
 *     para curvar mas los bordes que el centro, como un gran angular real.
 *   - Aberracion cromatica lateral (los canales R y B se desplazan hacia fuera).
 *   - Vinetado.
 *   - Grano fino, util para que las capturas de referencia no se vean planas.
 *
 * El muestreo es inverso: para cada pixel de salida se calcula de donde hay que
 * leer en la imagen original, que es lo que evita huecos en la deformacion.
 */
export const LensShader = {
  name: 'LensShader',
  uniforms: {
    tDiffuse: { value: null },
    uK1: { value: 0 },
    uK2: { value: 0 },
    uChromatic: { value: 0 },
    uVignette: { value: 0.2 },
    uGrain: { value: 0.02 },
    uAspect: { value: 1 },
    uTime: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;

    uniform sampler2D tDiffuse;
    uniform float uK1;
    uniform float uK2;
    uniform float uChromatic;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uAspect;
    uniform float uTime;
    varying vec2 vUv;

    // Ruido de valor rapido, suficiente para grano fotografico.
    float hash( vec2 p ) {
      return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453123 );
    }

    // Aplica la deformacion radial a unas coordenadas centradas.
    vec2 distort( vec2 centered, float scale ) {
      vec2 aspectCorrected = vec2( centered.x * uAspect, centered.y );
      float r2 = dot( aspectCorrected, aspectCorrected );
      float f = 1.0 + ( uK1 * scale ) * r2 + ( uK2 * scale ) * r2 * r2;
      return centered * f;
    }

    void main() {
      vec2 centered = vUv - 0.5;

      // Un desplazamiento distinto por canal produce la franja de color que
      // aparece en los bordes de los objetivos luminosos.
      vec2 uvR = distort( centered, 1.0 + uChromatic * 0.06 ) + 0.5;
      vec2 uvG = distort( centered, 1.0 ) + 0.5;
      vec2 uvB = distort( centered, 1.0 - uChromatic * 0.06 ) + 0.5;

      // Fuera del encuadre original se devuelve negro en lugar de estirar el
      // ultimo pixel: asi la deformacion se lee como un recorte de lente.
      float inside = step( 0.0, uvG.x ) * step( uvG.x, 1.0 ) * step( 0.0, uvG.y ) * step( uvG.y, 1.0 );

      // La muestra central se reutiliza para el canal alfa, de modo que las
      // capturas con fondo transparente conserven la transparencia.
      vec4 center = texture2D( tDiffuse, clamp( uvG, 0.0, 1.0 ) );
      vec3 color = vec3(
        texture2D( tDiffuse, clamp( uvR, 0.0, 1.0 ) ).r,
        center.g,
        texture2D( tDiffuse, clamp( uvB, 0.0, 1.0 ) ).b
      ) * inside;

      // Vinetado: cos^4 suavizado, la caida natural de un objetivo.
      float r = length( vec2( centered.x * uAspect, centered.y ) ) * 1.41421356;
      float vig = 1.0 - uVignette * pow( clamp( r, 0.0, 1.0 ), 2.2 );
      color *= vig;

      if ( uGrain > 0.0001 ) {
        float n = hash( vUv * 1024.0 + fract( uTime ) * 91.0 ) - 0.5;
        color += n * uGrain;
      }

      gl_FragColor = vec4( color, center.a * inside );
    }
  `,
};
