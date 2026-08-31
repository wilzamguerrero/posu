/**
 * POSU · Capa de interfaz
 * ---------------------------------------------------------------------------
 * Toma el marcado estatico de index.html y lo convierte en una interfaz viva:
 * barra de actividad, panel lateral con las secciones, barra de herramientas
 * flotante del visor, monitor de captura arrastrable, arrastrar y soltar y
 * atajos de teclado. Todo el estado vive en el almacen de ajustes; aqui solo
 * se pintan y se escuchan cambios.
 */

import { el, useStore } from './widgets.js';
import { icon, hydrateIcons } from './icons.js';
import { buildPanels } from './panels.js';
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
      status: document.getElementById('titlebar-status'),
      actions: document.getElementById('titlebar-actions'),
      activitybar: document.getElementById('activitybar'),
      sidebar: document.getElementById('sidebar'),
      sidebarTitle: document.getElementById('sidebar-title'),
      sidebarCollapse: document.getElementById('sidebar-collapse'),
      host: document.getElementById('sidebar-host'),
      viewport: document.getElementById('viewport'),
      toolbar: document.getElementById('viewport-toolbar'),
      badge: document.getElementById('viewport-badge'),
      hud: document.getElementById('mocap-hud'),
      hudDrag: document.getElementById('mocap-hud-drag'),
      hudClose: document.getElementById('mocap-hud-close'),
      hudFps: document.getElementById('mocap-fps'),
      dropHint: document.getElementById('drop-hint'),
    };

    this.panels = buildPanels(app);
    this.#buildActivityBar();
    this.#buildSidebar();
    this.#buildTitlebar();
    this.#buildToolbar();
    this.#buildBadge();
    this.#buildHud();
    this.#buildDropZone();
    this.#bindKeys();
    // El editor de escena avisa cuando se elige un elemento en el visor.
    app.hooks.revealScene = () => this.revealSection('scene');
    hydrateIcons(document);
  }

  /* ── Barra de actividad ─────────────────────────────────────────────── */

  #buildActivityBar() {
    this.activityItems = new Map();
    const nodes = [];
    for (const p of this.panels) {
      const btn = el('button', {
        class: 'activity-item', type: 'button', title: p.title,
        onClick: () => this.showSection(p.id),
      }, icon(p.icon, 22));
      this.activityItems.set(p.id, btn);
      // "Ajustes" queda anclado abajo, como en VS Code.
      if (p.id === 'settings') nodes.push(el('div', { class: 'activity-spacer' }));
      nodes.push(btn);
    }
    this.dom.activitybar.replaceChildren(...nodes);
  }

  #buildSidebar() {
    this.dom.host.replaceChildren(...this.panels.map((p) => p.node));
    this.dom.sidebarCollapse.addEventListener('click', () => this.settings.set('ui.sidebar', false));
    this.settings.on('ui.sidebar', (v) => this.dom.app.classList.toggle('sidebar-hidden', v === false));
    this.dom.app.classList.toggle('sidebar-hidden', this.settings.get('ui.sidebar') === false);
    this.settings.on('ui.section', (id) => this.#paintSection(id));
    this.#paintSection(this.settings.get('ui.section'));
  }

  #paintSection(id) {
    const active = this.panels.find((p) => p.id === id) ?? this.panels[0];
    for (const p of this.panels) p.node.classList.toggle('hidden', p !== active);
    for (const [key, btn] of this.activityItems) btn.classList.toggle('is-active', key === active.id);
    this.dom.sidebarTitle.textContent = active.title;
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

  /* ── Barra de titulo ────────────────────────────────────────────────── */

  #buildTitlebar() {
    const { actions } = this.app;
    this.statusText = el('span', { class: 'title-status-text', text: 'Listo' });
    this.dom.status.replaceChildren(this.statusText);

    this.dom.actions.replaceChildren(
      iconToggle(this.settings, { path: 'mocap.showHud', iconName: 'webcam', title: 'Monitor de captura' }),
      iconToggle(this.settings, { path: 'mocap.frozen', iconName: 'snowflake', title: 'Congelar la pose (Espacio)' }),
      iconButton({ iconName: 'image', title: 'Guardar captura PNG (Ctrl+S)', onClick: () => actions.screenshot(false) }),
      iconToggle(this.settings, { path: 'ui.sidebar', iconName: 'panel-left-close', title: 'Panel lateral (H)' }),
      iconButton({ iconName: 'maximize', title: 'Pantalla completa', onClick: () => this.#toggleFullscreen() }),
    );
  }

  /** Texto de estado de la barra de titulo. */
  setStatus(text, kind = '') {
    this.statusText.textContent = text;
    this.statusText.className = 'title-status-text' + (kind ? ' ' + kind : '');
  }

  async #toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await this.dom.app.requestFullscreen();
    } catch {
      toast('Este navegador no permite la pantalla completa', 'warn');
    }
  }

  /* ── Barra de herramientas del visor ────────────────────────────────── */

  #buildToolbar() {
    const s = this.settings;
    const { actions } = this.app;
    const sep = () => el('div', { class: 'toolbar-sep' });

    const variant = (value, iconName, title) => {
      const btn = el('button', { class: 'icon-btn', type: 'button', title }, icon(iconName, 16));
      btn.addEventListener('click', () => s.set('figure.variant', value));
      const paint = (v) => btn.classList.toggle('is-active', v === value);
      s.on('figure.variant', paint);
      paint(s.get('figure.variant'));
      return btn;
    };

    const projection = el('button', { class: 'icon-btn', type: 'button' });
    const paintProj = (v) => {
      const ortho = v === 'ortografica';
      projection.title = ortho ? 'Vista ortografica (O)' : 'Vista en perspectiva (O)';
      projection.classList.toggle('is-active', ortho);
      projection.replaceChildren(icon(ortho ? 'ratio' : 'camera', 16));
    };
    projection.addEventListener('click', () =>
      s.set('camera.projection', s.get('camera.projection') === 'ortografica' ? 'perspectiva' : 'ortografica'));
    s.on('camera.projection', paintProj);
    paintProj(s.get('camera.projection'));

    this.dom.toolbar.replaceChildren(
      variant('anatomia', 'person-standing', 'Anatomia (1)'),
      variant('maniqui', 'box', 'Maniqui (2)'),
      variant('esqueleto', 'bone', 'Esqueleto (3)'),
      sep(),
      projection,
      iconButton({ iconName: 'maximize', title: 'Encuadrar la figura (F)', onClick: () => actions.frameFigure() }),
      iconButton({ iconName: 'rotate-ccw', title: 'Restablecer la camara', onClick: () => actions.resetCamera() }),
      sep(),
      iconToggle(this.settings, { path: 'ui.manualPosing', iconName: 'hand', title: 'Pose manual (G)' }),
      iconToggle(this.settings, { path: 'mocap.mirror', iconName: 'flip-horizontal', title: 'Captura en espejo' }),
      sep(),
      this.#toolButton('translate', 'move', 'Mover el elemento seleccionado (W)'),
      this.#toolButton('rotate', 'rotate-3d', 'Girar el elemento seleccionado (E)'),
      this.#toolButton('scale', 'scaling', 'Escalar el elemento seleccionado (R)'),
      sep(),
      this.#perspectiveButton(),
      iconToggle(this.settings, { path: 'guides.heads', iconName: 'ruler', title: 'Canon de cabezas' }),
      iconToggle(this.settings, { path: 'guides.thirds', iconName: 'columns-3', title: 'Regla de los tercios' }),
      iconToggle(this.settings, { path: 'stage.grid', iconName: 'grid-3x3', title: 'Rejilla del suelo' }),
      sep(),
      this.#captureButton(),
    );
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

  /** Boton de la barra que fija una herramienta del gizmo (`scene.tool`). */
  #toolButton(value, iconName, title) {
    const btn = iconButton({ iconName, title, onClick: () => this.settings.set('scene.tool', value) });
    const paint = (v) => btn.classList.toggle('is-active', v === value);
    this.settings.on('scene.tool', paint);
    paint(this.settings.get('scene.tool'));
    return btn;
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

  /* ── Distintivo del visor ───────────────────────────────────────────── */

  #buildBadge() {
    const line = () => el('div', {});
    const lens = line();
    const proj = line();
    const engine = line();
    this.dom.badge.replaceChildren(lens, proj, engine);

    const paint = () => {
      const s = this.settings;
      const ortho = s.get('camera.projection') === 'ortografica';
      lens.innerHTML = ortho
        ? `<b>orto</b> ${(s.get('camera.orthoZoom') ?? 1).toFixed(2)}×`
        : `<b>${Math.round(s.get('camera.focalLength'))} mm</b> f/${Number(s.get('camera.fStop')).toFixed(1)}`;
      proj.innerHTML = `<b>${ortho ? 'ortografica' : 'perspectiva'}</b> · ${Math.round(s.get('camera.filmGauge'))} mm`;
      const variant = s.get('figure.variant');
      engine.innerHTML = `<b>${variant}</b> · ${s.get('mocap.engine')}`;
    };
    this.settings.on(
      ['camera.projection', 'camera.focalLength', 'camera.fStop', 'camera.filmGauge', 'camera.orthoZoom',
        'figure.variant', 'mocap.engine'],
      paint,
    );
    paint();
  }

  /* ── Monitor de captura ─────────────────────────────────────────────── */

  #buildHud() {
    const hud = this.dom.hud;
    const apply = (v) => hud.classList.toggle('hidden', v === false);
    this.settings.on('mocap.showHud', apply);
    apply(this.settings.get('mocap.showHud'));
    this.dom.hudClose.addEventListener('click', () => this.settings.set('mocap.showHud', false));
    this.dom.hudDrag.addEventListener('dblclick', () => hud.classList.toggle('is-collapsed'));

    // Arrastre con puntero: se guarda la posicion en pixeles dentro del visor.
    let start = null;
    this.dom.hudDrag.addEventListener('pointerdown', (ev) => {
      if (ev.target.closest('.icon-btn')) return;
      const box = hud.getBoundingClientRect();
      const host = this.dom.viewport.getBoundingClientRect();
      start = { x: ev.clientX, y: ev.clientY, left: box.left - host.left, top: box.top - host.top, w: box.width, h: box.height };
      hud.style.right = 'auto';
      hud.style.bottom = 'auto';
      this.dom.hudDrag.setPointerCapture(ev.pointerId);
    });
    this.dom.hudDrag.addEventListener('pointermove', (ev) => {
      if (!start) return;
      const host = this.dom.viewport.getBoundingClientRect();
      const max = { x: host.width - start.w, y: host.height - start.h };
      hud.style.left = Math.max(0, Math.min(max.x, start.left + ev.clientX - start.x)) + 'px';
      hud.style.top = Math.max(0, Math.min(max.y, start.top + ev.clientY - start.y)) + 'px';
    });
    const end = () => { start = null; };
    this.dom.hudDrag.addEventListener('pointerup', end);
    this.dom.hudDrag.addEventListener('pointercancel', end);
  }

  /** Fotogramas por segundo del detector, en la cabecera del monitor. */
  setMocapFps(fps) {
    this.dom.hudFps.textContent = fps > 0 ? Math.round(fps) + ' fps' : '—';
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
        if (k === 'z') { ev.preventDefault(); actions.undo(); }
        else if (k === 's') { ev.preventDefault(); actions.screenshot(false); }
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
        case ' ':
          ev.preventDefault();
          s.set('mocap.frozen', s.get('mocap.frozen') !== true);
          break;
        default: {
          switch (ev.key.toLowerCase()) {
            case 'p': this.cyclePerspective(1); break;
            case 'o': s.set('camera.projection', s.get('camera.projection') === 'ortografica' ? 'perspectiva' : 'ortografica'); break;
            case 'b': this.running ? actions.stopCapture() : actions.startCapture(); break;
            case 'f': actions.frameFigure(); break;
            case 'g': s.set('ui.manualPosing', s.get('ui.manualPosing') !== true); break;
            case 'h': s.set('ui.sidebar', s.get('ui.sidebar') === false); break;
            default: return;
          }
        }
      }
    });
  }
}
