/**
 * ATOM · Agente compositor de escena 3D
 * ---------------------------------------------------------------------------
 * Construye el prompt de sistema con el estado vivo de la escena (figuras,
 * solidos, luces, camara, guias y escenario) y ejecuta bloques estructurados
 * `<atom_actions>[...]</atom_actions>` sobre la aplicacion sin recargar nada.
 *
 * Incluye soporte para analizar bocetos o capturas del visor cuando el usuario
 * adjunta una imagen: interpreta cantidad de figuras, distribucion espacial,
 * poses, angulo focal y luz para plasmarlos en el escenario 3D.
 */
import * as THREE from 'three';
import { DEFAULTS, LIGHT_PRESETS, VIEW_PRESETS } from '../config.js';
import { BONE_ALIASES } from '../model/boneMap.js';
import { HAND_PRESET_BY_ID } from '../model/HandRig.js';
import { PRIMITIVE_BY_ID } from '../scene/primitives.js';
import { LIGHT_BY_ID } from '../scene/lights.js';

const DEG = Math.PI / 180;
const _qBasis = new THREE.Quaternion();
const _qBasisInv = new THREE.Quaternion();
const _qDelta = new THREE.Quaternion();
const _qWorld = new THREE.Quaternion();
const _qParentInv = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

const BONE_ORDER = [
  'hips', 'spine', 'spine1', 'spine2', 'neck', 'head',
  'leftShoulder', 'leftArm', 'leftForeArm', 'leftHand',
  'rightShoulder', 'rightArm', 'rightForeArm', 'rightHand',
  'leftUpLeg', 'leftLeg', 'leftFoot', 'leftToe',
  'rightUpLeg', 'rightLeg', 'rightFoot', 'rightToe',
];

/** Presets anatomicos en grados en el marco del cuerpo (+Y arriba, +Z frente, +X izq). */
export const AI_POSE_PRESETS = {
  t: { label: 'Pose T', bones: {} },
  a: {
    label: 'Pose A',
    bones: {
      leftArm: { rz: -45 },
      rightArm: { rz: 45 },
    },
  },
  relajada: {
    label: 'Relajada',
    bones: {
      spine: { rx: 3 },
      head: { rx: 4 },
      leftArm: { rz: -72, ry: -8 },
      leftForeArm: { ry: -18 },
      rightArm: { rz: 72, ry: 8 },
      rightForeArm: { ry: 18 },
      leftUpLeg: { rz: -3, rx: -2 },
      leftLeg: { rx: 5 },
      rightUpLeg: { rz: 3, rx: 2 },
      rightLeg: { rx: 6 },
    },
  },
  contrapposto: {
    label: 'Contrapposto',
    bones: {
      hips: { rz: -6, ry: -10, yOffset: -0.02 },
      spine: { rz: 5, rx: 2 },
      spine2: { rz: 4, ry: 12 },
      head: { ry: -10, rx: 5, rz: -3 },
      leftArm: { rz: -74, ry: -12 },
      leftForeArm: { ry: -26 },
      rightArm: { rz: 66, ry: 16 },
      rightForeArm: { ry: 48, rz: -10 },
      leftUpLeg: { rx: -8, rz: -4, ry: 10 },
      leftLeg: { rx: 14 },
      rightUpLeg: { rx: 12, rz: 6, ry: -12 },
      rightLeg: { rx: 28 },
    },
  },
  caminando: {
    label: 'Caminando',
    bones: {
      hips: { ry: -8, yOffset: -0.03 },
      spine: { rx: 6, ry: 6 },
      spine2: { ry: 12 },
      head: { rx: -4, ry: -8 },
      leftArm: { rz: -68, ry: -28 },
      leftForeArm: { ry: -32 },
      rightArm: { rz: 68, ry: -24 },
      rightForeArm: { ry: 22 },
      leftUpLeg: { rx: -32 },
      leftLeg: { rx: 18 },
      leftFoot: { rx: -10 },
      rightUpLeg: { rx: 24 },
      rightLeg: { rx: 36 },
      rightFoot: { rx: 22 },
    },
  },
  corriendo: {
    label: 'Corriendo',
    bones: {
      hips: { rx: 12, yOffset: -0.08 },
      spine: { rx: 14, ry: -10 },
      spine2: { rx: 10, ry: -14 },
      head: { rx: -18, ry: 16 },
      leftArm: { rz: -55, ry: -45 },
      leftForeArm: { ry: -85 },
      rightArm: { rz: 55, ry: -35 },
      rightForeArm: { ry: 85 },
      leftUpLeg: { rx: -58 },
      leftLeg: { rx: 75 },
      rightUpLeg: { rx: 38 },
      rightLeg: { rx: 88 },
    },
  },
  sentada: {
    label: 'Sentada',
    bones: {
      hips: { yOffset: -0.42 },
      spine: { rx: 6 },
      spine2: { rx: 4 },
      head: { rx: -4 },
      leftArm: { rz: -66, ry: -24 },
      leftForeArm: { ry: -44 },
      rightArm: { rz: 66, ry: 24 },
      rightForeArm: { ry: 44 },
      leftUpLeg: { rx: -86, rz: -5 },
      leftLeg: { rx: 88 },
      rightUpLeg: { rx: -86, rz: 5 },
      rightLeg: { rx: 88 },
    },
  },
  salto: {
    label: 'Salto',
    bones: {
      hips: { rx: 8, yOffset: 0.32 },
      spine: { rx: -10 },
      spine2: { rx: -12 },
      head: { rx: 10 },
      leftArm: { rz: 40, ry: -25 },
      leftForeArm: { ry: -35 },
      rightArm: { rz: -42, ry: 25 },
      rightForeArm: { ry: 35 },
      leftUpLeg: { rx: -65, rz: -8 },
      leftLeg: { rx: 95 },
      rightUpLeg: { rx: 18, rz: 8 },
      rightLeg: { rx: 52 },
    },
  },
  guardia: {
    label: 'En guardia / accion',
    bones: {
      hips: { ry: -38, yOffset: -0.09 },
      spine: { rx: 12, ry: 14 },
      spine2: { rx: 8, ry: 16 },
      head: { rx: -8, ry: 22 },
      leftArm: { rz: -42, ry: -58 },
      leftForeArm: { ry: -98 },
      rightArm: { rz: 48, ry: 46 },
      rightForeArm: { ry: 95 },
      leftUpLeg: { rx: -44, rz: -12 },
      leftLeg: { rx: 52 },
      rightUpLeg: { rx: 28, rz: 14 },
      rightLeg: { rx: 42 },
    },
  },
  senalar: {
    label: 'Senalando al frente',
    bones: {
      hips: { ry: -12 },
      spine2: { ry: 16 },
      head: { ry: -4, rx: -2 },
      leftArm: { rz: -72, ry: -8 },
      leftForeArm: { ry: -20 },
      rightArm: { rz: 2, ry: 82 },
      rightForeArm: { ry: 10 },
      leftUpLeg: { rx: -6 },
      leftLeg: { rx: 12 },
      rightUpLeg: { rx: 8 },
      rightLeg: { rx: 14 },
    },
  },
  pensativa: {
    label: 'Pensativa',
    bones: {
      hips: { rz: -4, ry: 8 },
      spine: { rx: 6 },
      head: { rx: 14, rz: 6 },
      leftArm: { rz: -64, ry: -34 },
      leftForeArm: { ry: -68 },
      rightArm: { rz: -44, ry: 52 },
      rightForeArm: { ry: 108 },
      leftUpLeg: { rx: -4, rz: -4 },
      leftLeg: { rx: 10 },
      rightUpLeg: { rx: 8, rz: 4 },
      rightLeg: { rx: 14 },
    },
  },
  brazos_cruzados: {
    label: 'Brazos cruzados',
    bones: {
      spine: { rx: -4 },
      head: { rx: 4, ry: -6 },
      leftArm: { rz: -54, ry: -44 },
      leftForeArm: { ry: -96 },
      rightArm: { rz: 54, ry: 44 },
      rightForeArm: { ry: 96 },
      leftUpLeg: { rz: -4 },
      rightUpLeg: { rz: 4 },
    },
  },
  rodilla_tierra: {
    label: 'Rodilla en tierra',
    bones: {
      hips: { rx: 8, yOffset: -0.52 },
      spine: { rx: 10 },
      head: { rx: -12 },
      leftArm: { rz: -62, ry: -30 },
      leftForeArm: { ry: -55 },
      rightArm: { rz: 66, ry: 15 },
      rightForeArm: { ry: 32 },
      leftUpLeg: { rx: -88, rz: -8 },
      leftLeg: { rx: 90 },
      rightUpLeg: { rx: 12, rz: 8 },
      rightLeg: { rx: 84 },
    },
  },
  agachada: {
    label: 'Agachada',
    bones: {
      hips: { rx: 22, yOffset: -0.56 },
      spine: { rx: 24 },
      spine2: { rx: 16 },
      head: { rx: -28 },
      leftArm: { rz: -56, ry: -38 },
      leftForeArm: { ry: -64 },
      rightArm: { rz: 56, ry: 38 },
      rightForeArm: { ry: 64 },
      leftUpLeg: { rx: -108, rz: -12 },
      leftLeg: { rx: 124 },
      rightUpLeg: { rx: -102, rz: 12 },
      rightLeg: { rx: 118 },
    },
  },
  accion_heroica: {
    label: 'Accion heroica',
    bones: {
      hips: { ry: -24, rx: 10, yOffset: -0.14 },
      spine: { rx: 14, ry: 14 },
      spine2: { rx: 8, ry: 18 },
      head: { rx: -14, ry: 16 },
      leftArm: { rz: -28, ry: -54 },
      leftForeArm: { ry: -46 },
      rightArm: { rz: 48, ry: -35 },
      rightForeArm: { ry: 54 },
      leftUpLeg: { rx: -52, rz: -14 },
      leftLeg: { rx: 56 },
      rightUpLeg: { rx: 32, rz: 14 },
      rightLeg: { rx: 24 },
    },
  },
};

export const ATOM_QUICK_SEEDS = [
  {
    id: 'two-figures-dramatic',
    label: 'Montar escena de 2 personajes dialogando con luz Rembrandt',
    prompt: 'Coloca 2 figuras frente a frente a 1.3 m de distancia en pose contrapposto y pensativa, encuadre tres cuartos 50 mm y luz Rembrandt.',
  },
  {
    id: 'action-perspective',
    label: 'Composicion dinamica de accion con perspectiva de 3 puntos',
    prompt: 'Prepara una composicion dinamica de accion heroica: 24 mm, vista contrapicada, guias de 3 puntos con deformacion activa y luz a contraluz.',
  },
  {
    id: 'study-mannequin',
    label: 'Modo estudio de dibujo (maniqui arcilla + contorno + regla 8 cabezas)',
    prompt: 'Configura la escena para estudio de dibujo clasico: variante maniqui en arcilla con contorno suave, luz lateral y guia de 8 cabezas.',
  },
  {
    id: 'sketch-hint',
    label: 'Analizar un boceto (adjunta o pega imagen y pide que recree la escena)',
    prompt: 'Analiza la imagen/boceto adjunto: detecta cuantas personas hay, su posicion aproximada en la escena, su pose corporal y el encuadre de camara, y reconstruye toda la escena en ATOM.',
  },
];

/* ── Prompt de sistema con estado actual de ATOM ─────────────────────────── */

export function buildAtomSystemPrompt(app) {
  const s = app?.settings;
  const figures = s?.get('scene.figures') ?? [];
  const activeId = s?.get('figure.active') ?? '';
  const objects = s?.get('scene.objects') ?? [];
  const lights = s?.get('scene.lights') ?? [];
  const persp = s?.get('guides.perspective') ?? DEFAULTS.guides.perspective;
  const light = s?.get('light') ?? DEFAULTS.light;
  const cam = s?.get('camera') ?? DEFAULTS.camera;
  const figStyle = s?.get('figure') ?? DEFAULTS.figure;

  const figLines = figures.map((f, idx) => {
    const p = f.position ?? { x: 0, y: 0, z: 0 };
    const r = f.rotation ?? { x: 0, y: 0, z: 0 };
    return `  ${idx + 1}. "${f.name}" (id=${f.id}${f.id === activeId ? ', ACTIVA' : ''}) pos=[${p.x},${p.y},${p.z}] rotY=${r.y ?? 0}° alt=${f.height ?? 1.75}m`;
  }).join('\n') || '  (ninguna)';

  const objLines = objects.map((o, idx) =>
    `  ${idx + 1}. "${o.name}" (${o.type}, id=${o.id}) pos=[${o.position?.x ?? 0},${o.position?.y ?? 0},${o.position?.z ?? 0}]`,
  ).join('\n') || '  (ninguno)';

  const sceneLightLines = lights.map((l, idx) =>
    `  ${idx + 1}. "${l.name}" (${l.type}, int=${l.intensity}, color=${l.color})`,
  ).join('\n') || '  (solo tripode de estudio)';

  return [
    'Eres ATOM IA, asistente experto en anatomia artistica, composicion 3D, perspectiva, iluminacion y direccion de escena integrado dentro de ATOM.',
    'Responde siempre en español claro y conciso. Cuando el usuario adjunte un boceto, foto o referencia visual:',
    '1) Identifica exactamente cuantas personas/figuras aparecen en el boceto (maximo 8), sus proporciones/alturas relativas, ubicacion en el plano (izquierda/centro/derecha, primer plano o fondo en metros [x,y,z]), hacia donde miran (rotation.y en grados: 0=hacia +Z camara, 90=mira +X izquierda, -90=mira -X derecha, 180=de espaldas), y la pose aproximada de torso, cabeza, brazos y piernas.',
    '2) Identifica tambien el angulo de camara (focal mm, altura/picado/contrapicado, inclinacion roll), perspectiva y tipo de iluminacion.',
    '3) Ejecuta los cambios directamente en la escena 3D emitiendo UN bloque al final de tu respuesta con formato exacto:',
    '<atom_actions>[ ...acciones JSON validas... ]</atom_actions>',
    '',
    'ESTADO ACTUAL DEL ESTUDIO:',
    `- Figuras (${figures.length}/8):\n${figLines}`,
    `- Aspecto figura: variant=${figStyle.variant}, shading=${figStyle.shading}`,
    `- Solidos extra (${objects.length}):\n${objLines}`,
    `- Luces extra (${lights.length}):\n${sceneLightLines}`,
    `- Luz estudio: preset=${light.preset}, key=(int:${light.key?.intensity}, color:${light.key?.color}), ambient=${light.ambient?.intensity}`,
    `- Camara: projection=${cam.projection}, focalLength=${cam.focalLength}mm, roll=${cam.roll}°`,
    `- Perspectiva: mode=${persp.mode}, warp=${Boolean(persp.warp)}, horizon=${Boolean(persp.horizon)}`,
    '',
    'ACCIONES SOPORTADAS EN <atom_actions> (JSON array de objetos):',
    `1. { "type": "set_figure_count", "count": 1..8 } -> Ajusta la cantidad exacta de figuras en escena (crea o quita).`,
    `2. { "type": "add_figure", "name"?: "Modelo 2", "position"?: {x,y,z}, "rotationY"?: grados, "height"?: metros, "pose"?: preset, "bones"?: {...} }`,
    `3. { "type": "update_figure", "figureIndex"?: 1..8, "name"?: string, "position"?: {x,y,z}, "rotation"?: {x,y,z} | number, "rotationY"?: number, "scale"?: number, "height"?: 0.5..3, "anchor"?: "suelo"|"centro"|"libre", "visible"?: bool, "active"?: bool }`,
    `4. { "type": "remove_figure", "figureIndex": 1..8 }`,
    `5. { "type": "pose_figure", "figureIndex"?: 1..8, "preset"?: "${Object.keys(AI_POSE_PRESETS).join('|')}", "bones"?: { "leftArm": {"rx":0,"ry":0,"rz":0}, ... }, "hipsOffset"?: metrosY, "hands"?: "${Object.keys(HAND_PRESET_BY_ID).join('|')}", "leftHand"?: preset, "rightHand"?: preset }`,
    `   Huesos validos: hips, spine, spine1, spine2, neck, head, leftShoulder, leftArm, leftForeArm, leftHand, rightShoulder, rightArm, rightForeArm, rightHand, leftUpLeg, leftLeg, leftFoot, rightUpLeg, rightLeg, rightFoot.`,
    `   Sistema de angulos en marco cuerpo (+Y arriba, +Z frente, +X lado izquierdo del personaje): rx+=inclinar adelante, ry+=girar a la izquierda, rz+=inclinar hacia la derecha del personaje. En brazos (T-pose horizontal): leftArm rz=-72 baja el brazo izq; rightArm rz=+72 baja el brazo der; ry gira adelante/atras. En piernas (cuelgan -Y): rx negativo sube pierna adelante.`,
    `6. { "type": "add_object", "kind": "${Object.keys(PRIMITIVE_BY_ID).join('|')}", "name"?: string, "position"?: {x,y,z}, "rotation"?: {x,y,z}, "scale"?: {x,y,z}|number, "params"?: {ancho?,alto?,fondo?,radio?}, "color"?: "#hex", "preset"?: "yeso|madera|metal|marmol|arcilla|vidrio|toon|cell" }`,
    `7. { "type": "clear_objects" } -> Elimina todos los solidos extra.`,
    `8. { "type": "set_lighting", "preset"?: "${Object.keys(LIGHT_PRESETS).join('|')}", "ambient"?: {"intensity"?:n,"color"?:"#hex"}, "env"?: number, "key"?: {"x"?:n,"y"?:n,"z"?:n,"intensity"?:n,"color"?:"#hex"}, "fill"?: {"enabled"?:bool,"intensity"?:n,"color"?:"#hex"}, "rim"?: {"enabled"?:bool,"intensity"?:n,"color"?:"#hex"} }`,
    `9. { "type": "add_light", "kind": "${Object.keys(LIGHT_BY_ID).join('|')}", "position"?: {x,y,z}, "color"?: "#hex", "intensity"?: number }`,
    `10. { "type": "clear_lights" }`,
    `11. { "type": "set_camera", "view"?: "${Object.keys(VIEW_PRESETS).join('|')}", "projection"?: "perspectiva|ortografica", "focalLength"?: 12..250, "roll"?: -180..180, "shiftH"?: -0.5..0.5, "shiftV"?: -0.5..0.5, "exposure"?: 0.2..3, "position"?: [x,y,z], "target"?: [x,y,z], "frame"?: true }`,
    `12. { "type": "set_guides", "perspective"?: { "mode"?: "ninguno|1punto|2puntos|3puntos|4puntos|5puntos|6puntos", "warp"?: bool, "pointSpread"?: 0.25..2.5, "fov4"?: number, "fov5"?: number, "fov6"?: number, "scale"?: number, "curvature"?: -1..1, "horizon"?: bool, "points"?: bool, "floorGrid"?: bool, "wallGrid"?: bool }, "action"?: { "line"?: bool, "arms"?: bool, "legs"?: bool, "shoulders"?: bool, "hips"?: bool, "ghost"?: bool }, "thirds"?: bool, "golden"?: bool, "symmetry"?: bool, "horizon"?: bool, "diagonals"?: bool, "heads"?: bool, "headCount"?: number, "safeFrame"?: string }`,
    `13. { "type": "set_stage", "background"?: "degradado|solido|ciclorama", "bgColor"?: "#hex", "floor"?: bool, "floorColor"?: "#hex", "grid"?: bool, "shadowStrength"?: 0..1 }`,
    `14. { "type": "set_appearance", "variant"?: "anatomia|maniqui|esqueleto", "shading"?: "textura|arcilla|wireframe|rayosx|toon|normales", "clayColor"?: "#hex", "outline"?: {"enabled"?:bool,"thickness"?:number,"color"?:"#hex"} }`,
    '',
    'REGLAS:',
    '- Usa coordenadas en metros reales: suelo en Y=0, figura estandar de pie en [0,0,0] mide 1.75 m. Para 2 personas lado a lado usa X=-0.75 y X=+0.75 (o segun el boceto). Para primer plano + fondo varia Z (ej. Z=+1.4 y Z=-1.2).',
    '- No inventes tipos de accion fuera de la lista.',
    '- Incluye siempre explicacion breve antes del bloque <atom_actions>.',
  ].join('\n');
}

/* ── Extraccion tolerante de <atom_actions> ──────────────────────────────── */

export function extractAtomActions(rawText) {
  const regex = /<atom_actions>\s*([\s\S]*?)\s*<\/atom_actions>/gi;
  const collected = [];
  let match;
  while ((match = regex.exec(rawText)) !== null) {
    let payload = match[1].trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    try {
      const parsed = JSON.parse(payload);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item === 'object') collected.push(item);
        }
      } else if (parsed && typeof parsed === 'object') {
        collected.push(parsed);
      }
    } catch {
      // Bloque JSON malformado ignorado sin romper la respuesta visible
    }
  }
  const cleanText = rawText
    .replace(/<atom_actions>[\s\S]*?<\/atom_actions>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { cleanText, actions: collected };
}

/* ── Aplicacion de poses en marco de cuerpo (+Y arriba, +Z frente) ───────── */

function resolveBoneKey(name) {
  if (!name) return '';
  if (Object.hasOwn(BONE_ALIASES, name)) return name;
  const lower = String(name).trim().toLowerCase();
  for (const key of Object.keys(BONE_ALIASES)) {
    if (key.toLowerCase() === lower) return key;
  }
  return '';
}

function clampDeg(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-175, Math.min(175, n));
}

/**
 * Aplica una pose declarativa (preset + ajustes finos de huesos) a un Character.
 * Exportada para probarla unitariamente en tests/ai.test.mjs.
 */
export function applyPoseRecipeToCharacter(ch, { preset = '', bones = null, hipsOffset = null, reset = true } = {}) {
  if (!ch || !ch.bones) return false;
  if (reset && typeof ch.resetToRest === 'function') ch.resetToRest();

  const recipe = preset && AI_POSE_PRESETS[preset] ? AI_POSE_PRESETS[preset] : null;
  const mergedBones = { ...(recipe?.bones ?? {}) };
  if (bones && typeof bones === 'object') {
    for (const [rawKey, spec] of Object.entries(bones)) {
      const key = resolveBoneKey(rawKey);
      if (!key || typeof spec !== 'object' || spec === null) continue;
      mergedBones[key] = { ...(mergedBones[key] ?? {}), ...spec };
    }
  }

  // Soporte de desplazamiento vertical de cadera (sentadilla, rodilla, salto)
  const explicitY = hipsOffset !== null && hipsOffset !== undefined && Number.isFinite(Number(hipsOffset))
    ? Number(hipsOffset)
    : null;
  const presetY = mergedBones.hips?.yOffset !== undefined && Number.isFinite(Number(mergedBones.hips?.yOffset))
    ? Number(mergedBones.hips.yOffset)
    : null;
  const yOff = explicitY ?? presetY;

  if (yOff !== null && ch.bones.hips) {
    const basePos = ch.restHipsLocal ?? ch.bones.hips.position.clone();
    ch.root?.updateMatrixWorld?.(true);
    const parentScaleY = ch.bones.hips.parent
      ? ch.bones.hips.parent.getWorldScale(new THREE.Vector3()).y
      : (ch.holder?.scale?.y || 1) * (ch.sourceScale || 1);
    ch.bones.hips.position.y = basePos.y + yOff / Math.max(0.0005, Math.abs(parentScaleY));
  }

  _qBasis.copy(ch.basis ?? new THREE.Quaternion());
  _qBasisInv.copy(_qBasis).invert();

  const orderedKeys = [
    ...BONE_ORDER.filter((k) => k in mergedBones),
    ...Object.keys(mergedBones).filter((k) => !BONE_ORDER.includes(k)),
  ];

  for (const key of orderedKeys) {
    const spec = mergedBones[key];
    if (!spec || typeof spec !== 'object') continue;
    const bone = ch.bones[key];
    const restWorld = ch.rest?.world?.get(bone);
    if (!bone || !restWorld) continue;

    const rx = clampDeg(spec.rx ?? spec.x ?? 0) * DEG;
    const ry = clampDeg(spec.ry ?? spec.y ?? 0) * DEG;
    const rz = clampDeg(spec.rz ?? spec.z ?? 0) * DEG;
    if (Math.abs(rx) < 1e-5 && Math.abs(ry) < 1e-5 && Math.abs(rz) < 1e-5) continue;

    _euler.set(rx, ry, rz, 'YXZ');
    _qDelta.setFromEuler(_euler);
    // Transforma delta del marco corporal (+Y arriba, +Z frente) al espacio del modelo
    _qDelta.premultiply(_qBasis).multiply(_qBasisInv);
    _qWorld.copy(_qDelta).multiply(restWorld);

    const parent = bone.parent;
    if (parent && ch.rest?.world?.has(parent)) {
      _qParentInv.copy(ch.rest.world.get(parent)).invert();
    } else if (ch.rest?.local?.has(bone)) {
      _qParentInv.copy(ch.rest.local.get(bone)).multiply(_qParentInv.copy(restWorld).invert());
    } else {
      _qParentInv.identity();
    }
    bone.quaternion.copy(_qParentInv).multiply(_qWorld);
  }

  ch.root?.updateMatrixWorld?.(true);
  return true;
}

/* ── Resolucion de figura objetivo ───────────────────────────────────────── */

function resolveFigureDef(app, action) {
  const defs = app?.figures?.defs ?? app?.settings?.get('scene.figures') ?? [];
  if (!defs.length) return null;
  if (typeof action.figureId === 'string' && action.figureId) {
    return defs.find((d) => d.id === action.figureId) ?? null;
  }
  if (typeof action.figureIndex === 'number' && Number.isFinite(action.figureIndex)) {
    const idx = Math.max(0, Math.min(defs.length - 1, Math.round(action.figureIndex) - 1));
    return defs[idx] ?? null;
  }
  if (typeof action.figure === 'string' && action.figure.trim()) {
    const q = action.figure.trim().toLowerCase();
    const byName = defs.find((d) => (d.name || '').toLowerCase() === q || d.id === action.figure);
    if (byName) return byName;
  }
  const activeId = app?.figures?.activeId || app?.settings?.get('figure.active');
  return defs.find((d) => d.id === activeId) ?? defs[0];
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function parseVec3(raw, current = { x: 0, y: 0, z: 0 }) {
  if (Array.isArray(raw)) {
    return { x: num(raw[0], current.x), y: num(raw[1], current.y), z: num(raw[2], current.z) };
  }
  if (raw && typeof raw === 'object') {
    return {
      x: raw.x !== undefined ? num(raw.x, current.x) : current.x,
      y: raw.y !== undefined ? num(raw.y, current.y) : current.y,
      z: raw.z !== undefined ? num(raw.z, current.z) : current.z,
    };
  }
  return current;
}

function applyHandsPreset(app, spec) {
  const s = app?.settings;
  if (!s) return;
  const applySide = (side, presetId) => {
    const preset = HAND_PRESET_BY_ID[presetId];
    if (!preset) return;
    s.batch(() => {
      s.set(`hands.${side}.preset`, preset.id);
      for (const [k, v] of Object.entries(preset.values)) {
        s.set(`hands.${side}.${k}`, v);
      }
    });
  };
  if (typeof spec.hands === 'string') {
    applySide('left', spec.hands);
    applySide('right', spec.hands);
  }
  if (typeof spec.leftHand === 'string') applySide('left', spec.leftHand);
  if (typeof spec.rightHand === 'string') applySide('right', spec.rightHand);
}

/* ── Ejecutor de acciones sobre ATOM ─────────────────────────────────────── */

export async function executeAtomActions(actions, app) {
  if (!app || !Array.isArray(actions) || actions.length === 0) return [];
  const s = app.settings;
  const figs = app.figures;
  const scene = app.scene;
  const applied = [];

  const updateDefById = (id, patch) => {
    const defs = [...(s.get('scene.figures') ?? [])];
    const idx = defs.findIndex((d) => d.id === id);
    if (idx < 0) return false;
    defs[idx] = { ...defs[idx], ...patch };
    s.set('scene.figures', defs);
    return true;
  };

  for (const a of actions) {
    if (!a || typeof a !== 'object') continue;

    if (a.type === 'set_figure_count') {
      if (!figs) continue;
      const target = Math.max(1, Math.min(8, Math.round(num(a.count, 1))));
      while (figs.count < target) {
        const added = await figs.add({});
        if (!added) break;
      }
      while (figs.count > target && figs.count > 1) {
        const last = figs.defs[figs.defs.length - 1];
        if (!last || !figs.remove(last.id)) break;
      }
      applied.push(`Figuras en escena: ${figs.count}`);
      continue;
    }

    if (a.type === 'add_figure') {
      if (!figs) continue;
      const id = await figs.add({ model: a.model });
      if (!id) continue;
      const def = figs.locate(id)?.def;
      if (def) {
        const patch = {};
        if (typeof a.name === 'string' && a.name.trim()) patch.name = a.name.trim();
        if (a.position !== undefined) patch.position = parseVec3(a.position, def.position);
        if (a.rotation !== undefined || a.rotationY !== undefined) {
          const rot = typeof a.rotation === 'number'
            ? { ...(def.rotation ?? { x: 0, y: 0, z: 0 }), y: a.rotation }
            : parseVec3(a.rotation, def.rotation ?? { x: 0, y: 0, z: 0 });
          if (a.rotationY !== undefined) rot.y = num(a.rotationY, rot.y);
          patch.rotation = rot;
        }
        if (a.height !== undefined) patch.height = Math.max(0.4, Math.min(3.2, num(a.height, 1.75)));
        if (a.scale !== undefined) {
          const sv = num(a.scale, 1);
          patch.scale = typeof a.scale === 'number' ? { x: sv, y: sv, z: sv } : parseVec3(a.scale, def.scale);
        }
        if (Object.keys(patch).length > 0) updateDefById(id, patch);
      }
      if (a.pose || a.bones || a.hipsOffset !== undefined) {
        const ch = figs.get(id);
        if (ch) {
          applyPoseRecipeToCharacter(ch, {
            preset: typeof a.pose === 'string' ? a.pose : '',
            bones: a.bones,
            hipsOffset: a.hipsOffset,
          });
          if (typeof ch.getPose === 'function') updateDefById(id, { pose: ch.getPose() });
          app.posing?.syncRig?.();
        }
      }
      if (a.hands || a.leftHand || a.rightHand) applyHandsPreset(app, a);
      applied.push(`Figura añadida${a.name ? `: ${a.name}` : ''}`);
      continue;
    }

    if (a.type === 'update_figure') {
      const def = resolveFigureDef(app, a);
      if (!def) continue;
      const patch = {};
      if (typeof a.name === 'string' && a.name.trim()) patch.name = a.name.trim();
      if (a.position !== undefined) patch.position = parseVec3(a.position, def.position ?? { x: 0, y: 0, z: 0 });
      if (a.rotation !== undefined || a.rotationY !== undefined) {
        const cur = def.rotation ?? { x: 0, y: 0, z: 0 };
        const rot = typeof a.rotation === 'number' ? { ...cur, y: a.rotation } : parseVec3(a.rotation, cur);
        if (a.rotationY !== undefined) rot.y = num(a.rotationY, rot.y);
        patch.rotation = rot;
      }
      if (a.scale !== undefined) {
        const cur = def.scale ?? { x: 1, y: 1, z: 1 };
        const sv = num(a.scale, 1);
        patch.scale = typeof a.scale === 'number' ? { x: sv, y: sv, z: sv } : parseVec3(a.scale, cur);
      }
      if (a.height !== undefined) patch.height = Math.max(0.4, Math.min(3.2, num(a.height, def.height ?? 1.75)));
      if (['suelo', 'centro', 'libre'].includes(a.anchor)) patch.anchor = a.anchor;
      if (typeof a.visible === 'boolean') patch.visible = a.visible;
      if (Object.keys(patch).length > 0) updateDefById(def.id, patch);
      if (a.active === true) figs?.setActive?.(def.id);
      applied.push(`Figura ajustada: ${patch.name ?? def.name}`);
      continue;
    }

    if (a.type === 'remove_figure') {
      const def = resolveFigureDef(app, a);
      if (def && figs?.remove?.(def.id)) applied.push(`Figura eliminada: ${def.name}`);
      continue;
    }

    if (a.type === 'pose_figure') {
      const def = resolveFigureDef(app, a);
      if (!def) continue;
      figs?.setActive?.(def.id);
      const ch = figs?.get?.(def.id) ?? figs?.active;
      app.posing?.mark?.();
      if (ch) {
        applyPoseRecipeToCharacter(ch, {
          preset: typeof a.preset === 'string' ? a.preset : '',
          bones: a.bones,
          hipsOffset: a.hipsOffset,
          reset: a.relative !== true,
        });
        if (typeof ch.getPose === 'function') updateDefById(def.id, { pose: ch.getPose() });
        app.posing?.syncRig?.();
      }
      if (a.hands || a.leftHand || a.rightHand) applyHandsPreset(app, a);
      const label = a.preset && AI_POSE_PRESETS[a.preset] ? AI_POSE_PRESETS[a.preset].label : 'personalizada';
      applied.push(`Pose ${label} (${def.name})`);
      continue;
    }

    if (a.type === 'add_object' && scene) {
      const kind = PRIMITIVE_BY_ID[a.kind] ? a.kind : 'cubo';
      const id = scene.addObject(kind);
      if (id) {
        const at = scene.locate(id);
        if (at) {
          const objs = [...(s.get('scene.objects') ?? [])];
          const cur = { ...objs[at.index] };
          if (typeof a.name === 'string' && a.name.trim()) cur.name = a.name.trim();
          if (a.position !== undefined) cur.position = parseVec3(a.position, cur.position);
          if (a.rotation !== undefined) cur.rotation = parseVec3(a.rotation, cur.rotation);
          if (a.scale !== undefined) {
            const sv = num(a.scale, 1);
            cur.scale = typeof a.scale === 'number' ? { x: sv, y: sv, z: sv } : parseVec3(a.scale, cur.scale);
          }
          if (a.params && typeof a.params === 'object') cur.params = { ...cur.params, ...a.params };
          if (typeof a.color === 'string' || typeof a.preset === 'string') {
            cur.material = {
              ...cur.material,
              ...(typeof a.preset === 'string' ? { preset: a.preset } : {}),
              ...(typeof a.color === 'string' ? { color: a.color } : {}),
            };
          }
          objs[at.index] = cur;
          s.set('scene.objects', objs);
        }
        applied.push(`Solido: ${a.name || PRIMITIVE_BY_ID[kind]?.label || kind}`);
      }
      continue;
    }

    if (a.type === 'clear_objects' && s) {
      s.set('scene.objects', []);
      applied.push('Solidos extra eliminados');
      continue;
    }

    if (a.type === 'set_lighting' && s) {
      if (typeof a.preset === 'string' && LIGHT_PRESETS[a.preset]) {
        app.viewport?.lighting?.setPreset?.(a.preset);
        s.set('light.preset', a.preset);
        applied.push(`Luz: ${a.preset}`);
      }
      s.batch(() => {
        if (typeof a.env === 'number') s.set('light.env.intensity', Math.max(0, Math.min(3, a.env)));
        for (const branch of ['ambient', 'key', 'fill', 'rim']) {
          const patch = a[branch];
          if (!patch || typeof patch !== 'object') continue;
          for (const [k, v] of Object.entries(patch)) {
            s.set(`light.${branch}.${k}`, v);
          }
        }
      });
      if (!a.preset) applied.push('Iluminacion ajustada');
      continue;
    }

    if (a.type === 'add_light' && scene) {
      const kind = LIGHT_BY_ID[a.kind] ? a.kind : 'punto';
      const id = scene.addLight(kind);
      if (id) {
        const at = scene.locate(id);
        if (at) {
          const lights = [...(s.get('scene.lights') ?? [])];
          const cur = { ...lights[at.index] };
          if (a.position !== undefined) cur.position = parseVec3(a.position, cur.position);
          if (typeof a.color === 'string') cur.color = a.color;
          if (typeof a.intensity === 'number') cur.intensity = Math.max(0, a.intensity);
          lights[at.index] = cur;
          s.set('scene.lights', lights);
        }
        applied.push(`Luz añadida: ${kind}`);
      }
      continue;
    }

    if (a.type === 'clear_lights' && s) {
      s.set('scene.lights', []);
      applied.push('Luces extra eliminadas');
      continue;
    }

    if (a.type === 'set_camera' && s) {
      s.batch(() => {
        if (a.projection === 'perspectiva' || a.projection === 'ortografica') {
          s.set('camera.projection', a.projection);
        }
        if (typeof a.focalLength === 'number') {
          s.set('camera.focalLength', Math.max(10, Math.min(250, a.focalLength)));
        }
        if (typeof a.roll === 'number') {
          s.set('camera.roll', Math.max(-180, Math.min(180, a.roll)));
        }
        if (typeof a.shiftH === 'number') s.set('camera.shiftH', Math.max(-0.5, Math.min(0.5, a.shiftH)));
        if (typeof a.shiftV === 'number') s.set('camera.shiftV', Math.max(-0.5, Math.min(0.5, a.shiftV)));
        if (typeof a.exposure === 'number') s.set('camera.exposure', Math.max(0.2, Math.min(3, a.exposure)));
      });
      const camRig = app.viewport?.cameras;
      if (typeof a.view === 'string' && VIEW_PRESETS[a.view]) {
        camRig?.setView?.(a.view);
        applied.push(`Camara: ${a.view}`);
      }
      if (Array.isArray(a.target) && camRig?.controls?.target) {
        camRig.controls.target.set(num(a.target[0]), num(a.target[1], 0.9), num(a.target[2]));
      }
      if (Array.isArray(a.position) && camRig?.active?.position) {
        camRig.active.position.set(num(a.position[0]), num(a.position[1], 1.4), num(a.position[2], 3.2));
        camRig.controls?.update?.();
      }
      if (a.frame === true) app.actions?.frameFigure?.();
      if (!a.view) applied.push('Optica ajustada');
      continue;
    }

    if (a.type === 'set_guides' && s) {
      s.batch(() => {
        if (a.perspective && typeof a.perspective === 'object') {
          for (const [k, v] of Object.entries(a.perspective)) {
            if (k === 'align') continue;
            s.set(`guides.perspective.${k}`, v);
          }
        }
        if (a.action && typeof a.action === 'object') {
          for (const [k, v] of Object.entries(a.action)) {
            s.set(`guides.action.${k}`, v);
          }
        }
        for (const k of ['thirds', 'golden', 'symmetry', 'horizon', 'diagonals', 'heads', 'headCount', 'grid', 'safeFrame']) {
          if (a[k] !== undefined) s.set(`guides.${k}`, a[k]);
        }
      });
      if (a.perspective?.align) app.actions?.alignPerspective?.();
      applied.push('Guias actualizadas');
      continue;
    }

    if (a.type === 'set_stage' && s) {
      s.batch(() => {
        for (const k of ['background', 'bgColor', 'floor', 'floorColor', 'grid', 'shadowStrength']) {
          if (a[k] !== undefined) s.set(`stage.${k}`, a[k]);
        }
      });
      applied.push('Escenario actualizado');
      continue;
    }

    if (a.type === 'set_appearance' && s) {
      s.batch(() => {
        if (['anatomia', 'maniqui', 'esqueleto'].includes(a.variant)) s.set('figure.variant', a.variant);
        if (['textura', 'arcilla', 'wireframe', 'rayosx', 'toon', 'normales'].includes(a.shading)) {
          s.set('figure.shading', a.shading);
        }
        if (typeof a.clayColor === 'string') s.set('figure.clayColor', a.clayColor);
        if (a.outline && typeof a.outline === 'object') {
          for (const [k, v] of Object.entries(a.outline)) {
            s.set(`outline.${k}`, v);
          }
        }
      });
      applied.push('Aspecto actualizado');
    }
  }

  return applied;
}

/* ── Respuestas locales sin conexion para ordenes rapidas directas ───────── */

export function buildOfflineQuickActions(prompt) {
  const q = prompt.toLowerCase();
  const actions = [];
  const notes = [];

  const countMatch = /\b([1-8])\s*(?:figuras?|personajes?|modelos?)\b/.exec(q);
  if (countMatch) {
    const count = Number(countMatch[1]);
    actions.push({ type: 'set_figure_count', count });
    notes.push(`${count} figura(s)`);
  }

  for (const preset of Object.keys(LIGHT_PRESETS)) {
    if (q.includes(preset)) {
      actions.push({ type: 'set_lighting', preset });
      notes.push(`luz ${preset}`);
      break;
    }
  }

  for (const view of Object.keys(VIEW_PRESETS)) {
    if (q.includes(view)) {
      actions.push({ type: 'set_camera', view });
      notes.push(`camara ${view}`);
      break;
    }
  }

  const mmMatch = /\b(\d{2,3})\s*mm\b/.exec(q);
  if (mmMatch) {
    const focalLength = Math.max(12, Math.min(240, Number(mmMatch[1])));
    actions.push({ type: 'set_camera', focalLength });
    notes.push(`${focalLength} mm`);
  }

  const perspMatch = /\b([1-6])\s*puntos?\b/.exec(q);
  if (perspMatch) {
    const mode = `${perspMatch[1]}punto${perspMatch[1] === '1' ? '' : 's'}`;
    actions.push({ type: 'set_guides', perspective: { mode, warp: true } });
    notes.push(`perspectiva ${mode}`);
  }

  for (const poseKey of Object.keys(AI_POSE_PRESETS)) {
    if (q.includes(poseKey.replace(/_/g, ' ')) || q.includes(poseKey)) {
      actions.push({ type: 'pose_figure', preset: poseKey });
      notes.push(`pose ${AI_POSE_PRESETS[poseKey].label}`);
      break;
    }
  }

  if (q.includes('maniqui')) {
    actions.push({ type: 'set_appearance', variant: 'maniqui' });
    notes.push('maniqui');
  } else if (q.includes('esqueleto')) {
    actions.push({ type: 'set_appearance', variant: 'esqueleto' });
    notes.push('esqueleto');
  } else if (q.includes('anatomia')) {
    actions.push({ type: 'set_appearance', variant: 'anatomia' });
    notes.push('anatomia');
  }
  if (q.includes('arcilla')) {
    actions.push({ type: 'set_appearance', shading: 'arcilla' });
    notes.push('arcilla');
  }
  if (q.includes('8 cabezas') || q.includes('ocho cabezas')) {
    actions.push({ type: 'set_guides', heads: true });
    notes.push('guia 8 cabezas');
  }

  if (actions.length === 0) return null;
  return {
    reply: `Aplicado directamente sin necesidad de conectar IA (${notes.join(', ')}). Para componer poses complejas o analizar bocetos, conecta free-pi u otro proveedor desde Ajustes > Asistente IA.`,
    actions,
  };
}
