/**
 * ATOM · Guardado de escena .atom
 * ---------------------------------------------------------------------------
 * Exporta e importa la escena completa en un archivo .atom (JSON).
 * Incluye todo lo que guarda el autoguardado del navegador:
 *   figura/modelos, poses de cada figura, cámara/ángulo, luces, escenario,
 *   materiales, guías/encuadre y el resto de ajustes, para continuar
 *   exactamente donde se dejó.
 */

const ATOM_VERSION = 2;

function stamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Clon profundo suficiente para el estado. */
function deepClone(v) {
  if (typeof structuredClone === 'function') return structuredClone(v);
  return JSON.parse(JSON.stringify(v));
}

/**
 * Genera el contenido .atom a partir del estado actual.
 * Hace snapshot de las poses antes de leer el estado para no perder la pose viva.
 */
export function buildAtomPayload(app) {
  const { settings, figures, viewport, library, sketch } = app;
  try { figures?.snapshotPoses?.(); } catch { /* sin figuras */ }

  const state = deepClone(settings.state);
  const payload = {
    app: 'atom',
    kind: 'scene',
    version: ATOM_VERSION,
    created: Date.now(),
    state,
  };
  // Ángulo de cámara: no vive en los ajustes, hay que guardarlo aparte.
  try {
    const cam = viewport?.cameras;
    if (cam) {
      payload.camera = {
        position: cam.active.position.toArray(),
        target: cam.controls.target.toArray(),
      };
    }
  } catch { /* viewport aún no listo */ }
  // Biblioteca de poses (opcional): por si la escena depende de poses guardadas.
  try {
    const items = library?.items;
    if (Array.isArray(items) && items.length) payload.poses = deepClone(items);
  } catch { /* sin poses */ }
  // Trazos del lápiz (opcional)
  try {
    if (sketch?.strokes?.length) payload.sketch = deepClone(sketch.strokes);
  } catch { /* sin dibujo */ }
  return payload;
}

export function exportSceneAtom(app) {
  const payload = buildAtomPayload(app);
  const text = JSON.stringify(payload, null, 2);
  const blob = new Blob([text], { type: 'application/json' });
  downloadBlob(blob, `atom-escena-${stamp()}.atom`);
  return true;
}

function isAtomData(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.app !== 'atom') return false;
  if (data.kind && data.kind !== 'scene') return false;
  if (!data.state || typeof data.state !== 'object') return false;
  return true;
}

/**
 * Importa un .atom desde texto JSON.
 * Aplica el estado, restaura cámara/poses/dibujo y sincroniza figuras.
 * @returns {Promise<boolean>}
 */
export async function importSceneAtom(app, text) {
  let data = null;
  try { data = JSON.parse(text); } catch { return false; }
  if (!isAtomData(data)) return false;

  const { settings, figures, viewport, library, sketch } = app;

  // Import compatible: data.state puede ser el antiguo `state` sin `snapshots`
  // o un archivo cogido directamente de localStorage posu.settings.v1. Si
  // snapshots venían dentro del atom, los `state.snapshots` ya los restaura;
  // si no, se conservan los locales (mergeKnown no borra claves ausentes).
  // Si el atom trae `snapshots` en raíz (futuro), también se aplican.
  if (Array.isArray(data.snapshots) && !Array.isArray(data.state?.snapshots)) {
    data.state.snapshots = deepClone(data.snapshots);
  }
  // Aplicar estado completo. `replace` solo toca claves conocidas (mergeKnown),
  // así que un .atom antiguo no rompe claves nuevas.
  settings.replace(deepClone(data.state));
  // Guardado inmediato para que recargar mantenga lo importado.
  try { settings.save(); } catch { /* quota */ }

  // Sincronizar figuras (carga modelos/poses). Es asíncrono: hay que esperar.
  try { await figures?.sync?.(); } catch { /* carga fallida: sigue */ }
  // Llevar modelo+pose del .atom al personaje vivo: `replace` escribe
  // `scene.figures[N].{model,pose}` pero `model` necesita `ch.load` y `pose`
  // necesita `ch.setPose` porque FigureSet ignora `pose` en #onPath.
  // Los modelos externos (`model === ''`) no se rehidratan (eran File), se
  // mantienen como están. Los de biblioteca se recargan por id con Cache.
  try {
    const defs = settings.get('scene.figures') ?? [];
    const { libraryUrl } = await import('../model/FigureSet.js');
    for (const def of defs) {
      const ch = figures?.get?.(def.id);
      if (!ch) continue;
      const want = String(def.model ?? '');
      if (want === '') continue;
      try { await ch.load(libraryUrl(want)); figures?.applyDef?.(def.id); } catch { /* modelo no disponible */ }
    }
    try { await figures?.sync?.(); } catch { /* sin figuras */ }
    for (const def of (settings.get('scene.figures') ?? [])) {
      const ch = figures?.get?.(def.id);
      if (!ch?.loaded) continue;
      if (def.pose?.rotations) { ch.setPose(def.pose, 1); ch.refreshBounds(); }
      else { ch.resetToRest(); ch.clearDeform(); ch.refreshBounds(); }
    }
    try { for (const ch of figures?.all?.() ?? []) ch.tick?.(); } catch { /* sin figuras */ }
  } catch { /* modelo/pose no crítico */ }

  // Restaurar ángulo de cámara si venía en el archivo.
  try {
    const cam = data.camera;
    if (cam?.position && cam?.target && viewport?.cameras) {
      viewport.cameras.active.position.fromArray(cam.position);
      viewport.cameras.controls.target.fromArray(cam.target);
      viewport.cameras.controls.update();
      viewport.cameras.applyOrtho?.();
    }
  } catch { /* cámara no crítica */ }

  // Restaurar poses de biblioteca si había.
  try {
    if (Array.isArray(data.poses) && library) {
      library.items = deepClone(data.poses);
      try { localStorage.setItem('posu.poses.v1', JSON.stringify(library.items)); } catch { /* quota */ }
      library.onChange?.(library.items);
      app.hooks?.refreshPoses?.();
    }
  } catch { /* poses opcionales */ }

  // Restaurar dibujo si había.
  try {
    if (Array.isArray(data.sketch) && sketch && data.sketch.length) {
      sketch.strokes = deepClone(data.sketch);
      sketch.history = [];
      sketch.future = [];
      sketch.redraw?.();
      sketch.onChange?.();
    }
  } catch { /* dibujo opcional */ }

  // Re-encuadrar si la cámara no traía ángulo (compatibilidad v1)
  if (!data.camera) {
    try { app.actions?.frameFigure?.(); } catch { /* sin figura */ }
  }

  app.hooks?.refreshSnapshots?.();
  viewport?.invalidateShadows?.();
  return true;
}

/**
 * Abre el selector de archivos para .atom y resuelve con el archivo elegido.
 */
export function pickAtomFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.atom,application/json';
    input.style.display = 'none';
    input.addEventListener('change', () => {
      resolve(input.files?.[0] ?? null);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

export const SCENE_ATOM_VERSION = ATOM_VERSION;
