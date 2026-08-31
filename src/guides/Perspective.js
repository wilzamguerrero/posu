/**
 * POSU · Guias de perspectiva
 * ---------------------------------------------------------------------------
 * Retícula de fugas dibujada sobre el visor. A diferencia de las herramientas
 * de perspectiva al uso, aqui los puntos de fuga no se colocan a mano: se
 * calculan desde la camara real de la escena, asi que la reticula siempre
 * coincide con lo que se ve, tambien al orbitar, al cambiar de focal o al pasar
 * a ortografica (donde las fugas se van al infinito y las familias de rectas se
 * vuelven paralelas, como manda la teoria).
 *
 * Como se obtiene un punto de fuga
 * --------------------------------
 * El punto de fuga de la direccion `d` es la imagen de su punto del infinito,
 * es decir el vector homogeneo (d, 0) pasado por la matriz de vista y la de
 * proyeccion. Si la componente `w` sale ~0, ese punto esta en el infinito de la
 * imagen: la familia no converge y se dibuja como haz paralelo.
 *
 * Modos rectilineos (1, 2 y 3 puntos) y curvilineos (4, 5 y 6)
 * -----------------------------------------------------------
 * Los tres primeros usan la proyeccion lineal de la camara. Los otros tres no
 * pueden: ninguna camara plana ve 180 grados. Se dibujan con proyecciones
 * propias calculadas por direccion — cilindrica (4), ojo de pez equidistante de
 * media esfera (5) y esfera completa (6) — que es exactamente como se construye
 * la perspectiva curvilinea a mano. Ademas, con «Fugas del solido» se añaden
 * las fugas de los ejes del objeto seleccionado: si esta girado respecto a los
 * ejes del mundo, en pantalla aparecen mas de seis puntos de fuga a la vez.
 */

import * as THREE from 'three';

const DEG = Math.PI / 180;
const EPS = 1e-6;

const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector4();
const _dir = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _eul = new THREE.Euler();
const _mat = new THREE.Matrix4();
const _pa = new THREE.Vector3();
const _pb = new THREE.Vector3();

// Ejes del mundo y sus opuestos (las fugas de d y -d son la misma en rectilinea,
// pero en las proyecciones curvas cada sentido tiene su propio punto).
const AX = new THREE.Vector3(1, 0, 0);
const AY = new THREE.Vector3(0, 1, 0);
const AZ = new THREE.Vector3(0, 0, 1);
const NX = new THREE.Vector3(-1, 0, 0);
const NY = new THREE.Vector3(0, -1, 0);
const NZ = new THREE.Vector3(0, 0, -1);

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Catalogo de modos, con el texto que explica cuando usar cada uno. */
export const PERSPECTIVE_MODES = [
  { id: 'ninguno', label: 'Ninguna', icon: 'circle-dashed', kind: 'off',
    note: 'Sin reticula de perspectiva.' },
  { id: '1punto', label: '1 punto', icon: 'target', kind: 'lineal',
    note: 'Frontal: una sola fuga. Calles y pasillos vistos de frente.' },
  { id: '2puntos', label: '2 puntos', icon: 'ruler', kind: 'lineal',
    note: 'De esquina: dos fugas en el horizonte y verticales paralelas.' },
  { id: '3puntos', label: '3 puntos', icon: 'axis-3d', kind: 'lineal',
    note: 'Picado o contrapicado: la tercera fuga cae en el cenit o el nadir.' },
  { id: '4puntos', label: '4 puntos', icon: 'proportions', kind: 'cilindrica',
    note: 'Panoramica cilindrica: horizontales curvas, verticales rectas.' },
  { id: '5puntos', label: '5 puntos', icon: 'circle-dot', kind: 'ojodepez',
    note: 'Ojo de pez de media esfera: 180 grados de campo mas el cenit.' },
  { id: '6puntos', label: '6 puntos', icon: 'globe', kind: 'esferica',
    note: 'Esfera completa: cenit, nadir y los cuatro puntos del horizonte.' },
];

export const PERSPECTIVE_BY_ID = Object.fromEntries(PERSPECTIVE_MODES.map((m) => [m.id, m]));

/** Direccion unitaria a partir de azimut y elevacion (radianes, mundo Y arriba). */
function dirAzEl(az, el, out = new THREE.Vector3()) {
  const c = Math.cos(el);
  return out.set(Math.sin(az) * c, Math.sin(el), Math.cos(az) * c);
}

export class Perspective {
  /** @type {{min:number,max:number}|null} Limites de OrbitControls guardados. */
  #limits = null;
  /** @type {THREE.Camera|null} Copia congelada de la camara (modo bloqueo). */
  #frozen = null;

  /**
   * @param {import('../core/Settings.js').Settings} settings
   * @param {import('../core/Viewport.js').Viewport} viewport
   */
  constructor(settings, viewport) {
    this.settings = settings;
    this.viewport = viewport;

    settings.on('guides.perspective.lock', (v) => this.#lock(v === true));
    settings.on('guides.perspective.align', () => this.#level());
    settings.on('guides.perspective.mode', () => { this.#frozen = null; this.#level(); });
    this.#level();
  }

  /* -- Estado ----------------------------------------------------------- */

  /** Rama de ajustes de este modulo. */
  get conf() { return this.settings.get('guides.perspective') ?? {}; }

  /** Familia de proyeccion del modo activo: off | lineal | cilindrica | ojodepez | esferica. */
  get kind() { return PERSPECTIVE_BY_ID[this.conf.mode]?.kind ?? 'off'; }

  /** True cuando hay algo que dibujar (lo consulta Guides.anyActive). */
  get active() { return this.kind !== 'off'; }

  /** Camara que manda en el dibujo: la congelada si hay bloqueo, si no la viva. */
  get camera() { return this.#frozen ?? this.viewport.cameras.active; }

  /**
   * Congela una copia de la camara para poder orbitar sin que se muevan las
   * fugas — el modo «bloquear» de las herramientas de perspectiva clasicas.
   * @param {boolean} on
   */
  #lock(on) {
    if (!on) { this.#frozen = null; return; }
    const cam = this.viewport.cameras.active;
    cam.updateMatrixWorld();
    // Camera.copy() ya arrastra matrixWorldInverse y projectionMatrix.
    this.#frozen = cam.clone();
  }

  /**
   * Con «horizonte a nivel» se fija el angulo polar de OrbitControls a 90 grados
   * (y se anula el giro de camara), que es la condicion para que 1 y 2 puntos
   * sean geometricamente correctos: la vertical del mundo no debe fugar.
   */
  #level() {
    const c = this.viewport.cameras?.controls;
    if (!c) return;
    const on = this.conf.align === true && this.active && this.conf.mode !== '3puntos';
    if (on) {
      if (!this.#limits) this.#limits = { min: c.minPolarAngle, max: c.maxPolarAngle };
      c.minPolarAngle = Math.PI / 2;
      c.maxPolarAngle = Math.PI / 2;
      if (this.settings.get('camera.roll')) this.settings.set('camera.roll', 0);
    } else if (this.#limits) {
      c.minPolarAngle = this.#limits.min;
      c.maxPolarAngle = this.#limits.max;
      this.#limits = null;
    }
    c.update?.();
  }

  /**
   * Lleva la camara a la posicion canonica del modo: acimut a 0/90 grados para
   * 1 punto, a 45 para los demas, y horizonte a nivel salvo en 3 puntos, donde
   * se conserva (o se fuerza) un picado claro.
   */
  alignCamera() {
    const rig = this.viewport.cameras;
    const controls = rig?.controls;
    if (!controls) return;
    const cam = rig.active;
    const off = cam.position.clone().sub(controls.target);
    const dist = off.length() || 3;
    let az = Math.atan2(off.x, off.z);
    let polar = Math.acos(clamp(off.y / dist, -1, 1));

    const q = Math.PI / 2;
    if (this.conf.mode === '1punto') az = Math.round(az / q) * q;
    else az = Math.round((az - q / 2) / q) * q + q / 2;

    if (this.conf.mode === '3puntos') {
      // Sin inclinacion no hay tercera fuga: si esta casi a nivel, se pica.
      if (Math.abs(polar - q) < 12 * DEG) polar = q - 28 * DEG;
    } else polar = q;

    cam.position.copy(controls.target).add(
      new THREE.Vector3().setFromSpherical(new THREE.Spherical(dist, polar, az)),
    );
    cam.up.set(0, 1, 0);
    cam.lookAt(controls.target);
    this.settings.set('camera.roll', 0);
    controls.update();
    rig.applyOrtho?.();
  }

  /* -- Proyecciones ------------------------------------------------------ */

  /**
   * Prepara las constantes del fotograma: centro, radio de imagen y factores de
   * escala de cada proyeccion curva.
   */
  #geometry(ctx, W, H, dpr) {
    const cam = this.camera;
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix?.();
    const geo = { ctx, W, H, dpr, cam, cx: W / 2, cy: H / 2, kind: this.kind };
    geo.R = Math.min(W, H) * 0.5;
    // Focal en pixeles de la camara real (para el cono de vision rectilineo).
    geo.fpx = cam.isPerspectiveCamera ? (H / 2) / Math.tan((cam.fov * DEG) / 2) : H / 2;
    // Cilindrica: 200 grados de panoramica ocupan el ancho del lienzo.
    geo.fu = (W * 0.5) / (100 * DEG);
    geo.uMax = 178 * DEG;
    if (geo.kind === 'ojodepez') {
      // El limite se pasa medio grado del hemisferio: en el borde exacto los
      // errores de coma flotante harian desaparecer el horizonte a intervalos.
      geo.fr = (geo.R * 0.98) / (Math.PI / 2);
      geo.thetaMax = 90.75 * DEG;
    }
    else { geo.fr = (geo.R * 0.98) / Math.PI; geo.thetaMax = 179 * DEG; }
    return geo;
  }

  /**
   * Punto del mundo a pixeles. Devuelve null si cae fuera del campo del modo
   * (detras de la camara en rectilinea, fuera del circulo en las curvas), lo que
   * permite cortar las polilineas por el borde.
   */
  #point(geo, p) {
    if (geo.kind === 'lineal') {
      _v4.set(p.x, p.y, p.z, 1)
        .applyMatrix4(geo.cam.matrixWorldInverse)
        .applyMatrix4(geo.cam.projectionMatrix);
      if (_v4.w <= EPS) return null;
      return {
        x: ((_v4.x / _v4.w) * 0.5 + 0.5) * geo.W,
        y: (-(_v4.y / _v4.w) * 0.5 + 0.5) * geo.H,
      };
    }
    _v3.set(p.x, p.y, p.z).applyMatrix4(geo.cam.matrixWorldInverse);
    return this.#screenFromCam(geo, _v3);
  }

  /** Direccion del mundo a pixeles (fugas y mallas de los modos curvos). */
  #dirPoint(geo, d) {
    _dir.copy(d).transformDirection(geo.cam.matrixWorldInverse);
    return this.#screenFromCam(geo, _dir);
  }

  /**
   * Nucleo de las proyecciones curvilineas: un vector en espacio de camara
   * (que mira a -Z) se convierte en pixeles.
   *  · cilindrica  u = f·atan2(x,-z),  v = f·y/hypot(x,z)
   *  · ojo de pez  r = f·theta   con theta medido desde el eje visual
   */
  #screenFromCam(geo, v) {
    const len = v.length();
    if (len < EPS) return null;
    const x = v.x / len, y = v.y / len, z = v.z / len;
    if (geo.kind === 'cilindrica') {
      const rho = Math.hypot(x, z);
      if (rho < EPS) return null;              // justo en el cenit: indefinido
      const u = Math.atan2(x, -z);
      if (Math.abs(u) > geo.uMax) return null;
      return { x: geo.cx + u * geo.fu, y: geo.cy - (y / rho) * geo.fu };
    }
    const theta = Math.acos(clamp(-z, -1, 1));
    if (theta > geo.thetaMax) return null;
    const r = theta * geo.fr;
    const plano = Math.hypot(x, y);
    if (plano < EPS) return { x: geo.cx, y: geo.cy };
    return { x: geo.cx + (x / plano) * r, y: geo.cy - (y / plano) * r };
  }

  /**
   * Punto de fuga de una direccion del mundo en los modos rectilineos.
   * @returns {{paralela:false,x:number,y:number}|{paralela:true,dx:number,dy:number}|null}
   */
  #vp(geo, d) {
    _v4.set(d.x, d.y, d.z, 0)
      .applyMatrix4(geo.cam.matrixWorldInverse)
      .applyMatrix4(geo.cam.projectionMatrix);
    if (Math.abs(_v4.w) < 1e-5) {
      // w = 0: la fuga esta en el infinito de la imagen. La familia se ve
      // paralela y (x,y) del clip da su direccion en pantalla.
      const dx = _v4.x, dy = -_v4.y;
      const n = Math.hypot(dx, dy);
      if (n < EPS) return null;
      return { paralela: true, dx: dx / n, dy: dy / n };
    }
    return {
      paralela: false,
      x: ((_v4.x / _v4.w) * 0.5 + 0.5) * geo.W,
      y: (-(_v4.y / _v4.w) * 0.5 + 0.5) * geo.H,
    };
  }

  /**
   * Punto de fuga de una direccion del mundo en pixeles de un lienzo de W x H.
   * Es publico porque lo usan las pruebas y permite leer las coordenadas de las
   * fugas sin repetir el calculo fuera del modulo.
   */
  vanishingPoint(dir, W, H, dpr = 1) {
    const geo = this.#geometry(null, W, H, dpr);
    if (geo.kind === 'off') return null;
    return geo.kind === 'lineal' ? this.#vp(geo, dir) : this.#dirPoint(geo, dir);
  }

  /** Proyeccion de un punto del mundo con la proyeccion del modo activo. */
  screenPoint(p, W, H, dpr = 1) {
    const geo = this.#geometry(null, W, H, dpr);
    return geo.kind === 'off' ? null : this.#point(geo, p);
  }

  /* -- Trazos basicos ---------------------------------------------------- */

  /** Recta infinita por (px,py) con direccion (dx,dy), recortada al lienzo. */
  #lineThrough(geo, px, py, dx, dy) {
    const { ctx, W, H } = geo;
    const ts = [];
    if (Math.abs(dx) > EPS) ts.push((0 - px) / dx, (W - px) / dx);
    if (Math.abs(dy) > EPS) ts.push((0 - py) / dy, (H - py) / dy);
    let a = null, b = null;
    for (const t of ts) {
      const x = px + dx * t, y = py + dy * t;
      if (x < -1 || x > W + 1 || y < -1 || y > H + 1) continue;
      if (a === null) a = t; else b = t;
    }
    if (a === null || b === null || Math.abs(a - b) < 0.5) return;
    ctx.beginPath();
    ctx.moveTo(px + dx * a, py + dy * a);
    ctx.lineTo(px + dx * b, py + dy * b);
    ctx.stroke();
  }

  /**
   * Franja de angulos con la que un punto de fuga «ve» el lienzo. Sin esto, con
   * la fuga muy fuera de pantalla casi todos los radios caerian invisibles.
   */
  #angleRange(geo, vp) {
    if (vp.x >= 0 && vp.x <= geo.W && vp.y >= 0 && vp.y <= geo.H) return { from: 0, span: Math.PI };
    const angs = [[0, 0], [geo.W, 0], [geo.W, geo.H], [0, geo.H]]
      .map(([x, y]) => {
        const a = Math.atan2(y - vp.y, x - vp.x);
        return ((a % Math.PI) + Math.PI) % Math.PI;   // las rectas son bidireccionales
      })
      .sort((p, q) => p - q);
    let hueco = -1, idx = 0;
    for (let i = 0; i < angs.length; i++) {
      const sig = angs[(i + 1) % angs.length];
      const d = (((sig - angs[i]) % Math.PI) + Math.PI) % Math.PI;
      if (d > hueco) { hueco = d; idx = i; }
    }
    const span = Math.PI - hueco;
    return span > 0.01 ? { from: angs[(idx + 1) % angs.length], span } : { from: 0, span: Math.PI };
  }

  /** Haz de radios de un punto de fuga (o familia paralela si esta en el infinito). */
  #fan(geo, vp, n, fade) {
    if (!vp) return;
    if (vp.paralela) { this.#parallels(geo, vp, n); return; }
    const total = Math.max(3, Math.round(n));
    const { from, span } = this.#angleRange(geo, vp);
    const base = geo.ctx.globalAlpha;
    for (let i = 0; i < total; i++) {
      const t = (i + 0.5) / total;
      const ang = from + span * t;
      // Con degradado, los radios centrales pesan mas que los de los extremos.
      if (fade) geo.ctx.globalAlpha = base * (0.45 + 0.55 * Math.sin(Math.PI * t));
      this.#lineThrough(geo, vp.x, vp.y, Math.cos(ang), Math.sin(ang));
    }
    geo.ctx.globalAlpha = base;
  }

  /** Familia paralela: rectas repartidas a lo largo de la normal del haz. */
  #parallels(geo, vp, n) {
    const nx = -vp.dy, ny = vp.dx;
    const proj = [[0, 0], [geo.W, 0], [geo.W, geo.H], [0, geo.H]].map(([x, y]) => x * nx + y * ny);
    const min = Math.min(...proj), max = Math.max(...proj);
    const total = Math.max(2, Math.round(n));
    for (let i = 1; i < total; i++) {
      const d = min + (max - min) * (i / total);
      this.#lineThrough(geo, nx * d, ny * d, vp.dx, vp.dy);
    }
  }

  /** Marca de punto de fuga con su etiqueta. */
  #mark(geo, vp, label, conEtiqueta) {
    if (!vp || vp.paralela) return;
    const { ctx, dpr } = geo;
    const r = 3.5 * dpr;
    const base = ctx.globalAlpha;
    ctx.globalAlpha = Math.min(1, base + 0.45);
    ctx.beginPath(); ctx.arc(vp.x, vp.y, r, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(vp.x, vp.y, r * 2.8, 0, Math.PI * 2); ctx.stroke();
    if (conEtiqueta && label) {
      const x = clamp(vp.x, 30 * dpr, geo.W - 30 * dpr);
      const y = clamp(vp.y, 22 * dpr, geo.H - 12 * dpr);
      ctx.font = 600 + ' ' + Math.round(11 * dpr) + 'px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(label, x, y - r * 3.6);
    }
    ctx.globalAlpha = base;
  }

  /**
   * Polilinea en el mundo. Las muestras que caen fuera del campo cortan el
   * trazo, y el punto de corte se afina con una biseccion para que la reticula
   * llegue limpia al borde del cono de vision o al plano cercano.
   */
  #polyline3(geo, pts, esDir = false) {
    const ctx = geo.ctx;
    ctx.beginPath();
    let prev = null, prevS = null, trazando = false;
    for (const p of pts) {
      const s = esDir ? this.#dirPoint(geo, p) : this.#point(geo, p);
      if (s && prev && !prevS) {
        const b = this.#boundary(geo, p, prev, esDir);
        if (b) { ctx.moveTo(b.x, b.y); trazando = true; }
      }
      if (s) {
        if (trazando) ctx.lineTo(s.x, s.y);
        else { ctx.moveTo(s.x, s.y); trazando = true; }
      } else if (trazando && prevS) {
        const b = this.#boundary(geo, prev, p, esDir);
        if (b) ctx.lineTo(b.x, b.y);
        trazando = false;
      }
      prev = p; prevS = s;
    }
    ctx.stroke();
  }

  /** Biseccion entre un punto visible y otro que no lo es. */
  #boundary(geo, dentro, fuera, esDir = false) {
    let a = dentro, b = fuera, res = null;
    for (let i = 0; i < 9; i++) {
      _mid.copy(a).add(b).multiplyScalar(0.5);
      const s = esDir ? this.#dirPoint(geo, _mid) : this.#point(geo, _mid);
      if (s) { res = s; a = _mid.clone(); } else b = _mid.clone();
    }
    return res;
  }

  /* -- Dibujo ------------------------------------------------------------ */

  /**
   * Punto de entrada llamado por Guides una vez por fotograma, con el lienzo ya
   * limpio y en pixeles fisicos.
   */
  draw(ctx, W, H, dpr) {
    if (!this.active) return;
    const c = this.conf;
    const geo = this.#geometry(ctx, W, H, dpr);
    const color = c.color2 || '#ff8a5b';
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = Math.max(0.75, (c.width ?? 1) * dpr);
    const alpha = clamp(c.opacity ?? 0.5, 0.04, 1);
    ctx.globalAlpha = alpha;

    if (geo.kind === 'lineal') this.#linear(geo, c);
    else this.#curved(geo, c);

    if (c.floorGrid || c.wallGrid) {
      ctx.globalAlpha = alpha * 0.85;
      ctx.lineWidth = Math.max(0.6, (c.width ?? 1) * dpr * 0.8);
      if (c.floorGrid) this.#floor(geo, c);
      if (c.wallGrid) this.#walls(geo, c);
      ctx.globalAlpha = alpha;
      ctx.lineWidth = Math.max(0.75, (c.width ?? 1) * dpr);
    }
    if (c.cube) this.#cube(geo, c);
    if (c.cone) this.#cone(geo, c);
    if (c.letterbox) this.#vignette(geo, c);
    ctx.restore();
  }

  /** Modos rectilineos: haces de fuga, horizonte, medidas y fugas del solido. */
  #linear(geo, c) {
    const vpX = this.#vp(geo, AX);
    const vpZ = this.#vp(geo, AZ);
    const vpY = this.#vp(geo, AY);
    const rays = Math.max(3, Math.round(c.rays ?? 20));
    const pocos = Math.max(4, Math.round(rays * 0.4));

    // En 1 punto manda el eje horizontal mas alineado con la vista; el otro
    // horizontal y la vertical se dibujan flojos (y salen paralelos cuando la
    // camara esta bien enfrentada, que es la definicion del modo).
    geo.cam.getWorldDirection(_v3);
    const principalZ = Math.abs(_v3.z) >= Math.abs(_v3.x);
    const primero = principalZ ? vpZ : vpX;
    const segundo = principalZ ? vpX : vpZ;

    if (c.mode === '1punto') {
      this.#fan(geo, primero, rays, c.fade);
      this.#fan(geo, segundo, pocos, false);
      this.#fan(geo, vpY, pocos, false);
    } else if (c.mode === '2puntos') {
      this.#fan(geo, primero, rays, c.fade);
      this.#fan(geo, segundo, rays, c.fade);
      this.#fan(geo, vpY, pocos, false);
    } else {
      this.#fan(geo, primero, rays, c.fade);
      this.#fan(geo, segundo, rays, c.fade);
      this.#fan(geo, vpY, Math.max(6, Math.round(rays * 0.7)), c.fade);
    }

    if (c.horizon) {
      const g = geo.ctx.globalAlpha;
      geo.ctx.globalAlpha = Math.min(1, g + 0.4);
      geo.ctx.lineWidth *= 1.6;
      this.#horizonLine(geo, vpX, vpZ);
      geo.ctx.lineWidth /= 1.6;
      geo.ctx.globalAlpha = g;
    }

    if (c.measuring) this.#measuring(geo, c);
    if (c.objects) this.#objectVanishing(geo, c);

    if (c.points) {
      this.#mark(geo, primero, 'F1', c.labels);
      this.#mark(geo, segundo, 'F2', c.labels);
      if (c.mode === '3puntos') this.#mark(geo, vpY, 'F3', c.labels);
    }
  }

  /** Linea de horizonte: pasa por las dos fugas horizontales del suelo. */
  #horizonLine(geo, a, b) {
    const fin = [a, b].filter((v) => v && !v.paralela);
    if (fin.length >= 2) {
      const dx = fin[1].x - fin[0].x, dy = fin[1].y - fin[0].y;
      const n = Math.hypot(dx, dy);
      if (n > EPS) { this.#lineThrough(geo, fin[0].x, fin[0].y, dx / n, dy / n); return; }
    }
    const par = [a, b].find((v) => v && v.paralela);
    if (fin.length === 1) {
      this.#lineThrough(geo, fin[0].x, fin[0].y, par ? par.dx : 1, par ? par.dy : 0);
      return;
    }
    // Sin fugas finitas (ortografica): se usa la imagen de un punto lejano a la
    // altura del ojo, que es donde queda la linea del infinito del suelo.
    geo.cam.getWorldDirection(_v3);
    _v3.y = 0;
    if (_v3.lengthSq() < EPS) return;
    _v3.normalize().multiplyScalar(1e4).add(geo.cam.position);
    _v3.y = geo.cam.position.y;
    const s = this.#point(geo, _v3);
    if (s) this.#lineThrough(geo, s.x, s.y, par ? par.dx : 1, par ? par.dy : 0);
  }

  /** Puntos de medida a 45 grados, para trasladar distancias reales al dibujo. */
  #measuring(geo, c) {
    const ctx = geo.ctx;
    ctx.save();
    ctx.setLineDash([6 * geo.dpr, 5 * geo.dpr]);
    ctx.globalAlpha *= 0.8;
    for (const [signo, label] of [[1, 'M1'], [-1, 'M2']]) {
      _v3.set(1, 0, signo).normalize();
      const vp = this.#vp(geo, _v3);
      this.#fan(geo, vp, 8, false);
      if (c.points) this.#mark(geo, vp, label, c.labels);
    }
    ctx.restore();
  }

  /**
   * Fugas de los ejes del solido seleccionado. Si esta girado respecto al mundo
   * aporta fugas nuevas: es la forma honesta de tener «6 puntos o mas» en una
   * escena rectilinea.
   */
  #objectVanishing(geo, c) {
    const id = this.settings.get('scene.selected');
    if (!id) return;
    const item = (this.settings.get('scene.objects') ?? []).find((o) => o && o.id === id);
    const rot = item?.rotation;
    if (!rot) return;
    _eul.set((rot.x || 0) * DEG, (rot.y || 0) * DEG, (rot.z || 0) * DEG, 'XYZ');
    _mat.makeRotationFromEuler(_eul);
    const ctx = geo.ctx;
    ctx.save();
    ctx.setLineDash([2 * geo.dpr, 6 * geo.dpr]);
    let i = 1;
    for (const eje of [AX, AZ, AY]) {
      _v3.copy(eje).applyMatrix4(_mat).normalize();
      const vp = this.#vp(geo, _v3);
      this.#fan(geo, vp, 10, false);
      if (c.points) this.#mark(geo, vp, 'O' + i, c.labels);
      i++;
    }
    ctx.restore();
  }

  /** Modos curvilineos: meridianos y paralelos de la esfera de vision. */
  #curved(geo, c) {
    const ctx = geo.ctx;
    const n = clamp(Math.round(c.meridians ?? 16), 4, 72);
    const elMax = geo.kind === 'cilindrica' ? 80 : 89.5;
    const pasoEl = geo.kind === 'cilindrica' ? 15 : 15;

    // Meridianos: las verticales del mundo. En la proyeccion cilindrica salen
    // rectas y verticales; en las esfericas convergen en cenit y nadir.
    for (let i = 0; i < n; i++) {
      const az = (i / n) * Math.PI * 2;
      const pts = [];
      for (let k = 0; k <= 72; k++) {
        pts.push(dirAzEl(az, (-elMax + (2 * elMax * k) / 72) * DEG, new THREE.Vector3()));
      }
      this.#polyline3(geo, pts, true);
    }

    // Paralelos: las horizontales del mundo a cada 15 grados de altura.
    for (let e = -75; e <= 75; e += pasoEl) {
      if (e === 0) continue;
      this.#polyline3(geo, this.#circlePts(e * DEG), true);
    }

    if (c.horizon) {
      const g = ctx.globalAlpha;
      ctx.globalAlpha = Math.min(1, g + 0.4);
      ctx.lineWidth *= 1.6;
      this.#polyline3(geo, this.#circlePts(0), true);
      ctx.lineWidth /= 1.6;
      ctx.globalAlpha = g;
    }

    if (c.points) {
      const horiz = [[AZ, 'F1'], [AX, 'F2'], [NZ, 'F3'], [NX, 'F4']];
      for (const [d, label] of horiz) this.#mark(geo, this.#dirPoint(geo, d), label, c.labels);
      if (geo.kind !== 'cilindrica') this.#mark(geo, this.#dirPoint(geo, AY), 'F5', c.labels);
      if (geo.kind === 'esferica') this.#mark(geo, this.#dirPoint(geo, NY), 'F6', c.labels);
    }
    if (c.measuring) {
      ctx.save();
      ctx.setLineDash([6 * geo.dpr, 5 * geo.dpr]);
      ctx.globalAlpha *= 0.8;
      for (let i = 0; i < 4; i++) {
        const az = (45 + i * 90) * DEG;
        const pts = [];
        for (let k = 0; k <= 72; k++) pts.push(dirAzEl(az, (-elMax + (2 * elMax * k) / 72) * DEG, new THREE.Vector3()));
        this.#polyline3(geo, pts, true);
      }
      ctx.restore();
    }
  }

  /** Muestras de un paralelo (circulo de elevacion constante). */
  #circlePts(el) {
    const pts = [];
    for (let k = 0; k <= 144; k++) pts.push(dirAzEl((k / 144) * Math.PI * 2, el, new THREE.Vector3()));
    return pts;
  }

  /** Muestras de un segmento del mundo (una sola division en modos rectos). */
  #segmentPts(a, b, n) {
    const out = [];
    for (let i = 0; i <= n; i++) out.push(new THREE.Vector3().lerpVectors(a, b, i / n));
    return out;
  }

  /** Rejilla del suelo en el plano y = 0. */
  #floor(geo, c) {
    const E = clamp(c.gridExtent ?? 8, 1, 40);
    const step = clamp(c.gridStep ?? 0.5, 0.05, 5);
    const n = Math.floor(E / step);
    const m = geo.kind === 'lineal' ? 1 : 28;
    for (let i = -n; i <= n; i++) {
      const t = i * step;
      this.#polyline3(geo, this.#segmentPts(_pa.set(t, 0, -E), _pb.set(t, 0, E), m));
      this.#polyline3(geo, this.#segmentPts(_pa.set(-E, 0, t), _pb.set(E, 0, t), m));
    }
  }

  /** Rejilla de dos muros (fondo en -Z y lateral en -X) para encajar interiores. */
  #walls(geo, c) {
    const E = clamp(c.gridExtent ?? 8, 1, 40);
    const step = clamp(c.gridStep ?? 0.5, 0.05, 5);
    const alto = Math.min(E, 4);
    const n = Math.floor(E / step);
    const m = geo.kind === 'lineal' ? 1 : 20;
    for (let i = -n; i <= n; i++) {
      const t = i * step;
      this.#polyline3(geo, this.#segmentPts(_pa.set(t, 0, -E), _pb.set(t, alto, -E), m));
      this.#polyline3(geo, this.#segmentPts(_pa.set(-E, 0, t), _pb.set(-E, alto, t), m));
    }
    for (let y = 0; y <= alto + EPS; y += step) {
      this.#polyline3(geo, this.#segmentPts(_pa.set(-E, y, -E), _pb.set(E, y, -E), m));
      this.#polyline3(geo, this.#segmentPts(_pa.set(-E, y, -E), _pb.set(-E, y, E), m));
    }
  }

  /** Cubo unitario en el origen: la referencia rapida para ver si la reticula cuadra. */
  #cube(geo) {
    const s = 0.5;
    const V = [[-s, 0, -s], [s, 0, -s], [s, 0, s], [-s, 0, s],
      [-s, 1, -s], [s, 1, -s], [s, 1, s], [-s, 1, s]]
      .map(([x, y, z]) => new THREE.Vector3(x, y, z));
    const A = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4],
      [0, 4], [1, 5], [2, 6], [3, 7]];
    const m = geo.kind === 'lineal' ? 1 : 18;
    const ctx = geo.ctx;
    const g = ctx.globalAlpha;
    ctx.globalAlpha = Math.min(1, g + 0.35);
    ctx.lineWidth *= 1.4;
    for (const [a, b] of A) this.#polyline3(geo, this.#segmentPts(V[a], V[b], m));
    ctx.lineWidth /= 1.4;
    ctx.globalAlpha = g;
  }

  /** Radio en pixeles del circulo que abarca un angulo total de vision. */
  #coneRadius(geo, ang) {
    if (geo.kind === 'lineal') return geo.fpx * Math.tan(clamp(ang, 2 * DEG, 175 * DEG) / 2);
    return geo.fr * (ang / 2);
  }

  /** Cono de vision: la zona donde la perspectiva rectilinea no se deforma. */
  #cone(geo, c) {
    const ang = clamp(c.coneAngle ?? 60, 10, 170) * DEG;
    const ctx = geo.ctx;
    ctx.save();
    ctx.setLineDash([9 * geo.dpr, 7 * geo.dpr]);
    for (const [f, a] of [[1, 0.95], [0.5, 0.55]]) {
      const r = this.#coneRadius(geo, ang * f);
      if (!(r > 2)) continue;
      ctx.globalAlpha = clamp((c.opacity ?? 0.5) * a, 0.04, 1);
      ctx.beginPath();
      ctx.arc(geo.cx, geo.cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Atenua todo lo que queda fuera del cono de vision (o del circulo de imagen). */
  #vignette(geo, c) {
    const r = c.cone
      ? this.#coneRadius(geo, clamp(c.coneAngle ?? 60, 10, 170) * DEG)
      : (geo.kind === 'lineal' ? geo.fpx * Math.tan(30 * DEG) : geo.R * 0.98);
    if (!(r > 4)) return;
    const ctx = geo.ctx;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(6, 8, 12, 0.5)';
    ctx.beginPath();
    ctx.rect(0, 0, geo.W, geo.H);
    ctx.arc(geo.cx, geo.cy, r, 0, Math.PI * 2, true);   // sentido inverso: agujero
    ctx.fill();
    ctx.restore();
  }
}
