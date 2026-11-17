/**
 * ATOM · Gizmo 2D proyectado para modos de perspectiva deformados
 * ---------------------------------------------------------------------------
 * Cuando la perspectiva curvilinea (4, 5, 6 puntos) o la curvatura/separacion
 * de fugas deforman la escena 3D en un shader de post-proceso, el gizmo WebGL
 * estándar de TransformControls se dibuja con la proyección lineal sin deformar
 * y queda desplazado del objeto en pantalla.
 *
 * Este modulo proyecta las flechas (mover), cubos (escalar) y anillos curvos
 * (girar) directamente mediante `Perspective.projectWorld` sobre el lienzo 2D
 * y resuelve el picking y el arrastre sobre rayos undeformed (`rayFromClient`).
 */
import * as THREE from 'three';

export const AXIS_COLORS = {
  X: '#ff5c5c',
  Y: '#6be272',
  Z: '#58a6ff',
  XYZ: '#e8edf5',
  E: '#ffd479',
};

const _d = new THREE.Vector3();
const _cR = new THREE.Vector3();
const _cU = new THREE.Vector3();
const _cF = new THREE.Vector3();
const _axX = new THREE.Vector3();
const _axY = new THREE.Vector3();
const _axZ = new THREE.Vector3();
const _axU = new THREE.Vector3();
const _axV = new THREE.Vector3();
const _hit = new THREE.Vector3();
const _qDelta = new THREE.Quaternion();
const _plane = new THREE.Plane();
const _ray = new THREE.Ray();

/** Distancia minima en pixeles entre el punto `(px,py)` y el segmento `(ax,ay)-(bx,by)`. */
export function distSeg2D(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  if (len2 < 1e-6) return Math.hypot(wx, wy);
  const t = THREE.MathUtils.clamp((wx * vx + wy * vy) / len2, 0, 1);
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}

/** Parametro `t` mas cercano en la recta `p0 + t * dir` respecto al rayo `ray`. */
export function axisParamFromRay(p0, dir, ray) {
  _d.copy(ray.origin).sub(p0);
  const b = dir.dot(ray.direction);
  const denom = 1 - b * b;
  if (Math.abs(denom) < 1e-4) return null;
  const c = dir.dot(_d);
  const f = ray.direction.dot(_d);
  return (b * f - c) / denom;
}

/** Calcula ejes mundo o locales de un transform y longitud de mundo para ~pxWanted px. */
export function computeGizmoAxes(quat, localSpace, out = { X: new THREE.Vector3(), Y: new THREE.Vector3(), Z: new THREE.Vector3() }) {
  if (localSpace) {
    out.X.set(1, 0, 0).applyQuaternion(quat).normalize();
    out.Y.set(0, 1, 0).applyQuaternion(quat).normalize();
    out.Z.set(0, 0, 1).applyQuaternion(quat).normalize();
  } else {
    out.X.set(1, 0, 0);
    out.Y.set(0, 1, 0);
    out.Z.set(0, 0, 1);
  }
  return out;
}

export function gizmoWorldLength(perspective, cam, p0, cssW, cssH, targetPx = 64) {
  const s0 = perspective.projectWorld(p0, cssW, cssH);
  if (!s0) return 0.35;
  _cR.set(1, 0, 0).applyQuaternion(cam.quaternion);
  const eps = Math.max(0.05, s0.dist * 0.07);
  _hit.copy(p0).addScaledVector(_cR, eps);
  let s1 = perspective.projectWorld(_hit, cssW, cssH);
  if (!s1) {
    _cU.set(0, 1, 0).applyQuaternion(cam.quaternion);
    _hit.copy(p0).addScaledVector(_cU, eps);
    s1 = perspective.projectWorld(_hit, cssW, cssH);
  }
  const px = s1 ? Math.hypot(s1.x - s0.x, s1.y - s0.y) : 0;
  const len = px > 1 ? eps * (targetPx / px) : Math.max(0.18, s0.dist * 0.16);
  return THREE.MathUtils.clamp(len, 0.06, Math.max(2.2, s0.dist * 0.45));
}

/** Construye geometria 2D del gizmo proyectado para pintar y hacer picking. */
export function buildWarpedGizmoScreen({
  perspective,
  cam,
  position,
  quaternion,
  mode = 'translate',
  localSpace = false,
  cssW,
  cssH,
  targetPx = 66,
}) {
  if (!perspective || !cam || !position) return null;
  const center = perspective.projectWorld(position, cssW, cssH);
  if (!center) return null;

  const L = gizmoWorldLength(perspective, cam, position, cssW, cssH, targetPx);
  computeGizmoAxes(quaternion, mode === 'scale' || localSpace, { X: _axX, Y: _axY, Z: _axZ });
  const axes = { X: _axX.clone(), Y: _axY.clone(), Z: _axZ.clone() };

  if (mode === 'rotate') {
    const rings = {};
    const sampleRing = (u, v, rad) => {
      const pts = [];
      const steps = 48;
      for (let i = 0; i <= steps; i += 1) {
        const a = (i / steps) * Math.PI * 2;
        _hit.copy(position).addScaledVector(u, Math.cos(a) * rad).addScaledVector(v, Math.sin(a) * rad);
        const s = perspective.projectWorld(_hit, cssW, cssH);
        pts.push(s ? { x: s.x, y: s.y } : null);
      }
      return pts;
    };
    for (const name of ['X', 'Y', 'Z']) {
      const n = axes[name];
      const ref = Math.abs(n.y) < 0.9 ? _cU.set(0, 1, 0) : _cR.set(1, 0, 0);
      _axU.crossVectors(n, ref).normalize();
      _axV.crossVectors(n, _axU).normalize();
      rings[name] = sampleRing(_axU, _axV, L);
    }
    _cR.set(1, 0, 0).applyQuaternion(cam.quaternion);
    _cU.set(0, 1, 0).applyQuaternion(cam.quaternion);
    rings.E = sampleRing(_cR, _cU, L * 1.18);
    return { mode, center, L, axes, rings };
  }

  const lines = {};
  for (const name of ['X', 'Y', 'Z']) {
    _hit.copy(position).addScaledVector(axes[name], L);
    const tip = perspective.projectWorld(_hit, cssW, cssH);
    if (tip) lines[name] = { x: tip.x, y: tip.y };
  }
  return { mode, center, L, axes, lines };
}

/** Devuelve el eje bajo `(px, py)` en CSS pixels, o `null`. */
export function pickWarpedGizmo2D(g, px, py, hitRadius = 14) {
  if (!g) return null;
  if (g.mode === 'rotate') {
    let best = null;
    let bestD = hitRadius;
    for (const name of ['X', 'Y', 'Z', 'E']) {
      const pts = g.rings[name];
      if (!pts) continue;
      for (let i = 1; i < pts.length; i += 1) {
        const a = pts[i - 1];
        const b = pts[i];
        if (!a || !b) continue;
        if (Math.hypot(b.x - a.x, b.y - a.y) > 120) continue;
        const d = distSeg2D(px, py, a.x, a.y, b.x, b.y);
        if (d < bestD) { bestD = d; best = name; }
      }
    }
    return best;
  }

  if (Math.hypot(px - g.center.x, py - g.center.y) <= hitRadius + 2) return 'XYZ';
  let best = null;
  let bestD = hitRadius;
  for (const name of ['X', 'Y', 'Z']) {
    const tip = g.lines[name];
    if (!tip) continue;
    const d = distSeg2D(px, py, g.center.x, g.center.y, tip.x, tip.y);
    if (d < bestD) { bestD = d; best = name; }
  }
  return best;
}

/** Pinta un gizmo 2D nitido en pixeles reales de pantalla. */
export function drawWarpedGizmo2D(ctx, g, activeAxis, dpr) {
  if (!ctx || !g) return;
  const cx = g.center.x * dpr;
  const cy = g.center.y * dpr;
  ctx.save();

  if (g.mode === 'rotate') {
    for (const name of ['X', 'Y', 'Z', 'E']) {
      const pts = g.rings[name];
      if (!pts) continue;
      const active = activeAxis === name;
      ctx.strokeStyle = active ? '#ffd479' : AXIS_COLORS[name];
      ctx.globalAlpha = name === 'E' ? (active ? 0.96 : 0.5) : (active ? 1 : 0.9);
      ctx.lineWidth = (active ? 3.2 : (name === 'E' ? 1.6 : 2.3)) * dpr;
      ctx.beginPath();
      let pen = false;
      let prev = null;
      for (const p of pts) {
        if (!p) { pen = false; prev = null; continue; }
        const x = p.x * dpr;
        const y = p.y * dpr;
        if (pen && prev && Math.hypot(x - prev.x, y - prev.y) > 120 * dpr) pen = false;
        if (!pen) { ctx.moveTo(x, y); pen = true; }
        else ctx.lineTo(x, y);
        prev = { x, y };
      }
      ctx.stroke();
    }
    ctx.restore();
    return;
  }

  for (const name of ['X', 'Y', 'Z']) {
    const tip = g.lines[name];
    if (!tip) continue;
    const tx = tip.x * dpr;
    const ty = tip.y * dpr;
    const active = activeAxis === name;
    const col = active ? '#ffd479' : AXIS_COLORS[name];

    ctx.strokeStyle = 'rgba(10, 14, 20, 0.85)';
    ctx.lineWidth = (active ? 5.2 : 4.2) * dpr;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(tx, ty);
    ctx.stroke();

    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.lineWidth = (active ? 3.2 : 2.4) * dpr;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(tx, ty);
    ctx.stroke();

    const ang = Math.atan2(ty - cy, tx - cx);
    if (g.mode === 'scale') {
      const s = 4.8 * dpr;
      ctx.fillRect(tx - s, ty - s, s * 2, s * 2);
    } else {
      const ah = 9.5 * dpr;
      ctx.beginPath();
      ctx.moveTo(tx + Math.cos(ang) * 2.5 * dpr, ty + Math.sin(ang) * 2.5 * dpr);
      ctx.lineTo(tx - Math.cos(ang - 0.45) * ah, ty - Math.sin(ang - 0.45) * ah);
      ctx.lineTo(tx - Math.cos(ang + 0.45) * ah, ty - Math.sin(ang + 0.45) * ah);
      ctx.closePath();
      ctx.fill();
    }
  }

  const cActive = activeAxis === 'XYZ';
  ctx.beginPath();
  ctx.arc(cx, cy, 9 * dpr, 0, Math.PI * 2);
  ctx.strokeStyle = cActive ? '#ffd479' : 'rgba(240, 245, 255, 0.92)';
  ctx.fillStyle = cActive ? 'rgba(255, 212, 121, 0.28)' : 'rgba(16, 22, 30, 0.5)';
  ctx.lineWidth = 1.8 * dpr;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** Inicia sesion de arrastre para cualquier Object3D usando la proyeccion deformada. */
export function createWarpedDragState({
  g,
  axis,
  object,
  cam,
  perspective,
  rect,
  clientX,
  clientY,
}) {
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  const startPos = object.position.clone();
  const startQuat = object.quaternion.clone();
  const startScale = object.scale.clone();

  _cF.copy(startPos).sub(cam.position).normalize();
  if (_cF.lengthSq() < 1e-6) cam.getWorldDirection(_cF);
  const viewDir = _cF.clone();

  let axisVec = null;
  let axisScreen = { x: 1, y: 0, len: 64 };
  let startParam = 0;
  let startAngle = 0;
  let ringU = null;
  let ringV = null;
  let startHit = null;

  const hasRay = perspective.rayFromClient(clientX, clientY, rect, _ray);

  if (axis === 'X' || axis === 'Y' || axis === 'Z') {
    axisVec = g.axes[axis].clone();
    if (g.lines?.[axis]) {
      const dx = g.lines[axis].x - g.center.x;
      const dy = g.lines[axis].y - g.center.y;
      const n = Math.hypot(dx, dy) || 1;
      axisScreen = { x: dx / n, y: dy / n, len: n };
    }
    if (g.mode === 'translate' && hasRay) {
      const t = axisParamFromRay(startPos, axisVec, _ray);
      if (t !== null) startParam = t;
    } else if (g.mode === 'rotate') {
      const ref = Math.abs(axisVec.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      ringU = new THREE.Vector3().crossVectors(axisVec, ref).normalize();
      ringV = new THREE.Vector3().crossVectors(axisVec, ringU).normalize();
      if (hasRay) {
        _plane.setFromNormalAndCoplanarPoint(axisVec, startPos);
        if (_ray.intersectPlane(_plane, _hit)) {
          _d.copy(_hit).sub(startPos);
          startAngle = Math.atan2(_d.dot(ringV), _d.dot(ringU));
        }
      }
    }
  } else if (axis === 'E' && g.mode === 'rotate') {
    axisVec = viewDir.clone().negate();
    startAngle = Math.atan2(py - g.center.y, px - g.center.x);
  } else if (axis === 'XYZ' && g.mode === 'translate' && hasRay) {
    _plane.setFromNormalAndCoplanarPoint(viewDir, startPos);
    if (_ray.intersectPlane(_plane, _hit)) startHit = _hit.clone();
  }

  return {
    mode: g.mode,
    axis,
    downX: clientX,
    downY: clientY,
    centerPx: { x: g.center.x, y: g.center.y },
    axisVec,
    axisScreen,
    viewDir,
    ringU,
    ringV,
    startPos,
    startQuat,
    startScale,
    startParam,
    startAngle,
    startHit,
  };
}

/** Aplica un movimiento del raton a `object` durante el arrastre deformado. */
export function stepWarpedDragState(d, {
  object,
  perspective,
  rect,
  clientX,
  clientY,
  snapT = null,
  snapR = null,
  snapS = null,
}) {
  if (!d || !object) return;
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  const hasRay = perspective.rayFromClient(clientX, clientY, rect, _ray);

  if (d.mode === 'translate') {
    if (d.axis === 'XYZ') {
      if (d.startHit && hasRay) {
        _plane.setFromNormalAndCoplanarPoint(d.viewDir, d.startPos);
        if (_ray.intersectPlane(_plane, _hit)) {
          object.position.copy(d.startPos).add(_hit).sub(d.startHit);
        }
      } else {
        const dx = (clientX - d.downX) * 0.005;
        const dy = -(clientY - d.downY) * 0.005;
        _cR.set(1, 0, 0).applyQuaternion(perspective.camera.quaternion);
        _cU.set(0, 1, 0).applyQuaternion(perspective.camera.quaternion);
        object.position.copy(d.startPos).addScaledVector(_cR, dx).addScaledVector(_cU, dy);
      }
      if (snapT) {
        object.position.x = Math.round(object.position.x / snapT) * snapT;
        object.position.y = Math.round(object.position.y / snapT) * snapT;
        object.position.z = Math.round(object.position.z / snapT) * snapT;
      }
      return;
    }
    if (d.axisVec) {
      let delta = null;
      if (hasRay && Math.abs(d.axisVec.dot(_ray.direction)) < 0.96) {
        const t = axisParamFromRay(d.startPos, d.axisVec, _ray);
        if (t !== null) delta = t - d.startParam;
      }
      if (delta === null) {
        const pxDelta = (clientX - d.downX) * d.axisScreen.x + (clientY - d.downY) * d.axisScreen.y;
        delta = (pxDelta / Math.max(20, d.axisScreen.len || 64)) * 0.5;
      }
      if (snapT) delta = Math.round(delta / snapT) * snapT;
      object.position.copy(d.startPos).addScaledVector(d.axisVec, delta);
    }
    return;
  }

  if (d.mode === 'scale') {
    let factor = 1;
    if (d.axis === 'XYZ') {
      const pxDelta = (clientX - d.downX) - (clientY - d.downY);
      factor = Math.exp(pxDelta / 90);
    } else {
      const pxDelta = (clientX - d.downX) * d.axisScreen.x + (clientY - d.downY) * d.axisScreen.y;
      factor = Math.exp(pxDelta / Math.max(36, d.axisScreen.len || 64));
    }
    if (snapS) factor = Math.max(0.05, Math.round(factor / snapS) * snapS);
    object.scale.copy(d.startScale);
    if (d.axis === 'XYZ') object.scale.multiplyScalar(factor);
    else if (d.axis === 'X') object.scale.x *= factor;
    else if (d.axis === 'Y') object.scale.y *= factor;
    else if (d.axis === 'Z') object.scale.z *= factor;
    return;
  }

  if (d.mode === 'rotate' && d.axisVec) {
    let angle = 0;
    if (d.axis === 'E') {
      const cur = Math.atan2(py - d.centerPx.y, px - d.centerPx.x);
      angle = -(cur - d.startAngle);
    } else if (d.ringU && d.ringV && hasRay && Math.abs(_ray.direction.dot(d.axisVec)) > 0.08) {
      _plane.setFromNormalAndCoplanarPoint(d.axisVec, d.startPos);
      if (_ray.intersectPlane(_plane, _hit)) {
        _d.copy(_hit).sub(d.startPos);
        angle = Math.atan2(_d.dot(d.ringV), _d.dot(d.ringU)) - d.startAngle;
      }
    } else {
      angle = ((clientX - d.downX) - (clientY - d.downY)) * 0.012;
    }
    if (snapR) angle = Math.round(angle / snapR) * snapR;
    _qDelta.setFromAxisAngle(d.axisVec, angle);
    object.quaternion.copy(d.startQuat).premultiply(_qDelta).normalize();
  }
}
