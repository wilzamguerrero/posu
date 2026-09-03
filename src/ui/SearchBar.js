/**
 * ATOM · Buscador de imagenes de referencia
 * ---------------------------------------------------------------------------
 * Paleta flotante sobre el visor: se escribe que pose se busca, salen las
 * miniaturas y al pulsar una entra en el monitor de captura como imagen fija,
 * de donde el detector saca la pose y la pasa a la figura activa. Es el mismo
 * camino que soltar un archivo en la ventana, sin salir de la aplicacion.
 *
 * Se abre con Espacio, con el boton de la lupa de la barra o desde el panel
 * Captura, y se cierra con Escape.
 */

import { el } from './widgets.js';
import { icon } from './icons.js';
import { toast } from './Toast.js';
import { errorText } from '../core/errors.js';

/** Busquedas de ejemplo: lo que suele hacer falta en un estudio de figura. */
const SUGERENCIAS = [
  'persona corriendo',
  'figura sentada de perfil',
  'salto en el aire',
  'contrapposto de pie',
  'escorzo tumbado',
  'brazos en alto estirandose',
];

export class SearchBar {
  /**
   * @param {object} app contexto de la aplicacion (settings, actions, search)
   * @param {HTMLElement} host nodo vacio donde montarse
   */
  constructor(app, host) {
    this.app = app;
    this.root = host;
    this.page = 1;
    this.query = '';
    this.busy = false;
    this.open = false;
    /** @type {Array<object>} */
    this.results = [];
    this.#build();
  }

  /* ── Montaje ──────────────────────────────────────────────────────────── */

  #build() {
    this.input = el('input', {
      type: 'search', id: 'imgsearch-input', autocomplete: 'off', spellcheck: 'false',
      placeholder: 'Busca una pose: «persona corriendo», «figura sentada de perfil»…',
      'aria-label': 'Buscar imagenes de referencia',
    });
    this.input.addEventListener('keydown', (ev) => this.#onInputKey(ev));

    this.tag = el('span', { class: 'imgsearch-tag' });
    const lupa = el('button', {
      class: 'icon-btn', type: 'button', title: 'Buscar (Intro)',
      onClick: () => this.run(this.input.value),
    }, icon('search', 15));
    const cerrar = el('button', {
      class: 'icon-btn', type: 'button', title: 'Cerrar (Esc)',
      onClick: () => this.hide(),
    }, icon('x', 15));

    this.body = el('div', { class: 'imgsearch-body' });
    this.body.addEventListener('keydown', (ev) => this.#onGridKey(ev));

    this.root.replaceChildren(
      el('div', { class: 'imgsearch-bar' }, [el('span', { class: 'imgsearch-lead' }, icon('search', 15)), this.input, this.tag, lupa, cerrar]),
      this.body,
    );
    this.root.classList.add('imgsearch');
    this.#renderIdle();
  }

  /* ── Abrir y cerrar ───────────────────────────────────────────────────── */

  show() {
    this.open = true;
    this.root.classList.remove('hidden');
    this.input.focus();
    this.input.select();
  }

  hide() {
    this.open = false;
    this.root.classList.add('hidden');
  }

  toggle() {
    if (this.open) this.hide();
    else this.show();
  }

  /* ── Teclado ──────────────────────────────────────────────────────────── */

  #onInputKey(ev) {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      this.run(this.input.value);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      this.hide();
    } else if (ev.key === 'ArrowDown') {
      const primera = this.body.querySelector('.imgsearch-card');
      if (primera) {
        ev.preventDefault();
        primera.focus();
      }
    }
  }

  /** Flechas entre miniaturas; Escape vuelve al cuadro de texto. */
  #onGridKey(ev) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      this.input.focus();
      return;
    }
    const paso = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 4, ArrowUp: -4 }[ev.key];
    if (!paso) return;
    const cards = [...this.body.querySelectorAll('.imgsearch-card')];
    const i = cards.indexOf(document.activeElement);
    if (i < 0) return;
    ev.preventDefault();
    const destino = cards[i + paso];
    if (destino) destino.focus();
    else if (paso < 0) this.input.focus();
  }

  /* ── Busqueda ─────────────────────────────────────────────────────────── */

  /**
   * Lanza una busqueda nueva o pide la pagina siguiente.
   *
   * @param {string} query
   * @param {{append?:boolean}} [opts]
   */
  async run(query, { append = false } = {}) {
    const q = String(query ?? '').trim();
    if (!q || this.busy) return;
    this.busy = true;
    this.query = q;
    if (this.input.value !== q) this.input.value = q;
    this.page = append ? this.page + 1 : 1;
    if (!append) {
      this.results = [];
      this.#renderMessage('Buscando…', 'search');
    }
    this.tag.textContent = 'buscando…';

    try {
      const res = await this.app.search.search(q, { page: this.page });
      this.results = append ? this.results.concat(res.results) : res.results;
      this.tag.textContent = res.label ? res.label.toLowerCase() : '';
      if (!this.results.length) {
        this.#renderMessage(`Sin resultados para «${q}».`, 'image');
      } else {
        this.#renderResults(res.results.length >= 12);
      }
    } catch (err) {
      console.error('[Buscador]', err);
      this.tag.textContent = '';
      this.#renderMessage('No se pudo buscar: ' + errorText(err), 'triangle-alert');
    } finally {
      this.busy = false;
    }
  }

  /* ── Eleccion de una imagen ───────────────────────────────────────────── */

  /**
   * Descarga el resultado elegido y lo mete en el monitor de captura, que es lo
   * que dispara la deteccion de la pose sobre la figura activa.
   */
  async pick(result, card) {
    if (this.busy) return;
    this.busy = true;
    card?.classList.add('is-loading');
    this.tag.textContent = 'descargando…';
    try {
      const file = await this.app.search.toFile(result);
      this.hide();
      await this.app.actions.handleDroppedFile(file);
    } catch (err) {
      console.error('[Buscador]', err);
      toast('No se pudo usar esa imagen: ' + errorText(err), 'err');
    } finally {
      card?.classList.remove('is-loading');
      this.tag.textContent = '';
      this.busy = false;
    }
  }

  /* ── Pintado ──────────────────────────────────────────────────────────── */

  /** Estado inicial: unas cuantas busquedas de ejemplo. */
  #renderIdle() {
    this.body.replaceChildren(
      el('div', { class: 'imgsearch-note' }, [
        icon('info', 13),
        el('span', { text: 'Escribe la pose que necesitas y pulsa Intro. Al elegir una imagen, la figura activa copia su postura.' }),
      ]),
      el('div', { class: 'imgsearch-chips' }, SUGERENCIAS.map((s) =>
        el('button', { class: 'imgsearch-chip', type: 'button', onClick: () => this.run(s) }, [
          icon('person-standing', 12), el('span', { text: s }),
        ]))),
    );
  }

  #renderMessage(text, iconName) {
    this.body.replaceChildren(el('div', { class: 'imgsearch-message' }, [icon(iconName, 26), el('p', { text })]));
  }

  /** Rejilla de miniaturas. `hayMas` anade el boton de la pagina siguiente. */
  #renderResults(hayMas) {
    const grid = el('div', { class: 'imgsearch-grid' }, this.results.map((r) => this.#card(r)));
    const hijos = [grid];
    // `replaceChildren` no descarta los nulos como hace `el()`: colar uno pinta
    // un nodo de texto con la palabra «null» debajo de la rejilla.
    if (hayMas) {
      hijos.push(el('div', { class: 'imgsearch-more' }, [
        el('button', { class: 'btn', type: 'button', onClick: () => this.run(this.query, { append: true }) }, [
          icon('plus', 14), el('span', { text: 'Cargar mas' }),
        ]),
      ]));
    }
    this.body.replaceChildren(...hijos);
  }

  /** Una miniatura: la imagen, el dominio de origen y el tamano real. */
  #card(r) {
    const img = el('img', { src: r.thumb, alt: r.title || 'resultado', loading: 'lazy', referrerpolicy: 'no-referrer' });
    const medida = r.w && r.h ? `${r.w}×${r.h}` : '';
    const card = el('button', {
      class: 'imgsearch-card', type: 'button',
      title: [r.title, r.host, medida].filter(Boolean).join(' · '),
    }, [
      img,
      el('span', { class: 'imgsearch-meta' }, [
        el('b', { text: r.host || 'web' }),
        medida ? el('i', { text: medida }) : null,
      ]),
    ]);
    // Una miniatura rota deja la tarjeta inservible: mejor retirarla.
    img.addEventListener('error', () => card.remove());
    card.addEventListener('click', () => this.pick(r, card));
    return card;
  }
}
