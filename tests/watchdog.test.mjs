/**
 * Prueba del vigilante del bucle de dibujo.
 * Comprueba que avisa cuando el navegador deja de pedir fotogramas y que no da
 * falsas alarmas: pestana en segundo plano, hilo principal atascado o
 * fotogramas lentos pero constantes.
 */
import { RenderWatchdog } from '../src/core/RenderWatchdog.js';

const fails = [];
const oks = [];
const check = (name, cond, extra) => {
  (cond ? oks : fails).push(name);
  console.log((cond ? 'OK   ' : 'FALLA') + ' ' + name + (extra ? '  (' + extra + ')' : ''));
};

/** Vigilante con reloj de mentira: `t` avanza a mano. */
function crea({ every = 800, stall = 2500, visible = () => true } = {}) {
  const reloj = { t: 0 };
  const avisos = [];
  const dog = new RenderWatchdog({
    every,
    stall,
    visible,
    now: () => reloj.t,
    onStall: (ms, veces) => avisos.push({ ms, veces }),
  });
  dog.start();
  dog.stop();            // no queremos el temporizador real en la prueba
  return { dog, reloj, avisos };
}

// ------------------------------------------------- fotogramas con normalidad ---
{
  const { dog, reloj, avisos } = crea();
  for (let i = 0; i < 20; i++) {
    reloj.t += 200;      // 5 fotogramas por segundo: lento, pero vivo
    dog.beat();
    if (i % 4 === 3) dog.check();
  }
  check('con fotogramas seguidos no avisa', avisos.length === 0, String(avisos.length));
}

// -------------------------------------------------------- paron de verdad ---
{
  const { dog, reloj, avisos } = crea();
  // El temporizador llega puntual (cada 800 ms) pero nadie dibuja.
  for (let i = 0; i < 4; i++) { reloj.t += 800; dog.check(); }
  check('avisa cuando se dejan de pedir fotogramas', avisos.length === 1, String(avisos.length));
  check('el aviso trae el tiempo parado', avisos[0]?.ms >= 2500, String(Math.round(avisos[0]?.ms ?? -1)));
  check('el aviso va numerado', avisos[0]?.veces === 1, String(avisos[0]?.veces));
  check('el contador queda a la vista', dog.stalls === 1, String(dog.stalls));

  // Tras avisar, el contador se reinicia: no se repite en cada comprobacion.
  reloj.t += 800;
  dog.check();
  check('no se repite el aviso en la comprobacion siguiente', avisos.length === 1, String(avisos.length));

  // Si sigue parado el tiempo suficiente, vuelve a avisar con el numero al dia.
  for (let i = 0; i < 3; i++) { reloj.t += 800; dog.check(); }
  check('un paron que continua vuelve a avisar', avisos.length === 2 && avisos[1].veces === 2,
    avisos.map((a) => a.veces).join(','));
}

// ------------------------------------------------------ hilo principal ocupado ---
{
  const { dog, reloj, avisos } = crea();
  // Compilar el modelo de deteccion bloquea el hilo: ni fotogramas ni
  // temporizadores. Al soltar, el retraso del propio temporizador lo delata.
  reloj.t += 6000;
  dog.check();
  check('un atasco del hilo principal no cuenta como paron', avisos.length === 0, String(avisos.length));
  // Y despues del atasco se sigue vigilando con normalidad.
  for (let i = 0; i < 4; i++) { reloj.t += 800; dog.check(); }
  check('tras el atasco se recupera la vigilancia', avisos.length === 1, String(avisos.length));
}

// ----------------------------------------------------- pestana en segundo plano ---
{
  let oculta = true;
  const { dog, reloj, avisos } = crea({ visible: () => !oculta });
  for (let i = 0; i < 8; i++) { reloj.t += 800; dog.check(); }
  check('con la pestana oculta no avisa', avisos.length === 0, String(avisos.length));
  oculta = false;
  dog.check();
  check('al volver a la pestana no hereda el tiempo oculto', avisos.length === 0, String(avisos.length));
}

// ------------------------------------------------------------- arranque limpio ---
{
  const dog = new RenderWatchdog({ now: () => 1234, onStall: null });
  dog.start();
  check('al arrancar el reloj queda en hora', dog.stamp === 1234 && dog.checked === 1234);
  const primero = dog.timer;
  dog.start();
  check('arrancar dos veces no duplica el temporizador', dog.timer === primero);
  dog.stop();
  check('al parar se suelta el temporizador', dog.timer === null);
  dog.stop();
  check('parar dos veces no rompe', dog.timer === null);
}

console.log('\n' + oks.length + ' correctas / ' + fails.length + ' fallos');
if (fails.length) {
  console.log('FALLOS:\n - ' + fails.join('\n - '));
  process.exit(1);
}
