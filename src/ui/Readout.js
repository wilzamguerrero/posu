/**
 * ATOM · Lectura flotante del visor
 * ---------------------------------------------------------------------------
 * Resume el rendimiento del visor y el estado de la captura en una linea que
 * flota sobre el borde inferior del visor, con la misma tipografia que el
 * distintivo de la esquina superior derecha. Se actualiza a 5 Hz para no
 * forzar reflows en cada fotograma.
 */

import { el } from './widgets.js';
import { icon } from './icons.js';

/** Crea un elemento de la lectura; devuelve {root, set}. */
function item({ iconName, title, onClick, mono = true, cls = '' }) {
  const value = el('span', { class: mono ? 'status-value' : '', text: '—' });
  const root = el('div', {
    class: 'status-item' + (cls ? ' ' + cls : ''),
    title,
    dataset: onClick ? { clickable: '1' } : {},
    onClick,
  }, [iconName ? icon(iconName, 13) : null, value]);
  return {
    root,
    set(text, kind = '') {
      if (value.textContent !== text) value.textContent = text;
      // `hidden` la pone quien decide si el elemento se muestra; reescribir la
      // clase entera sin conservarla lo volveria a sacar en el tic siguiente.
      const oculto = root.classList.contains('hidden');
      root.className = 'status-item' + (cls ? ' ' + cls : '') + (kind ? ' ' + kind : '') + (oculto ? ' hidden' : '');
    },
  };
}

export class Readout {
  /** @param {HTMLElement} host  @param {object} app */
  constructor(host, app) {
    this.app = app;
    this.settings = app.settings;
    // `ui.setStatus` escribe aqui a traves de `app.readout`: se registra en el
    // acto para que no dependa de que lo haga quien construye la lectura.
    app.readout = this;

    this.status = item({ iconName: 'info', title: 'Ultimo aviso de la aplicacion', mono: false, cls: 'status-text' });
    this.capture = item({ iconName: 'video', title: 'Estado de la captura de movimiento', onClick: () => app.ui.showSection('mocap') });
    this.confidence = item({ iconName: 'activity', title: 'Confianza media de la deteccion' });
    this.bone = item({ iconName: 'bone', title: 'Hueso seleccionado en la pose manual', onClick: () => app.ui.showSection('poses') });
    this.lens = item({ iconName: 'aperture', title: 'Optica de la camara', onClick: () => app.ui.showSection('camera') });
    this.figure = item({ iconName: 'person-standing', title: 'Malla visible', mono: false, onClick: () => app.ui.showSection('figure') });
    this.tris = item({ iconName: 'layers', title: 'Triangulos y llamadas de dibujo por fotograma' });
    this.fps = item({ iconName: 'gauge', title: 'Fotogramas por segundo del visor' });

    host.replaceChildren(
      this.status.root,
      this.capture.root,
      this.confidence.root,
      this.bone.root,
      el('div', { class: 'status-spacer' }),
      this.figure.root,
      this.lens.root,
      this.tris.root,
      this.fps.root,
    );

    this.#bind();
    this.#paintStatic();
    this.setCapture('inactiva');
    // La interfaz se monta antes que la lectura: si ya hubo un aviso durante el
    // arranque (la carga de la figura, por ejemplo), se recupera aqui.
    const previo = app.ui?.status;
    this.setStatus(previo?.text || 'Listo', previo?.kind || '');
    this.last = 0;
    app.viewport.onFrame(() => this.#tickThrottled());
  }

  #bind() {
    const s = this.settings;
    s.on(['figure.variant', 'figure.opacity', 'camera.projection', 'camera.focalLength', 'camera.fStop',
      'camera.dof', 'mocap.engine', 'quality.showStats'], () => this.#paintStatic());
    s.on('mocap.frozen', () => this.#paintCapture());
    s.on('ui.selectedBone', (v) => this.bone.set(v ? String(v).replace(/^mixamorig:?/, '') : 'sin seleccion'));
  }

  #paintStatic() {
    const s = this.settings;
    const ortho = s.get('camera.projection') === 'ortografica';
    this.lens.set(ortho
      ? `orto ${Number(s.get('camera.orthoZoom')).toFixed(2)}×`
      : `${Math.round(s.get('camera.focalLength'))}mm ${s.get('camera.dof') ? 'f/' + Number(s.get('camera.fStop')).toFixed(1) : ''}`.trim());
    this.lens.root.title = `Optica de la camara · ${ortho ? 'ortografica' : 'perspectiva'} · sensor ${Math.round(s.get('camera.filmGauge'))} mm`;
    this.capture.root.title = `Estado de la captura de movimiento · motor «${s.get('mocap.engine')}»`;
    this.#paintFigure();
    const show = s.get('quality.showStats') !== false;
    this.tris.root.classList.toggle('hidden', !show);
    this.fps.root.classList.toggle('hidden', !show);
    this.bone.set(s.get('ui.selectedBone') ? String(s.get('ui.selectedBone')).replace(/^mixamorig:?/, '') : 'sin seleccion');
  }

  /**
   * Texto libre del ultimo aviso: lo escribe `ui.setStatus`, que es a quien
   * llaman la carga de figuras y el arranque de la captura.
   */
  setStatus(text, kind = '') {
    const texto = String(text ?? '');
    this.status.set(texto, kind);
    this.status.root.classList.toggle('hidden', !texto);
  }

  /**
   * Malla visible y, cuando hay mas de una figura en la escena, el nombre de la
   * que recibe la camara y las poses: sin esto no se sabe a quien se esta
   * posando. Lo llama `main` cada vez que cambia la figura activa.
   */
  setFigure() { this.#paintFigure(); }

  #paintFigure() {
    const s = this.settings;
    const figuras = this.app.figures;
    const varias = (figuras?.count ?? 0) > 1;
    const nombre = figuras?.activeDef?.name ?? '';
    const opacity = Number(s.get('figure.opacity'));
    const partes = [];
    if (varias && nombre) partes.push(nombre);
    partes.push(String(s.get('figure.variant')));
    if (opacity < 0.999) partes.push(`${Math.round(opacity * 100)}%`);
    this.figure.set(partes.join(' · '));
    this.figure.root.title = varias
      ? `Posando «${nombre}» de ${figuras.count} figuras · malla visible`
      : 'Malla visible';
  }

  /**
   * Estado de la captura. `state` es libre: 'inactiva' | 'camara' | 'imagen' | …
   */
  setCapture(state, kind = '') {
    this.captureBase = { state, kind };
    this.#paintCapture();
  }

  /** Compone el texto de captura con el aviso de pose congelada. */
  #paintCapture() {
    const { state = 'inactiva', kind = '' } = this.captureBase ?? {};
    if (this.settings.get('mocap.frozen') === true) {
      this.capture.set(state + ' · congelada', 'warn');
      return;
    }
    this.capture.set(state, kind);
  }

  setConfidence(value) {
    if (!Number.isFinite(value) || value <= 0) {
      this.confidence.set('—');
      return;
    }
    const pct = Math.round(value * 100);
    this.confidence.set(pct + '%', pct < 40 ? 'err' : pct < 70 ? 'warn' : 'ok');
  }

  #tickThrottled() {
    const now = performance.now();
    if (now - this.last < 200) return;
    this.last = now;
    const st = this.app.viewport.stats;
    this.fps.set(`${Math.round(st.fps)} fps · ${st.ms.toFixed(1)} ms`);
    this.tris.set(`${(st.triangles / 1000).toFixed(1)}k tri · ${st.calls} dc`);
  }
}
