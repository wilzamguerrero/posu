/**
 * ATOM · Buscador de imagenes de referencia
 * ---------------------------------------------------------------------------
 * Paleta flotante sobre el visor: se escribe que pose se busca, salen las
 * miniaturas y al pulsar una entra en el monitor de captura como imagen fija,
 * de donde el detector saca la pose y la pasa a la figura activa. Es el mismo
 * camino que soltar un archivo en la ventana, sin salir de la aplicacion.
 *
 * La rejilla mezcla los ocho sitios que consulta el servidor. Encima queda una
 * fila con los que han contestado y cuanto ha puesto cada uno, que filtra lo ya
 * cargado sin volver a la red.
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
    /** Si la ultima pagina venia llena, y por tanto hay mas que pedir. */
    this.hayMas = false;
    /** Sitio por el que esta filtrada la rejilla; vacio es «todos». */
    this.filtro = '';
    /** Nombre presentable de cada sitio que ha contestado. */
    this.etiquetas = new Map();
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
      this.filtro = '';
      this.etiquetas.clear();
      this.#renderMessage('Buscando…', 'search');
    }
    this.tag.textContent = 'buscando…';
    this.tag.title = '';

    try {
      const res = await this.app.search.search(q, { page: this.page });
      this.results = append ? this.results.concat(res.results) : res.results;
      for (const f of res.fuentes ?? []) this.etiquetas.set(f.id, f.label);
      this.hayMas = res.results.length >= 12;
      this.#renderTag(res);
      if (!this.results.length) {
        this.#renderMessage(`Sin resultados para «${q}».`, 'image');
      } else {
        this.#renderResults();
      }
    } catch (err) {
      console.error('[Buscador]', err);
      this.tag.textContent = '';
      this.#renderMessage('No se pudo buscar: ' + errorText(err), 'triangle-alert');
    } finally {
      this.busy = false;
    }
  }

  /** Cuantas imagenes hay cargadas y de cuantos sitios vienen. */
  #renderTag(res) {
    const total = this.results.length;
    const fuentes = this.#fuentes();
    if (!total) {
      this.tag.textContent = res.label ? res.label.toLowerCase() : '';
      this.tag.title = '';
      return;
    }
    this.tag.textContent = fuentes.length > 1
      ? `${total} · ${fuentes.length} fuentes`
      : `${total} · ${(this.etiquetas.get(fuentes[0]?.id) ?? res.label ?? '').toLowerCase()}`;
    this.tag.title = fuentes.map((f) => `${this.etiquetas.get(f.id) ?? f.id}: ${f.count}`).join('\n');
  }

  /** Recuento por sitio de todo lo cargado, en el orden en que llego. */
  #fuentes() {
    const cuenta = new Map();
    for (const r of this.results) {
      const id = r.source || 'web';
      cuenta.set(id, (cuenta.get(id) ?? 0) + 1);
    }
    return [...cuenta].map(([id, count]) => ({ id, count }));
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

  /** Rejilla de miniaturas, con la fila de sitios si hay mas de uno. */
  #renderResults() {
    const fuentes = this.#fuentes();
    const visibles = this.filtro ? this.results.filter((r) => r.source === this.filtro) : this.results;
    const grid = el('div', { class: 'imgsearch-grid' }, visibles.map((r) => this.#card(r)));
    // `replaceChildren` no descarta los nulos como hace `el()`: colar uno pinta
    // un nodo de texto con la palabra «null» debajo de la rejilla.
    const hijos = [];
    if (fuentes.length > 1) hijos.push(this.#chipsFuente(fuentes));
    hijos.push(grid);
    if (this.hayMas) {
      hijos.push(el('div', { class: 'imgsearch-more' }, [
        el('button', { class: 'btn', type: 'button', onClick: () => this.run(this.query, { append: true }) }, [
          icon('plus', 14), el('span', { text: 'Cargar mas' }),
        ]),
      ]));
    }
    this.body.replaceChildren(...hijos);
  }

  /**
   * Fila de sitios que han contestado. Filtra lo que ya esta cargado, sin volver
   * a la red: con ocho fuentes en la misma rejilla conviene poder quedarse solo
   * con las fotografias de un buscador o solo con las laminas de un museo.
   */
  #chipsFuente(fuentes) {
    const chip = (id, texto, cuantas) => el('button', {
      class: 'imgsearch-chip' + (this.filtro === id ? ' is-on' : ''),
      type: 'button', 'aria-pressed': this.filtro === id ? 'true' : 'false',
      onClick: () => { this.filtro = id; this.#renderResults(); },
    }, [
      icon(id ? 'image' : 'layers', 12),
      el('span', { text: texto }),
      el('small', { text: String(cuantas) }),
    ]);
    return el('div', { class: 'imgsearch-chips imgsearch-fuentes' }, [
      chip('', 'Todas', this.results.length),
      ...fuentes.map((f) => chip(f.id, this.etiquetas.get(f.id) ?? f.id, f.count)),
    ]);
  }

  /** Una miniatura: la imagen, el dominio de origen y el tamano real. */
  #card(r) {
    const img = el('img', {
      src: this.app.search.thumbUrl?.(r) ?? r.thumb,
      alt: r.title || 'resultado', loading: 'lazy', referrerpolicy: 'no-referrer',
    });
    const medida = r.w && r.h ? `${r.w}×${r.h}` : '';
    const card = el('button', {
      class: 'imgsearch-card', type: 'button',
      title: [r.title, this.etiquetas.get(r.source), r.host, medida].filter(Boolean).join(' · '),
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
