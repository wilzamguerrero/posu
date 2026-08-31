/**
 * POSU · Mapa de huesos
 * ---------------------------------------------------------------------------
 * El objetivo es que el resto de la aplicacion no sepa nunca como se llaman
 * los huesos en el archivo. Se trabaja con claves canonicas ("leftArm") y este
 * modulo resuelve a que hueso real corresponden.
 *
 * Es necesario porque el nombre cambia segun el origen:
 *   FBX de Mixamo   -> "mixamorig:LeftArm"
 *   GLB convertido  -> "mixamorig1:LeftArm"
 *   tras GLTFLoader -> "mixamorig1LeftArm"   (los ':' se eliminan)
 *   otros riggings  -> "upper_arm.L", "LeftUpperArm", "Bip01 L UpperArm"…
 */

/** Quita prefijos de rigging, separadores y sufijos de lado para comparar. */
export function normalizeBoneName(name = '') {
  return String(name)
    .toLowerCase()
    .replace(/mixamorig\d*/g, '')
    .replace(/^bip\d*/, '')
    .replace(/[\s:._\-|]/g, '');
}

/**
 * Claves canonicas -> nombres aceptados (ya normalizados). El primero es el de
 * Mixamo; los siguientes cubren riggings habituales.
 */
export const BONE_ALIASES = {
  hips: ['hips', 'pelvis', 'root', 'cog'],
  spine: ['spine', 'spine01', 'abdomen', 'waist'],
  spine1: ['spine1', 'spine02', 'chestlower'],
  spine2: ['spine2', 'spine03', 'chest', 'upperchest'],
  neck: ['neck', 'neck01'],
  head: ['head'],
  headTop: ['headtopend', 'headtop', 'headend'],

  leftShoulder: ['leftshoulder', 'shoulderl', 'lshoulder', 'claviclel', 'leftclavicle'],
  leftArm: ['leftarm', 'leftupperarm', 'upperarml', 'larm', 'upperarml'],
  leftForeArm: ['leftforearm', 'leftlowerarm', 'forearml', 'lowerarml'],
  leftHand: ['lefthand', 'handl', 'lhand'],
  rightShoulder: ['rightshoulder', 'shoulderr', 'rshoulder', 'clavicler', 'rightclavicle'],
  rightArm: ['rightarm', 'rightupperarm', 'upperarmr', 'rarm'],
  rightForeArm: ['rightforearm', 'rightlowerarm', 'forearmr', 'lowerarmr'],
  rightHand: ['righthand', 'handr', 'rhand'],

  leftUpLeg: ['leftupleg', 'leftupperleg', 'thighl', 'upperlegl', 'lthigh'],
  leftLeg: ['leftleg', 'leftlowerleg', 'shinl', 'lowerlegl', 'calfl'],
  leftFoot: ['leftfoot', 'footl', 'lfoot'],
  leftToe: ['lefttoebase', 'toebasel', 'lefttoe', 'toel'],
  rightUpLeg: ['rightupleg', 'rightupperleg', 'thighr', 'upperlegr', 'rthigh'],
  rightLeg: ['rightleg', 'rightlowerleg', 'shinr', 'lowerlegr', 'calfr'],
  rightFoot: ['rightfoot', 'footr', 'rfoot'],
  rightToe: ['righttoebase', 'toebaser', 'righttoe', 'toer'],
};

// Cadenas de dedos: se generan porque son 30 huesos con nombre sistematico.
for (const side of ['left', 'right']) {
  for (const finger of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']) {
    for (let i = 1; i <= 3; i++) {
      const key = `${side}${finger}${i}`;
      const s = side === 'left' ? 'l' : 'r';
      BONE_ALIASES[key] = [
        `${side}hand${finger.toLowerCase()}${i}`,
        `${finger.toLowerCase()}${i}${s}`,
        `${side}${finger.toLowerCase()}${i}`,
      ];
    }
  }
}

/** Agrupacion por zona: la usan las ganancias por parte de la captura. */
export const BONE_GROUPS = {
  torso: ['hips', 'spine', 'spine1', 'spine2'],
  head: ['neck', 'head'],
  arms: ['leftShoulder', 'leftArm', 'leftForeArm', 'rightShoulder', 'rightArm', 'rightForeArm'],
  hands: ['leftHand', 'rightHand'],
  // Los dedos se añaden abajo, en cuanto estan generadas sus claves.
  fingers: [],
  legs: ['leftUpLeg', 'leftLeg', 'leftFoot', 'leftToe', 'rightUpLeg', 'rightLeg', 'rightFoot', 'rightToe'],
};

/** Nombres de los cinco dedos, en el orden en que se muestran en la interfaz. */
export const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'];

/** Etiquetas de dedo para la interfaz. */
export const FINGER_LABELS = {
  thumb: 'Pulgar', index: 'Indice', middle: 'Medio', ring: 'Anular', pinky: 'Menique',
};

/** Claves canonicas de las tres falanges de un dedo, de la palma a la punta. */
export function fingerKeys(side, finger) {
  const name = finger[0].toUpperCase() + finger.slice(1);
  return [1, 2, 3].map((i) => side + name + i);
}

/** Las 30 claves de falange, en orden estable. */
export const FINGER_BONES = ['left', 'right'].flatMap((side) => FINGERS.flatMap((f) => fingerKeys(side, f)));

BONE_GROUPS.fingers = FINGER_BONES;

/** Clave canonica -> grupo, para consultar la ganancia en O(1). */
export const BONE_GROUP_OF = (() => {
  const map = {};
  for (const [group, keys] of Object.entries(BONE_GROUPS)) for (const k of keys) map[k] = group;
  return map;
})();

/** Falanges que el posado manual puede ofrecer aparte (son 30 manejadores). */
export const POSABLE_FINGERS = FINGER_BONES;

/** Huesos que se ofrecen como manejadores en el posado manual. */
export const POSABLE_BONES = [
  'hips', 'spine', 'spine1', 'spine2', 'neck', 'head',
  'leftShoulder', 'leftArm', 'leftForeArm', 'leftHand',
  'rightShoulder', 'rightArm', 'rightForeArm', 'rightHand',
  'leftUpLeg', 'leftLeg', 'leftFoot', 'leftToe',
  'rightUpLeg', 'rightLeg', 'rightFoot', 'rightToe',
];

/** Etiquetas en castellano para la interfaz. */
export const BONE_LABELS = {
  hips: 'Cadera', spine: 'Lumbar', spine1: 'Dorsal', spine2: 'Pecho',
  neck: 'Cuello', head: 'Cabeza', headTop: 'Coronilla',
  leftShoulder: 'Clavicula izq.', leftArm: 'Brazo izq.', leftForeArm: 'Antebrazo izq.', leftHand: 'Mano izq.',
  rightShoulder: 'Clavicula der.', rightArm: 'Brazo der.', rightForeArm: 'Antebrazo der.', rightHand: 'Mano der.',
  leftUpLeg: 'Muslo izq.', leftLeg: 'Pierna izq.', leftFoot: 'Pie izq.', leftToe: 'Dedos pie izq.',
  rightUpLeg: 'Muslo der.', rightLeg: 'Pierna der.', rightFoot: 'Pie der.', rightToe: 'Dedos pie der.',
};

// Falanges: se generan para no repetir cuarenta lineas a mano.
for (const side of ['left', 'right']) {
  const lado = side === 'left' ? 'izq.' : 'der.';
  for (const f of FINGERS) {
    fingerKeys(side, f).forEach((key, i) => {
      BONE_LABELS[key] = FINGER_LABELS[f] + ' ' + (i + 1) + ' ' + lado;
    });
  }
}

/**
 * Huesos que no todos los riggings traen y que la aplicacion sabe suplir: la
 * coronilla solo se usa para medir la altura y los dedos del pie solo afinan el
 * apoyo. Su ausencia no merece aviso; la de cualquier otro, si.
 */
export const OPTIONAL_BONES = new Set(['headTop', 'leftToe', 'rightToe', ...FINGER_BONES]);

/**
 * Resuelve el esqueleto cargado contra las claves canonicas.
 * @returns {{ bones: Object<string, import('three').Bone>, missing: string[],
 *            missingRequired: string[] }} `missing` incluye los opcionales.
 */
export function resolveBones(skeletonOrBones) {
  const list = skeletonOrBones?.bones ?? skeletonOrBones ?? [];
  const byNormalized = new Map();
  for (const bone of list) {
    const key = normalizeBoneName(bone.name);
    // Se conserva la primera aparicion: en Mixamo el orden es de raiz a hoja.
    if (!byNormalized.has(key)) byNormalized.set(key, bone);
  }

  const bones = {};
  const missing = [];
  for (const [canonical, aliases] of Object.entries(BONE_ALIASES)) {
    const found = aliases.map((a) => byNormalized.get(a)).find(Boolean);
    if (found) bones[canonical] = found;
    else missing.push(canonical);
  }
  return { bones, missing, missingRequired: missing.filter((k) => !OPTIONAL_BONES.has(k)) };
}
