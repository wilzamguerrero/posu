/**
 * POSU · Paneles del panel lateral
 * ---------------------------------------------------------------------------
 * Cada seccion se construye una sola vez y se enlaza al almacen de ajustes: los
 * controles no guardan estado, solo leen y escriben rutas. Las acciones que
 * necesitan tocar varios modulos (cargar un modelo, arrancar la camara, guardar
 * una pose) llegan por el objeto `app.actions`, que arma main.js.
 */

import {
  el, group, field, slider, toggle, segmented, select, color, vector3, buttons, notice, meter, listView, enableWhen,
  presetGrid, reactive,
} from './widgets.js';
import { icon } from './icons.js';
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
import { FINGERS, FINGER_LABELS } from '../model/boneMap.js';

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
  const { actions } = app;
  return [
    group({ id: 'fig-variant', title: 'Malla visible', icon: 'layers' }, [
      segmented({
        path: 'figure.variant',
        options: [
          { value: 'anatomia', label: 'Anatomia', icon: 'person-standing', title: 'Musculatura y piel' },
          { value: 'maniqui', label: 'Maniqui', icon: 'box', title: 'Volumenes de madera' },
          { value: 'esqueleto', label: 'Esqueleto', icon: 'bone', title: 'Estructura osea' },
        ],
        hint: 'Las tres mallas comparten el mismo esqueleto: la pose no se pierde al cambiar.',
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
    group({ id: 'fig-transform', title: 'Colocacion', icon: 'move' }, [
      slider({ label: 'Altura', path: 'figure.height', min: 1.2, max: 2.2, step: 0.01, unit: ' m' }),
      slider({ label: 'Giro', path: 'figure.turn', min: -180, max: 180, step: 1, unit: '°' }),
      segmented({
        label: 'Anclaje', path: 'figure.anchor',
        options: [
          { value: 'suelo', label: 'Al suelo' },
          { value: 'centro', label: 'Centrado' },
        ],
      }),
    ]),
    group({ id: 'fig-manos', title: 'Manos y dedos', icon: 'hand' }, [
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
    group({ id: 'fig-file', title: 'Modelo', icon: 'folder-open' }, [
      presetGrid({
        path: 'figure.model', cols: 2,
        options: MODEL_LIBRARY.map((m) => ({ value: m.id, label: m.label, icon: 'user', title: m.note })),
        onPick: (id) => actions.loadLibraryModel(id),
        hint: 'Todas comparten el esqueleto de Mixamo: la pose se conserva al cambiar de figura.',
      }),
      buttons([
        { label: 'Cargar .glb / .fbx', icon: 'upload', onClick: () => actions.loadModelFile() },
        { label: 'Restablecer', icon: 'refresh-cw', title: 'Vuelve al modelo incluido', onClick: () => actions.resetModel() },
      ], { cols: 2 }),
      notice('info', 'Tambien puedes <b>arrastrar</b> el archivo sobre el visor. Se admite el esqueleto estandar de Mixamo (<code>mixamorig…</code>).'),
    ]),
  ];
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

/* ── 1c · Escena: solidos y luces insertados ───────────────────────────── */

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
      'Nada seleccionado. Pincha un solido o una luz en el visor, o eligelo en la lista de arriba.')];
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
  ], { cols: 2, compact: true }));
  return out;
}

/** Panel de escena: insertar solidos y luces, manipularlos y listarlos. */
function scenePanel(app) {
  const { settings, actions } = app;

  const lista = listView({
    empty: 'Solo esta la figura. Inserta un solido o una luz para empezar.',
    onSelect: (item) => actions.selectItem?.(item.id),
    onDelete: (item) => actions.removeItem?.(item.id),
  });
  const pintarLista = () => lista.render(app.scene?.list?.() ?? [], settings.get('scene.selected'));
  // main.js llama a este gancho cuando la seleccion cambia desde el visor.
  app.hooks.refreshScene = pintarLista;
  settings.on(['scene.objects', 'scene.lights', 'scene.selected'], pintarLista);
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
        hint: 'Atajos: W mover, E girar, R escalar, Supr eliminar, Esc deseleccionar.',
      }),
      segmented({
        label: 'Ejes', path: 'scene.space',
        options: [
          { value: 'world', label: 'Mundo', icon: 'globe' },
          { value: 'local', label: 'Local', icon: 'box' },
        ],
        hint: 'Alt+X alterna entre los ejes del mundo y los del propio objeto.',
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
        { label: 'Duplicar', icon: 'copy', onClick: () => actions.duplicateItem?.(settings.get('scene.selected')) },
        { label: 'Vaciar escena', icon: 'trash-2', onClick: () => actions.clearScene?.() },
      ], { cols: 2, compact: true }),
    ]),
    group({ id: 'esc-item', title: 'Elemento seleccionado', icon: 'sliders-horizontal' }, [
      reactive(['scene.selected', 'scene.objects', 'scene.lights'], () => itemControls(app)),
    ]),
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
      toggle({ path: 'mocap.frozen', label: 'Congelar pose', hint: 'Mantiene la ultima pose detectada aunque te muevas.' }),
      toggle({ path: 'mocap.autoStart', label: 'Iniciar la camara al abrir' }),
      field('Confianza de la deteccion', conf),
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

  // Hueso seleccionado por el gizmo de pose manual.
  const boneTag = el('span', { class: 'value', text: '—' });
  const paintBone = (v) => { boneTag.textContent = v ? String(v).replace(/^mixamorig:?/, '') : '—'; };
  settings.on('ui.selectedBone', paintBone);
  paintBone(settings.get('ui.selectedBone'));

  return [
    group({ id: 'ps-manual', title: 'Pose manual', icon: 'hand' }, [
      toggle({ path: 'ui.manualPosing', label: 'Editar huesos con el raton',
        hint: 'Pulsa un tirador sobre la figura y gira el hueso; la captura se congela al editar.' }),
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

/* ── 7 · Ajustes y rendimiento ─────────────────────────────────────────── */

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
        kbd('H', 'Ocultar el panel lateral'),
        kbd('W + E + R', 'Gizmo: mover · girar · escalar'),
        kbd('Supr', 'Eliminar el elemento seleccionado'),
        kbd('Esc', 'Deseleccionar'),
        kbd('Alt + X', 'Ejes del mundo / locales'),
        kbd('Shift + R', 'Volver a la pose de reposo'),
        kbd('Space', 'Congelar la pose'),
        kbd('Ctrl + Z', 'Deshacer el ultimo giro'),
        kbd('Ctrl + S', 'Guardar captura PNG'),
      ]),
    ]),
    group({ id: 'st-about', title: 'Acerca de', icon: 'info', open: false }, [
      notice('info',
        '<b>POSU</b> · estudio de anatomia y dibujo del natural. Three.js + MediaPipe Pose Landmarker + Kalidokit, '
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
    { id: 'settings', title: 'Ajustes', icon: 'settings', build: settingsPanel },
  ];
  return sections.map(({ id, title, icon: ico, build }) => ({
    id, title, icon: ico,
    node: el('div', { class: 'panel', dataset: { panel: id } }, build(app)),
  }));
}
