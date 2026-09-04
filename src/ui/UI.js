/**
 * ATOM · Capa de interfaz
 * ---------------------------------------------------------------------------
 * Toma el marcado estatico de index.html y lo convierte en una interfaz viva:
 * panel lateral con la fila de secciones, barra de herramientas flotante del
 * visor, monitor de captura arrastrable, arrastrar y soltar y atajos de teclado.
 * Todo el estado vive en el almacen de ajustes; aqui solo se pintan y se
 * escuchan cambios.
 */

import { el, useStore } from './widgets.js';
import { icon, hydrateIcons } from './icons.js';
import { buildPanels } from './panels.js';
import { SearchBar } from './SearchBar.js';
import { toast } from './Toast.js';
import { PERSPECTIVE_MODES, PERSPECTIVE_BY_ID } from '../guides/Perspective.js';

/** Botón de icono cuyo estado activo sigue una ruta booleana del almacen. */
function iconToggle(settings, { path, iconName, title, value = true, activeIcon = null }) {
  const box = el('span', {});
  const btn = el('button', { class: 'icon-btn', type: 'button', title }, box);
  const paint = (v) => {
    const on = v === value;
    btn.classList.toggle('is-active', on);
    box.replaceChildren(icon(on && activeIcon ? activeIcon : iconName, 16));
  };
  btn.addEventListener('click', () => {
    const current = settings.get(path);
    settings.set(path, typeof value === 'boolean' ? !current : (current === value ? null : value));
  });
  settings.on(path, paint);
  paint(settings.get(path));
  return btn;
}

/** Botón de icono de accion directa. */
function iconButton({ iconName, title, onClick, id }) {
  return el('button', { class: 'icon-btn', type: 'button', title, id, onClick }, icon(iconName, 16));
}

export class UI {
  /** @param {object} app contexto con ajustes, modulos y acciones */
  constructor(app) {
    this.app = app;
    this.settings = app.settings;
    useStore(app.settings);
    app.hooks ??= {};

    this.dom = {
      app: document.getElementById('app'),
      sidebar: document.getElementById('sidebar'),
      sidebarTabs: document.getElementById('sidebar-tabs'),
      sidebarTitle: document.getElementById('sidebar-title'),
      sidebarCollapse: document.getElementById('sidebar-collapse'),
      host: document.getElementById('sidebar-host'),
      viewport: document.getElementById('viewport'),
      toolbar: document.getElementById('viewport-toolbar'),
      options: document.getElementById('viewport-options'),
      readout: document.getElementById('viewport-readout'),
      hud: document.getElementById('mocap-hud'),
      hudDrag: document.getElementById('mocap-hud-drag'),
      hudClose: document.getElementById('mocap-hud-close'),
      hudFps: document.getElementById('mocap-fps'),
      hudOverlay: document.getElementById('mocap-overlay'),
      search: document.getElementById('imgsearch'),
      dropHint: document.getElementById('drop-hint'),
    };

    this.panels = buildPanels(app);
    this.#buildSidebar();
    this.#buildToolbar();
    this.#buildHud();
    this.#buildSearch();
    this.#buildDropZone();
    this.#bindKeys();
    // El editor de escena avisa cuando se elige un elemento en el visor.
    app.hooks.revealScene = () => this.revealSection('scene');
    hydrateIcons(document);
  }

  /* ── Fila de secciones del panel lateral ────────────────────────────── */

  #buildSidebar() {
    this.dom.host.replaceChildren(...this.panels.map((p) => p.node));
    this.#buildTabs();
    this.dom.sidebarCollapse.addEventListener('click', () => this.settings.set('ui.sidebar', false));
    this.settings.on('ui.sidebar', (v) => this.dom.app.classList.toggle('sidebar-hidden', v === false));
    this.dom.app.classList.toggle('sidebar-hidden', this.settings.get('ui.sidebar') === false);
    this.settings.on('ui.section', (id) => this.#paintSection(id));
    this.#paintSection(this.settings.get('ui.section'));
  }

  /**
   * Un icono por panel en lo alto de la barra lateral: cambiar de seccion es un
   * solo clic, sin desplegar ningun menu. La fila se genera de `buildPanels`,
   * que ya trae el titulo y el icono de cada seccion.
   */
  #buildTabs() {
    const host = this.dom.sidebarTabs;
    if (!host) return;
    this.tabs = this.panels.map((p) => {
      const btn = el('button', {
        class: 'sidebar-tab', type: 'button', title: p.title,
        dataset: { section: p.id },
      }, icon(p.icon, 17));
      btn.setAttribute('aria-label', p.title);
      // `revealSection` en vez de `showSection`: los iconos viven dentro del
      // panel, asi que replegarlo al pulsar la seccion activa se los llevaria por
      // delante y no habria manera de volver sin el atajo.
      btn.addEventListener('click', () => this.revealSection(p.id));
      return { id: p.id, btn };
    });
    host.replaceChildren(...this.tabs.map((t) => t.btn));
  }

  #paintSection(id) {
    const active = this.panels.find((p) => p.id === id) ?? this.panels[0];
    for (const p of this.panels) p.node.classList.toggle('hidden', p !== active);
    this.dom.sidebarTitle.textContent = active.title;
    for (const t of this.tabs ?? []) {
      const on = t.id === active.id;
      t.btn.classList.toggle('is-active', on);
      if (on) t.btn.setAttribute('aria-current', 'page');
      else t.btn.removeAttribute('aria-current');
    }
  }

  /** Muestra una seccion; si ya estaba visible, repliega el panel. */
  showSection(id) {
    const hidden = this.settings.get('ui.sidebar') === false;
    if (!hidden && this.settings.get('ui.section') === id) {
      this.settings.set('ui.sidebar', false);
      return;
    }
    this.settings.batch(() => {
      this.settings.set('ui.section', id);
      this.settings.set('ui.sidebar', true);
    });
  }

  /**
   * Abre una seccion sin alternarla: lo usa la seleccion hecha en el visor, que
   * debe acabar siempre con el panel del elemento a la vista.
   */
  revealSection(id) {
    if (!this.panels.some((p) => p.id === id)) return;
    this.settings.batch(() => {
      this.settings.set('ui.section', id);
      this.settings.set('ui.sidebar', true);
    });
  }

  /* ── Barra de titulo (eliminada) ────────────────────────────────────── */

  /**
   * Texto de estado de la aplicacion. Ya no hay barra de titulo: el aviso vive
   * en la lectura del borde inferior del visor. Se guarda tambien aqui porque
   * la interfaz se monta antes que la lectura y algun modulo (la carga de la
   * figura) puede avisar durante el arranque.
   *
   * @param {string} text
   * @param {''|'ok'|'warn'|'err'} [kind]
   */
  setStatus(text, kind = '') {
    this.status = { text: String(text ?? ''), kind };
    this.app.readout?.setStatus?.(this.status.text, kind);
  }

  /* ── Barra de herramientas del visor ────────────────────────────────── */

  /**
   * Barra del visor: una columna con las herramientas y, al lado, otra con las
   * opciones de la que este elegida. Las tres primeras herramientas son modos del
   * puntero (seleccionar, posar, dibujar) y elegirlas cambia el modo; las demas
   * solo cambian la columna de opciones, asi que se puede encender una guia sin
   * soltar el lapiz.
   */
  #buildToolbar() {
    const s = this.settings;
    this.tools = this.#toolModel();

    this.toolButtons = this.tools.map((tool) => {
      const btn = el('button', {
        class: 'icon-btn', type: 'button', title: tool.title,
        dataset: { tool: tool.id },
      }, icon(tool.icon, 16));
      btn.addEventListener('click', () => this.selectTool(tool.id));
      return btn;
    });

    this.dom.toolbar.replaceChildren(
      ...this.toolButtons,
      el('div', { class: 'toolbar-sep' }),
      iconToggle(s, { path: 'ui.sidebar', iconName: 'panel-left-close', title: 'Panel lateral (H)' }),
    );

    // Las columnas de opciones se construyen una sola vez y se van mostrando: si
    // se rehicieran en cada cambio de herramienta, cada boton dejaria detras su
    // suscripcion al almacen.
    this.optionBars = new Map(this.tools.map((tool) => [
      tool.id,
      el('div', { class: 'toolbar-options', dataset: { tool: tool.id } },
        (tool.options ?? []).map((item) => this.#optionButton(item))),
    ]));
    this.dom.options?.replaceChildren(...this.optionBars.values());

    // Dibujar y posar a mano son modos que se estorban: encender uno apaga el otro.
    s.on('draw.enabled', (v) => { if (v === true) s.set('ui.manualPosing', false); });
    s.on('ui.manualPosing', (v) => { if (v === true) s.set('draw.enabled', false); });
    // El modo puede cambiar desde el teclado o desde los paneles; la barra se pone
    // al dia y trae a la vista las opciones de ese modo.
    s.on('ui.tool', () => this.#paintTools());
    s.on(['draw.enabled', 'ui.manualPosing'], () => {
      const modo = this.#activeMode();
      const elegida = s.get('ui.tool');
      if (modo !== 'select' && elegida !== modo) s.set('ui.tool', modo);
      else if (modo === 'select' && (elegida === 'pose' || elegida === 'draw')) s.set('ui.tool', 'select');
      else this.#paintTools();
    });
    this.#paintTools();
  }

  /** Modo del puntero en marcha, deducido de los ajustes que lo mandan. */
  #activeMode() {
    if (this.settings.get('draw.enabled') === true) return 'draw';
    if (this.settings.get('ui.manualPosing') === true) return 'pose';
    return 'select';
  }

  /**
   * Elige una herramienta. Las tres modales encienden su modo y apagan los otros;
   * el resto solo cambia la columna de opciones.
   */
  selectTool(id) {
    const tool = this.tools?.find((t) => t.id === id);
    if (!tool) return;
    if (tool.mode) {
      this.settings.batch({
        'draw.enabled': id === 'draw',
        'ui.manualPosing': id === 'pose',
        'ui.tool': id,
      });
    } else {
      this.settings.set('ui.tool', id);
    }
    this.#paintTools();
  }

  /** Marca la herramienta elegida y el modo en marcha, y muestra sus opciones. */
  #paintTools() {
    const id = this.tools?.some((t) => t.id === this.settings.get('ui.tool'))
      ? this.settings.get('ui.tool') : 'select';
    const modo = this.#activeMode();
    for (const btn of this.toolButtons ?? []) {
      btn.classList.toggle('is-active', btn.dataset.tool === id);
      btn.classList.toggle('is-mode', btn.dataset.tool === modo);
    }
    for (const [tool, bar] of this.optionBars ?? []) bar.classList.toggle('hidden', tool !== id);
  }

  /**
   * Boton de la columna de opciones. Con `value` es una eleccion entre varias
   * (queda marcado el que coincide), sin `value` un interruptor, y con `onClick`
   * una accion suelta —en ese caso `path` solo sirve para pintarlo.
   */
  #optionButton(item) {
    if (item.sep) return el('div', { class: 'toolbar-sep' });
    if (item.make) return item.make();
    const s = this.settings;
    const btn = el('button', {
      class: 'icon-btn', type: 'button', title: item.title, id: item.id,
    }, icon(item.icon, 16));
    btn.addEventListener('click', () => {
      if (item.onClick) { item.onClick(); return; }
      if (item.value !== undefined) s.set(item.path, item.value);
      else if (item.path) s.set(item.path, s.get(item.path) !== true);
    });
    if (item.path) {
      const test = item.test ?? ((v) => (item.value !== undefined ? v === item.value : v === true));
      const paint = (v) => btn.classList.toggle('is-active', !!test(v));
      s.on(item.path, paint);
      paint(s.get(item.path));
    }
    return btn;
  }

  /**
   * Las herramientas de la barra y las opciones de cada una. `mode: true` marca
   * las que cambian el modo del puntero. La ultima opcion de cada herramienta
   * abre su panel, que es donde esta todo lo que no cabe en una columna de iconos.
   */
  #toolModel() {
    const s = this.settings;
    const { actions } = this.app;
    const panel = (id, title) => ({ icon: 'sliders-horizontal', title, onClick: () => this.revealSection(id) });

    return [
      {
        id: 'select', icon: 'move-3d', mode: true, title: 'Seleccionar y transformar',
        options: [
          { icon: 'move', title: 'Mover (W)', path: 'scene.tool', value: 'translate' },
          { icon: 'rotate-3d', title: 'Girar (E)', path: 'scene.tool', value: 'rotate' },
          { icon: 'scaling', title: 'Escalar (R)', path: 'scene.tool', value: 'scale' },
          { sep: true },
          { icon: 'globe', title: 'Ejes del mundo (Alt+X)', path: 'scene.space', value: 'world' },
          { icon: 'box', title: 'Ejes del propio objeto (Alt+X)', path: 'scene.space', value: 'local' },
          { icon: 'magnet', title: 'Imantado: 10 cm y 15 grados', path: 'scene.snap',
            test: (v) => (Number(v) || 0) > 0,
            onClick: () => s.set('scene.snap', (Number(s.get('scene.snap')) || 0) > 0 ? 0 : 0.1) },
          { sep: true },
          { icon: 'scan', title: 'Caja del elemento seleccionado', path: 'scene.bounds.selected' },
          { icon: 'square-dashed', title: 'Caja de todos los elementos', path: 'scene.bounds.all' },
          panel('scene', 'Panel de escena'),
        ],
      },
      {
        id: 'pose', icon: 'hand', mode: true, title: 'Posar los huesos a mano (G)',
        options: [
          { icon: 'target', title: 'Cinematica inversa: arrastrar manos y pies (I)', path: 'ik.enabled' },
          { icon: 'move', title: 'Mover el control (W)', path: 'scene.tool', value: 'translate' },
          { icon: 'rotate-3d', title: 'Girar el hueso (E)', path: 'scene.tool', value: 'rotate' },
          { icon: 'magnet', title: 'Fijar o soltar el control elegido (X)', onClick: () => actions.togglePin?.() },
          { sep: true },
          { icon: 'fingerprint', title: 'Manejadores de falange', path: 'hands.fingers' },
          { icon: 'snowflake', title: 'Congelar la pose (C)', path: 'mocap.frozen' },
          { sep: true },
          { icon: 'undo-2', title: 'Deshacer el ultimo giro (Ctrl+Z)', onClick: () => actions.undo?.() },
          { icon: 'refresh-cw', title: 'Volver a la pose de reposo (Mayus+R)', onClick: () => actions.resetPose?.() },
          { icon: 'save', title: 'Guardar esta pose en la biblioteca', onClick: () => actions.capturePose?.('') },
          panel('poses', 'Panel de poses'),
        ],
      },
      {
        id: 'draw', icon: 'pencil', mode: true, title: 'Lapiz: dibujar sobre el visor (D)',
        options: [
          { icon: 'pencil', title: 'Lapiz: afilado, con presion o velocidad', path: 'draw.tool', value: 'lapiz' },
          { icon: 'highlighter', title: 'Rotulador: grosor parejo', path: 'draw.tool', value: 'rotulador' },
          { icon: 'eraser', title: 'Borrador: quita el trazo que toques', path: 'draw.tool', value: 'borrador' },
          { sep: true },
          { icon: 'undo-2', title: 'Deshacer el trazo (Ctrl+Z)', onClick: () => actions.undoDrawing?.() },
          { icon: 'redo-2', title: 'Rehacer (Ctrl+Mayus+Z)', onClick: () => actions.redoDrawing?.() },
          { icon: 'eye', title: 'Mostrar el dibujo', path: 'draw.visible' },
          { icon: 'trash-2', title: 'Vaciar el dibujo', onClick: () => actions.clearDrawing?.() },
          panel('draw', 'Panel del lapiz'),
        ],
      },
      {
        id: 'figure', icon: 'person-standing', title: 'Figura: malla visible y aspecto',
        options: [
          { icon: 'person-standing', title: 'Anatomia (1)', path: 'figure.variant', value: 'anatomia' },
          { icon: 'box', title: 'Maniqui (2)', path: 'figure.variant', value: 'maniqui' },
          { icon: 'bone', title: 'Esqueleto (3)', path: 'figure.variant', value: 'esqueleto' },
          { sep: true },
          { icon: 'blend', title: 'Silueta de piel superpuesta', path: 'figure.showGhost' },
          { icon: 'list-tree', title: 'Mostrar los huesos', path: 'figure.showSkeletonHelper' },
          panel('figure', 'Panel de figura'),
        ],
      },
      {
        id: 'camera', icon: 'camera', title: 'Camara y encuadre',
        options: [
          { icon: 'camera', title: 'Perspectiva (O)', path: 'camera.projection', value: 'perspectiva' },
          { icon: 'ratio', title: 'Ortografica (O)', path: 'camera.projection', value: 'ortografica' },
          { sep: true },
          { icon: 'maximize', title: 'Encuadrar la figura (F)', onClick: () => actions.frameFigure?.() },
          { icon: 'rotate-ccw', title: 'Restablecer la camara', onClick: () => actions.resetCamera?.() },
          { icon: 'focus', title: 'Profundidad de campo', path: 'camera.dof' },
          panel('camera', 'Panel de camara'),
        ],
      },
      {
        id: 'capture', icon: 'video', title: 'Captura de movimiento',
        options: [
          { make: () => this.#captureButton() },
          { icon: 'search', id: 'imgsearch-toggle', title: 'Buscar una imagen de referencia (Espacio)',
            onClick: () => this.toggleSearch() },
          { icon: 'scan-face', title: 'Analizar el fotograma cargado', onClick: () => actions.detectStill?.() },
          { sep: true },
          { icon: 'webcam', title: 'Monitor de captura', path: 'mocap.showHud' },
          { icon: 'flip-horizontal', title: 'Vista en espejo', path: 'mocap.mirror' },
          { icon: 'snowflake', title: 'Congelar la pose (C)', path: 'mocap.frozen' },
          panel('mocap', 'Panel de captura'),
        ],
      },
      {
        id: 'guides', icon: 'pencil-ruler', title: 'Guias de dibujo',
        options: [
          { icon: 'spline', title: 'Linea de accion', path: 'guides.action.line' },
          { icon: 'waves', title: 'Ritmo de brazo a brazo', path: 'guides.action.arms' },
          { icon: 'footprints', title: 'Ritmo de hombro a pierna', path: 'guides.action.legs' },
          { icon: 'ghost', title: 'Fantasma con la exageracion', path: 'guides.action.ghost' },
          { sep: true },
          { icon: 'ruler', title: 'Canon de cabezas', path: 'guides.heads' },
          { icon: 'columns-3', title: 'Regla de tercios', path: 'guides.thirds' },
          { icon: 'grid-3x3', title: 'Rejilla del suelo', path: 'stage.grid' },
          { make: () => this.#perspectiveButton() },
          panel('guides', 'Panel de guias'),
        ],
      },
      {
        id: 'settings', icon: 'settings', title: 'Exportar y ajustes',
        options: [
          { icon: 'image', title: 'Captura PNG (Ctrl+S)', onClick: () => actions.screenshot?.(false) },
          { icon: 'crop', title: 'Captura PNG sin fondo', onClick: () => actions.screenshot?.(true) },
          { sep: true },
          { icon: 'maximize', title: 'Pantalla completa', onClick: () => this.#toggleFullscreen() },
          panel('settings', 'Panel de ajustes'),
        ],
      },
    ];
  }

  async #toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await this.dom.app.requestFullscreen();
    } catch {
      toast('Este navegador no permite la pantalla completa', 'warn');
    }
  }

  /**
   * Boton que recorre los modos de perspectiva (tambien con la tecla P). El
   * titulo dice siempre cual viene despues, para no obligar a abrir el panel.
   */
  #perspectiveButton() {
    const btn = iconButton({
      iconName: 'vector-square',
      title: 'Guias de perspectiva (P)',
      onClick: () => this.cyclePerspective(),
    });
    const paint = (v) => {
      const modo = v ?? 'ninguno';
      btn.classList.toggle('is-active', modo !== 'ninguno');
      const def = PERSPECTIVE_BY_ID[modo];
      btn.title = 'Perspectiva: ' + (def ? def.label.toLowerCase() : 'ninguna') + ' · P para cambiar';
    };
    this.settings.on('guides.perspective.mode', paint);
    paint(this.settings.get('guides.perspective.mode'));
    return btn;
  }

  /** Pasa al siguiente modo de perspectiva de la lista, volviendo al principio. */
  cyclePerspective(paso = 1) {
    const ids = PERSPECTIVE_MODES.map((m) => m.id);
    const i = Math.max(0, ids.indexOf(this.settings.get('guides.perspective.mode') ?? 'ninguno'));
    const next = ids[(i + paso + ids.length) % ids.length];
    this.settings.set('guides.perspective.mode', next);
    toast('Perspectiva: ' + PERSPECTIVE_BY_ID[next].label.toLowerCase());
  }

  /** Botón principal de captura; refleja si la fuente esta corriendo. */
  #captureButton() {
    const btn = el('button', { class: 'icon-btn', type: 'button' });
    const paint = () => {
      const live = this.running === true;
      btn.title = live ? 'Detener la captura (B)' : 'Iniciar la captura (B)';
      btn.classList.toggle('is-active', live);
      btn.replaceChildren(icon(live ? 'circle-x' : 'play', 16));
    };
    btn.addEventListener('click', () => (this.running ? this.app.actions.stopCapture() : this.app.actions.startCapture()));
    this.app.hooks.captureState = (live) => { this.running = live; paint(); };
    paint();
    return btn;
  }

  /* ── Lectura del visor ──────────────────────────────────────────────── */

  // La linea del borde inferior la construye y mantiene `Readout` (ui/Readout.js),
  // que main.js crea justo despues de esta clase. Aqui no se toca: escribir en
  // `#viewport-readout` desde los dos sitios borraba los indicadores vivos
  // (fps, triangulos, confianza) cada vez que cambiaba un ajuste de camara.

  /* ── Monitor de captura ─────────────────────────────────────────────── */

  #buildHud() {
    const hud = this.dom.hud;
    const apply = (v) => hud.classList.toggle('hidden', v === false);
    this.settings.on('mocap.showHud', apply);
    apply(this.settings.get('mocap.showHud'));
    this.dom.hudClose.addEventListener('click', () => this.settings.set('mocap.showHud', false));
    this.dom.hudDrag.addEventListener('dblclick', () => hud.classList.toggle('is-collapsed'));

    // Arrastre con puntero. Tres cosas hacian que fuera a tirones y que la caja
    // saltara de sitio, y las tres se arreglan aqui:
    //  · `left`/`top` se fijan ya en el `pointerdown`. Poner solo `right` y
    //    `bottom` en automatico deja la caja en su posicion estatica, o sea de un
    //    salto a la esquina de arriba a la izquierda, y ahi se quedaba si se
    //    pulsaba sin llegar a mover (o al doble clic que la repliega).
    //  · La caja del visor se mide una sola vez, al empezar. Medirla en cada
    //    aviso de movimiento obliga al navegador a recalcular la disposicion, y un
    //    raton de 1000 Hz manda un aviso por milisegundo: de ahi el tiron.
    //  · Los avisos se acumulan y se escriben una vez por cuadro; mas de un
    //    movimiento por cuadro no se puede ver.
    let drag = null;
    let pending = null;
    let frame = 0;

    const write = () => {
      frame = 0;
      if (!pending) return;
      hud.style.left = pending.x + 'px';
      hud.style.top = pending.y + 'px';
      pending = null;
    };

    const release = () => {
      if (!drag) return;
      try { this.dom.hudDrag.releasePointerCapture?.(drag.id); } catch { /* ya soltado */ }
      drag = null;
      hud.classList.remove('is-dragging');
      if (frame) cancelAnimationFrame(frame);
      write();
    };

    this.dom.hudDrag.addEventListener('pointerdown', (ev) => {
      if (ev.target.closest('.icon-btn')) return;
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      ev.preventDefault();
      const box = hud.getBoundingClientRect();
      const host = this.dom.viewport.getBoundingClientRect();
      const left = box.left - host.left;
      const top = box.top - host.top;
      drag = {
        id: ev.pointerId,
        x: ev.clientX,
        y: ev.clientY,
        left,
        top,
        maxX: Math.max(0, host.width - box.width),
        maxY: Math.max(0, host.height - box.height),
      };
      hud.style.right = 'auto';
      hud.style.bottom = 'auto';
      hud.style.left = left + 'px';
      hud.style.top = top + 'px';
      hud.classList.add('is-dragging');
      try { this.dom.hudDrag.setPointerCapture?.(ev.pointerId); } catch { /* sin captura: basta con los avisos del elemento */ }
    });
    this.dom.hudDrag.addEventListener('pointermove', (ev) => {
      if (!drag || ev.pointerId !== drag.id) return;
      // Un raton sin botones pulsados no esta arrastrando: si el gesto se perdio
      // por el camino (menu contextual, gesto del sistema) se suelta aqui.
      if (ev.pointerType === 'mouse' && ev.buttons === 0) { release(); return; }
      pending = {
        x: Math.round(Math.max(0, Math.min(drag.maxX, drag.left + ev.clientX - drag.x))),
        y: Math.round(Math.max(0, Math.min(drag.maxY, drag.top + ev.clientY - drag.y))),
      };
      frame ||= requestAnimationFrame(write);
    });
    for (const evt of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      this.dom.hudDrag.addEventListener(evt, release);
    }

    // Al encoger la ventana el monitor podria quedarse fuera del visor. Solo se
    // recoloca si el usuario lo habia movido: mientras siga anclado a la esquina
    // se apana solo con `right`/`bottom`.
    window.addEventListener('resize', () => {
      if (drag || !hud.style.left) return;
      const host = this.dom.viewport.getBoundingClientRect();
      const box = hud.getBoundingClientRect();
      if (!host.width || !box.width) return;
      hud.style.left = Math.round(Math.max(0, Math.min(host.width - box.width, box.left - host.left))) + 'px';
      hud.style.top = Math.round(Math.max(0, Math.min(host.height - box.height, box.top - host.top))) + 'px';
    });

    this.#buildHudResize();
    this.#buildHudPicking();
  }

  /** Tamano minimo del monitor, en pixeles CSS. */
  static HUD_MIN = { w: 160, h: 120 };

  /**
   * Redimension desde las cuatro esquinas. Al empezar se fija el monitor en
   * coordenadas left/top (como hace el arrastre), porque ajustar `bottom` y
   * `height` a la vez hace que la caja se escape del cursor. El resultado se
   * guarda en los ajustes para que sobreviva a un refresco.
   */
  #buildHudResize() {
    const hud = this.dom.hud;
    const { w: MIN_W, h: MIN_H } = UI.HUD_MIN;

    const applySize = (w, h) => {
      hud.style.setProperty('--mocap-w', Math.round(w) + 'px');
      if (h > 0) {
        hud.style.height = Math.round(h) + 'px';
        hud.classList.add('is-sized');
      } else {
        hud.style.height = '';
        hud.classList.remove('is-sized');
      }
    };
    const stored = () => ({
      w: Number(this.settings.get('mocap.hudW')) || 268,
      h: Number(this.settings.get('mocap.hudH')) || 0,
    });
    const initial = stored();
    applySize(initial.w, initial.h);
    this.settings.on(['mocap.hudW', 'mocap.hudH'], () => {
      const s = stored();
      applySize(s.w, s.h);
      this.app.overlay?.clear?.();
    });

    let drag = null;
    for (const grip of hud.querySelectorAll('.mocap-grip')) {
      // Doble clic en una esquina: de vuelta al tamano y al sitio por defecto
      // (abajo a la derecha). Sin soltar las coordenadas del arrastre el monitor
      // se quedaria donde lo dejo el usuario, sin manera de recuperar la esquina.
      grip.addEventListener('dblclick', (ev) => {
        ev.stopPropagation();
        for (const prop of ['left', 'top', 'right', 'bottom']) hud.style.removeProperty(prop);
        this.settings.batch(() => {
          this.settings.set('mocap.hudW', 268);
          this.settings.set('mocap.hudH', 0);
        });
      });
      grip.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const box = hud.getBoundingClientRect();
        const host = this.dom.viewport.getBoundingClientRect();
        drag = {
          dir: grip.dataset.grip ?? 'se',
          id: ev.pointerId,
          x: ev.clientX,
          y: ev.clientY,
          left: box.left - host.left,
          top: box.top - host.top,
          w: box.width,
          h: box.height,
          host,
        };
        // Pasamos a left/top: con `bottom`/`right` el redimensionado desde las
        // esquinas contrarias moveria la caja en el sentido opuesto.
        hud.style.right = 'auto';
        hud.style.bottom = 'auto';
        hud.style.left = drag.left + 'px';
        hud.style.top = drag.top + 'px';
        grip.setPointerCapture?.(ev.pointerId);
      });
      grip.addEventListener('pointermove', (ev) => {
        if (!drag || ev.pointerId !== drag.id) return;
        // Igual que en el arrastre: un raton sin botones ya no esta estirando.
        if (ev.pointerType === 'mouse' && ev.buttons === 0) { stop(); return; }
        const dx = ev.clientX - drag.x;
        const dy = ev.clientY - drag.y;
        const east = drag.dir.includes('e');
        const south = drag.dir.includes('s');

        let w = drag.w + (east ? dx : -dx);
        let h = drag.h + (south ? dy : -dy);
        // Sin salirse del visor por el lado que queda fijo.
        const maxW = east ? drag.host.width - drag.left : drag.left + drag.w;
        const maxH = south ? drag.host.height - drag.top : drag.top + drag.h;
        w = Math.max(MIN_W, Math.min(maxW, w));
        h = Math.max(MIN_H, Math.min(maxH, h));

        if (!east) hud.style.left = (drag.left + drag.w - w) + 'px';
        if (!south) hud.style.top = (drag.top + drag.h - h) + 'px';
        applySize(w, h);
      });
      const stop = () => {
        if (!drag) return;
        drag = null;
        const box = hud.getBoundingClientRect();
        // Replegado no hay cuerpo que medir: el alto se deja en automatico.
        const replegado = hud.classList.contains('is-collapsed');
        this.settings.batch(() => {
          this.settings.set('mocap.hudW', Math.round(box.width));
          this.settings.set('mocap.hudH', replegado ? 0 : Math.round(box.height));
        });
        // El lienzo del monitor cambia de tamano: el trazado se recalcula solo
        // en el siguiente cuadro, pero conviene no dejar el anterior estirado.
        this.app.overlay?.clear?.();
      };
      grip.addEventListener('pointerup', stop);
      grip.addEventListener('pointercancel', stop);
      // Si el navegador se queda el puntero a medias, el tirador tiene que
      // enterarse: de otro modo el monitor seguiria estirandose sin boton.
      grip.addEventListener('lostpointercapture', stop);
    }
  }

  /**
   * Seleccion de controles desde el propio monitor: pulsar un punto detectado
   * elige el hueso que ese punto acciona, sin tener que buscarlo en el visor.
   */
  #buildHudPicking() {
    const canvas = this.dom.hudOverlay;
    if (!canvas) return;
    canvas.addEventListener('pointermove', (ev) => {
      const hit = this.app.overlay?.pick?.(ev.clientX, ev.clientY) ?? -1;
      canvas.classList.toggle('is-over-point', hit >= 0);
    });
    canvas.addEventListener('pointerleave', () => canvas.classList.remove('is-over-point'));
    canvas.addEventListener('pointerdown', (ev) => {
      const hit = this.app.overlay?.pick?.(ev.clientX, ev.clientY) ?? -1;
      if (hit < 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      this.app.actions.selectJointFromCapture?.(hit);
    });
  }

  /** Fotogramas por segundo del detector, en la cabecera del monitor. */
  setMocapFps(fps) {
    this.dom.hudFps.textContent = fps > 0 ? Math.round(fps) + ' fps' : '—';
  }

  /* ── Buscador de imagenes ───────────────────────────────────────────── */

  /**
   * Monta la paleta de busqueda sobre el visor. Solo existe si la aplicacion
   * trae el cliente (`app.search`), que es quien habla con el servidor.
   */
  #buildSearch() {
    if (!this.dom.search || !this.app.search) return;
    this.searchBar = new SearchBar(this.app, this.dom.search);
  }

  /** Abre o cierra el buscador de imagenes de referencia. */
  toggleSearch() {
    if (!this.searchBar) {
      toast('El buscador de imagenes no esta disponible', 'warn');
      return;
    }
    this.searchBar.toggle();
  }

  /* ── Arrastrar y soltar ─────────────────────────────────────────────── */

  #buildDropZone() {
    const hint = this.dom.dropHint;
    let depth = 0;
    const show = (v) => hint.classList.toggle('is-visible', v);
    const vp = this.dom.viewport;
    vp.addEventListener('dragenter', (ev) => { ev.preventDefault(); depth++; show(true); });
    vp.addEventListener('dragover', (ev) => { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; });
    vp.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; show(false); } });
    vp.addEventListener('drop', (ev) => {
      ev.preventDefault();
      depth = 0;
      show(false);
      const file = ev.dataTransfer?.files?.[0];
      if (file) this.app.actions.handleDroppedFile(file);
    });
  }

  /* ── Atajos de teclado ──────────────────────────────────────────────── */

  #bindKeys() {
    const { actions } = this.app;
    const s = this.settings;
    window.addEventListener('keydown', (ev) => {
      const t = ev.target;
      // No secuestramos el teclado mientras se escribe en un control.
      if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName))) return;

      if (ev.ctrlKey || ev.metaKey) {
        const k = ev.key.toLowerCase();
        // Con el lapiz encendido, deshacer es cosa del dibujo: es lo ultimo que
        // ha hecho el usuario. Sin el, se deshace el ultimo giro de hueso.
        const dibujando = s.get('draw.enabled') === true;
        if (k === 'z' && ev.shiftKey) { ev.preventDefault(); if (dibujando) actions.redoDrawing?.(); }
        else if (k === 'z') {
          ev.preventDefault();
          if (!(dibujando && actions.undoDrawing?.())) actions.undo();
        } else if (k === 's') { ev.preventDefault(); actions.screenshot(false); }
        return;
      }
      // Grosor del lapiz, como en cualquier programa de dibujo.
      if (ev.key === '[' || ev.key === ']') {
        const paso = ev.key === '[' ? -1 : 1;
        const actual = Number(s.get('draw.size')) || 4;
        s.set('draw.size', Math.max(0.5, Math.min(40, Math.round((actual + paso * Math.max(0.5, actual * 0.2)) * 2) / 2)));
        return;
      }
      // El buscador abierto se queda con Escape: cerrarlo es lo que espera
      // quien lo tiene delante, antes que deseleccionar en la escena.
      if (ev.key === 'Escape' && this.searchBar?.open) {
        ev.preventDefault();
        this.searchBar.hide();
        return;
      }
      // Y luego el lapiz: Escape lo apaga y el visor vuelve a responder al raton.
      if (ev.key === 'Escape' && s.get('draw.enabled') === true) {
        ev.preventDefault();
        s.set('draw.enabled', false);
        return;
      }
      // El editor de escena tiene prioridad: W/E/R cambian de herramienta y
      // Supr/Esc/Alt+X actuan sobre el elemento seleccionado. Con Shift se le
      // deja pasar la tecla para no pisar los atajos con mayuscula.
      if (!ev.shiftKey && this.app.scene?.handleKey?.(ev)) {
        ev.preventDefault();
        return;
      }
      if (ev.altKey) return;

      switch (ev.key) {
        case '1': s.set('figure.variant', 'anatomia'); break;
        case '2': s.set('figure.variant', 'maniqui'); break;
        case '3': s.set('figure.variant', 'esqueleto'); break;
        case 'R': actions.resetPose(); break;
        case 'P': this.cyclePerspective(-1); break;
        // Espacio abre el buscador de imagenes de referencia. Congelar la pose,
        // que antes vivia aqui, se ha movido a la C.
        case ' ':
          ev.preventDefault();
          this.toggleSearch();
          break;
        default: {
          switch (ev.key.toLowerCase()) {
            case 'p': this.cyclePerspective(1); break;
            case 'o': s.set('camera.projection', s.get('camera.projection') === 'ortografica' ? 'perspectiva' : 'ortografica'); break;
            case 'b': this.running ? actions.stopCapture() : actions.startCapture(); break;
            case 'c': s.set('mocap.frozen', s.get('mocap.frozen') !== true); break;
            case 'f': actions.frameFigure(); break;
            case 'g': s.set('ui.manualPosing', s.get('ui.manualPosing') !== true); break;
            // La cinematica inversa solo tiene sentido con los manejadores a la
            // vista, asi que encenderla enciende tambien el posado manual.
            case 'i': {
              const on = s.get('ik.enabled') !== true;
              s.batch({ 'ik.enabled': on, ...(on ? { 'ui.manualPosing': true } : {}) });
              break;
            }
            case 'x': actions.togglePin?.(); break;
            case 'd': s.set('draw.enabled', s.get('draw.enabled') !== true); break;
            case 'h': s.set('ui.sidebar', s.get('ui.sidebar') === false); break;
            default: return;
          }
        }
      }
    });
  }
}
