/**
 * Manejadores por proximidad: la cuenta de `src/posing/proximity.js`.
 *
 * Es matematica pura (proyeccion a pantalla y rampa suave), asi que aqui no hay
 * ni DOM ni WebGL ni modelo: camaras de three de verdad y puntos a mano. Lo que
 * se comprueba es lo que se nota al usarlo:
 *
 *   - dentro del radio el manejador esta entero y pasado el borde no esta;
 *   - el borde es una rampa, no un salto, para que no parpadee al rozarlo;
 *   - la distancia se mide en alto de visor y corregida por la relacion de
 *     aspecto, de modo que el entorno del puntero es un circulo y no una elipse;
 *   - lo que queda detras de la camara no cuenta como cercano, aunque su
 *     proyeccion caiga justo debajo del raton.
 */
import * as THREE from 'three';
import { nearFactor, screenDistance, viewAspect, FADE } from '../src/posing/proximity.js';

const fails = [];
const oks = [];
const check = (name, cond, extra = '') => {
  (cond ? oks : fails).push(name + (extra ? ' :: ' + extra : ''));
  console.log((cond ? 'OK   ' : 'FALLA') + ' ' + name + (extra ? '  (' + extra + ')' : ''));
};

/** Camara de perspectiva en el eje Z mirando al origen. */
const camaraP = (aspect = 1) => {
  const cam = new THREE.PerspectiveCamera(50, aspect, 0.1, 100);
  cam.position.set(0, 0, 5);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
};

/** Donde cae un punto en coordenadas normalizadas (-1..1), sin tocar el original. */
const ndc = (p, cam) => p.clone().project(cam);
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const P = (x, y) => ({ x, y });

// ------------------------------------------- 1 · relacion de aspecto ---
{
  check('la relacion de aspecto sale de la camara de perspectiva',
    viewAspect(camaraP(16 / 9)) === 16 / 9);

  const orto = new THREE.OrthographicCamera(-2, 2, 1, -1, 0.1, 100);
  check('y del encuadre de la ortografica', Math.abs(viewAspect(orto) - 2) < 1e-9,
    String(viewAspect(orto)));

  check('sin camara no revienta: vale 1', viewAspect(null) === 1);
  check('una camara con aspecto absurdo tambien vale 1',
    viewAspect({ aspect: 0 }) === 1 && viewAspect({ aspect: NaN }) === 1);
}

// -------------------------------------------------- 2 · el radio manda ---
{
  const cam = camaraP(1);
  const centro = ndc(V(0, 0, 0), cam);
  check('el punto que esta debajo del raton no tiene distancia',
    screenDistance(V(0, 0, 0), cam, P(centro.x, centro.y)) < 1e-9);
  check('y asoma del todo', nearFactor(V(0, 0, 0), cam, P(centro.x, centro.y), 0.16) === 1);

  // Un punto a media pantalla de altura: su distancia es 0.5 por definicion.
  const alto = ndc(V(0, 1, 0), cam);
  const d = screenDistance(V(0, 1, 0), cam, P(centro.x, centro.y));
  check('la distancia se mide en alto de visor',
    Math.abs(d - Math.abs(alto.y) * 0.5) < 1e-9, d.toFixed(4));

  check('dentro del radio, entero', nearFactor(V(0, 1, 0), cam, P(centro.x, centro.y), d * 1.01) === 1);
  check('pasado el borde blando, nada',
    nearFactor(V(0, 1, 0), cam, P(centro.x, centro.y), d / FADE * 0.999) === 0);
  check('un radio mas grande alcanza a lo que antes no llegaba',
    nearFactor(V(0, 1, 0), cam, P(centro.x, centro.y), d * 2) === 1
    && nearFactor(V(0, 1, 0), cam, P(centro.x, centro.y), d * 0.1) === 0);
}

// ------------------------------------------------ 3 · el borde es rampa ---
{
  const cam = camaraP(1);
  const raton = P(0, 0);
  const r = 0.16;
  // Se busca a mano el punto de mundo que cae a la distancia de pantalla pedida.
  const aY = (d) => {
    let lo = 0; let hi = 6;
    for (let i = 0; i < 60; i++) {
      const m = (lo + hi) / 2;
      if (screenDistance(V(0, m, 0), cam, raton) < d) lo = m; else hi = m;
    }
    return V(0, (lo + hi) / 2, 0);
  };
  const enMedio = nearFactor(aY(r * (1 + FADE) / 2), cam, raton, r);
  check('en mitad de la rampa asoma la mitad', Math.abs(enMedio - 0.5) < 0.02, enMedio.toFixed(4));

  let previo = 1;
  let baja = true;
  let dentro = true;
  for (let i = 0; i <= 20; i++) {
    const d = r * (1 + (FADE - 1) * i / 20);
    const v = nearFactor(aY(d), cam, raton, r);
    if (v > previo + 1e-6) baja = false;
    if (v < -1e-9 || v > 1 + 1e-9) dentro = false;
    previo = v;
  }
  check('la rampa solo baja, sin escalones ni rebotes', baja);
  check('y nunca se sale de 0..1', dentro);
  check('justo en el borde exterior ya es cero', previo < 1e-6, previo.toExponential(2));
}

// ---------------------------------------- 4 · el entorno es un circulo ---
{
  // Con la pantalla mas ancha que alta, el mismo desplazamiento de mundo da
  // menos recorrido en X que en Y en coordenadas normalizadas...
  const cam = camaraP(2);
  const raton = P(0, 0);
  const derecha = V(0.6, 0, 0);
  const arriba = V(0, 0.6, 0);
  const nx = ndc(derecha, cam);
  const ny = ndc(arriba, cam);
  check('en normalizadas el eje ancho recorre menos (de ahi la correccion)',
    Math.abs(nx.x * 2 - ny.y) < 1e-6, nx.x.toFixed(4) + ' vs ' + ny.y.toFixed(4));
  // ...y aun asi las dos distancias de pantalla salen iguales: es lo que hace
  // que el entorno del raton sea un circulo y no una elipse aplastada.
  const dx = screenDistance(derecha, cam, raton);
  const dy = screenDistance(arriba, cam, raton);
  check('corregido el aspecto, ancho y alto miden lo mismo',
    Math.abs(dx - dy) < 1e-9, dx.toFixed(5) + ' vs ' + dy.toFixed(5));
  check('y por tanto asoman lo mismo',
    nearFactor(derecha, cam, raton, 0.2) === nearFactor(arriba, cam, raton, 0.2));
}

// -------------------------------------- 5 · lo que no se ve no esta cerca ---
{
  const cam = camaraP(1);
  const detras = V(0, 0, 12);   // la camara esta en z=5 mirando al origen
  const nd = ndc(detras, cam);
  check('un punto a la espalda se proyecta justo debajo del raton',
    Math.abs(nd.x) < 1e-9 && Math.abs(nd.y) < 1e-9, 'z=' + nd.z.toFixed(3));
  check('pero no cuenta como cercano', screenDistance(detras, cam, P(0, 0)) === Infinity);
  check('y no asoma', nearFactor(detras, cam, P(0, 0), 0.16) === 0);
}

// ----------------------------------------------- 6 · camara ortografica ---
{
  const cam = new THREE.OrthographicCamera(-2, 2, 1, -1, 0.1, 100);
  cam.position.set(0, 0, 5);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  check('en ortografica el punto bajo el raton asoma entero',
    nearFactor(V(0, 0, 0), cam, P(0, 0), 0.16) === 1);
  // Medio alto de encuadre (top = 1) son 0.5 alturas de visor.
  const d = screenDistance(V(0, 0.5, 0), cam, P(0, 0));
  check('y la distancia sigue siendo en alto de visor', Math.abs(d - 0.25) < 1e-9, d.toFixed(4));
  check('con ella tambien se descarta lo que queda detras',
    nearFactor(V(0, 0, 200), cam, P(0, 0), 0.5) === 0);
}

// ------------------------------------------------- 7 · malos argumentos ---
{
  const cam = camaraP(1);
  check('sin punto, sin camara o sin puntero no hay distancia',
    screenDistance(null, cam, P(0, 0)) === Infinity
    && screenDistance(V(0, 0, 0), null, P(0, 0)) === Infinity
    && screenDistance(V(0, 0, 0), cam, null) === Infinity);
  const r0 = nearFactor(V(0, 0, 0), cam, P(0, 0), 0);
  check('un radio de cero no da NaN', Number.isFinite(r0) && r0 === 1, String(r0));
  const rn = nearFactor(V(0, 1.5, 0), cam, P(0, 0), NaN);
  check('ni un radio invalido', Number.isFinite(rn), String(rn));
}

console.log('');
console.log(oks.length + ' correctas / ' + fails.length + ' fallos');
if (fails.length) { console.log('FALLOS:'); for (const f of fails) console.log(' - ' + f); process.exit(1); }
process.exit(0);
