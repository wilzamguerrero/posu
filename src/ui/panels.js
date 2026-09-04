/**
 * ATOM · Paneles del panel lateral
 * ---------------------------------------------------------------------------
 * Cada seccion se construye una sola vez y se enlaza al almacen de ajustes: los
 * controles no guardan estado, solo leen y escriben rutas. Las acciones que
 * necesitan tocar varios modulos (cargar un modelo, arrancar la camara, guardar
 * una pose) llegan por el objeto `app.actions`, que arma main.js.
 */

import {
  el, group, field, slider, toggle, segmented, select, color, vector3, buttons, notice, meter, listView, enableWhen,
  presetGrid, reactive, liveValue,
} from './widgets.js';
import { icon } from './icons.js';
import { humanBytes } from '../model/FbxToGlb.js';
import {
  FOCAL_PRESETS, VIEW_PRESETS, LIGHT_PRESETS, FOCUS_TARGETS, POSE_MODELS, MODEL_LIBRARY,
  APP_VERSION, APP_AUTHOR,
} from '../config.js';
import {
  MATERIAL_PRESETS, MATERIAL_BY_ID, MATERIAL_RANGE, materialSupports, materialDefaults,
} from '../model/MaterialLibrary.js';
import { PRIMITIVES, PARAM_RANGE } from '../scene/primitives.js';
import { PERSPECTIVE_MODES, PERSPECTIVE_BY_ID } from '../guides/Perspective.js';
import { LIGHT_TYPES, LIGHT_BY_ID, LIGHT_RANGE } from '../scene/lights.js';
import { HAND_PRESETS } from '../model/HandRig.js';
import { MAX_FIGURAS } from '../model/FigureSet.js';
import { FINGERS, FINGER_LABELS } from '../model/boneMap.js';
import { IK_CHAINS } from '../posing/IKRig.js';

/** Abre el selector de archivos del sistema y resuelve con el archivo elegido. */
export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept, style: { display: 'none' } });
    input.addEventListener('change', () => {
      resolve(input.files?.[0] ?? null);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/* ── 1 · Figura ────────────────────────────────────────────────────────── */

function figurePanel(app) {
  const { settings, actions } = app;

  // Lista de figuras: la activa lleva la marca «posando» y es la que reciben la
  // captura, las poses y el posado manual.
  const listaFiguras = listView({
    empty: 'Sin figuras.',
    onSelect: (item) => actions.setActiveFigure?.(item.id),
    onDelete: (item) => actions.removeFigure?.(item.id),
  });
  const pintarFiguras = () =>
    listaFiguras.render(app.figures?.list?.() ?? [], app.figures?.activeId ?? '');
  // main.js lo llama cuando cambia la figura activa o acaba de cargar una.
  app.hooks.refreshFigures = pintarFiguras;
  settings.on(['scene.figures', 'figure.active'], pintarFiguras);
  pintarFiguras();

  return [
    group({ id: 'fig-lista', title: 'Figuras en la escena', icon: 'user' }, [
      listaFiguras,
      buttons([
        { label: 'Anadir', icon: 'plus', title: `Nueva figura (hasta ${MAX_FIGURAS})`,
          onClick: () => actions.addFigure?.() },
        { label: 'Duplicar', icon: 'copy', title: 'Copia la figura activa con su pose',
          onClick: () => actions.duplicateFigure?.() },
        { label: 'Eliminar', icon: 'trash-2', title: 'Quita la figura activa',
          onClick: () => actions.removeFigure?.() },
      ], { cols: 3, compact: true }),
      notice('info', 'La figura marcada <b>posando</b> es la que recibe la captura por camara, las poses y el posado manual. Pinchar un solido o una luz no la cambia.'),
    ]),
    group({ id: 'fig-variant', title: 'Malla visible', icon: 'layers' }, [
      segmented({
        path: 'figure.variant',
        options: [
          { value: 'anatomia', label: 'Anatomia', icon: 'person-standing', title: 'Musculatura y piel' },
          { value: 'maniqui', label: 'Maniqui', icon: 'box', title: 'Volumenes de madera' },
          { value: 'esqueleto', label: 'Esqueleto', icon: 'bone', title: 'Estructura osea' },
        ],
        hint: 'Las tres mallas comparten el mismo esqueleto: la pose no se pierde al cambiar. El aspecto es comun a todas las figuras de la escena.',
      }),
      select({
        label: 'Sombreado', path: 'figure.shading',
        options: [
          { value: 'textura', label: 'Textura del modelo' },
          { value: 'arcilla', label: 'Arcilla mate' },
          { value: 'toon', label: 'Toon (bandas)' },
          { value: 'wireframe', label: 'Malla de alambre' },
          { value: 'rayosx', label: 'Rayos X' },
        ],
      }).root,
      slider({ label: 'Opacidad', path: 'figure.opacity', min: 0.05, max: 1, step: 0.01,
        hint: 'Baja la opacidad para ver el esqueleto interno bajo la musculatura.' }),
      toggle({ path: 'figure.showGhost', label: 'Silueta de piel superpuesta' }),
      slider({ label: 'Opacidad de la silueta', path: 'figure.ghostOpacity', min: 0.02, max: 0.6, step: 0.01 }),
      toggle({ path: 'figure.showSkeletonHelper', label: 'Mostrar huesos (helper)' }),
    ]),
    group({ id: 'fig-material', title: 'Materiales', icon: 'palette' }, [
      segmented({
        label: 'Malla a la que se aplica', path: 'materials.slot',
        options: [
          { value: 'anatomia', label: 'Anatomia', icon: 'person-standing' },
          { value: 'maniqui', label: 'Maniqui', icon: 'box' },
          { value: 'esqueleto', label: 'Esqueleto', icon: 'bone' },
          { value: 'objeto', label: 'Solidos', icon: 'shapes' },
        ],
        hint: 'Cada malla guarda su propio material, tambien la anatomia.',
      }),
      reactive(
        ['materials.slot', 'materials.anatomia.preset', 'materials.maniqui.preset',
          'materials.esqueleto.preset', 'materials.objeto.preset'],
        () => materialSlotControls(app),
      ),
      notice('info', 'El <b>sombreado</b> de arriba (arcilla, rayos X…) manda sobre estos materiales mientras este activo.'),
    ]),
    group({ id: 'fig-file', title: 'Modelo', icon: 'folder-open' }, [
      modelLibraryGrid(app),
      buttons([
        { label: 'Cargar .glb / .fbx', icon: 'upload', onClick: () => actions.loadModelFile() },
        { label: 'Restablecer', icon: 'refresh-cw', title: 'Vuelve al modelo incluido', onClick: () => actions.resetModel() },
      ], { cols: 2 }),
      fbxConverter(app),
    ]),
  ];
}

/**
 * Conversor FBX → GLB, en el sitio del aviso que habia aqui. Deja preparado el
 * archivo sin salir de la aplicacion: se elige (o se suelta) un `.fbx`, se
 * descarga el `.glb`, y desde ahi se puede copiar a `public/models` o compartir.
 * El resultado se guarda en memoria para poder probarlo o volver a bajarlo sin
 * repetir la conversion, que en un personaje con texturas no es instantanea.
 */
function fbxConverter(app) {
  const { actions } = app;
  let ultimo = null;
  let trabajando = false;

  const zona = el('div', { class: 'dropbox' }, [
    icon('file-up', 18),
    el('div', { class: 'dropbox-text' }, [
      el('b', { text: 'Convertir FBX a GLB' }),
      el('span', { text: 'Elige un .fbx o sueltalo aqui' }),
    ]),
  ]);
  const barra = meter();
  const estado = el('div', { class: 'field-hint' });
  const resultado = el('div', { class: 'reactive' });

  const paso = (texto, avance = 0) => {
    estado.textContent = texto;
    barra.setValue(avance);
    barra.classList.toggle('hidden', avance <= 0 || avance >= 1);
  };

  const mostrar = (res) => {
    ultimo = res;
    if (!res) { resultado.replaceChildren(); return; }
    const detalle = [
      `${humanBytes(res.sourceBytes)} → ${humanBytes(res.bytes)}`,
      `${res.meshes} malla${res.meshes === 1 ? '' : 's'}`,
      res.bones ? `${res.bones} huesos` : null,
      res.animations ? `${res.animations} animacion${res.animations === 1 ? '' : 'es'}` : null,
      res.textures ? `${res.textures} textura${res.textures === 1 ? '' : 's'}` : 'sin texturas',
      res.scale !== 1 ? 'escala cm → m' : null,
    ].filter(Boolean).join(' · ');
    resultado.replaceChildren(
      notice('ok', `<b>${res.name}</b><br>${detalle}`, 'circle-check'),
      buttons([
        { label: 'Descargar otra vez', icon: 'download', onClick: () => actions.saveConverted?.(ultimo) },
        { label: 'Probar en la figura', icon: 'person-standing',
          title: 'Carga el resultado en la figura activa sin volver a convertir',
          onClick: () => actions.loadConverted?.(ultimo) },
      ], { cols: 2, compact: true }),
    );
  };

  const convertir = async (file) => {
    if (!file || trabajando) return;
    trabajando = true;
    zona.classList.add('is-busy');
    mostrar(null);
    paso('Preparando…', 0.02);
    const res = await actions.convertFbx?.(file, paso);
    trabajando = false;
    zona.classList.remove('is-busy');
    paso(res ? 'Listo, descargado.' : 'No se pudo convertir ese archivo.', 0);
    mostrar(res);
  };

  zona.addEventListener('click', async () => {
    if (trabajando) return;
    convertir(await pickFile('.fbx'));
  });
  zona.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    ev.dataTransfer.dropEffect = 'copy';
    zona.classList.add('is-over');
  });
  zona.addEventListener('dragleave', () => zona.classList.remove('is-over'));
  zona.addEventListener('drop', (ev) => {
    // Sin `stopPropagation` el archivo llegaria tambien al visor, que lo cargaria
    // en la escena en vez de convertirlo.
    ev.preventDefault();
    ev.stopPropagation();
    zona.classList.remove('is-over');
    convertir(ev.dataTransfer?.files?.[0]);
  });

  return el('div', { class: 'converter' }, [
    zona,
    segmented({
      label: 'Tamano maximo de textura', path: 'convert.maxTexture', compact: true,
      options: [
        { value: 1024, label: '1k' },
        { value: 2048, label: '2k' },
        { value: 4096, label: '4k' },
        { value: 0, label: 'Tal cual' },
      ],
      hint: 'Un FBX de Mixamo trae mapas de 4096 px. Reducirlos a 2k baja el peso del .glb sin que se note en el visor.',
    }),
    toggle({ path: 'convert.jpeg', label: 'Color en JPEG (menos peso)',
      hint: 'Solo el color de los materiales opacos. Los mapas de normales y rugosidad se quedan en PNG.' }),
    barra,
    estado,
    resultado,
    notice('info', 'La lista de arriba es la carpeta <code>public/models</code>: cada figura se llama como su archivo, sin la extension. Copia ahi el <b>.glb</b> y aparece.'),
  ]);
}
/**
 * Rejilla de la biblioteca de figuras. Se reconstruye a mano (no por una ruta
 * del almacen) porque la lista no vive en los ajustes: la rellena
 * `refreshModelLibrary()` leyendo la carpeta `public/models`.
 */
function modelLibraryGrid(app) {
  const node = reactive([], () => (MODEL_LIBRARY.length
    ? presetGrid({
      path: 'figure.model', cols: 2,
      options: MODEL_LIBRARY.map((m) => ({ value: m.id, label: m.label, icon: 'user', title: m.file })),
      onPick: (id) => app.actions.loadLibraryModel(id),
      hint: 'El modelo se carga en la figura activa. Todas comparten el esqueleto de Mixamo: la pose se conserva al cambiar de figura.',
    })
    : notice('warn', 'La carpeta <code>public/models</code> esta vacia. Copia ahi un <b>.glb</b> y la figura aparece aqui sola.', 'triangle-alert')));
  app.hooks ??= {};
  app.hooks.refreshModelGrid = () => node.refresh();
  return node;
}

/**
 * Colocacion (y modelo) de una figura concreta: edita `scene.figures.N`. Lo
 * comparten el panel de Figura, que trabaja siempre sobre la activa, y la lista
 * de escena, que trabaja sobre la seleccionada; son las mismas rutas.
 *
 * Una figura no se escala: su tamano es el deslizador de Altura, que estira el
 * personaje conservando las proporciones del modelo.
 */
function figureControls(app, id, { modelo = false, posar = false } = {}) {
  const store = app.settings;
  const base = app.figures?.pathOf?.(id) ?? '';
  if (!base) return [notice('info', 'No hay ninguna figura seleccionada.')];
  const activa = id === app.figures?.activeId;
  const out = [
    textField(store, base + '.name', 'Nombre'),
    toggle({ path: base + '.visible', label: 'Visible' }),
    vector3({ label: 'Posicion', path: base + '.position', min: -8, max: 8, step: 0.01, unit: ' m' }),
    vector3({ label: 'Rotacion', path: base + '.rotation', min: -180, max: 180, step: 1, unit: '°' }),
    vector3({
      label: 'Escala', path: base + '.scale', min: 0.2, max: 3, step: 0.01,
      hint: 'Deformacion aparte de la altura: achatar o estirar la figura. 1 = sin deformar.',
    }),
    slider({ label: 'Altura', path: base + '.height', min: 1.2, max: 2.2, step: 0.01, unit: ' m',
      hint: 'Se mide con la figura de pie, no con la pose puesta: agacharse no la reescala.' }),
    segmented({
      label: 'Anclaje', path: base + '.anchor',
      options: [
        { value: 'suelo', label: 'Al suelo' },
        { value: 'centro', label: 'Centrado' },
        { value: 'libre', label: 'Libre' },
      ],
      hint: 'Al suelo apoya la pose en y = 0 fotograma a fotograma (una figura en cuclillas '
        + 'sigue tocando el suelo). Centrado deja el volumen en el origen. Libre no toca el archivo.',
    }),
  ];
  if (modelo) {
    // Escribir la ruta basta: `FigureSet` recarga esa figura al verla cambiar.
    out.push(presetGrid({
      label: 'Modelo', path: base + '.model', cols: 2,
      options: MODEL_LIBRARY.map((m) => ({ value: m.id, label: m.label, icon: 'user', title: m.file })),
      hint: 'Se sustituye el modelo de esta figura y se conserva su pose.',
    }));
  }
  if (posar && !activa) {
    out.push(buttons([
      { label: 'Posar con la camara', icon: 'video',
        title: 'Pasa a esta figura la captura, las poses y el posado manual',
        onClick: () => app.actions.setActiveFigure?.(id) },
    ], { cols: 1, compact: true }));
  }
  return out;
}

/**
 * Controles de una sola mano. Se reconstruyen al cambiar `hands.edit` para no
 * duplicar diez deslizadores en pantalla.
 */
function handControls(app) {
  const side = app.settings.get('hands.edit') === 'right' ? 'right' : 'left';
  const base = 'hands.' + side;
  return [
    presetGrid({
      label: 'Gesto', path: base + '.preset', cols: 4,
      options: HAND_PRESETS.map((g) => ({ value: g.id, label: g.label, icon: g.icon })),
      onPick: (id) => app.actions.handPreset?.(id),
      hint: 'Un gesto solo rellena los deslizadores: despues puedes afinar dedo a dedo.',
    }),
    ...FINGERS.map((f) => slider({
      label: FINGER_LABELS[f], path: base + '.' + f, min: 0, max: 1, step: 0.01,
      format: (v) => Math.round(v * 100) + ' %',
    })),
    slider({ label: 'Abanico', path: base + '.spread', min: 0, max: 1, step: 0.01,
      format: (v) => Math.round(v * 100) + ' %',
      hint: 'Separacion entre indice, anular y menique.' }),
    slider({ label: 'Pulgar separado', path: base + '.thumbOut', min: 0, max: 1, step: 0.01,
      format: (v) => Math.round(v * 100) + ' %' }),
  ];
}

/* ── 1b · Materiales compartidos ───────────────────────────────────────── */

const MAT_LABEL = { roughness: 'Rugosidad', metalness: 'Metalico', opacity: 'Opacidad' };
const SLOT_LABEL = {
  anatomia: 'la musculatura', maniqui: 'el maniqui',
  esqueleto: 'el esqueleto', objeto: 'los solidos insertados',
};

/** Prefija valores planos con la ruta base: {color:x} -> {"materials.piel.color":x}. */
function conPrefijo(base, values) {
  const out = {};
  for (const [k, v] of Object.entries(values)) out[base + '.' + k] = v;
  return out;
}

/**
 * Controles de un material. Se reutilizan tal cual para las ranuras de la
 * figura (materials.anatomia…) y para cada solido insertado
 * (scene.objects.N.material), porque ambos guardan el mismo juego de claves.
 * Solo se dibujan las propiedades que el preajuste elegido admite.
 */
function materialControls(store, base, { cols = 3 } = {}) {
  const presetId = store.get(base + '.preset') ?? 'yeso';
  const def = MATERIAL_BY_ID[presetId];
  const out = [
    presetGrid({
      path: base + '.preset',
      cols,
      options: MATERIAL_PRESETS.map((m) => ({
        value: m.id, label: m.label, icon: m.icon, title: m.note ?? m.label,
      })),
      // Al elegir preajuste se siembran sus valores de partida de una sola vez.
      onPick: (id) => store.batch(conPrefijo(base, materialDefaults(id))),
    }),
  ];
  if (def?.note) out.push(el('div', { class: 'field-hint', text: def.note }));
  if (materialSupports(presetId, 'color')) out.push(color({ path: base + '.color', label: 'Color' }));
  for (const prop of ['roughness', 'metalness', 'opacity']) {
    if (!materialSupports(presetId, prop)) continue;
    const r = MATERIAL_RANGE[prop];
    out.push(slider({ label: MAT_LABEL[prop], path: base + '.' + prop, min: r.min, max: r.max, step: r.step }));
  }
  if (materialSupports(presetId, 'flat')) {
    out.push(toggle({ path: base + '.flat', label: 'Facetado (sin suavizar normales)' }));
  }
  return out;
}

/** Cuerpo reactivo del grupo "Materiales": depende de la ranura seleccionada. */
function materialSlotControls(app) {
  const store = app.settings;
  const slot = store.get('materials.slot') ?? 'anatomia';
  return [
    el('div', { class: 'field-hint', text: 'Editando el material de ' + (SLOT_LABEL[slot] ?? slot) + '.' }),
    ...materialControls(store, 'materials.' + slot),
  ];
}

/* ── 1c · Escena: figuras, solidos y luces ─────────────────────────────── */

const LIGHT_LABEL = {
  intensity: 'Intensidad', distance: 'Alcance', decay: 'Caida',
  angle: 'Apertura (medio cono)', penumbra: 'Penumbra',
  width: 'Ancho del panel', height: 'Alto del panel', radius: 'Difuminado de la sombra',
};
const PARAM_LABEL = {
  ancho: 'Ancho', alto: 'Alto', fondo: 'Fondo', radio: 'Radio',
  grosor: 'Grosor del tubo', seg: 'Segmentos',
};

/** Campo de texto enlazado a una ruta: se usa para renombrar elementos. */
function textField(store, path, label) {
  const input = el('input', { type: 'text', class: 'text-input', value: String(store.get(path) ?? '') });
  input.spellcheck = false;
  const push = () => store.set(path, input.value.trim() || 'Sin nombre');
  input.addEventListener('change', push);
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') input.blur(); });
  store.on(path, (v) => { if (document.activeElement !== input) input.value = String(v ?? ''); });
  return field(label, input);
}

/**
 * Controles del elemento seleccionado. Se reconstruye cuando cambia la
 * seleccion o la lista, no cuando se arrastra el gizmo: los deslizadores se
 * refrescan solos porque leen del almacen.
 */
function itemControls(app) {
  const store = app.settings;
  const id = store.get('scene.selected');
  const at = app.scene?.locate?.(id);
  if (!at) {
    return [notice('info',
      'Nada seleccionado. Pincha una figura, un solido o una luz en el visor, o eligelo en la lista de arriba.')];
  }
  // Las figuras se editan con los mismos controles que en el panel de Figura,
  // pero aqui sobre la seleccionada, que no tiene que ser la que se posa.
  if (at.branch === 'figures') {
    return [
      ...figureControls(app, id, { modelo: true, posar: true }),
      buttons([
        { label: 'Duplicar', icon: 'copy', title: 'Copia esta figura con su pose',
          onClick: () => app.actions.duplicateFigure?.(id) },
        { label: 'Eliminar', icon: 'trash-2', onClick: () => app.actions.removeFigure?.(id) },
        { path: 'scene.bounds.selected', label: 'Caja', icon: 'scan',
          title: 'Deja puesta la caja envolvente de lo seleccionado' },
      ], { cols: 3, compact: true }),
    ];
  }
  const base = 'scene.' + at.branch + '.' + at.index;
  const def = at.def;
  const esLuz = at.branch === 'lights';
  const out = [
    textField(store, base + '.name', 'Nombre'),
    toggle({ path: base + '.visible', label: esLuz ? 'Luz encendida' : 'Visible' }),
    vector3({ label: 'Posicion', path: base + '.position', min: -8, max: 8, step: 0.01, unit: ' m' }),
  ];

  if (esLuz) {
    const preset = LIGHT_BY_ID[def.type] ?? LIGHT_TYPES[0];
    if (preset.hint) out.push(el('div', { class: 'field-hint', text: preset.hint }));
    out.push(color({ path: base + '.color', label: 'Color de la luz' }));
    for (const campo of preset.fields) {
      if (campo === 'target' || campo === 'shadow') continue;
      if (campo === 'groundColor') {
        out.push(color({ path: base + '.groundColor', label: 'Color del rebote del suelo' }));
        continue;
      }
      const r = LIGHT_RANGE[campo];
      if (!r) continue;
      out.push(slider({
        label: LIGHT_LABEL[campo] ?? titleCase(campo), path: base + '.' + campo,
        min: r.min, max: r.max, step: r.step, unit: r.unit, hint: r.hint,
      }));
    }
    if (preset.fields.includes('target')) {
      out.push(vector3({
        label: 'Objetivo al que apunta', path: base + '.target',
        min: -8, max: 8, step: 0.01, unit: ' m',
      }));
    }
    if (preset.fields.includes('shadow')) {
      out.push(toggle({ path: base + '.shadow', label: 'Proyecta sombras' }));
      out.push(slider({
        label: 'Sesgo de la sombra', path: base + '.bias',
        min: -0.005, max: 0.005, step: 0.0001, format: (v) => v.toFixed(4),
        hint: 'Corrige el rayado o la sombra despegada del punto de contacto.',
      }));
    }
  } else {
    out.push(vector3({ label: 'Rotacion', path: base + '.rotation', min: -180, max: 180, step: 1, unit: '°' }));
    out.push(vector3({ label: 'Escala', path: base + '.scale', min: 0.05, max: 8, step: 0.01 }));
    const claves = Object.keys(def.params ?? {}).filter((k) => PARAM_RANGE[k]);
    if (claves.length) {
      out.push(el('div', { class: 'field-label' }, [el('span', { text: 'Geometria' })]));
      for (const k of claves) {
        const r = PARAM_RANGE[k];
        out.push(slider({
          label: PARAM_LABEL[k] ?? titleCase(k), path: base + '.params.' + k,
          min: r.min, max: r.max, step: r.step, unit: r.unit,
        }));
      }
    }
    out.push(el('div', { class: 'field-label' }, [el('span', { text: 'Material del solido' })]));
    out.push(reactive(base + '.material.preset', () => materialControls(store, base + '.material')));
    out.push(toggle({ path: base + '.castShadow', label: 'Arroja sombra' }));
    out.push(toggle({ path: base + '.receiveShadow', label: 'Recibe sombra' }));
  }

  out.push(buttons([
    { label: 'Duplicar', icon: 'copy', onClick: () => app.actions.duplicateItem?.(id) },
    { label: 'Eliminar', icon: 'trash-2', onClick: () => app.actions.removeItem?.(id) },
    { path: 'scene.bounds.selected', label: 'Caja', icon: 'scan',
      title: 'Deja puesta la caja envolvente de lo seleccionado' },
  ], { cols: 3, compact: true }));
  return out;
}

/** Panel de escena: insertar solidos y luces, manipularlos y listarlos junto a las figuras. */
function scenePanel(app) {
  const { settings, actions } = app;

  const lista = listView({
    empty: 'La escena esta vacia.',
    onSelect: (item) => actions.selectItem?.(item.id),
    onDelete: (item) => actions.removeItem?.(item.id),
  });
  const pintarLista = () => lista.render(app.scene?.list?.() ?? [], settings.get('scene.selected'));
  // main.js llama a este gancho cuando la seleccion cambia desde el visor.
  app.hooks.refreshScene = pintarLista;
  settings.on(['scene.objects', 'scene.lights', 'scene.figures', 'figure.active', 'scene.selected'], pintarLista);
  pintarLista();

  return [
    group({ id: 'esc-solidos', title: 'Insertar solidos', icon: 'shapes' }, [
      presetGrid({
        cols: 3,
        options: PRIMITIVES.map((p) => ({ value: p.id, label: p.label, icon: p.icon })),
        onPick: (id) => actions.addObject?.(id),
        hint: 'Cajas de encaje, planos de apoyo y bodegones. Nacen frente a la camara.',
      }),
    ]),
    group({ id: 'esc-luces', title: 'Insertar luces', icon: 'lamp-desk' }, [
      presetGrid({
        cols: 3,
        options: LIGHT_TYPES.map((l) => ({ value: l.id, label: l.label, icon: l.icon, title: l.hint })),
        onPick: (id) => actions.addLight?.(id),
        hint: 'Se suman al tripode de estudio del panel de Luz. Colocalas con el gizmo.',
      }),
    ]),
    group({ id: 'esc-gizmo', title: 'Manipulador', icon: 'move-3d' }, [
      segmented({
        label: 'Herramienta', path: 'scene.tool',
        options: [
          { value: 'translate', label: 'Mover', icon: 'move' },
          { value: 'rotate', label: 'Girar', icon: 'rotate-3d' },
          { value: 'scale', label: 'Escalar', icon: 'scaling' },
        ],
        hint: 'Atajos: W mover, E girar, R escalar, Supr eliminar, Esc deseleccionar. En una figura, el tamano en metros lo manda el deslizador de Altura y la escala es una deformacion aparte.',
      }),
      segmented({
        label: 'Ejes', path: 'scene.space',
        options: [
          { value: 'world', label: 'Mundo', icon: 'globe' },
          { value: 'local', label: 'Local', icon: 'box' },
        ],
        hint: 'Alt+X alterna entre los ejes del mundo y los del propio objeto. Vale tambien para el giroscopio del posado manual: "Mundo" gira el hueso sobre los ejes de la escena.',
      }),
      select({
        label: 'Imantado', path: 'scene.snap',
        options: [
          { value: 0, label: 'Libre' }, { value: 0.05, label: '5 cm' },
          { value: 0.1, label: '10 cm' }, { value: 0.25, label: '25 cm' },
          { value: 0.5, label: '50 cm' },
        ],
      }).root,
      toggle({ path: 'scene.helpers', label: 'Mostrar cuerpos y ayudantes de luz' }),
    ]),
    group({ id: 'esc-lista', title: 'Elementos de la escena', icon: 'list' }, [
      lista,
      buttons([
        { label: 'Anadir figura', icon: 'plus', title: `Nueva figura (hasta ${MAX_FIGURAS})`,
          onClick: () => actions.addFigure?.() },
        { label: 'Duplicar', icon: 'copy', onClick: () => actions.duplicateItem?.(settings.get('scene.selected')) },
        { label: 'Vaciar escena', icon: 'trash-2', title: 'Quita solidos y luces; las figuras se quedan',
          onClick: () => actions.clearScene?.() },
      ], { cols: 3, compact: true }),
    ]),
    group({ id: 'esc-item', title: 'Elemento seleccionado', icon: 'sliders-horizontal' }, [
      reactive(['scene.selected', 'scene.objects', 'scene.lights', 'scene.figures', 'figure.active'],
        () => itemControls(app)),
    ]),
    group({ id: 'esc-caja', title: 'Caja envolvente', icon: 'scan' }, boundsControls(app)),
  ];
}

/**
 * Caja envolvente: el contorno que avisa de lo que hay bajo el raton y la caja
 * fija del elemento elegido. Se recalculan en cada fotograma, asi que siguen a la
 * pose del personaje; con `live` apagado se mide la figura en reposo, que es el
 * area del modelo sin posar.
 */
function boundsControls(app) {
  const medidas = () => {
    const v = app.scene?.sizeOf?.(app.settings.get('scene.selected'));
    if (!v) return '—';
    return [v.x, v.y, v.z].map((n) => n.toFixed(2)).join(' × ') + ' m';
  };
  return [
    toggle({ path: 'scene.bounds.hover', label: 'Contorno al pasar el raton' }),
    toggle({ path: 'scene.bounds.selected', label: 'Caja del elemento seleccionado' }),
    toggle({ path: 'scene.bounds.all', label: 'Caja de todos los elementos',
      hint: 'Deja la caja puesta en cada figura, solido y luz de la escena, aunque no esten seleccionados. La del elemento elegido se sigue viendo en ambar.' }),
    toggle({ path: 'scene.bounds.live', label: 'Ajustarla a la pose',
      hint: 'Encendida, la caja se rehace en cada fotograma y sigue a la pose. Apagada, mide la figura en reposo (el area del modelo de pie).' }),
    segmented({
      label: 'Ejes de la caja', path: 'scene.bounds.space',
      options: [
        { value: 'objeto', label: 'Del objeto', icon: 'box' },
        { value: 'mundo', label: 'Del mundo', icon: 'globe' },
      ],
      hint: 'Con los ejes del objeto la caja se pega a la forma aunque este girada; con los del mundo se alinea con la escena.',
    }),
    toggle({ path: 'scene.bounds.floor', label: 'Huella en el suelo',
      hint: 'Proyecta la base de la caja en y = 0: sirve para ver donde apoya la figura.' }),
    field('Medidas de lo seleccionado', liveValue(app, medidas)),
  ];
}

/* ── 2 · Camara ────────────────────────────────────────────────────────── */

function cameraPanel(app) {
  const { settings, actions } = app;

  const focalRow = buttons(
    FOCAL_PRESETS.map((mm) => ({
      label: String(mm), title: mm + ' mm',
      onClick: () => settings.set('camera.focalLength', mm),
    })),
    { cols: FOCAL_PRESETS.length, compact: true },
  );

  const viewRow = buttons(
    Object.keys(VIEW_PRESETS).map((name) => ({
      label: titleCase(name), title: 'Vista ' + name,
      onClick: () => actions.setView(name),
    })),
    { cols: 4, compact: true },
  );

  const dofBlock = el('div', {}, [
    slider({ label: 'Diafragma', path: 'camera.fStop', min: 0.95, max: 22, step: 0.05,
      format: (v) => 'f/' + v.toFixed(1),
      hint: 'Numero f bajo = menos profundidad de campo y mas desenfoque.' }),
    toggle({ path: 'camera.autoFocus', label: 'Enfoque automatico al objetivo' }),
    select({ label: 'Objetivo de enfoque', path: 'camera.focusTarget',
      options: FOCUS_TARGETS.map((t) => ({ value: t, label: titleCase(t) })) }).root,
    enableWhen(
      slider({ label: 'Distancia de enfoque', path: 'camera.focusDistance', min: 0.2, max: 20, step: 0.01, unit: ' m' }),
      'camera.autoFocus', (s) => !s.get('camera.autoFocus'),
    ),
    slider({ label: 'Desenfoque maximo', path: 'camera.maxBlur', min: 0, max: 0.05, step: 0.001 }),
  ]);

  return [
    group({ id: 'cam-lens', title: 'Optica', icon: 'aperture' }, [
      segmented({
        path: 'camera.projection',
        options: [
          { value: 'perspectiva', label: 'Perspectiva', icon: 'camera', title: 'Con distorsion de perspectiva' },
          { value: 'ortografica', label: 'Ortografica', icon: 'ratio', title: 'Sin perspectiva: proporciones lineales' },
        ],
        hint: 'La vista ortografica conserva el encuadre y sirve para medir proporciones.',
      }),
      slider({ label: 'Distancia focal', path: 'camera.focalLength', min: 8, max: 300, step: 1, unit: ' mm' }),
      field('Focales habituales', focalRow),
      slider({ label: 'Ancho de sensor', path: 'camera.filmGauge', min: 8, max: 70, step: 0.5, unit: ' mm',
        hint: 'Cambia el angulo de vision para una misma focal (formato de pelicula).' }),
      enableWhen(
        slider({ label: 'Zoom ortografico', path: 'camera.orthoZoom', min: 0.2, max: 4, step: 0.01 }),
        'camera.projection', (s) => s.get('camera.projection') === 'ortografica',
      ),
      slider({ label: 'Inclinacion (roll)', path: 'camera.roll', min: -180, max: 180, step: 0.5, unit: '°' }),
      slider({ label: 'Descentrado H', path: 'camera.shiftH', min: -1, max: 1, step: 0.01,
        hint: 'Lente tilt-shift: desplaza el encuadre sin girar la camara.' }),
      slider({ label: 'Descentrado V', path: 'camera.shiftV', min: -1, max: 1, step: 0.01 }),
    ]),
    group({ id: 'cam-views', title: 'Encuadres', icon: 'frame' }, [
      viewRow,
      slider({ label: 'Plato giratorio', path: 'camera.turntable', min: -30, max: 30, step: 0.5, unit: ' °/s' }),
      toggle({ path: 'camera.damping', label: 'Inercia al orbitar' }),
      buttons([
        { label: 'Encuadrar figura', icon: 'maximize', onClick: () => actions.frameFigure() },
        { label: 'Restablecer camara', icon: 'rotate-ccw', onClick: () => actions.resetCamera() },
      ], { cols: 2 }),
    ]),
    group({ id: 'cam-dof', title: 'Profundidad de campo', icon: 'focus', open: false }, [
      toggle({ path: 'camera.dof', label: 'Activar desenfoque' }),
      enableWhen(dofBlock, 'camera.dof', (s) => s.get('camera.dof') === true),
    ]),
    group({ id: 'cam-lensfx', title: 'Defectos de lente', icon: 'circle-dot', open: false }, [
      slider({ label: 'Distorsion k1', path: 'camera.distortion', min: -0.6, max: 0.6, step: 0.005,
        hint: 'Positivo = barril (ojo de pez); negativo = corsete.' }),
      slider({ label: 'Distorsion k2', path: 'camera.distortion2', min: -0.3, max: 0.3, step: 0.005 }),
      slider({ label: 'Aberracion cromatica', path: 'camera.chromatic', min: 0, max: 1, step: 0.01 }),
      slider({ label: 'Vineteado', path: 'camera.vignette', min: 0, max: 1, step: 0.01 }),
      slider({ label: 'Grano', path: 'camera.grain', min: 0, max: 0.2, step: 0.002 }),
      slider({ label: 'Halo (bloom)', path: 'camera.bloom', min: 0, max: 1.5, step: 0.01 }),
    ]),
    group({ id: 'cam-tone', title: 'Exposicion', icon: 'contrast', open: false }, [
      slider({ label: 'Exposicion', path: 'camera.exposure', min: 0.1, max: 3, step: 0.01 }),
      select({ label: 'Mapa de tonos', path: 'camera.toneMapping',
        options: [
          { value: 'agx', label: 'AgX (neutro filmico)' },
          { value: 'aces', label: 'ACES Filmic' },
          { value: 'neutral', label: 'Khronos Neutral' },
          { value: 'reinhard', label: 'Reinhard' },
          { value: 'linear', label: 'Lineal' },
        ] }).root,
    ]),
  ];
}

/* ── 3 · Luz y escenario ───────────────────────────────────────────────── */

function lightPanel(app) {
  const presets = Object.keys(LIGHT_PRESETS);
  return [
    group({ id: 'lt-preset', title: 'Esquema de luz', icon: 'sparkles' }, [
      select({ label: 'Preajuste', path: 'light.preset',
        options: presets.map((p) => ({ value: p, label: titleCase(p) })),
        hint: 'Ajusta las tres luces a un esquema clasico de claroscuro.' }).root,
      buttons(presets.slice(0, 4).map((p) => ({
        label: titleCase(p), title: 'Esquema ' + p,
        onClick: () => app.settings.set('light.preset', p),
      })), { cols: 4, compact: true }),
    ]),
    group({ id: 'lt-key', title: 'Luz principal', icon: 'sun' }, [
      slider({ label: 'X', path: 'light.key.x', min: -10, max: 10, step: 0.05 }),
      slider({ label: 'Y', path: 'light.key.y', min: -6, max: 12, step: 0.05 }),
      slider({ label: 'Z', path: 'light.key.z', min: -10, max: 10, step: 0.05 }),
      slider({ label: 'Intensidad', path: 'light.key.intensity', min: 0, max: 12, step: 0.05 }),
      color({ path: 'light.key.color', label: 'Color de la luz principal' }),
      toggle({ path: 'light.key.shadows', label: 'Proyectar sombras' }),
      slider({ label: 'Suavidad de sombra', path: 'light.key.softness', min: 0, max: 12, step: 0.1 }),
      slider({ label: 'Sesgo de sombra', path: 'light.key.bias', min: -0.005, max: 0.005, step: 0.0001,
        format: (v) => v.toFixed(4),
        hint: 'Corrige el moteado o el despegue de la sombra si aparecen artefactos.' }),
    ]),
    group({ id: 'lt-fill', title: 'Relleno y contra', icon: 'lightbulb', open: false }, [
      toggle({ path: 'light.fill.enabled', label: 'Luz de relleno' }),
      slider({ label: 'Intensidad relleno', path: 'light.fill.intensity', min: 0, max: 6, step: 0.05 }),
      color({ path: 'light.fill.color', label: 'Color del relleno' }),
      slider({ label: 'Relleno X', path: 'light.fill.x', min: -10, max: 10, step: 0.05 }),
      slider({ label: 'Relleno Y', path: 'light.fill.y', min: -6, max: 12, step: 0.05 }),
      slider({ label: 'Relleno Z', path: 'light.fill.z', min: -10, max: 10, step: 0.05 }),
      toggle({ path: 'light.rim.enabled', label: 'Luz de contorno' }),
      slider({ label: 'Intensidad contorno', path: 'light.rim.intensity', min: 0, max: 8, step: 0.05 }),
      color({ path: 'light.rim.color', label: 'Color del contorno' }),
      slider({ label: 'Contorno X', path: 'light.rim.x', min: -10, max: 10, step: 0.05 }),
      slider({ label: 'Contorno Y', path: 'light.rim.y', min: -6, max: 12, step: 0.05 }),
      slider({ label: 'Contorno Z', path: 'light.rim.z', min: -10, max: 10, step: 0.05 }),
    ]),
    group({ id: 'lt-amb', title: 'Ambiente', icon: 'sunrise' }, [
      slider({ label: 'Luz ambiental', path: 'light.ambient.intensity', min: 0, max: 3, step: 0.01 }),
      color({ path: 'light.ambient.color', label: 'Color ambiental' }),
      slider({ label: 'Entorno (HDRI)', path: 'light.env.intensity', min: 0, max: 3, step: 0.01,
        hint: 'Iluminacion difusa del estudio virtual; da volumen sin endurecer las sombras.' }),
    ]),
    group({ id: 'lt-stage', title: 'Escenario', icon: 'square', open: false }, [
      select({ label: 'Fondo', path: 'stage.background',
        options: [
          { value: 'degradado', label: 'Degradado de estudio' },
          { value: 'solido', label: 'Color solido' },
          { value: 'ciclorama', label: 'Ciclorama (fondo curvo)' },
        ] }).root,
      color({ path: 'stage.bgColor', label: 'Color de fondo' }),
      toggle({ path: 'stage.floor', label: 'Suelo' }),
      color({ path: 'stage.floorColor', label: 'Color del suelo' }),
      slider({ label: 'Fuerza de la sombra', path: 'stage.shadowStrength', min: 0, max: 1, step: 0.01 }),
      toggle({ path: 'stage.grid', label: 'Rejilla de referencia' }),
      slider({ label: 'Tamano de rejilla', path: 'stage.gridSize', min: 2, max: 40, step: 1, unit: ' m' }),
      toggle({ path: 'stage.axes', label: 'Ejes XYZ' }),
    ]),
  ];
}

/* ── 4 · Captura de movimiento ─────────────────────────────────────────── */

function mocapPanel(app) {
  const { settings, actions, hooks } = app;

  // Medidor de confianza: main.js lo alimenta cada fotograma por el gancho.
  const conf = meter();
  hooks.confidence = (v) => conf.setValue(v);

  // Lista de camaras disponibles. Se rellena al abrir y tras cada permiso.
  const devices = select({ label: 'Camara', path: 'mocap.deviceId', options: [{ value: '', label: 'Predeterminada' }] });
  const refreshDevices = async () => {
    const list = await app.source.listDevices();
    devices.setOptions([
      { value: '', label: 'Predeterminada' },
      ...list.map((d, i) => ({ value: d.id, label: d.label || 'Camara ' + (i + 1) })),
    ]);
    devices.element.value = String(settings.get('mocap.deviceId') ?? '');
  };
  refreshDevices();
  navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);

  // Resumen vivo del detector (modelo · delegado · ritmo · recorte).
  const detTag = el('span', { class: 'value', text: 'sin cargar' });
  hooks.detectorInfo = (texto) => { detTag.textContent = texto || 'sin cargar'; };

  // Indicador de manos detectadas: main.js lo alimenta por el gancho.
  const manosTag = el('span', { class: 'value', text: 'ninguna' });
  hooks.handCount = (n) => { manosTag.textContent = n === 0 ? 'ninguna' : n === 1 ? '1 mano' : n + ' manos'; };

  const partSlider = (path, label) =>
    slider({ label, path: 'mocap.parts.' + path, min: 0, max: 1.4, step: 0.01 });

  return [
    group({ id: 'mo-source', title: 'Fuente', icon: 'webcam' }, [
      segmented({
        path: 'mocap.source',
        options: [
          { value: 'webcam', label: 'Camara', icon: 'webcam', title: 'Camara web local' },
          { value: 'imagen', label: 'Imagen', icon: 'image', title: 'Fotografia de referencia' },
          { value: 'video', label: 'Video', icon: 'film', title: 'Archivo de video en bucle' },
        ],
      }),
      enableWhen(el('div', {}, [devices.root, buttons([
        { label: 'Actualizar camaras', icon: 'refresh-cw', onClick: refreshDevices },
      ], { compact: true })]), 'mocap.source', (s) => s.get('mocap.source') === 'webcam'),
      buttons([
        { label: 'Iniciar', icon: 'play', variant: 'primary', onClick: () => actions.startCapture(),
          ref: (n) => { hooks.startBtn = n; } },
        { label: 'Detener', icon: 'circle-x', onClick: () => actions.stopCapture() },
      ], { cols: 2 }),
      buttons([
        { label: 'Abrir archivo', icon: 'folder-open', title: 'Imagen o video de referencia',
          onClick: () => actions.loadMediaFile() },
        { label: 'Analizar fotograma', icon: 'scan-face', title: 'Detecta la pose del fotograma actual',
          onClick: () => actions.detectStill() },
      ], { cols: 2 }),
      buttons([
        { label: 'Buscar imagen en la web', icon: 'search', variant: 'primary',
          title: 'Buscador de imagenes de referencia (Espacio)',
          onClick: () => actions.searchImage?.() },
      ], { cols: 1 }),
      toggle({ path: 'mocap.frozen', label: 'Congelar pose', hint: 'Mantiene la ultima pose detectada aunque te muevas.' }),
      toggle({ path: 'mocap.autoStart', label: 'Iniciar la camara al abrir' }),
      field('Confianza de la deteccion', conf),
    ]),
    group({ id: 'mo-buscador', title: 'Buscador de imagenes', icon: 'search', open: false }, [
      buttons([
        { label: 'Abrir el buscador', icon: 'search', title: 'Tambien con la tecla Espacio',
          onClick: () => actions.searchImage?.() },
      ], { cols: 1 }),
      select({ label: 'Proveedor', path: 'search.provider',
        options: [
          { value: 'auto', label: 'Todos mezclados (recomendado)' },
          { value: 'bing', label: 'Bing Imagenes' },
          { value: 'duck', label: 'DuckDuckGo' },
          { value: 'wikimedia', label: 'Wikimedia Commons' },
          { value: 'openverse', label: 'Openverse (licencia libre)' },
          { value: 'artic', label: 'Art Institute of Chicago' },
          { value: 'cleveland', label: 'Cleveland Museum of Art' },
          { value: 'met', label: 'The Met' },
          { value: 'wellcome', label: 'Wellcome Collection (anatomia)' },
        ],
        hint: 'Mezclado se pregunta a todos a la vez y la rejilla se entrelaza, con mas cupo para Bing y DuckDuckGo. Los museos estan indexados en ingles, y Wellcome solo entra si lo eliges: su fondo es clinico.' }).root,
      toggle({ path: 'search.safe', label: 'Filtrar contenido para adultos',
        hint: 'Desactivalo si buscas desnudo artistico para estudio de figura. Solo lo tienen Bing y DuckDuckGo; los archivos y museos no.' }),
      notice('info', 'Las imagenes se descargan por el propio dominio para que el detector pueda leerlas. No se usa ninguna clave de API.', 'search'),
    ]),
    group({ id: 'mo-solver', title: 'Transferencia', icon: 'bone' }, [
      segmented({
        label: 'Motor', path: 'mocap.engine',
        options: [
          { value: 'directo', label: 'Directo', icon: 'target', title: 'Resuelve los huesos por direccion medida' },
          { value: 'kalidokit', label: 'Kalidokit', icon: 'cpu', title: 'Angulos calculados por Kalidokit' },
        ],
        hint: 'El motor directo respeta mejor las proporciones; Kalidokit suaviza mas las extremidades.',
      }),
      toggle({ path: 'mocap.mirror', label: 'Vista en espejo', hint: 'Actívalo si te mueves frente a la camara como ante un espejo.' }),
      slider({ label: 'Suavizado de rotacion', path: 'mocap.smoothing', min: 0, max: 0.98, step: 0.01,
        hint: 'Interpolacion slerp por fotograma: sube el valor si la malla vibra.' }),
      slider({ label: 'Visibilidad minima', path: 'mocap.confidence', min: 0, max: 0.95, step: 0.01 }),
      toggle({ path: 'mocap.followPosition', label: 'Seguir la posicion del cuerpo' }),
      slider({ label: 'Recorrido', path: 'mocap.positionRange', min: 0, max: 2, step: 0.01, unit: ' m' }),
    ]),
    group({ id: 'mo-parts', title: 'Influencia por zona', icon: 'sliders-horizontal', open: false }, [
      partSlider('torso', 'Torso'), partSlider('arms', 'Brazos'), partSlider('legs', 'Piernas'),
      partSlider('head', 'Cabeza'), partSlider('hands', 'Manos'),
      notice('info', 'Baja una zona a <b>0</b> para posarla a mano mientras el resto sigue la captura.'),
    ]),
    group({ id: 'mo-filter', title: 'Filtro One Euro', icon: 'activity', open: false }, [
      toggle({ path: 'mocap.oneEuro', label: 'Filtrar los puntos detectados' }),
      slider({ label: 'Frecuencia', path: 'mocap.oneEuroFreq', min: 5, max: 120, step: 1, unit: ' Hz' }),
      slider({ label: 'Corte minimo', path: 'mocap.oneEuroMinCutoff', min: 0.1, max: 6, step: 0.05 }),
      slider({ label: 'Beta', path: 'mocap.oneEuroBeta', min: 0, max: 2, step: 0.01,
        hint: 'Mas beta = responde antes a movimientos rapidos; menos = mas estable en reposo.' }),
    ]),
    group({ id: 'mo-manos', title: 'Dedos por camara', icon: 'hand', open: false }, [
      toggle({ path: 'mocap.hands', label: 'Detectar las manos (21 puntos)',
        hint: 'Carga un segundo modelo y mueve las falanges del personaje con tus dedos.' }),
      slider({ label: 'Suavizado de los dedos', path: 'mocap.handSmoothing', min: 0.05, max: 1, step: 0.01,
        format: (v) => (v >= 1 ? 'sin suavizar' : Math.round(v * 100) + ' %') }),
      field('Manos detectadas', manosTag),
      notice('info', 'Cuando la deteccion pierde una mano, sus dedos se quedan en la ultima postura en vez de saltar a la posicion de reposo.', 'hand-grab'),
      notice('warn', 'Si los dedos salen en la mano contraria, cambia <b>Vista en espejo</b> en Transferencia: dedos y brazos usan el mismo criterio.', 'flip-horizontal'),
    ]),
    group({ id: 'mo-model', title: 'Detector', icon: 'cpu', open: false }, [
      select({ label: 'Precision del modelo', path: 'mocap.modelQuality',
        options: Object.keys(POSE_MODELS).map((q) => ({
          value: q,
          label: q === 'lite' ? 'Ligero (mas rapido)' : q === 'full' ? 'Completo (equilibrado)' : 'Pesado (mas preciso)',
        })) }).root,
      field('En marcha', detTag),
      segmented({ label: 'Ejecucion', path: 'mocap.delegate',
        options: [
          { value: 'GPU', label: 'GPU', icon: 'zap' },
          { value: 'CPU', label: 'CPU', icon: 'cpu' },
        ],
        hint: 'La CPU es el respaldo cuando no hay GPU: mas lenta, pero funciona en cualquier equipo.' }),
      slider({ label: 'Fotogramas analizados', path: 'mocap.detectFps', min: 0, max: 60, step: 1,
        format: (v) => (v <= 0 ? 'automatico' : v + ' fps'),
        hint: 'En CPU conviene bajarlo: cada fotograma cuesta mucho mas que en GPU.' }),
      select({ label: 'Recorte cuadrado', path: 'mocap.square',
        options: [
          { value: 'auto', label: 'Automatico (solo en CPU)' },
          { value: 'si', label: 'Siempre' },
          { value: 'no', label: 'Nunca' },
        ] }).root,
      notice('info', 'El grafo de CPU de MediaPipe solo acepta recortes cuadrados: el recorte anade bandas negras y devuelve los puntos a las coordenadas del video.', 'square'),
      slider({ label: 'Umbral de deteccion', path: 'mocap.minDetection', min: 0.1, max: 0.95, step: 0.01 }),
      slider({ label: 'Umbral de presencia', path: 'mocap.minPresence', min: 0.1, max: 0.95, step: 0.01 }),
      slider({ label: 'Umbral de seguimiento', path: 'mocap.minTracking', min: 0.1, max: 0.95, step: 0.01 }),
      toggle({ path: 'mocap.showHud', label: 'Mostrar la ventana de camara' }),
      toggle({ path: 'mocap.showOverlay', label: 'Dibujar el esqueleto detectado' }),
      notice('info', 'La ventana de camara se <b>arrastra</b> por su cabecera y se <b>redimensiona</b> desde las esquinas (doble clic en una esquina: tamano por defecto).', 'move'),
      notice('info', 'Pincha un <b>punto detectado</b> para seleccionar ese control en la figura: activa el posado manual y engancha el giroscopio a ese hueso.', 'mouse-pointer-2'),
      notice('info', 'Todo el analisis se ejecuta en tu equipo: ningun fotograma sale del navegador.', 'circle-check'),
    ]),
  ];
}

/* ── 5 · Poses ─────────────────────────────────────────────────────────── */

function posesPanel(app) {
  const { settings, actions, library, hooks } = app;

  const nameInput = el('input', { type: 'text', placeholder: 'Nombre de la pose', style: { flex: '1', minWidth: '0' } });
  const list = listView({
    empty: 'Aun no has guardado poses.',
    onSelect: (item) => actions.applyPose(item.id),
    onDelete: (item) => actions.deletePose(item.id),
  });
  const refresh = () => {
    const fmt = new Intl.DateTimeFormat('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    list.render(library.list().map((p) => ({
      id: p.id, label: p.name, icon: 'person-standing',
      meta: p.created ? fmt.format(new Date(p.created)) : '',
    })));
  };
  hooks.refreshPoses = refresh;
  refresh();

  // Fijaciones: se listan en el orden en que se usan al montar una pose (los
  // brazos son lo que mas se arrastra, la cabeza lo que menos). La etiqueta y el
  // grupo salen de IK_CHAINS para no repetir aqui los nombres de los tiradores.
  const pines = ['leftArm', 'rightArm', 'leftLeg', 'rightLeg', 'torso', 'head']
    .map((id) => IK_CHAINS.find((c) => c.id === id))
    .filter(Boolean)
    .map((def) => ({
      label: def.handle, icon: 'magnet', path: 'ik.pins.' + def.id,
      title: 'Clavar ' + def.label.toLowerCase() + ' en su sitio',
      ref: (node) => enableWhen(node, ['ik.enabled', 'ik.' + def.group],
        (s) => s.get('ik.enabled') === true && s.get('ik.' + def.group) !== false),
    }));

  // Hueso seleccionado por el gizmo de pose manual.
  const boneTag = el('span', { class: 'value', text: '—' });
  const paintBone = (v) => { boneTag.textContent = v ? String(v).replace(/^mixamorig:?/, '') : '—'; };
  settings.on('ui.selectedBone', paintBone);
  paintBone(settings.get('ui.selectedBone'));

  // Y cuanto se ha deformado ese hueso, que lo escribe el propio posado.
  const deformTag = el('span', { class: 'value', text: '—' });
  const paintDeform = (v) => { deformTag.textContent = v ? String(v) : '—'; };
  settings.on('ui.boneDeform', paintDeform);
  paintDeform(settings.get('ui.boneDeform'));

  return [
    group({ id: 'ps-manual', title: 'Pose manual', icon: 'hand' }, [
      toggle({ path: 'ui.manualPosing', label: 'Editar huesos con el raton',
        hint: 'Pulsa un tirador sobre la figura y gira el hueso; la captura se congela al editar.' }),
      segmented({
        label: 'Modo del rig', path: 'ik.enabled',
        options: [
          { value: false, label: 'Directa (FK)', icon: 'rotate-3d' },
          { value: true, label: 'Inversa (IK)', icon: 'target' },
        ],
        hint: 'Los dos modos de un rig de verdad, y se cambia con la tecla I o desde las siglas de la barra de abajo. En modo inverso desaparecen las esferas de giro de los huesos que manda el solucionador: ahi se deforma por posicion, con el pliegue y los tiradores de volumen.',
      }),
      segmented({
        label: 'Que hace el giroscopio', path: 'scene.tool',
        options: [
          { value: 'translate', label: 'Mover', icon: 'move' },
          { value: 'rotate', label: 'Girar', icon: 'rotate-3d' },
          { value: 'scale', label: 'Deformar', icon: 'scaling' },
        ],
        hint: 'Teclas W, E y R. Mover es para los controles de mano, pie y cadera; girar y deformar valen para cualquier hueso. Al deformar, el tirador que va a lo largo del hueso lo alarga y los otros dos lo engordan.',
      }),
      toggle({ path: 'pose.proximity', label: 'Ensenar solo lo que hay junto al puntero',
        hint: 'En una figura entera hay mas de cuarenta manejadores y de espaldas se tapan entre si: asi solo aparecen los del entorno del raton (tecla N). Vale para las dos formas de posar, girar hueso a hueso y arrastrar la mano.' }),
      enableWhen(slider({ label: 'Radio del entorno', path: 'pose.proximityRadius',
        min: 0.06, max: 0.4, step: 0.01,
        format: (v) => Math.round(v * 100) + ' % del alto',
        hint: 'Medido en alto de visor y no en pixeles, para que se porte igual en una pantalla grande que en un portatil.' }),
        'pose.proximity', (s) => s.get('pose.proximity') === true),
      slider({ label: 'Tamano de los manejadores', path: 'pose.handleScale',
        min: 0.01, max: 1, step: 0.01,
        format: (v) => Math.round(v * 100) + ' %',
        hint: 'Encoge de golpe todos los controles del rig —los del modo directo y los del inverso— sin cambiar sus proporciones ni cual es mas gordo que cual. Empieza al 50 %; al 100 % son los grandes de siempre, y por debajo del 20 % quedan puntos, que tapan menos la figura pero tambien se pinchan peor. Doble clic para volver al 50 %.' }),
      field('Hueso seleccionado', boneTag),
      buttons([
        { label: 'Deshacer', icon: 'rotate-ccw', title: 'Deshacer el ultimo giro (Ctrl+Z)', onClick: () => actions.undo() },
        { label: 'Pose de reposo', icon: 'refresh-cw', onClick: () => actions.resetPose() },
      ], { cols: 2 }),
      buttons([
        { label: 'Pose T', icon: 'person-standing', onClick: () => actions.presetPose('t') },
        { label: 'Pose A', icon: 'person-standing', onClick: () => actions.presetPose('a') },
      ], { cols: 2, compact: true }),
    ]),
    group({ id: 'ps-fk', title: 'Cinematica directa (FK)', icon: 'rotate-3d' }, [
      notice('info', 'Girar hueso a hueso, del hombro a la mano: cada giro arrastra lo que cuelga de el, como en un maniqui de madera. Es el modo de la tecla I por la mitad de la izquierda; en modo inverso solo quedan las esferas de los huesos que no lleva ninguna cadena encendida, y para recuperar el resto se apaga esa cadena en <b>Cadenas</b>.'),
      segmented({
        label: 'Ejes del giro', path: 'pose.space',
        options: [
          { value: 'world', label: 'Mundo', icon: 'globe' },
          { value: 'local', label: 'Hueso', icon: 'box' },
        ],
        hint: 'Alt+X mientras se posa. «Mundo» gira sobre los ejes de la escena; «Hueso» sobre los del propio hueso, que es lo comodo para doblar un codo o una rodilla. Es ajuste aparte del de las cajas y los solidos, que tienen el suyo en el editor de escena.',
      }),
      select({
        label: 'Imantado', path: 'scene.snap',
        options: [
          { value: 0, label: 'Libre' }, { value: 0.05, label: '5 cm' },
          { value: 0.1, label: '10 cm' }, { value: 0.25, label: '25 cm' },
          { value: 0.5, label: '50 cm' },
        ],
        hint: 'Con el imantado puesto los huesos giran de 15 en 15 grados, los controles se mueven a saltos de esa medida y la deformacion va de cinco en cinco centesimas (1,05 · 1,10 · 1,15).',
      }).root,
    ]),
    group({ id: 'ps-ik', title: 'Cinematica inversa (IK)', icon: 'target' }, [
      notice('info', 'Rombos en manos, pies, pecho y cabeza: arrastras uno y la cadena entera le sigue. W mueve el control, E gira el hueso de la punta y R lo deforma. Se enciende arriba, en <b>Modo del rig</b>, con la tecla I o desde las siglas FK/IK de la barra de abajo.'),
      enableWhen(el('div', { class: 'stack' }, [
        field('Cadenas', buttons([
          { label: 'Brazos', icon: 'hand', path: 'ik.arms', title: 'Hombro, codo y mano' },
          { label: 'Piernas', icon: 'footprints', path: 'ik.legs', title: 'Muslo, rodilla y pie' },
          { label: 'Torso', icon: 'person-standing', path: 'ik.torso', title: 'Columna: el pecho arrastra la espalda' },
          { label: 'Cabeza', icon: 'scan-face', path: 'ik.head', title: 'Cuello y cabeza: la coronilla mira al control' },
        ], { cols: 2, compact: true }), { hint: 'Lo que apagues aqui se sigue posando hueso a hueso, como siempre.' }),
        field('Controles auxiliares', buttons([
          { label: 'Codo y rodilla', icon: 'circle-dot', path: 'ik.poles', title: 'Cubo pequeno junto a la articulacion: gira el plano de flexion sin mover la mano' },
          { label: 'Peso del cuerpo', icon: 'move-3d', path: 'ik.body', title: 'Cubo en la cadera: con los pies clavados, agacha la figura' },
          { label: 'Deformar por posicion', icon: 'scaling', path: 'ik.deform', title: 'La bola del pliegue en el codo y la rodilla, y un pico de volumen en cada hueso de la cadena' },
        ], { cols: 2, compact: true }),
        { hint: 'La bola morada del codo o la rodilla lleva la articulacion a un punto y los dos eslabones dan de si lo justo para llegar, con la mano quieta. El pico verde de cada hueso lo engorda al apartarlo del eje y lo alarga al correrlo a lo largo. Son los que sustituyen a la esfera de giro cuando la cadena esta encendida.' }),
        slider({ label: 'Holgura de la articulacion', path: 'ik.margin', min: 0, max: 0.15, step: 0.005,
          format: (v) => Math.round(v * 100) + ' %',
          hint: 'Parte del miembro que nunca se estira. A cero el brazo puede quedar del todo recto y pierde el plano del codo.' }),
        toggle({ path: 'ik.stretch', label: 'Squash y stretch',
          hint: 'La cadena se alarga para llegar a donde no alcanza y se aplasta cuando el objetivo queda mas cerca de lo que puede plegarse. Solo entra en juego en esos dos extremos: encenderlo no cambia ninguna pose que ya llegaba.' }),
        enableWhen(slider({ label: 'Estirado maximo', path: 'ik.stretchMax',
          min: 0.05, max: 0.6, step: 0.05,
          format: (v) => '+' + Math.round(v * 100) + ' %',
          hint: 'Cuanto se permite dar de si al miembro. Un 25 % es el gesto de dibujo animado sin que la figura deje de parecer la misma.' }),
          'ik.stretch', (s) => s.get('ik.stretch') === true),
        field('Fijaciones', buttons(pines, { cols: 2, compact: true }),
          { hint: 'Un control clavado se queda donde esta aunque muevas el resto del cuerpo. Con X clavas o sueltas el control elegido.' }),
        buttons([
          { label: 'Clavar los pies', icon: 'magnet', title: 'Fija los dos pies para agacharse o inclinarse sin despegarlos del suelo', onClick: () => actions.pinFeet?.() },
          { label: 'Soltar todo', icon: 'lock-open', title: 'Quita todas las fijaciones', onClick: () => actions.unpinAll?.() },
        ], { cols: 2 }),
      ]), 'ik.enabled', (s) => s.get('ik.enabled') === true),
      notice('info', 'Los controles sin clavar vuelven solos a la mano o el pie, asi que la cinematica inversa no pelea con la captura ni con la biblioteca de poses.'),
    ]),
    group({ id: 'ps-deform', title: 'Deformar los huesos', icon: 'scaling' }, [
      notice('info', 'Con <b>R</b> el giroscopio deforma el hueso del control elegido: es el aplastado a mano de un rig de dibujo animado. El tirador que va <b>a lo largo</b> del hueso lo <b>alarga</b> moviendo la articulacion de abajo, asi que la piel se estira entre las dos sin dar un escalon; los otros dos lo <b>engordan</b> sin moverla. Lo que cuelga del hueso mantiene su tamano, asi que engordar la rodilla no engorda el pie.'),
      notice('info', 'En los huesos que lleva una cadena encendida no hace falta el giroscopio: se deforman <b>por posicion</b>, arrastrando la bola del pliegue o el pico de volumen del propio hueso. Es la misma deformacion, con los mismos topes, y se apagan juntos en <b>Controles auxiliares</b>.'),
      field('Deformacion del hueso', deformTag),
      toggle({ path: 'pose.deformVolume', label: 'Conservar el volumen al deformar',
        hint: 'Aplastar y estirar de dibujo animado: al alargar un hueso se adelgaza y al acortarlo se ensancha, la misma cuenta que el squash de las cadenas. Apagado, el largo y el grosor van cada uno a lo suyo.' }),
      buttons([
        { label: 'Devolver el tamano', icon: 'refresh-cw', title: 'Quita la deformacion del control elegido',
          onClick: () => actions.resetBoneDeform?.() },
        { label: 'Quitar todas', icon: 'eraser', title: 'Devuelve su tamano a todos los huesos',
          onClick: () => actions.clearDeform?.() },
      ], { cols: 2 }),
      notice('info', 'La deformacion viaja con la pose: se guarda en la biblioteca, se deshace con Ctrl+Z y no se pierde al cambiar de modo. El estirado del squash tampoco: la silueta es la misma a los dos lados del interruptor.'),
    ]),
    group({ id: 'ps-manos', title: 'Manos y dedos', icon: 'hand' }, [
      segmented({
        label: 'Mano que estas editando', path: 'hands.edit',
        options: [
          { value: 'left', label: 'Izquierda', icon: 'hand' },
          { value: 'right', label: 'Derecha', icon: 'hand-grab' },
        ],
      }),
      toggle({ path: 'hands.link', label: 'Mover las dos manos a la vez',
        hint: 'Con esto activado, lo que ajustes en una mano se copia en la otra.' }),
      reactive(['hands.edit'], () => handControls(app)),
      buttons([
        { label: 'Copiar a la otra', icon: 'copy', title: 'Iguala la otra mano a esta',
          onClick: () => actions.mirrorHand?.() },
        { label: 'Abrir del todo', icon: 'hand', title: 'Dedos rectos',
          onClick: () => actions.handPreset?.('abierta') },
      ], { cols: 2 }),
      toggle({ path: 'hands.fingers', label: 'Manejadores de falange en el posado manual',
        hint: 'Anade 30 esferas pequenas sobre las falanges para girarlas una a una con el giroscopio.' }),
      notice('info', 'Los ejes de flexion se deducen de la geometria de la mano, no de los ejes locales del archivo: funcionan igual en cualquier personaje de Mixamo.'),
    ]),
    group({ id: 'ps-coloc', title: 'Colocacion', icon: 'move' }, [
      // La colocacion es propia de cada figura: se edita la activa y se
      // reconstruye al cambiar de figura o al renombrarla.
      reactive(['scene.figures', 'figure.active'],
        () => figureControls(app, app.figures?.activeId ?? '')),
    ]),
    group({ id: 'ps-lib', title: 'Biblioteca', icon: 'library' }, [
      field('Guardar la pose actual', el('div', { class: 'field-row' }, [
        nameInput,
        el('button', {
          class: 'btn primary', type: 'button', title: 'Guardar pose',
          onClick: () => { actions.capturePose(nameInput.value); nameInput.value = ''; },
        }, [icon('save', 14), el('span', { text: 'Guardar' })]),
      ])),
      list,
      buttons([
        { label: 'Exportar', icon: 'file-down', title: 'Descarga todas las poses en JSON', onClick: () => actions.exportPoses() },
        { label: 'Importar', icon: 'file-up', title: 'Carga un JSON de poses', onClick: () => actions.importPoses() },
      ], { cols: 2 }),
      notice('info', 'Las poses se guardan en este navegador. Exportalas para llevarlas a otro equipo.'),
    ]),
  ];
}

/* ── 6 · Guias de dibujo ───────────────────────────────────────────────── */

/**
 * Controles que dependen del modo de perspectiva elegido. Se reconstruyen solo
 * cuando cambia `mode`, nunca cuando se arrastra un deslizador.
 */
function perspectiveControls(app) {
  const modo = app.settings.get('guides.perspective.mode') ?? 'ninguno';
  const def = PERSPECTIVE_BY_ID[modo];
  const out = [];
  if (def?.note) out.push(el('div', { class: 'field-hint', text: def.note }));
  if (modo === 'ninguno') return out;

  const lineal = def.kind === 'lineal';
  if (lineal) {
    out.push(slider({ label: 'Radios por fuga', path: 'guides.perspective.rays',
      min: 4, max: 60, step: 1, format: (v) => Math.round(v) + ' lineas' }));
  } else {
    out.push(slider({ label: 'Meridianos', path: 'guides.perspective.meridians',
      min: 4, max: 72, step: 2, format: (v) => Math.round(v) + ' cada ' + Math.round(360 / Math.max(4, v)) + ' grados' }));
  }
  out.push(toggle({ path: 'guides.perspective.horizon', label: 'Linea de horizonte' }));
  out.push(toggle({ path: 'guides.perspective.points', label: 'Marcar los puntos de fuga' }));
  out.push(toggle({ path: 'guides.perspective.labels', label: 'Etiquetas (F1, F2, F3...)' }));
  out.push(toggle({ path: 'guides.perspective.measuring',
    label: lineal ? 'Puntos de medida a 45 grados' : 'Diagonales a 45 grados',
    hint: lineal ? 'Sirven para trasladar medidas reales al dibujo.' : undefined }));
  if (lineal) {
    out.push(toggle({ path: 'guides.perspective.objects',
      label: 'Fugas del solido seleccionado',
      hint: 'Si el solido esta girado aporta fugas propias: asi se pasa de tres puntos a los que hagan falta.' }));
  }
  return out;
}

function guidesPanel(app) {
  return [
    group({ id: 'gu-persp', title: 'Perspectiva', icon: 'vector-square' }, [
      presetGrid({ path: 'guides.perspective.mode', cols: 4,
        options: PERSPECTIVE_MODES.map((m) => ({ value: m.id, label: m.label, icon: m.icon, title: m.note })),
        hint: 'Las fugas se calculan desde la camara real, no se colocan a mano.' }),
      reactive('guides.perspective.mode', () => perspectiveControls(app)),
    ]),
    group({ id: 'gu-persp-malla', title: 'Reticulas y volumen', icon: 'grid-3x3', open: false }, [
      toggle({ path: 'guides.perspective.floorGrid', label: 'Rejilla del suelo' }),
      toggle({ path: 'guides.perspective.wallGrid', label: 'Rejilla de los muros' }),
      slider({ label: 'Paso de la rejilla', path: 'guides.perspective.gridStep',
        min: 0.1, max: 2, step: 0.05, format: (v) => v.toFixed(2) + ' m' }),
      slider({ label: 'Extension', path: 'guides.perspective.gridExtent',
        min: 2, max: 30, step: 1, format: (v) => '± ' + Math.round(v) + ' m' }),
      toggle({ path: 'guides.perspective.cube', label: 'Cubo de referencia (1 m)',
        hint: 'Si el cubo encaja con la reticula, el encuadre es correcto.' }),
      toggle({ path: 'guides.perspective.cone', label: 'Cono de vision' }),
      slider({ label: 'Angulo del cono', path: 'guides.perspective.coneAngle',
        min: 20, max: 140, step: 1, format: (v) => Math.round(v) + ' grados' }),
      toggle({ path: 'guides.perspective.letterbox', label: 'Atenuar fuera del cono' }),
    ]),
    group({ id: 'gu-persp-cam', title: 'Camara y trazo', icon: 'compass', open: false }, [
      buttons([{ label: 'Alinear la camara al modo', icon: 'crosshair',
        onClick: () => app.actions.alignPerspective?.() }]),
      toggle({ path: 'guides.perspective.align', label: 'Horizonte a nivel',
        hint: 'Fija la camara al horizonte: condicion de 1 y 2 puntos.' }),
      toggle({ path: 'guides.perspective.lock', label: 'Congelar las fugas',
        hint: 'Guarda la camara actual para poder orbitar sin mover la reticula.' }),
      color({ path: 'guides.perspective.color2', label: 'Color de la perspectiva' }),
      slider({ label: 'Opacidad', path: 'guides.perspective.opacity', min: 0.05, max: 1, step: 0.01 }),
      slider({ label: 'Grosor', path: 'guides.perspective.width', min: 0.5, max: 3, step: 0.1,
        format: (v) => v.toFixed(1) + ' px' }),
      toggle({ path: 'guides.perspective.fade', label: 'Degradar los radios',
        hint: 'Baja la opacidad de los radios extremos para no ensuciar el encuadre.' }),
    ]),
    group({ id: 'gu-accion', title: 'Linea de accion', icon: 'spline' }, [
      toggle({ path: 'guides.action.line', label: 'Linea de accion',
        hint: 'El recorrido del movimiento: de la coronilla a la pierna que aguanta el peso, pasando por la columna.' }),
      toggle({ path: 'guides.action.arms', label: 'Ritmo de brazo a brazo',
        hint: 'Una sola curva de una mano a la otra, arqueada por encima de los hombros.' }),
      toggle({ path: 'guides.action.legs', label: 'Ritmo de hombro a pierna',
        hint: 'Dos curvas que bajan del hombro por el torso hasta el pie.' }),
      segmented({
        label: 'Camino de ese ritmo', path: 'guides.action.legPath',
        options: [
          { value: 'cruzado', label: 'Cruzado', icon: 'spline', title: 'Baja al pie del lado contrario; los dos trazos se cruzan en la pelvis' },
          { value: 'mismo', label: 'Mismo lado', icon: 'spline', title: 'Pasa por la columna y baja a la pierna de su lado' },
          { value: 'costado', label: 'Por el costado', icon: 'spline', title: 'Del hombro a la pierna casi recto, sin entrar al centro' },
        ],
        hint: 'Por el costado no pasa por la columna: baja del hombro a la pierna de su lado casi recto, pero llevandose la curvatura de la espalda (si la figura se dobla, el trazo se dobla).',
      }),
      toggle({ path: 'guides.action.shoulders', label: 'Recta de los hombros',
        hint: 'Une los dos hombros y se prolonga a los lados: mide cuanto estan volcados.' }),
      toggle({ path: 'guides.action.hips', label: 'Recta de la cadera',
        hint: 'La misma medida en la pelvis. Si las dos rectas se cruzan hay contrapposto; si van paralelas la figura esta plantada.' }),
      slider({ label: 'Exageracion', path: 'guides.action.exaggeration', min: 0, max: 1.5, step: 0.05,
        format: (v) => Math.round(v * 100) + ' %',
        hint: 'Amplifica la curva del movimiento. El trazo exagerado sale de puntos junto al real.' }),
      toggle({ path: 'guides.action.ghost', label: 'Fantasma con la exageracion',
        hint: 'Dibuja el mismo personaje llevado a esa exageracion, con los hombros y la cadera mas volcados: es la pose hacia la que apunta su linea de movimiento.' }),
      slider({ label: 'Grosor del trazo', path: 'guides.action.width', min: 1, max: 16, step: 0.5,
        format: (v) => v.toFixed(1) + ' px' }),
      color({ path: 'guides.action.color', label: 'Color del trazo' }),
      color({ path: 'guides.action.color2', label: 'Color de hombros y cadera' }),
      slider({ label: 'Opacidad', path: 'guides.action.opacity', min: 0.1, max: 1, step: 0.01 }),
      notice('info', 'Los trazos se calculan sobre la figura que <b>posa</b> y se rehacen con la pose. Cada uno se prolonga un poco mas alla de las articulaciones y se <b>desvanece</b> afilandose en las dos puntas, como un gesto de lapiz. Las dos rectas de hombros y cadera son lineas de <b>construccion</b>: van rectas, mas finas y en su propio color.', 'spline'),
    ]),
    group({ id: 'gu-prop', title: 'Proporcion', icon: 'ruler' }, [
      toggle({ path: 'guides.heads', label: 'Canon de cabezas' }),
      slider({ label: 'Numero de cabezas', path: 'guides.headCount', min: 5, max: 10, step: 0.5,
        hint: '7,5 es el canon realista; 8 el academico; 9 el heroico.' }),
      toggle({ path: 'guides.symmetry', label: 'Eje de simetria' }),
      toggle({ path: 'guides.horizon', label: 'Linea de horizonte' }),
    ]),
    group({ id: 'gu-comp', title: 'Composicion', icon: 'grid-3x3' }, [
      toggle({ path: 'guides.thirds', label: 'Regla de los tercios' }),
      toggle({ path: 'guides.golden', label: 'Seccion dorada' }),
      toggle({ path: 'guides.diagonals', label: 'Diagonales y armadura' }),
      slider({ label: 'Rejilla', path: 'guides.grid', min: 0, max: 12, step: 1,
        format: (v) => (v < 1 ? 'sin rejilla' : `${Math.round(v)} × ${Math.round(v)}`) }),
      select({ label: 'Encuadre seguro', path: 'guides.safeFrame',
        options: [
          { value: 'ninguno', label: 'Sin recorte' },
          { value: '1:1', label: 'Cuadrado 1:1' },
          { value: '4:5', label: 'Retrato 4:5' },
          { value: '3:2', label: 'Clasico 3:2' },
          { value: '16:9', label: 'Panoramico 16:9' },
        ] }).root,
    ]),
    group({ id: 'gu-style', title: 'Aspecto', icon: 'palette', open: false }, [
      color({ path: 'guides.color', label: 'Color de las guias' }),
      slider({ label: 'Opacidad', path: 'guides.opacity', min: 0.05, max: 1, step: 0.01 }),
    ]),
  ];
}

/* ── 7 · Lapiz sobre el visor ──────────────────────────────────────────── */

/**
 * Lapiz para practicar encima de la escena. El grosor sale de la presion de la
 * pluma; sin pluma, de la velocidad del trazo (lento = grueso, rapido = fino),
 * con las entradas y salidas afiladas.
 */
function drawPanel(app) {
  const { actions } = app;
  const cuenta = () => {
    const n = app.sketch?.count ?? 0;
    return n === 0 ? 'nada dibujado' : n === 1 ? '1 trazo' : n + ' trazos';
  };
  const pluma = () => (app.sketch?.pen ? 'presion de la pluma' : 'velocidad del trazo');

  return [
    group({ id: 'dib-lapiz', title: 'Lapiz', icon: 'pencil' }, [
      toggle({ path: 'draw.enabled', label: 'Dibujar sobre el visor (D)',
        hint: 'Mientras esta encendido el puntero dibuja. Con Alt pulsado se orbita sin apagarlo, y la rueda hace zoom como siempre.' }),
      segmented({
        label: 'Herramienta', path: 'draw.tool',
        options: [
          { value: 'lapiz', label: 'Lapiz', icon: 'pencil', title: 'Trazo afilado, con presion o velocidad' },
          { value: 'rotulador', label: 'Rotulador', icon: 'highlighter', title: 'Grosor parejo, sin afilar las puntas' },
          { value: 'borrador', label: 'Borrador', icon: 'eraser', title: 'Quita el trazo que toques' },
        ],
      }),
      color({ path: 'draw.color', label: 'Color del trazo' }),
      slider({ label: 'Grosor', path: 'draw.size', min: 0.5, max: 40, step: 0.5, unit: ' px' }),
      slider({ label: 'Opacidad', path: 'draw.opacity', min: 0.05, max: 1, step: 0.01 }),
      buttons([
        { label: 'Deshacer', icon: 'undo-2', title: 'Deshacer el ultimo trazo (Ctrl+Z)',
          onClick: () => actions.undoDrawing?.() },
        { label: 'Rehacer', icon: 'redo-2', title: 'Rehacer (Ctrl+Mayus+Z)',
          onClick: () => actions.redoDrawing?.() },
      ], { cols: 2, compact: true }),
      buttons([
        { label: 'Vaciar el dibujo', icon: 'trash-2', variant: 'danger',
          title: 'Quita todos los trazos (se puede deshacer)', onClick: () => actions.clearDrawing?.() },
      ], { cols: 1 }),
      field('En el lienzo', liveValue(app, cuenta)),
    ]),
    group({ id: 'dib-presion', title: 'Presion y tacto del trazo', icon: 'pen-tool' }, [
      field('Grosor gobernado por', liveValue(app, pluma)),
      slider({ label: 'Influencia de la presion', path: 'draw.pressureSize', min: 0, max: 1, step: 0.01,
        format: (v) => Math.round(v * 100) + ' %',
        hint: 'Cuanto adelgaza el trazo al apoyar flojo con una pluma digital.' }),
      slider({ label: 'Presion sobre la opacidad', path: 'draw.pressureAlpha', min: 0, max: 1, step: 0.01,
        format: (v) => Math.round(v * 100) + ' %',
        hint: 'Los trazos suaves salen mas claros. Se aplica al trazo entero para no dejar costuras.' }),
      slider({ label: 'Grosor por velocidad', path: 'draw.speed', min: 0, max: 1, step: 0.01,
        format: (v) => Math.round(v * 100) + ' %',
        hint: 'Lo que manda cuando no hay presion: raton, trackpad o pluma sin sensor.' }),
      slider({ label: 'Estabilizador', path: 'draw.smoothing', min: 0, max: 0.9, step: 0.01,
        format: (v) => Math.round(v * 100) + ' %',
        hint: 'Suaviza el pulso. Mucho estabilizador retrasa la punta.' }),
      toggle({ path: 'draw.taper', label: 'Entradas y salidas afiladas' }),
      toggle({ path: 'draw.touch', label: 'Dibujar con el dedo',
        hint: 'Apagado, el dedo mueve la camara y solo la pluma dibuja (lo comodo en tableta).' }),
      notice('info', 'Si tu pluma trae boton de borrar, funciona como el borrador sin cambiar de herramienta.', 'eraser'),
    ]),
    group({ id: 'dib-salida', title: 'Ver y exportar', icon: 'image' }, [
      toggle({ path: 'draw.visible', label: 'Mostrar el dibujo' }),
      toggle({ path: 'draw.inShot', label: 'Incluirlo en la captura PNG' }),
      buttons([
        { label: 'Captura PNG', icon: 'image', onClick: () => actions.screenshot(false) },
        { label: 'Sin fondo', icon: 'crop', title: 'Fondo transparente', onClick: () => actions.screenshot(true) },
      ], { cols: 2 }),
      notice('info', 'El dibujo se queda pegado a la pantalla, no a la escena: al orbitar la camara los trazos no se mueven, como un papel de calco sobre el visor. No se guarda al recargar la pagina: exportalo con la captura PNG.', 'pencil'),
    ]),
  ];
}

/* ── 8 · Ajustes y rendimiento ─────────────────────────────────────────── */

function settingsPanel(app) {
  const { actions } = app;
  const kbd = (keys, what) =>
    el('div', { class: 'shortcut' }, [
      el('div', {}, keys.split('+').map((k) => el('kbd', { text: k.trim() }))),
      el('span', { text: what }),
    ]);

  return [
    group({ id: 'st-quality', title: 'Rendimiento', icon: 'gauge' }, [
      select({ label: 'Resolucion de render', path: 'quality.pixelRatio',
        options: [
          { value: 'auto', label: 'Automatica (pantalla)' },
          { value: '1', label: '1× (mas rapido)' },
          { value: '1.5', label: '1,5×' },
          { value: '2', label: '2× (mas nitido)' },
        ] }).root,
      select({ label: 'Mapa de sombras', path: 'quality.shadowMap',
        options: [512, 1024, 2048, 4096].map((n) => ({ value: n, label: n + ' px' })) }).root,
      toggle({ path: 'quality.antialias', label: 'Suavizado de bordes' }),
      toggle({ path: 'quality.ssao', label: 'Oclusion ambiental (SSAO)',
        hint: 'Oscurece los pliegues y da profundidad, a costa de fotogramas.' }),
      select({ label: 'Limite de fotogramas', path: 'quality.fpsCap',
        options: [
          { value: 0, label: 'Sin limite' },
          { value: 60, label: '60 fps' },
          { value: 30, label: '30 fps' },
          { value: 24, label: '24 fps' },
        ] }).root,
      toggle({ path: 'quality.showStats', label: 'Mostrar contador de fotogramas' }),
      toggle({ path: 'quality.compat', label: 'Modo compatible',
        hint: 'Sombras y efectos por la ruta mas simple de WebGL. Actívalo si el visor sale en negro o el navegador pierde el contexto grafico. Requiere recargar.' }),
    ]),
    group({ id: 'st-export', title: 'Exportar', icon: 'download' }, [
      buttons([
        { label: 'Captura PNG', icon: 'image', onClick: () => actions.screenshot(false) },
        { label: 'PNG sin fondo', icon: 'crop', title: 'Fondo transparente', onClick: () => actions.screenshot(true) },
      ], { cols: 2 }),
      buttons([
        { label: 'Copiar ajustes', icon: 'copy', title: 'Copia la configuracion actual al portapapeles',
          onClick: () => actions.copySettings() },
        { label: 'Restablecer todo', icon: 'trash-2', variant: 'danger',
          title: 'Vuelve a los valores por defecto', onClick: () => actions.resetAll() },
      ], { cols: 2 }),
    ]),
    group({ id: 'st-keys', title: 'Atajos de teclado', icon: 'keyboard', open: false }, [
      el('div', { class: 'shortcuts' }, [
        kbd('1 + 2 + 3', 'Anatomia · maniqui · esqueleto'),
        kbd('O', 'Perspectiva / ortografica'),
        kbd('P', 'Siguiente modo de guias de perspectiva'),
        kbd('B', 'Iniciar o detener la captura'),
        kbd('F', 'Encuadrar la figura'),
        kbd('G', 'Pose manual con tiradores'),
        kbd('D', 'Lapiz para dibujar sobre el visor'),
        kbd('Alt + arrastrar', 'Orbitar sin apagar el lapiz'),
        kbd('[ + ]', 'Grosor del lapiz'),
        kbd('H', 'Ocultar el panel lateral'),
        kbd('W + E + R', 'Gizmo: mover · girar · escalar'),
        kbd('Supr', 'Eliminar el elemento seleccionado'),
        kbd('Esc', 'Deseleccionar'),
        kbd('Alt + X', 'Ejes del mundo / locales'),
        kbd('Shift + R', 'Volver a la pose de reposo'),
        kbd('Space', 'Buscar una imagen de referencia'),
        kbd('C', 'Congelar la pose'),
        kbd('Ctrl + Z', 'Deshacer el ultimo giro'),
        kbd('Ctrl + S', 'Guardar captura PNG'),
      ]),
    ]),
    group({ id: 'st-about', title: 'Acerca de', icon: 'info', open: false }, [
      notice('info',
        '<b>ATOM</b> · Three.js + MediaPipe Pose Landmarker + Kalidokit, '
        + 'ejecutandose por completo en tu navegador.'),
      // Firma del autor: version en config.js para no repetir el numero.
      el('div', { class: 'credit' }, [
        icon('code-xml', 12),
        el('span', { class: 'credit-dev', text: 'Dev by ' + APP_AUTHOR }),
        el('span', { class: 'credit-ver', text: 'v' + APP_VERSION }),
      ]),
    ]),
  ];
}

/* ── Ensamblado ────────────────────────────────────────────────────────── */

/**
 * Construye las secciones del panel lateral.
 * @param {object} app contexto de la aplicacion (ajustes, modulos y acciones)
 * @returns {{id:string,title:string,icon:string,node:HTMLElement}[]}
 */
export function buildPanels(app) {
  app.hooks ??= {};
  const sections = [
    { id: 'figure', title: 'Figura', icon: 'person-standing', build: figurePanel },
    { id: 'scene', title: 'Escena', icon: 'shapes', build: scenePanel },
    { id: 'camera', title: 'Camara', icon: 'camera', build: cameraPanel },
    { id: 'light', title: 'Luz', icon: 'lightbulb', build: lightPanel },
    { id: 'mocap', title: 'Captura', icon: 'video', build: mocapPanel },
    { id: 'poses', title: 'Poses', icon: 'library', build: posesPanel },
    { id: 'guides', title: 'Guias', icon: 'pencil-ruler', build: guidesPanel },
    { id: 'draw', title: 'Dibujo', icon: 'pencil', build: drawPanel },
    { id: 'settings', title: 'Ajustes', icon: 'settings', build: settingsPanel },
  ];
  return sections.map(({ id, title, icon: ico, build }) => ({
    id, title, icon: ico,
    node: el('div', { class: 'panel', dataset: { panel: id } }, build(app)),
  }));
}
