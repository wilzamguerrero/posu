/**
 * ATOM · Fabrica de controles de interfaz
 * ---------------------------------------------------------------------------
 * Cada control se declara con la ruta del ajuste al que pertenece y se encarga
 * solo de dos cosas: escribir en el almacen cuando el usuario interactua y
 * refrescarse cuando el almacen cambia desde otro sitio (un preajuste, un
 * atajo de teclado, "restablecer"). Ningun control guarda estado propio.
 */
import { icon } from './icons.js';

/** Hyperscript minimo. */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    // Las propiedades personalizadas (--cols, --fill) no entran por asignacion
    // directa: `style['--cols'] = 2` lo ignora el navegador sin avisar, y la
    // rejilla se quedaba siempre en las tres columnas de reserva, que es lo que
    // desbordaba los botones largos fuera del panel.
    else if (k === 'style' && typeof v === 'object') {
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith('--')) node.style.setProperty(prop, String(val));
        else node.style[prop] = val;
      }
    }
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k in node && k !== 'list') node[k] = v;
    else node.setAttribute(k, String(v));
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** El almacen activo. Se inyecta una vez desde main.js. */
let store = null;
export function useStore(settings) {
  store = settings;
}

/* -- Ayuda emergente --------------------------------------------------- */

/**
 * La explicacion larga de un control no vive en el panel: vive detras de un boton
 * con un signo de pregunta que la abre en un globo. No se ha recortado nada de lo
 * que se contaba antes —los paneles de este programa explican cosas de dibujo que
 * no se adivinan del nombre del ajuste—, pero deja de ocupar sitio mientras no se
 * pide, que era lo que volvia los paneles ilegibles.
 *
 * Hay un solo globo para toda la aplicacion: abrirlo en un sitio cierra el de
 * antes, asi que nunca se solapan dos ni queda ninguno olvidado por ahi.
 */
let pop = null;
let popOwner = null;

/** El globo, que se monta la primera vez que alguien pide ayuda. */
function popNode() {
  if (pop) return pop;
  pop = el('div', { class: 'help-pop hidden', role: 'dialog', 'aria-label': 'Ayuda' });
  // Un clic dentro no cuenta como clic fuera: el texto se puede seleccionar.
  pop.addEventListener('pointerdown', (ev) => ev.stopPropagation());
  document.body.append(pop);
  document.addEventListener('pointerdown', closeHelp);
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeHelp(); });
  window.addEventListener('resize', closeHelp);
  // El panel lateral se desplaza y el globo se quedaria a la deriva, colgado de
  // un control que ya no esta debajo: mas vale cerrarlo.
  window.addEventListener('scroll', closeHelp, true);
  return pop;
}

/** Cierra el globo, si hay alguno abierto. */
export function closeHelp() {
  if (!popOwner) return;
  popNode().classList.add('hidden');
  popOwner.setAttribute('aria-expanded', 'false');
  popOwner.classList.remove('is-active');
  popOwner = null;
}

/** Pega el globo a su boton, debajo si cabe y encima si no, sin salir de la ventana. */
function placeHelp(node, btn) {
  const r = btn.getBoundingClientRect();
  const w = window.innerWidth || 1280;
  const h = window.innerHeight || 800;
  const caja = node.getBoundingClientRect();
  const ancho = caja.width || 300;
  const alto = caja.height || 140;
  const left = Math.max(8, Math.min(w - ancho - 8, r.left + r.width / 2 - ancho / 2));
  const abajo = r.bottom + 8;
  const top = abajo + alto <= h - 8 ? abajo : Math.max(8, r.top - alto - 8);
  node.style.left = Math.round(left) + 'px';
  node.style.top = Math.round(top) + 'px';
}

/** Abre la ayuda de un boton. Volver a pulsarlo la cierra. */
function openHelp(btn, titulo, contenido) {
  const node = popNode();
  const antes = popOwner;
  closeHelp();
  if (antes === btn) return;
  node.replaceChildren(
    el('div', { class: 'help-pop-head' }, [
      el('span', { text: titulo || 'Que es esto' }),
      el('button', {
        class: 'icon-btn tiny', type: 'button', title: 'Cerrar (Esc)',
        onClick: closeHelp,
      }, icon('x', 13)),
    ]),
    typeof contenido === 'string'
      ? el('div', { class: 'help-pop-body', html: contenido })
      : el('div', { class: 'help-pop-body' }, contenido),
  );
  node.classList.remove('hidden');
  popOwner = btn;
  btn.setAttribute('aria-expanded', 'true');
  btn.classList.add('is-active');
  placeHelp(node, btn);
}

/**
 * Boton de ayuda de un control o de un grupo. Devuelve `null` cuando no hay nada
 * que contar, para poder colocarlo sin condicionales en cualquier fila.
 * @param {string|Node} [contenido] texto (admite HTML) o nodo ya montado
 * @param {string} [titulo] nombre del control, que encabeza el globo
 */
export function helpButton(contenido, titulo) {
  if (!contenido) return null;
  const btn = el('button', {
    class: 'help-btn', type: 'button', title: 'Que es esto',
    'aria-label': 'Ayuda de ' + (titulo || 'este control'),
    'aria-expanded': 'false',
  }, icon('circle-question-mark', 13));
  // El pointerdown del documento cierra el globo: si el de aqui no se detiene,
  // el click posterior lo volveria a abrir y el boton no cerraria nunca.
  btn.addEventListener('pointerdown', (ev) => ev.stopPropagation());
  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openHelp(btn, titulo, contenido);
  });
  return btn;
}

/* -- Contenedores ------------------------------------------------------ */

const COLLAPSE_KEY = 'posu.groups.v1';
const collapsed = (() => {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
})();
const persistCollapsed = () => {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed]));
  } catch { /* sin persistencia */ }
};

/**
 * Grupo plegable con cabecera, al estilo de las secciones de VS Code. `help` es la
 * explicacion de para que sirve la seccion entera: sale en el signo de pregunta de
 * la cabecera, no como un parrafo delante de los controles.
 *
 * La cabecera es una fila y no un boton, porque dentro de un boton no se puede
 * meter otro boton: el que pliega es `group-toggle` y la ayuda va a su lado.
 * @param {{id:string,title:string,icon?:string,open?:boolean,help?:string|Node}} opts
 */
export function group(opts, children = []) {
  const isClosed = collapsed.has(opts.id) || (opts.open === false && !collapsed.has('!' + opts.id));
  const chev = el('span', { class: 'chev' }, icon('chevron-down', 14));
  const toggler = el('button', { class: 'group-toggle', type: 'button', title: opts.title }, [
    chev,
    opts.icon ? el('span', { class: 'group-icon' }, icon(opts.icon, 14)) : null,
    el('span', { text: opts.title }),
  ]);
  const head = el('div', { class: 'group-head' }, [toggler, helpButton(opts.help, opts.title)]);
  const body = el('div', { class: 'group-body' }, children);
  const root = el('section', { class: 'group' + (isClosed ? ' is-collapsed' : '') }, [head, body]);
  toggler.addEventListener('click', () => {
    const nowClosed = root.classList.toggle('is-collapsed');
    if (nowClosed) collapsed.add(opts.id);
    else {
      collapsed.delete(opts.id);
      collapsed.add('!' + opts.id);
    }
    persistCollapsed();
  });
  return root;
}

/**
 * Envoltorio etiqueta + valor + control. El `hint` no se escribe debajo: se
 * cuelga del signo de pregunta que va pegado a la etiqueta.
 */
export function field(labelText, control, { hint, value } = {}) {
  const valueTag = value ? el('span', { class: 'value', text: value }) : null;
  const ayuda = helpButton(hint, labelText);
  return el('div', { class: 'field' }, [
    labelText || ayuda
      ? el('div', { class: 'field-label' }, [
        el('span', { class: 'label-text' }, [labelText ? el('span', { text: labelText }) : null, ayuda]),
        valueTag,
      ])
      : null,
    control,
  ]);
}

/* -- Controles enlazados al almacen ------------------------------------ */

const fmtDefault = (v, step) =>
  step >= 1 ? String(Math.round(v)) : v.toFixed(step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3);

/**
 * Deslizador numerico. Doble clic restablece el valor por defecto.
 * @param {{label:string,path:string,min:number,max:number,step?:number,
 *          unit?:string,format?:(v:number)=>string,hint?:string}} o
 */
export function slider(o) {
  const step = o.step ?? 0.01;
  const format = o.format ?? ((v) => fmtDefault(v, step) + (o.unit ?? ''));
  const input = el('input', { type: 'range', min: o.min, max: o.max, step, title: o.label });
  const valueTag = el('span', { class: 'value' });
  const paint = (v) => {
    input.value = String(v);
    input.style.setProperty('--fill', ((v - o.min) / (o.max - o.min)) * 100 + '%');
    valueTag.textContent = format(Number(v));
  };
  input.addEventListener('input', () => {
    const v = Number(input.value);
    store.set(o.path, v);
    paint(v);
  });
  input.addEventListener('dblclick', () => {
    const d = o.path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), store.defaults);
    if (typeof d === 'number') {
      store.set(o.path, d);
      paint(d);
    }
  });
  store.on(o.path, paint);
  paint(store.get(o.path));
  const ayuda = helpButton(o.hint, o.label);
  return el('div', { class: 'field' }, [
    el('div', { class: 'field-label' }, [
      el('span', { class: 'label-text' }, [el('span', { text: o.label }), ayuda]),
      valueTag,
    ]),
    input,
  ]);
}

/** Interruptor booleano. */
export function toggle(o) {
  const input = el('input', { type: 'checkbox', checked: Boolean(store.get(o.path)) });
  input.addEventListener('change', () => store.set(o.path, input.checked));
  store.on(o.path, (v) => {
    input.checked = Boolean(v);
  });
  const ayuda = helpButton(o.hint, o.label);
  const label = el('label', { class: 'switch' }, [
    input,
    el('span', { class: 'switch-track' }),
    el('span', { class: 'switch-text', text: o.label }),
  ]);
  if (!ayuda) return label;
  return el('div', { class: 'field' }, [
    el('div', { class: 'field-row' }, [label, ayuda]),
  ]);
}

/** Grupo de botones exclusivos (radio con aspecto de pestanas). */
export function segmented(o) {
  const nodes = o.options.map((opt) =>
    el('button', { type: 'button', title: opt.title ?? opt.label, dataset: { value: String(opt.value) } }, [
      opt.icon ? icon(opt.icon, 14) : null,
      opt.label ? el('span', { text: opt.label }) : null,
    ]),
  );
  const bar = el('div', { class: 'segmented' + (o.compact ? ' compact' : '') }, nodes);
  const paint = (v) => nodes.forEach((b) => b.classList.toggle('is-active', b.dataset.value === String(v)));
  nodes.forEach((b) =>
    b.addEventListener('click', () => {
      // El valor se escribe con el tipo que ya tenia el ajuste: un numero como
      // numero y un interruptor como booleano, no como las cadenas "true"/"false".
      const actual = store.get(o.path);
      const crudo = b.dataset.value;
      const typed = typeof actual === 'number' ? Number(crudo)
        : typeof actual === 'boolean' ? crudo === 'true'
          : crudo;
      store.set(o.path, typed);
      paint(typed);
      o.onPick?.(typed);
    }),
  );
  store.on(o.path, paint);
  paint(store.get(o.path));
  return o.label ? field(o.label, bar, { hint: o.hint }) : bar;
}

/** Lista desplegable. Devuelve {root, element} para poder repoblarla. */
export function select(o) {
  const sel = el('select', { title: o.label });
  const fill = (options) => {
    const current = String(store.get(o.path));
    sel.replaceChildren(
      ...options.map((opt) =>
        el('option', { value: String(opt.value), text: opt.label, selected: String(opt.value) === current }),
      ),
    );
  };
  fill(o.options);
  sel.addEventListener('change', () => {
    const typed = typeof store.get(o.path) === 'number' ? Number(sel.value) : sel.value;
    store.set(o.path, typed);
    o.onPick?.(typed);
  });
  store.on(o.path, (v) => {
    sel.value = String(v);
  });
  return { root: o.label ? field(o.label, sel, { hint: o.hint }) : sel, element: sel, setOptions: fill };
}

/** Selector de color. */
export function color(o) {
  const input = el('input', { type: 'color', value: store.get(o.path), title: o.label });
  input.addEventListener('input', () => store.set(o.path, input.value));
  store.on(o.path, (v) => {
    input.value = v;
  });
  return el('div', { class: 'field' }, [
    el('div', { class: 'field-row' }, [input, el('span', { class: 'switch-text', text: o.label })]),
  ]);
}

/** Tres deslizadores X/Y/Z sobre rutas hermanas. */
export function vector3(o) {
  return el('div', { class: 'field' }, [
    el('div', { class: 'field-label' }, [el('span', { text: o.label })]),
    ...['x', 'y', 'z'].map((axis) =>
      slider({
        label: axis.toUpperCase(),
        path: o.path + '.' + axis,
        min: o.min, max: o.max, step: o.step ?? 0.1, unit: o.unit,
      }),
    ),
  ]);
}

/* -- Controles sin estado ---------------------------------------------- */

/**
 * Fila o rejilla de botones. Un elemento con `path` sale como interruptor
 * marcado (ver `toggleButton`), para poder mezclar acciones y conmutadores en la
 * misma fila.
 */
export function buttons(list, { cols = 0, compact = false } = {}) {
  const nodes = list.filter(Boolean).map((b) => {
    if (b.path) {
      const t = toggleButton(b);
      b.ref?.(t);
      return t;
    }
    const node = el(
      'button',
      {
        class: 'btn' + (b.variant ? ' ' + b.variant : ''),
        type: 'button',
        title: b.title ?? b.label,
        onClick: b.onClick,
      },
      [b.icon ? icon(b.icon, compact ? 13 : 14) : null, b.label ? el('span', { text: b.label }) : null],
    );
    b.ref?.(node);
    return node;
  });
  if (cols) return el('div', { class: 'btn-grid', style: { '--cols': String(cols) } }, nodes);
  return el('div', { class: 'field-row' }, nodes);
}

/**
 * Boton de accion que refleja (y alterna) un interruptor del almacen. Es el
 * mismo aspecto que `buttons`, para poder ponerlo en la misma fila que Duplicar
 * o Eliminar, pero se queda marcado mientras el ajuste este encendido.
 * @param {{path:string,label:string,icon?:string,title?:string}} o
 */
export function toggleButton(o) {
  const node = el('button', { class: 'btn', type: 'button', title: o.title ?? o.label }, [
    o.icon ? icon(o.icon, 13) : null,
    el('span', { text: o.label }),
  ]);
  const paint = (v) => node.classList.toggle('is-active', v === true);
  node.addEventListener('click', () => store.set(o.path, store.get(o.path) !== true));
  store.on(o.path, paint);
  paint(store.get(o.path));
  return node;
}

/**
 * Texto que se refresca con el visor (medidas vivas, contadores). Se actualiza a
 * 5 Hz: mas a menudo obligaria al navegador a recalcular la maqueta del panel en
 * cada fotograma sin que se note la diferencia.
 * @param {object} app
 * @param {() => string} read
 */
export function liveValue(app, read) {
  const node = el('span', { class: 'value', text: read() ?? '—' });
  let last = 0;
  app.viewport?.onFrame?.(() => {
    const now = performance.now();
    if (now - last < 200) return;
    last = now;
    const texto = read() ?? '—';
    if (node.textContent !== texto) node.textContent = texto;
  });
  return node;
}

/** Aviso informativo en linea. */
export function notice(kind, content, iconName = 'info') {
  return el('div', { class: 'notice ' + kind }, [
    icon(iconName, 14),
    typeof content === 'string' ? el('div', { html: content }) : content,
  ]);
}

/** Barra de medida normalizada (0..1). */
export function meter() {
  const bar = el('i');
  const root = el('div', { class: 'meter' }, bar);
  root.setValue = (v) => {
    bar.style.width = Math.max(0, Math.min(1, v)) * 100 + '%';
    root.classList.toggle('low', v < 0.34);
    root.classList.toggle('mid', v >= 0.34 && v < 0.7);
  };
  return root;
}

/** Lista seleccionable con accion de borrado opcional. */
export function listView({ empty = 'Sin elementos', onSelect, onDelete } = {}) {
  const root = el('div', { class: 'list' });
  root.render = (items, activeId) => {
    if (!items.length) {
      root.replaceChildren(el('div', { class: 'list-empty', text: empty }));
      return;
    }
    root.replaceChildren(
      ...items.map((item) =>
        el('div', { class: 'list-row' + (item.id === activeId ? ' is-active' : ''), onClick: () => onSelect?.(item) }, [
          item.icon ? icon(item.icon, 13) : null,
          el('span', { class: 'name', text: item.label, title: item.label }),
          item.meta ? el('span', { class: 'meta', text: item.meta }) : null,
          onDelete
            ? el('button', {
                class: 'icon-btn tiny', type: 'button', title: 'Eliminar',
                onClick: (ev) => { ev.stopPropagation(); onDelete(item); },
              }, icon('trash-2', 12))
            : null,
        ]),
      ),
    );
  };
  return root;
}

/** Atenua y desactiva un nodo mientras la condicion no se cumpla. */
export function enableWhen(node, paths, test) {
  const apply = () => node.classList.toggle('is-disabled', !test(store));
  [].concat(paths).forEach((p) => store.on(p, apply));
  apply();
  return node;
}

/**
 * Rejilla de preajustes (materiales, primitivas, tipos de luz). A diferencia de
 * `segmented`, admite muchas opciones sin comprimirlas: se envuelven en filas.
 */
export function presetGrid(o) {
  const nodes = o.options.map((opt) =>
    el('button', {
      class: 'tile', type: 'button', title: opt.title ?? opt.label,
      dataset: { value: String(opt.value) },
      onClick: () => {
        if (o.path) store.set(o.path, opt.value);
        o.onPick?.(opt.value);
        if (!o.path) return;
        paint(opt.value);
      },
    }, [
      opt.icon ? icon(opt.icon, 15) : null,
      el('span', { text: opt.label }),
    ]),
  );
  const grid = el('div', { class: 'tiles', style: { '--cols': String(o.cols ?? 3) } }, nodes);
  const paint = (v) => nodes.forEach((b) => b.classList.toggle('is-active', b.dataset.value === String(v)));
  if (o.path) {
    store.on(o.path, paint);
    paint(store.get(o.path));
  }
  return o.label ? field(o.label, grid, { hint: o.hint }) : grid;
}

/**
 * Contenedor que se reconstruye cuando cambian las rutas indicadas. Se usa
 * cuando los controles dependen de *que* elemento esta seleccionado (la ranura
 * de material, el objeto de la escena, la luz elegida).
 */
export function reactive(paths, build) {
  const root = el('div', { class: 'reactive' });
  const render = () => {
    const kids = [].concat(build() ?? []).filter(Boolean);
    root.replaceChildren(...kids);
  };
  [].concat(paths).forEach((p) => store.on(p, render));
  render();
  root.refresh = render;
  return root;
}
