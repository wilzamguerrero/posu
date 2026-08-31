/**
 * POSU · Perfil grafico del equipo
 * ---------------------------------------------------------------------------
 * El mismo ajuste no vale en todas partes. Lo que va sobrado en un equipo de
 * escritorio con GPU dedicada se arrastra en un telefono, y en algunos
 * controladores de Linux ni siquiera consigue enlazar los programas de sombra:
 * aparece una cascada de «VALIDATE_STATUS false» con el registro vacio y acto
 * seguido «CONTEXT_LOST_WEBGL», que es la firma de un contexto que ha muerto,
 * no de un shader mal escrito.
 *
 * Aqui se decide, una sola vez y antes de crear el renderizador, cual es el
 * techo razonable para este equipo. Los ajustes del usuario siguen mandando:
 * este modulo solo resuelve el modo «auto» y pone un maximo a lo que se le pide
 * a la GPU.
 *
 * El «modo compatible» es la red de seguridad: baja todo a la ruta mas trillada
 * de WebGL (sombras PCF, sin multimuestreo, sin sobremuestreo de pantalla) y la
 * aplicacion lo activa sola si el contexto se pierde durante el arranque.
 */

const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
const plataforma = typeof navigator !== 'undefined' ? navigator.platform || '' : '';

/** Puntero grueso y varios dedos: es un movil o una tableta, no un raton. */
const tactil = typeof navigator !== 'undefined'
  && (navigator.maxTouchPoints ?? 0) > 1
  && typeof matchMedia === 'function'
  && matchMedia('(pointer: coarse)').matches;

/** Rasgos del equipo que se conocen sin crear todavia el contexto WebGL. */
export const PLATFORM = {
  mobile: /Android|iPhone|iPad|iPod|Windows Phone/i.test(ua) || tactil,
  android: /Android/i.test(ua),
  linux: /Linux|X11/i.test(plataforma || ua) && !/Android/i.test(ua),
  /** Nucleos logicos; 4 como suposicion prudente si el navegador no lo dice. */
  cores: (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4,
  /** Memoria aproximada en GiB (solo la publican los navegadores Chromium). */
  memory: (typeof navigator !== 'undefined' && navigator.deviceMemory) || 4,
};

/**
 * Techos de calidad por nivel. `shadow` elige el filtro de sombra: «vsm» es el
 * unico donde el deslizador de suavidad cambia de verdad la penumbra, pero
 * cuesta dos pasadas de difuminado sobre una textura de coma flotante, asi que
 * en equipos modestos se cambia por «pcf», mucho mas barato y universal.
 */
const NIVELES = {
  alto:  { pixelRatio: 2,   shadowMap: 4096, samples: 4, shadow: 'vsm', blurSamples: 16 },
  medio: { pixelRatio: 2,   shadowMap: 2048, samples: 4, shadow: 'vsm', blurSamples: 12 },
  bajo:  { pixelRatio: 1.5, shadowMap: 1024, samples: 0, shadow: 'pcf', blurSamples: 8 },
  compat:{ pixelRatio: 1,   shadowMap: 1024, samples: 0, shadow: 'pcf', blurSamples: 4 },
};

/** Nivel deducido de los rasgos del equipo. */
function nivelAutomatico() {
  if (PLATFORM.mobile) return 'bajo';
  if (PLATFORM.cores <= 4 || PLATFORM.memory <= 4) return 'medio';
  return 'alto';
}

/**
 * Perfil efectivo con el que se configuran renderizador, sombras y compositor.
 * @param {boolean} compat Fuerza el modo compatible (lo pide el usuario o un
 *   contexto perdido en el arranque).
 */
export function graphicsProfile(compat = false) {
  const tier = compat ? 'compat' : nivelAutomatico();
  return {
    tier,
    compat: tier === 'compat',
    ...NIVELES[tier],
    /**
     * En Linux con GPU hibrida (y bajo algunos compositores Wayland) pedir
     * «high-performance» puede llevar al navegador a elegir una GPU distinta de
     * la que compone la pantalla, y el contexto se pierde en el primer dibujo.
     * En movil, ademas, solo sirve para gastar bateria.
     */
    powerPreference: (PLATFORM.linux || PLATFORM.mobile || tier === 'compat')
      ? 'default'
      : 'high-performance',
  };
}

/** Nombre real de la GPU, si el navegador lo expone (util en los avisos). */
export function describeRenderer(gl) {
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (ext) return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
    return String(gl.getParameter(gl.RENDERER));
  } catch {
    return '';
  }
}

/** ¿Se esta dibujando por software? Entonces conviene bajarlo todo. */
export function isSoftwareRenderer(name) {
  return /swiftshader|softwarerasterizer|llvmpipe|softpipe|basic render|microsoft basic/i.test(name || '');
}
