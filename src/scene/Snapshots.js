/**
 * ATOM · Vistas guardadas (snapshots)
 * ---------------------------------------------------------------------------
 * Cada vista es un estado completo: todo lo que guarda el autoguardado más
 * el ángulo exacto de la cámara. Cambias lente, luz, material, pose… lo
 * guardas y luego saltas entre vistas como marcadores. Viajan dentro del
 * .atom porque viven en `settings.state.snapshots`.
 */

import { nuevoId } from '../core/ids.js';
import { libraryUrl } from '../model/FigureSet.js';

function deepClone(v) {
  if (typeof structuredClone === 'function') return structuredClone(v);
  return JSON.parse(JSON.stringify(v));
}

/**
 * Captura la vista actual.
 * @param {object} app
 * @param {string} name
 * @returns {object|null} snapshot creado
 */
export function captureSnapshot(app, name = '') {
  const { settings, figures, viewport, sketch } = app;
  try { figures?.snapshotPoses?.(); } catch { /* sin figuras */ }
  const raw = deepClone(settings.state);
  // No anidar vistas dentro de la vista (evita duplicar y bucle).
  delete raw.snapshots;
  const base = raw.scene?.figures?.length
    ? `Vista ${((settings.get('snapshots')?.length ?? 0) + 1)}`
    : 'Vista 1';
  const snap = {
    id: nuevoId(),
    name: String(name).trim() || base,
    created: Date.now(),
    state: raw,
    camera: null,
    sketch: null,
  };
  try {
    const cam = viewport?.cameras;
    if (cam) {
      snap.camera = {
        position: cam.active.position.toArray(),
        target: cam.controls.target.toArray(),
      };
    }
  } catch { /* sin viewport */ }
  try {
    if (sketch?.strokes?.length) snap.sketch = deepClone(sketch.strokes);
    else snap.sketch = [];
  } catch { /* sin dibujo */ }
  const list = [...(settings.get('snapshots') ?? []), snap];
  settings.set('snapshots', list);
  try { settings.save(); } catch { /* quota */ }
  return snap;
}

/** Aplica una vista por id. Devuelve true si se aplicó. */
export async function applySnapshot(app, id) {
  const { settings, figures, viewport } = app;
  const list = settings.get('snapshots') ?? [];
  const snap = list.find((s) => s.id === id);
  if (!snap?.state) return false;
  // snapshot.state no trae `snapshots` (se borró al capturar), así que
  // `replace` no toca la lista actual: el resto de vistas sobreviven.
  settings.replace(deepClone(snap.state));
  try { settings.save(); } catch { /* quota */ }
  try { await figures?.sync?.(); } catch { /* modelo no disponible */ }
  // Llevar modelo/pose/deformacion del snapshot al Character vivo.
  // `replace` escribe `model` y `pose` en el almacen pero el personaje vivo
  // no se actualiza solo: el modelo requiere `load` y la pose `setPose`
  // porque FigureSet ignora `pose` en #onPath.
  // Cambio de modelo: se recarga cada figura con el `model` del snapshot
  // (biblioteca). Los modelos externos (`model === ''`, File) mantienen lo que hay.
  // Se recarga siempre que el snapshot traiga id no vacío: `ch.load` usa
  // Three.Cache y si es el mismo glb no descarga de nuevo.
  try {
    const defs = settings.get('scene.figures') ?? [];
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
  } catch { /* pose no crítica */ }
  // Dibujo/trazo del snapshot: es el estado por vista, no global.
  try {
    const sk = snap.sketch;
    if (Array.isArray(sk)) {
      const sketch = app.sketch;
      if (sketch) {
        sketch.strokes = deepClone(sk);
        sketch.history = []; sketch.future = [];
        sketch.redraw?.();
      }
    }
  } catch { /* trazo no crítico */ }
  try {
    const cam = snap.camera;
    if (cam?.position && cam?.target && viewport?.cameras) {
      viewport.cameras.active.position.fromArray(cam.position);
      viewport.cameras.controls.target.fromArray(cam.target);
      viewport.cameras.controls.update();
      viewport.cameras.applyOrtho?.();
    }
  } catch { /* ángulo no crítico */ }
  viewport?.invalidateShadows?.();
  return true;
}

export function deleteSnapshot(app, id) {
  const { settings } = app;
  const list = settings.get('snapshots') ?? [];
  const next = list.filter((s) => s.id !== id);
  if (next.length === list.length) return false;
  settings.set('snapshots', next);
  try { settings.save(); } catch { /* quota */ }
  return true;
}

export function renameSnapshot(app, id, name) {
  const { settings } = app;
  const list = settings.get('snapshots') ?? [];
  const idx = list.findIndex((s) => s.id === id);
  if (idx < 0) return false;
  const clean = String(name).trim();
  if (!clean) return false;
  const next = list.slice();
  next[idx] = { ...next[idx], name: clean };
  settings.set('snapshots', next);
  try { settings.save(); } catch { /* quota */ }
  return true;
}

export function updateSnapshot(app, id) {
  const { settings, figures, viewport, sketch } = app;
  const list = settings.get('snapshots') ?? [];
  const idx = list.findIndex((s) => s.id === id);
  if (idx < 0) return null;
  try { figures?.snapshotPoses?.(); } catch { /* sin figuras */ }
  const raw = deepClone(settings.state);
  delete raw.snapshots;
  const snap = { ...list[idx] };
  snap.state = raw;
  try {
    const cam = viewport?.cameras;
    if (cam) snap.camera = { position: cam.active.position.toArray(), target: cam.controls.target.toArray() };
  } catch { /* sin viewport */ }
  try { snap.sketch = sketch?.strokes?.length ? deepClone(sketch.strokes) : []; } catch { snap.sketch = []; }
  snap.created = Date.now();
  const next = list.slice();
  next[idx] = snap;
  settings.set('snapshots', next);
  try { settings.save(); } catch { /* quota */ }
  return snap;
}
