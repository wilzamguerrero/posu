/**
 * Prueba del perfil grafico.
 * `capabilities.js` lee el navegador una sola vez, al importarse, asi que cada
 * escenario simula su equipo y vuelve a importar el modulo con una consulta
 * distinta en la URL para saltarse la cache de modulos.
 */
const fails = [];
const oks = [];
const check = (name, cond, extra) => {
  (cond ? oks : fails).push(name);
  console.log((cond ? 'OK   ' : 'FALLA') + ' ' + name + (extra ? '  (' + extra + ')' : ''));
};

/** Instala un navegador simulado y devuelve el modulo recien evaluado. */
async function conEquipo(nombre, nav) {
  try {
    Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
  } catch { /* si no se deja sobrescribir, la prueba lo delatara */ }
  return import('../src/core/capabilities.js?equipo=' + nombre);
}

const ESCRITORIO = { hardwareConcurrency: 16, deviceMemory: 16, maxTouchPoints: 0 };

// ------------------------------------------------------------- sobremesa ---
{
  const { graphicsProfile, PLATFORM } = await conEquipo('windows', {
    ...ESCRITORIO,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0',
    platform: 'Win32',
  });
  const p = graphicsProfile();
  check('sobremesa potente: nivel alto', p.tier === 'alto', p.tier);
  check('sobremesa potente: pide la GPU dedicada',
    p.powerPreference === 'high-performance', p.powerPreference);
  check('sobremesa potente: sombras VSM y multimuestreo',
    p.shadow === 'vsm' && p.samples === 4, p.shadow + ' / ' + p.samples + 'x');
  check('sobremesa potente: no es movil ni Linux',
    !PLATFORM.mobile && !PLATFORM.linux);
}

// ------------------------------------------------------------------ Linux ---
{
  const { graphicsProfile, PLATFORM } = await conEquipo('linux', {
    ...ESCRITORIO,
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0',
    platform: 'Linux x86_64',
  });
  const p = graphicsProfile();
  check('Linux: se reconoce la plataforma', PLATFORM.linux && !PLATFORM.mobile);
  check('Linux: no fuerza la eleccion de GPU',
    p.powerPreference === 'default', p.powerPreference);
  check('Linux: conserva la calidad alta', p.tier === 'alto', p.tier);
}

// ------------------------------------------------------------- equipo justo ---
{
  const { graphicsProfile } = await conEquipo('justo', {
    ...ESCRITORIO,
    hardwareConcurrency: 4,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0',
    platform: 'Win32',
  });
  const p = graphicsProfile();
  check('cuatro nucleos: baja a nivel medio', p.tier === 'medio', p.tier);
  check('cuatro nucleos: mapa de sombra de 2048', p.shadowMap === 2048, String(p.shadowMap));
}

// ------------------------------------------------------------------ movil ---
{
  const { graphicsProfile, PLATFORM } = await conEquipo('android', {
    hardwareConcurrency: 8,
    deviceMemory: 8,
    maxTouchPoints: 5,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/140.0 Mobile',
    platform: 'Linux armv8l',
  });
  const p = graphicsProfile();
  check('Android: se reconoce como movil', PLATFORM.mobile && PLATFORM.android);
  check('Android: no cuenta como Linux de escritorio', !PLATFORM.linux);
  check('Android: nivel bajo', p.tier === 'bajo', p.tier);
  check('Android: techo de resolucion 1.5x', p.pixelRatio === 1.5, p.pixelRatio + 'x');
  check('Android: sombras PCF sin multimuestreo',
    p.shadow === 'pcf' && p.samples === 0, p.shadow + ' / ' + p.samples + 'x');
  check('Android: no pide la GPU dedicada', p.powerPreference === 'default', p.powerPreference);

  const c = graphicsProfile(true);
  check('modo compatible: se impone sobre el nivel automatico',
    c.tier === 'compat' && c.compat === true, c.tier);
  check('modo compatible: resolucion 1x y sombra pequena',
    c.pixelRatio === 1 && c.shadowMap === 1024, c.pixelRatio + 'x / ' + c.shadowMap);
}

// ------------------------------------------------------- nombre de la GPU ---
{
  const { describeRenderer, isSoftwareRenderer } = await conEquipo('gpu', { ...ESCRITORIO, userAgent: '', platform: '' });

  const conExtension = {
    getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 0x9246 }),
    getParameter: (p) => (p === 0x9246 ? 'NVIDIA GeForce RTX 4070' : 'WebKit WebGL'),
    RENDERER: 0x1f01,
  };
  check('describeRenderer usa la extension de depuracion',
    describeRenderer(conExtension) === 'NVIDIA GeForce RTX 4070', describeRenderer(conExtension));

  const sinExtension = {
    getExtension: () => null,
    getParameter: (p) => (p === 0x1f01 ? 'Mesa Intel(R) UHD Graphics' : ''),
    RENDERER: 0x1f01,
  };
  check('describeRenderer recurre a RENDERER',
    describeRenderer(sinExtension) === 'Mesa Intel(R) UHD Graphics', describeRenderer(sinExtension));

  check('describeRenderer aguanta un contexto roto',
    describeRenderer({ getExtension() { throw new Error('lost'); } }) === '');

  check('llvmpipe se detecta como software', isSoftwareRenderer('llvmpipe (LLVM 17, 256 bits)'));
  check('SwiftShader se detecta como software',
    isSoftwareRenderer('Google SwiftShader'));
  check('una GPU real no se confunde con software',
    !isSoftwareRenderer('NVIDIA GeForce RTX 4070') && !isSoftwareRenderer(''));
}

console.log('\n' + oks.length + ' correctas / ' + fails.length + ' fallos');
if (fails.length) {
  console.log('FALLOS:\n - ' + fails.join('\n - '));
  process.exit(1);
}
