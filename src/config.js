/**
 * ATOM · Configuracion por defecto
 * ---------------------------------------------------------------------------
 * Toda la aplicacion se controla desde este arbol de estado. Los paneles de la
 * interfaz solo leen y escriben rutas de aqui; los modulos 3D reaccionan.
 */

export const STORAGE_KEY = 'posu.settings.v1';
export const POSE_STORAGE_KEY = 'posu.poses.v1';

/** Firma que se muestra en Ayuda › Acerca de. */
export const APP_VERSION = '1.0';
export const APP_AUTHOR = 'Wilzamguerrero';

/** Modelo por defecto (generado por `npm run convert` desde el FBX de Mixamo). */
export const DEFAULT_MODEL_URL = 'models/character.glb';

/** Runtime WASM de MediaPipe servido desde el propio dominio. */
export const WASM_PATH = 'wasm';

/** Pesos oficiales de Hand Landmarker (21 puntos por mano, para los dedos). */
export const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

/** Pesos oficiales de Pose Landmarker (BlazePose GHUM). */
export const POSE_MODELS = {
  lite: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  full: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
  heavy: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task',
};

/** Carpeta publica donde viven las figuras. */
export const MODEL_DIR = 'models';

/**
 * Entrada de la biblioteca a partir del nombre de archivo.
 *
 * El nombre que se ve en el panel es el del archivo sin la extension, tal cual:
 * no hay ninguna tabla de nombres en ninguna parte, asi que renombrar el `.glb`
 * renombra la figura y basta con recargar. `id` es lo que se guarda en los
 * ajustes (`figure.model`), y por eso es el nombre del archivo y no un indice.
 */
export function modelEntry(file) {
  const name = String(file);
  const id = name.replace(/\.[^.]+$/, '');
  // La url se codifica: hay nombres de archivo con espacios, acentos o signos
  // que de otro modo no llegarian bien al cargador.
  return { id, file: name, label: id, url: `${MODEL_DIR}/${encodeURIComponent(name)}` };
}

/**
 * Biblioteca de figuras. Todas comparten la nomenclatura de huesos
 * "mixamorig..." asi que el rig, las poses y el mocap funcionan en cualquiera.
 *
 * Es un array **mutable** y arranca solo con el modelo por defecto: la lista de
 * verdad la pone `refreshModelLibrary()` (src/model/library.js) leyendo la
 * carpeta `public/models`. Esto es unicamente el respaldo para cuando esa
 * carpeta no se puede leer (las pruebas en Node, por ejemplo).
 */
export const MODEL_LIBRARY = [modelEntry(DEFAULT_MODEL_URL.split('/').pop())];

/** Objetivos de encuadre para el autofoco y las vistas predefinidas. */
export const FOCUS_TARGETS = ['figura', 'cabeza', 'torso', 'manos', 'pies'];

export const DEFAULTS = {
  /**
   * Aspecto de las figuras. Estos ajustes son comunes a todas las que haya en la
   * escena: cambiar la malla visible o el sombreado las cambia a la vez. Lo
   * propio de cada figura (modelo, sitio, altura y pose) vive en `scene.figures`.
   * `model`, `height`, `turn` y `anchor` se quedan aqui como plantilla del alta
   * de una figura nueva.
   */
  figure: {
    active: '',                 // id de la figura que recibe camara, poses y manos
    model: 'character',         // id de MODEL_LIBRARY
    variant: 'anatomia',        // anatomia | maniqui | esqueleto
    shading: 'textura',         // textura | arcilla | wireframe | rayosx | toon
    opacity: 1,
    clayColor: '#c9c2b8',
    woodColor: '#c08a4a',
    boneColor: '#e9e4d8',
    showGhost: false,           // Silueta traslucida de la piel bajo el maniqui
    ghostOpacity: 0.16,
    showSkeletonHelper: false,  // Helper de huesos de Three.js
    height: 1.75,               // Altura objetivo en metros
    turn: 0,                    // Giro del modelo en grados
    anchor: 'suelo',            // suelo | centro  (por defecto, de pie en el suelo)
  },

  /**
   * Rig de dedos. Cada mano guarda el cierre (0 = extendido, 1 = cerrado) de sus
   * cinco dedos, la apertura del abanico y la separacion del pulgar. Los valores
   * se traducen a giros sobre los ejes reales del esqueleto cargado, no a angulos
   * fijos, asi que funcionan con cualquier rigging que traiga falanges.
   */
  hands: {
    edit: 'left',               // mano que muestran los deslizadores
    link: true,                 // mover una mano mueve las dos
    fingers: false,             // manejadores de falanges en el posado manual
    left:  { preset: 'relajada', thumb: 0.22, index: 0.18, middle: 0.16, ring: 0.18, pinky: 0.22, spread: 0.15, thumbOut: 0.35 },
    right: { preset: 'relajada', thumb: 0.22, index: 0.18, middle: 0.16, ring: 0.18, pinky: 0.22, spread: 0.15, thumbOut: 0.35 },
  },

  /**
   * Conversor FBX → GLB del panel Modelo. Un FBX de Mixamo trae texturas de
   * 4096 px: guardadas tal cual el .glb se va a decenas de megas, asi que por
   * defecto se limita el lado mayor y el color se escribe en JPEG.
   */
  convert: {
    maxTexture: 2048,           // 0 = dejar las texturas como vienen
    jpeg: true,                 // color en JPEG cuando el material es opaco
  },

  /** Un material independiente por variante de malla y por objeto insertado. */
  materials: {
    slot: 'anatomia',           // pestana activa del panel
    anatomia:  { preset: 'original', color: '#d9a189', roughness: 0.56, metalness: 0.04, opacity: 1, flat: false },
    maniqui:   { preset: 'madera',   color: '#c08a4a', roughness: 0.62, metalness: 0.05, opacity: 1, flat: false },
    esqueleto: { preset: 'hueso',    color: '#e9e4d8', roughness: 0.52, metalness: 0.02, opacity: 1, flat: false },
    objeto:    { preset: 'yeso',     color: '#d8d4cc', roughness: 0.70, metalness: 0.00, opacity: 1, flat: false },
  },

  /** Editor de escena: figuras, solidos y luces que el usuario coloca. */
  scene: {
    /**
     * Figuras de la escena. Cada una: { id, name, model, visible, position,
     * rotation (grados), height, anchor, pose }. Se siembra al arrancar desde
     * los valores de `figure`, asi que nunca esta vacia en marcha.
     */
    figures: [],
    objects: [],
    lights: [],
    selected: '',
    tool: 'translate',          // translate | rotate | scale
    space: 'world',             // world | local
    snap: 0,                    // 0 = libre
    helpers: true,
  },

  camera: {
    projection: 'perspectiva',  // perspectiva | ortografica
    focalLength: 50,            // mm sobre sensor full-frame
    filmGauge: 36,              // ancho del sensor en mm
    orthoZoom: 1,
    roll: 0,                    // grados
    shiftH: 0,                  // descentrado horizontal (lente tilt-shift)
    shiftV: 0,
    exposure: 1.05,
    toneMapping: 'agx',         // agx | aces | neutral | reinhard | linear
    dof: false,
    fStop: 2.8,
    focusDistance: 3.2,
    focusTarget: 'figura',      // objetivo del autofoco
    autoFocus: true,
    maxBlur: 0.012,
    distortion: 0,              // barril (+) / corsete (-)
    distortion2: 0,
    chromatic: 0,
    vignette: 0.22,
    grain: 0.02,
    bloom: 0,
    turntable: 0,               // grados por segundo
    damping: true,
  },

  light: {
    ambient: { intensity: 0.35, color: '#8fa6c4' },
    env: { intensity: 0.5 },
    key: {
      x: 3.1, y: 4.4, z: 3.6,
      intensity: 3.4,
      color: '#fff4e2',
      shadows: true,
      softness: 2.4,
      bias: -0.0006,
    },
    fill: { enabled: true, intensity: 0.85, color: '#9fc4ff', x: -3.4, y: 1.8, z: 2.2 },
    rim: { enabled: true, intensity: 2.1, color: '#cfe4ff', x: -1.4, y: 3.0, z: -4.2 },
    preset: 'rembrandt',
  },

  stage: {
    background: 'degradado',    // degradado | solido | ciclorama
    bgColor: '#141618',
    floor: true,
    floorColor: '#1b1d20',
    grid: true,
    gridSize: 10,
    axes: false,
    shadowStrength: 0.55,
  },

  mocap: {
    source: 'webcam',           // webcam | imagen | video
    deviceId: '',
    modelQuality: 'full',       // lite | full | heavy
    delegate: 'GPU',            // GPU | CPU
    detectFps: 0,               // 0 = automatico (60 en GPU, 15 en CPU)
    square: 'auto',             // auto | si | no  -> recorte cuadrado para el detector
    hands: false,               // rig de dedos con Hand Landmarker (21 puntos/mano)
    handSmoothing: 0.45,
    minDetection: 0.5,
    minPresence: 0.5,
    minTracking: 0.5,
    engine: 'directo',          // directo | kalidokit
    mirror: true,
    smoothing: 0.35,            // factor de slerp por fotograma
    oneEuro: true,
    oneEuroFreq: 30,
    oneEuroMinCutoff: 1.2,
    oneEuroBeta: 0.35,
    confidence: 0.5,            // visibilidad minima por punto
    showOverlay: true,
    showHud: true,
    /** Tamano del monitor de captura; 0 en la altura = proporcion 4:3 libre. */
    hudW: 268,
    hudH: 0,
    parts: { torso: 1, arms: 1, legs: 1, head: 1, hands: 1 },
    followPosition: false,
    positionRange: 0.45,
    frozen: false,
    autoStart: false,
  },

  /**
   * Buscador de imagenes de referencia (Espacio). En `auto` se pregunta a los
   * siete sitios a la vez y la rejilla sale mezclada, con mas cupo para Bing y
   * DuckDuckGo, que son los que entienden una frase en castellano; los archivos
   * de museo estan indexados en ingles. Con un proveedor concreto solo se
   * pregunta a ese. `safe` filtra el contenido para adultos, y solo lo tienen los
   * dos buscadores web.
   */
  search: {
    // auto | bing | duck | wikimedia | openverse | artic | cleveland | met | wellcome
    provider: 'auto',
    safe: true,
  },

  guides: {
    heads: false,               // Regla de 8 cabezas
    headCount: 8,
    thirds: false,
    golden: false,
    symmetry: false,
    horizon: false,
    diagonals: false,
    grid: 0,                    // 0 = sin rejilla; n = n x n
    safeFrame: 'ninguno',       // ninguno | 1:1 | 4:5 | 3:2 | 16:9

    /** Sistema de perspectiva: 1, 2 y 3 puntos mas curvilineas de 4, 5 y 6. */
    perspective: {
      mode: 'ninguno',          // ninguno | 1 | 2 | 3 | 4 | 5 | 6
      rays: 20,                 // radios por punto de fuga
      horizon: true,
      points: true,
      labels: true,
      measuring: false,         // puntos de medida a 45 grados
      floorGrid: false,
      wallGrid: false,
      gridStep: 0.5,
      gridExtent: 8,
      cube: false,              // cubo de referencia en el origen
      cone: false,              // cono de vision
      coneAngle: 60,
      meridians: 16,            // meridianos de las proyecciones curvas
      objects: false,           // fugas de los ejes del solido seleccionado
      align: false,             // alinear la camara al modo elegido
      lock: false,              // bloquear la camara al modo elegido
      color2: '#ff8a5b',
      opacity: 0.5,
      width: 1,
      fade: true,
      letterbox: false,
    },
    color: '#4daafc',
    opacity: 0.45,
  },

  quality: {
    pixelRatio: 'auto',         // auto | 1 | 1.5 | 2
    shadowMap: 2048,
    antialias: true,
    ssao: false,
    fpsCap: 0,                  // 0 = sin limite
    showStats: true,
    // Ruta grafica minima (sombras PCF, sin multimuestreo, resolucion 1x). Se
    // enciende sola si el contexto WebGL se pierde al arrancar, que es lo que
    // ocurre con algunos controladores de Linux.
    compat: false,
  },

  ui: {
    section: 'figure',
    sidebar: true,
    theme: 'oscuro',            // oscuro | claro
    manualPosing: false,
    selectedBone: '',
    /** Clave canonica del hueso seleccionado (`selectedBone` es la etiqueta). */
    selectedBoneKey: '',
  },
};

/** Preajustes de iluminacion clasicos para estudio de claroscuro. */
export const LIGHT_PRESETS = {
  rembrandt: { key: { x: 3.1, y: 4.4, z: 3.6, intensity: 3.4 }, fill: { enabled: true, intensity: 0.85 }, rim: { enabled: true, intensity: 2.1 }, ambient: { intensity: 0.35 } },
  lateral:   { key: { x: 5.2, y: 2.2, z: 0.4, intensity: 3.8 }, fill: { enabled: false, intensity: 0.3 }, rim: { enabled: true, intensity: 1.4 }, ambient: { intensity: 0.16 } },
  mariposa:  { key: { x: 0.2, y: 5.4, z: 3.4, intensity: 3.6 }, fill: { enabled: true, intensity: 0.6 }, rim: { enabled: false, intensity: 0 },   ambient: { intensity: 0.28 } },
  contraluz: { key: { x: -0.6, y: 3.2, z: -5.4, intensity: 4.6 }, fill: { enabled: true, intensity: 0.35 }, rim: { enabled: true, intensity: 2.6 }, ambient: { intensity: 0.14 } },
  cenital:   { key: { x: 0.1, y: 6.2, z: 0.6, intensity: 3.9 }, fill: { enabled: false, intensity: 0 },   rim: { enabled: true, intensity: 1.1 }, ambient: { intensity: 0.12 } },
  inferior:  { key: { x: 0.4, y: -2.6, z: 3.4, intensity: 3.2 }, fill: { enabled: false, intensity: 0 },   rim: { enabled: true, intensity: 1.6 }, ambient: { intensity: 0.1 } },
  plano:     { key: { x: 0.4, y: 2.6, z: 5.2, intensity: 2.6 }, fill: { enabled: true, intensity: 1.6 }, rim: { enabled: true, intensity: 1.0 }, ambient: { intensity: 0.6 } },
};

/** Distancias focales habituales en fotografia de figura. */
export const FOCAL_PRESETS = [14, 24, 35, 50, 85, 135, 200];

/** Vistas de camara predefinidas: [azimut, elevacion] en grados. */
export const VIEW_PRESETS = {
  frente:      [0, 2],
  'tres cuartos': [-35, 6],
  perfil:      [-90, 2],
  espalda:     [180, 2],
  picado:      [-25, 42],
  contrapicado: [-25, -28],
  cenital:     [0, 84],
};
