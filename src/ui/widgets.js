/**
 * POSU · Fabrica de controles de interfaz
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
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
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
 * Grupo plegable con cabecera, al estilo de las secciones de VS Code.
 * @param {{id:string,title:string,icon?:string,open?:boolean}} opts
 */
export function group(opts, children = []) {
  const isClosed = collapsed.has(opts.id) || (opts.open === false && !collapsed.has('!' + opts.id));
  const chev = el('span', { class: 'chev' }, icon('chevron-down', 14));
  const head = el('button', { class: 'group-head', type: 'button', title: opts.title }, [
    chev,
    opts.icon ? el('span', { class: 'group-icon' }, icon(opts.icon, 14)) : null,
    el('span', { text: opts.title }),
  ]);
  const body = el('div', { class: 'group-body' }, children);
  const root = el('section', { class: 'group' + (isClosed ? ' is-collapsed' : '') }, [head, body]);
  head.addEventListener('click', () => {
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

/** Envoltorio etiqueta + valor + control. */
export function field(labelText, control, { hint, value } = {}) {
  const valueTag = value ? el('span', { class: 'value', text: value }) : null;
  return el('div', { class: 'field' }, [
    labelText ? el('div', { class: 'field-label' }, [el('span', { text: labelText }), valueTag]) : null,
    control,
    hint ? el('div', { class: 'field-hint', text: hint }) : null,
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
  return el('div', { class: 'field' }, [
    el('div', { class: 'field-label' }, [el('span', { text: o.label }), valueTag]),
    input,
    o.hint ? el('div', { class: 'field-hint', text: o.hint }) : null,
  ]);
}

/** Interruptor booleano. */
export function toggle(o) {
  const input = el('input', { type: 'checkbox', checked: Boolean(store.get(o.path)) });
  input.addEventListener('change', () => store.set(o.path, input.checked));
  store.on(o.path, (v) => {
    input.checked = Boolean(v);
  });
  const label = el('label', { class: 'switch' }, [
    input,
    el('span', { class: 'switch-track' }),
    el('span', { class: 'switch-text', text: o.label }),
  ]);
  if (!o.hint) return label;
  return el('div', { class: 'field' }, [label, el('div', { class: 'field-hint', text: o.hint })]);
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
      const typed = typeof store.get(o.path) === 'number' ? Number(b.dataset.value) : b.dataset.value;
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

/** Fila o rejilla de botones de accion. */
export function buttons(list, { cols = 0, compact = false } = {}) {
  const nodes = list.filter(Boolean).map((b) => {
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
