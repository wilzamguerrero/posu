/**
 * ATOM · Geometria del trazo
 * ---------------------------------------------------------------------------
 * Convierte una polilinea con grosor variable en un contorno cerrado que se
 * rellena de una vez. Es lo que hace que un trazo parezca hecho con un lapiz y
 * no con una tuberia de grosor fijo: cada punto lleva su propio radio, asi que
 * la linea engorda donde se aprieta y adelgaza donde el trazo corre.
 *
 * Lo comparten el lapiz del visor (`draw/Sketch.js`) y las lineas de accion de
 * las guias (`guides/ActionLine.js`), para que todo lo dibujado a mano alzada
 * tenga el mismo acabado.
 */

/** Punto de un trazo: sitio y radio (medio grosor) en pixeles de lienzo. */

/** Distancia entre dos puntos. */
const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

/**
 * Estabiliza el trazo tirando de cada punto hacia el anterior. Es el mismo
 * recurso que usan las aplicaciones de dibujo para que un pulso nervioso (o un
 * raton a saltos) no salga con esquinas: 0 = tal cual entra, 1 = una gelatina.
 * @param {{x:number,y:number,w:number}[]} points
 * @param {number} amount 0..0.95
 */
export function streamline(points, amount = 0.5) {
  const k = Math.max(0, Math.min(0.95, amount));
  if (k <= 0.001 || points.length < 3) return points;
  const out = [points[0]];
  let x = points[0].x;
  let y = points[0].y;
  for (let i = 1; i < points.length; i++) {
    x += (points[i].x - x) * (1 - k);
    y += (points[i].y - y) * (1 - k);
    out.push({ ...points[i], x, y });
  }
  // El ultimo punto manda: sin esto el trazo se queda corto respecto al puntero.
  out[out.length - 1] = { ...points[points.length - 1] };
  return out;
}

/**
 * Afila la entrada y la salida del trazo. `start` y `end` son las longitudes en
 * pixeles a lo largo de las que el grosor crece desde cero: es lo que da la
 * forma de hoja de los trazos hechos con un lapiz de verdad, y lo que sustituye
 * a la presion cuando se dibuja con raton.
 * @param {{x:number,y:number,w:number}[]} points
 */
export function taper(points, { start = 0, end = 0 } = {}) {
  if (points.length < 2 || (start <= 0 && end <= 0)) return points;
  const acum = [0];
  for (let i = 1; i < points.length; i++) acum.push(acum[i - 1] + dist(points[i - 1], points[i]));
  const total = acum[acum.length - 1];
  if (total <= 0.001) return points;
  // Con trazos cortos las dos rampas se reparten el largo disponible.
  const ini = Math.min(start, total * 0.45);
  const fin = Math.min(end, total * 0.45);
  return points.map((p, i) => {
    const d = acum[i];
    let f = 1;
    if (ini > 0) f = Math.min(f, easeOut(d / ini));
    if (fin > 0) f = Math.min(f, easeOut((total - d) / fin));
    return { ...p, w: p.w * f };
  });
}

/** Rampa suave (rapida al principio) para que la punta no salga en cuña. */
const easeOut = (t) => {
  const x = Math.max(0, Math.min(1, t));
  return Math.sin((x * Math.PI) / 2);
};

/**
 * Quita los puntos que no aportan nada: los que caen encima del anterior. Sin
 * esto una pluma de 1000 Hz manda decenas de puntos repetidos por pixel y las
 * normales del contorno salen indefinidas.
 * @param {{x:number,y:number,w:number}[]} points
 * @param {number} min distancia minima en pixeles
 */
export function decimate(points, min = 1) {
  if (points.length < 2) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    if (dist(out[out.length - 1], points[i]) >= min) out.push(points[i]);
  }
  const last = points[points.length - 1];
  if (dist(out[out.length - 1], last) > 0.01 || out.length === 1) out.push(last);
  return out;
}

/**
 * Contorno cerrado de un trazo, listo para `ctx.fill(path)`.
 *
 * Se recorre el lado izquierdo de la linea hacia delante, se da la vuelta con
 * una tapa redonda y se vuelve por el lado derecho. Los tramos se unen con
 * curvas cuadraticas que pasan por los puntos medios, que es la manera clasica
 * de suavizar una polilinea sin desviarse de ella.
 *
 * @param {{x:number,y:number,w:number}[]} points radio (medio grosor) por punto
 * @returns {Path2D}
 */
export function strokePath(points) {
  const path = new Path2D();
  const pts = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!pts.length) return path;

  if (pts.length === 1) {
    const r = Math.max(0.35, pts[0].w);
    path.moveTo(pts[0].x + r, pts[0].y);
    path.arc(pts[0].x, pts[0].y, r, 0, Math.PI * 2);
    return path;
  }

  const izq = [];
  const der = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[i - 1] ?? pts[i];
    const next = pts[i + 1] ?? pts[i];
    let dx = next.x - prev.x;
    let dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    // Normal a izquierda del avance.
    const nx = -dy;
    const ny = dx;
    const w = Math.max(0.15, pts[i].w);
    izq.push({ x: pts[i].x + nx * w, y: pts[i].y + ny * w });
    der.push({ x: pts[i].x - nx * w, y: pts[i].y - ny * w });
  }

  const angulo = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
  const aFin = angulo(pts[pts.length - 2], pts[pts.length - 1]);
  const aIni = angulo(pts[0], pts[1]);

  suave(path, izq, true);
  // Tapa del final: de la orilla izquierda a la derecha pasando por la punta.
  path.arc(pts[pts.length - 1].x, pts[pts.length - 1].y,
    Math.max(0.15, pts[pts.length - 1].w), aFin + Math.PI / 2, aFin - Math.PI / 2, true);
  suave(path, der.reverse(), false);
  // Y tapa del principio, cerrando el contorno.
  path.arc(pts[0].x, pts[0].y, Math.max(0.15, pts[0].w),
    aIni - Math.PI / 2, aIni - Math.PI * 1.5, true);
  path.closePath();
  return path;
}

/** Polilinea suavizada con cuadraticas por los puntos medios. */
function suave(path, list, mover) {
  if (!list.length) return;
  if (mover) path.moveTo(list[0].x, list[0].y);
  else path.lineTo(list[0].x, list[0].y);
  for (let i = 1; i < list.length - 1; i++) {
    const mx = (list[i].x + list[i + 1].x) / 2;
    const my = (list[i].y + list[i + 1].y) / 2;
    path.quadraticCurveTo(list[i].x, list[i].y, mx, my);
  }
  const last = list[list.length - 1];
  path.lineTo(last.x, last.y);
}

/**
 * Vuelve a repartir los puntos a lo largo de una curva de Catmull-Rom que pasa
 * por todos ellos. Es lo que convierte una cadena de articulaciones (mano,
 * codo, hombro...) en una linea que fluye: sin esto el trazo se lee como una
 * poligonal con codos, no como un gesto.
 *
 * La parametrizacion es **centripeta** (los nudos van con la raiz de la
 * distancia, no con el indice). Importa: en una cadena con tramos muy desiguales
 * —tres puntos juntos en los hombros entre dos brazos largos— la version
 * uniforme se pasa de largo y deja un rizo en el medio. Con nudos centripetos la
 * curva no se sale del poligono de control ni se cruza consigo misma.
 *
 * @param {{x:number,y:number,w?:number}[]} points
 * @param {number} count puntos de salida
 */
export function resample(points, count = 48) {
  if (points.length < 3 || count < 3) return points.map((p) => ({ ...p }));
  const n = points.length;
  const t = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    t[i] = t[i - 1] + Math.max(1e-4, Math.sqrt(dist(points[i - 1], points[i])));
  }
  const total = t[n - 1];
  const out = [];
  let k = 0;
  for (let i = 0; i < count; i++) {
    const u = (i / (count - 1)) * total;
    while (k < n - 2 && u > t[k + 1]) k++;
    out.push(hermite(points, t, k, u));
  }
  return out;
}

/**
 * Un tramo de Catmull-Rom no uniforme, escrito como Hermite cubica: los dos
 * puntos del tramo y las tangentes que salen de sus vecinos, ponderadas por la
 * separacion de los nudos. Los extremos duplican su punto, asi que la curva
 * arranca y acaba en ellos.
 */
function hermite(points, t, k, u) {
  const n = points.length;
  const p1 = points[k];
  const p2 = points[k + 1];
  const t1 = t[k];
  const t2 = t[k + 1];
  const dt = Math.max(1e-6, t2 - t1);
  const p0 = k > 0 ? points[k - 1] : p1;
  const t0 = k > 0 ? t[k - 1] : t1 - dt;
  const p3 = k + 2 < n ? points[k + 2] : p2;
  const t3 = k + 2 < n ? t[k + 2] : t2 + dt;
  const s = Math.max(0, Math.min(1, (u - t1) / dt));
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  const eje = (a, b, c, d) => {
    const d1 = (b - a) / Math.max(1e-6, t1 - t0);
    const d2 = (c - b) / dt;
    const d3 = (d - c) / Math.max(1e-6, t3 - t2);
    const m1 = dt * ((d1 * (t2 - t1) + d2 * (t1 - t0)) / Math.max(1e-6, t2 - t0));
    const m2 = dt * ((d2 * (t3 - t2) + d3 * (t2 - t1)) / Math.max(1e-6, t3 - t1));
    return h00 * b + h10 * m1 + h01 * c + h11 * m2;
  };
  return {
    x: eje(p0.x, p1.x, p2.x, p3.x),
    y: eje(p0.y, p1.y, p2.y, p3.y),
    w: (p1.w ?? 0) + ((p2.w ?? 0) - (p1.w ?? 0)) * s,
  };
}

/**
 * Prolonga la curva por sus dos extremos siguiendo la tangente, para que el
 * trazo salga y entre del dibujo en vez de empezar clavado en una articulacion.
 * @param {{x:number,y:number,w?:number}[]} points
 * @param {number} length largo de cada prolongacion, en pixeles
 * @param {number} steps puntos por prolongacion
 */
export function extend(points, length, steps = 5) {
  if (points.length < 2 || length <= 0) return points;
  const punta = (desde, hacia) => {
    let dx = hacia.x - desde.x;
    let dy = hacia.y - desde.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
  };
  const ini = punta(points[1], points[0]);
  const fin = punta(points[points.length - 2], points[points.length - 1]);
  const out = [];
  for (let i = steps; i >= 1; i--) {
    const d = (length * i) / steps;
    out.push({ ...points[0], x: points[0].x + ini.x * d, y: points[0].y + ini.y * d });
  }
  out.push(...points.map((p) => ({ ...p })));
  const last = points[points.length - 1];
  for (let i = 1; i <= steps; i++) {
    const d = (length * i) / steps;
    out.push({ ...last, x: last.x + fin.x * d, y: last.y + fin.y * d });
  }
  return out;
}

/**
 * Redondea los giros de una polilinea densa con una media movil a lo largo de
 * ella. Es lo que convierte el recorrido exacto de las articulaciones en un
 * gesto: el hombro y la muneca hacen esquinas de casi noventa grados, y una linea
 * de ritmo tiene que pasar por ahi sin frenar. La ventana se estrecha al acercarse
 * a los extremos, asi que las dos puntas no se mueven ni un pixel.
 * @param {{x:number,y:number,w?:number}[]} points curva ya remuestreada
 * @param {number} strength fraccion de la curva que abarca la ventana (0 = nada)
 */
export function relax(points, strength = 0.12) {
  const n = points.length;
  if (n < 5 || strength <= 0) return points;
  const radio = Math.max(1, Math.round((n * strength) / 2));
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = Math.min(radio, i, n - 1 - i);
    if (r === 0) { out[i] = { ...points[i] }; continue; }
    let x = 0;
    let y = 0;
    for (let k = i - r; k <= i + r; k++) {
      x += points[k].x;
      y += points[k].y;
    }
    const m = r * 2 + 1;
    out[i] = { ...points[i], x: x / m, y: y / m };
  }
  return out;
}

/** Largo total de una polilinea, en pixeles. */
export function pathLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
  return total;
}

/**
 * Curva suave abierta (sin grosor) por una lista de puntos. La usan las guias
 * para las lineas finas del fantasma.
 * @param {{x:number,y:number}[]} list
 * @returns {Path2D}
 */
export function curvePath(list) {
  const path = new Path2D();
  if (list.length < 2) return path;
  suave(path, list, true);
  return path;
}
