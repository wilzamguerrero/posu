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

  #buildToolbar() {
    const s = this.settings;
    const { actions } = this.app;
    const sep = () => el('div', { class: 'toolbar-sep' });

    // Menus desplegables de acciones. Cambiar de panel ya no vive aqui: eso lo
    // hace la fila de iconos de lo alto de la barra lateral (`#buildTabs`).
    const createDropdown = (label, iconName, items) => {
      const dropdown = el('div', { class: 'toolbar-dropdown' });
      const btn = el('button', { class: 'toolbar-dropdown-btn', title: label }, [
        icon(iconName, 16),
        icon('chevron-down', 12, 'chev'),
      ]);
      const menu = el('div', { class: 'toolbar-dropdown-menu' });

      items.forEach((item) => {
        const itemBtn = el('button', { class: 'toolbar-dropdown-item' }, [
          icon(item.icon, 16),
          el('span', { text: item.label }),
        ]);
        itemBtn.addEventListener('click', () => {
          // Una entrada con `path` es un interruptor: se alterna y se queda
          // marcada, para saber que hay encendido sin abrir el panel.
          if (item.path) s.set(item.path, s.get(item.path) !== true);
          item.onClick?.();
          dropdown.classList.remove('is-open');
        });
        if (item.path) {
          const paint = (v) => itemBtn.classList.toggle('is-active', v === true);
          s.on(item.path, paint);
          paint(s.get(item.path));
        }
        menu.appendChild(itemBtn);
      });

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasOpen = dropdown.classList.contains('is-open');
        // Cerrar todos los dropdowns
        document.querySelectorAll('.toolbar-dropdown').forEach((d) => d.classList.remove('is-open'));
        if (!wasOpen) dropdown.classList.add('is-open');
      });

      dropdown.append(btn, menu);
      return dropdown;
    };

    // Cerrar dropdowns al hacer clic fuera
    document.addEventListener('click', () => {
      document.querySelectorAll('.toolbar-dropdown').forEach((d) => d.classList.remove('is-open'));
    });

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

    // Dropdown de figuras (Anatomía/Maniquí/Esqueleto)
    const figuraDropdown = createDropdown('Figura', 'person-standing', [
      { label: 'Anatomia', icon: 'person-standing', onClick: () => s.set('figure.variant', 'anatomia') },
      { label: 'Maniqui', icon: 'box', onClick: () => s.set('figure.variant', 'maniqui') },
      { label: 'Esqueleto', icon: 'bone', onClick: () => s.set('figure.variant', 'esqueleto') },
    ]);

    // Dropdown de cámara
    const camaraDropdown = createDropdown('Camara', 'camera', [
      { label: 'Perspectiva/Ortografica', icon: 'ratio', onClick: () => s.set('camera.projection', s.get('camera.projection') === 'ortografica' ? 'perspectiva' : 'ortografica') },
      { label: 'Encuadrar figura', icon: 'maximize', onClick: () => actions.frameFigure() },
      { label: 'Restablecer camara', icon: 'rotate-ccw', onClick: () => actions.resetCamera() },
    ]);

    // Dropdown de captura
    const capturaDropdown = createDropdown('Captura', 'video', [
      { label: 'Buscar imagen de referencia', icon: 'search', onClick: () => this.toggleSearch() },
      { label: 'Monitor de captura', icon: 'webcam', path: 'mocap.showHud' },
      { label: 'Congelar pose', icon: 'snowflake', path: 'mocap.frozen' },
    ]);

    // Dropdown del lapiz. Ocupa el sitio del antiguo menu de Poses, que solo
    // repetia el boton de pose manual que hay dos filas mas abajo.
    const lapizDropdown = createDropdown('Lapiz', 'pencil', [
      { label: 'Dibujar sobre el visor', icon: 'pencil', path: 'draw.enabled' },
      { label: 'Lapiz', icon: 'pencil', onClick: () => s.set('draw.tool', 'lapiz') },
      { label: 'Rotulador', icon: 'highlighter', onClick: () => s.set('draw.tool', 'rotulador') },
      { label: 'Borrador', icon: 'eraser', onClick: () => s.set('draw.tool', 'borrador') },
      { label: 'Mostrar el dibujo', icon: 'eye', path: 'draw.visible' },
      { label: 'Vaciar el dibujo', icon: 'trash-2', onClick: () => actions.clearDrawing?.() },
    ]);

    // Dropdown de guías
    const guiasDropdown = createDropdown('Guias', 'pencil-ruler', [
      { label: 'Linea de accion', icon: 'spline', path: 'guides.action.line' },
      { label: 'Ritmo de brazo a brazo', icon: 'spline', path: 'guides.action.arms' },
      { label: 'Ritmo de hombro a pierna', icon: 'spline', path: 'guides.action.legs' },
      { label: 'Fantasma exagerado', icon: 'ghost', path: 'guides.action.ghost' },
      { label: 'Caja de lo seleccionado', icon: 'scan', path: 'scene.bounds.selected' },
      { label: 'Caja de todo', icon: 'scan', path: 'scene.bounds.all' },
      { label: 'Canon de cabezas', icon: 'ruler', path: 'guides.heads' },
      { label: 'Regla de tercios', icon: 'columns-3', path: 'guides.thirds' },
      { label: 'Rejilla del suelo', icon: 'grid-3x3', path: 'stage.grid' },
    ]);

    // Dropdown de ajustes
    const ajustesDropdown = createDropdown('Ajustes', 'settings', [
      { label: 'Captura PNG', icon: 'image', onClick: () => actions.screenshot(false) },
      { label: 'Pantalla completa', icon: 'maximize', onClick: () => this.#toggleFullscreen() },
    ]);

    this.dom.toolbar.replaceChildren(
      figuraDropdown,
      camaraDropdown,
      capturaDropdown,
      lapizDropdown,
      guiasDropdown,
      ajustesDropdown,
      sep(),
      iconToggle(this.settings, { path: 'ui.manualPosing', iconName: 'hand', title: 'Pose manual (G)' }),
      iconToggle(this.settings, { path: 'draw.enabled', iconName: 'pencil', title: 'Lapiz: dibujar sobre el visor (D)' }),
      sep(),
      this.#toolButton('translate', 'move', 'Mover el elemento seleccionado (W)'),
      this.#toolButton('rotate', 'rotate-3d', 'Girar el elemento seleccionado (E)'),
      this.#toolButton('scale', 'scaling', 'Escalar el elemento seleccionado (R)'),
      sep(),
      this.#perspectiveButton(),
      sep(),
      iconButton({
        id: 'imgsearch-toggle', iconName: 'search',
        title: 'Buscar una imagen de referencia en la web (Espacio)',
        onClick: () => this.toggleSearch(),
      }),
      this.#captureButton(),
      iconToggle(this.settings, { path: 'ui.sidebar', iconName: 'panel-left-close', title: 'Panel lateral (H)' }),
    );
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
            case 'd': s.set('draw.enabled', s.get('draw.enabled') !== true); break;
            case 'h': s.set('ui.sidebar', s.get('ui.sidebar') === false); break;
            default: return;
          }
        }
      }
    });
  }
}
