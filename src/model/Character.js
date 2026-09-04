/**
 * ATOM · Personaje
 * ---------------------------------------------------------------------------
 * Carga el modelo, resuelve su esqueleto, genera las variantes de geometria y
 * expone los controles de visualizacion que pide el plan:
 *
 *   cambiarGeometria('anatomia' | 'maniqui' | 'esqueleto')
 *   setOpacity(0..1)   -> activa `transparent` en la malla visible
 *   setShading('textura' | 'arcilla' | 'wireframe' | 'rayosx' | 'toon')
 *
 * Si el archivo trae mallas llamadas `Mesh_Anatomica`, `Mesh_Maniqui` o
 * `Mesh_Esqueleto` se respetan tal cual. Si no (caso del FBX de Mixamo, que
 * solo trae la piel), las dos ultimas se construyen por codigo compartiendo el
 * mismo esqueleto. Ver variants.js.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { resolveBones, BONE_LABELS, POSABLE_BONES, POSABLE_FINGERS } from './boneMap.js';
import { buildVariantGeometry, makeVariantMesh, PROFILES } from './variants.js';
import {
  crearMaterial, aplicarParametros, aplicarOpacidad, proyectaSombra,
} from './MaterialLibrary.js';

/** Nombres de malla reconocidos, en el orden de las variantes. */
const MESH_NAMES = {
  anatomia: ['mesh_anatomica', 'anatomia', 'musculos', 'skin', 'body'],
  maniqui: ['mesh_maniqui', 'maniqui', 'mannequin', 'dummy'],
  esqueleto: ['mesh_esqueleto', 'esqueleto', 'skeleton', 'bones'],
};

/**
 * Estilos globales de `figure.shading` que anulan los materiales por variante.
 * 'textura' no aparece aqui: significa "usa el material propio de cada malla".
 */
const ESTILO_A_PRESET = {
  arcilla: 'arcilla',
  wireframe: 'wireframe',
  rayosx: 'rayosx',
  toon: 'toon',
  normales: 'normales',
};

/** Estilos cuyo color decide el usuario con `figure.clayColor`. */
const ESTILO_TENIDO = new Set(['arcilla', 'toon']);

/**
 * Puntos extremos por hueso, cacheados por geometria: duplicar una figura
 * comparte las mallas del archivo, asi que el recorrido de vertices se hace una
 * sola vez por modelo y no una por personaje.
 * @type {WeakMap<import('three').BufferGeometry, (Float32Array|null)[]>}
 */
const BONE_BOUNDS_CACHE = new WeakMap();

/**
 * Peso minimo para que un vertice cuente como piel de un hueso. Los pesos
 * residuales (un 2 % de la mano en el hombro) inflaban la caja varios
 * centimetros al mover ese hueso sin mover la piel de verdad.
 */
const WEIGHT_MIN = 0.12;

/**
 * Direcciones del envoltorio de 26 caras (las 13 rectas y sus opuestas). Se
 * guarda el vertice mas lejano en cada una: son los puntos que dibujan la
 * silueta del trozo de piel que mueve un hueso, y con ellos la caja se recalcula
 * sin volver a mirar la malla.
 */
const HULL_DIRS = [
  [1, 0, 0], [0, 1, 0], [0, 0, 1],
  [1, 1, 0], [1, -1, 0], [1, 0, 1], [1, 0, -1], [0, 1, 1], [0, 1, -1],
  [1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1],
];

const _m = new THREE.Matrix4();
const _mm = new THREE.Matrix4();
const _cajaTmp = new THREE.Box3();
const _vTmp = new THREE.Vector3();
const _i4 = new THREE.Vector4();
const _w4 = new THREE.Vector4();

// --- Deformacion de huesos (rig tipo dibujo animado) ---
const DEFORM_MIN = 0.2;
const DEFORM_MAX = 3;
/** Un factor de escala sano: numero finito y dentro de los topes. */
const factorDeform = (v) => Math.min(DEFORM_MAX, Math.max(DEFORM_MIN, Number.isFinite(v) ? v : 1));
/** ¿Es un factor que no deforma nada? Entonces no se guarda. */
const sinDeformar = (x, y, z) =>
  Math.abs(x - 1) < 1e-4 && Math.abs(y - 1) < 1e-4 && Math.abs(z - 1) < 1e-4;
const _mDef = new THREE.Matrix4();
const _vDef = new THREE.Vector3();
/**
 * Cuanto hay que dividir la escala de un hijo para que no herede el tamano de su
 * padre deformado. El factor del padre esta en los ejes del padre y la escala del
 * hijo en los suyos, asi que dividir componente a componente solo vale si el hijo
 * no esta girado respecto a su padre, y en un esqueleto de Mixamo casi siempre lo
 * esta. Lo que se mide aqui es cuanto crece cada eje del hijo dentro del padre: la
 * norma de la columna correspondiente de `diag(f) · R`. Con el hijo sin girar sale
 * el propio `f`, y girado sale el tamano exacto. El sesgo que deja una escala no
 * uniforme bajo un giro no lo arregla ninguna escala, y por eso deformar de forma
 * uniforme es lo unico que nunca cizalla la piel.
 */
function compensacion(f, quat, out = _vDef) {
  const e = _mDef.makeRotationFromQuaternion(quat).elements;
  return out.set(
    Math.hypot(f.x * e[0], f.y * e[1], f.z * e[2]),
    Math.hypot(f.x * e[4], f.y * e[5], f.z * e[6]),
    Math.hypot(f.x * e[8], f.y * e[9], f.z * e[10]),
  );
}


export class Character {
  constructor(settings) {
    this.settings = settings;

    this.root = new THREE.Group();
    this.root.name = 'Personaje';
    // `holder` recibe altura, giro y anclaje; el contenido del archivo queda
    // intacto dentro para no falsear las matrices de enlace.
    this.holder = new THREE.Group();
    this.holder.name = 'Ajuste';
    this.root.add(this.holder);

    /**
     * Colocacion propia de esta figura: la empuja `FigureSet` desde su
     * definicion en `scene.figures`. El sitio y el giro van en el `root` (los
     * escribe el gizmo); aqui solo queda lo que deforma el contenido.
     */
    this.placement = {
      height: settings.get('figure.height') ?? 1.75,
      anchor: settings.get('figure.anchor') ?? 'suelo',
    };

    // variante -> mallas de esa variante (un archivo puede traer varias).
    this.meshes = { anatomia: [], maniqui: [], esqueleto: [] };
    this.baseMaterials = new Map(); // malla -> material original del archivo
    this.skeleton = null;
    this.bones = {};
    this.missing = [];          // todas las claves sin hueso
    this.missingRequired = []; // solo las que la aplicacion necesita
    // local/world: rotacion de reposo (local y de mundo); position: donde cae
    // cada hueso en el mundo; scale/offset: tamano y traslacion locales tal
    // como llegan del archivo, que son la base de la deformacion.
    this.rest = {
      local: new Map(),
      world: new Map(),
      position: new Map(),
      scale: new Map(),
      offset: new Map(),
    };
    /**
     * Deformacion del usuario: clave de hueso -> factor de escala local. Es una
     * capa aparte del reposo y del estirado del IK; las tres se escriben juntas
     * en `applyDeform()` (y en `IKRig.applyStretch()`) para que ninguna pise a
     * las otras. Viaja con la pose, asi que se guarda y se deshace con ella.
     */
    this.deform = new Map();
    this.basis = new THREE.Quaternion();
    this.helper = null;
    this.ghost = null;
    /** Volumen envolvente en coordenadas de mundo (sigue a la pose). */
    this.box = new THREE.Box3();
    /** El mismo volumen en el espacio del `root`: caja alineada con la figura. */
    this.localBox = new THREE.Box3();
    /** Y en el espacio del contenido, sin la altura ni el anclaje aplicados. */
    this.contentBox = new THREE.Box3();
    /** Figura en reposo, para medir la altura y para la caja «sin pose». */
    this.restBox = new THREE.Box3();
    this.restHeight = 1;
    /** Por variante: [{ bone, points }] con la piel que mueve cada hueso. */
    this.boneBounds = { anatomia: [], maniqui: [], esqueleto: [] };
    this.loaded = false;
    this.sourceScale = 1;

    this.#bind();
  }

  #bind() {
    const s = this.settings;
    // El aspecto es comun a todas las figuras de la escena, asi que se lee del
    // almacen: cambiar la malla visible o el sombreado las cambia a la vez.
    // Las suscripciones se guardan porque una figura se puede eliminar y no
    // debe seguir escuchando (ver `dispose`).
    this.offs = [
      s.on('figure.variant', (v) => this.cambiarGeometria(v)),
      s.on(['figure.shading', 'figure.clayColor'], () => this.applyShading()),
      // Cada variante tiene su propia ranura de material: anatomia incluida.
      s.on('materials.*', () => this.applyShading()),
      s.on('figure.opacity', () => this.applyOpacity()),
      s.on(['figure.showGhost', 'figure.ghostOpacity'], () => this.applyGhost()),
      s.on('figure.showSkeletonHelper', () => this.applyHelper()),
    ];
    // La altura y el anclaje no se leen del almacen: son propios de cada figura
    // y llegan por `setPlacement` (ver FigureSet).
  }

  /**
   * Altura y anclaje de esta figura. Se llama al crearla y cada vez que cambia
   * su definicion en `scene.figures`.
   * @param {{height?: number, anchor?: 'suelo'|'centro'|'libre'}} placement
   */
  setPlacement({ height, anchor } = {}) {
    if (Number.isFinite(height)) this.placement.height = height;
    if (anchor) this.placement.anchor = anchor;
    this.applyTransform();
    return this;
  }

  // ---------------------------------------------------------------- carga ---

  /** Carga un modelo desde una URL o un File soltado en la ventana. */
  async load(source, { onProgress } = {}) {
    const isFile = typeof File !== 'undefined' && source instanceof File;
    const name = isFile ? source.name : String(source);
    const url = isFile ? URL.createObjectURL(source) : source;
    const ext = name.split('?')[0].split('.').pop().toLowerCase();

    let object;
    try {
      if (ext === 'fbx') {
        // Carga diferida: el lector de FBX pesa y solo hace falta si el usuario
        // suelta un archivo de Mixamo sin convertir.
        const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
        object = await new FBXLoader().loadAsync(url, onProgress);
      } else {
        const gltf = await new GLTFLoader().loadAsync(url, onProgress);
        object = gltf.scene;
      }
    } finally {
      if (isFile) URL.revokeObjectURL(url);
    }

    this.#adopt(object);
    return this;
  }

  /**
   * Adopta un modelo ya cargado (o clonado). Es la puerta que usa `FigureSet`
   * para duplicar una figura sin volver a leer el archivo.
   */
  adopt(object) {
    this.#adopt(object);
    return this;
  }

  /**
   * Copia de otra figura: mismo modelo, misma pose. Se clona el contenido del
   * archivo con `SkeletonUtils.clone`, que reengancha las mallas al esqueleto
   * nuevo; las variantes maniqui/esqueleto se vuelven a generar por codigo.
   */
  cloneFrom(other) {
    if (!other?.loaded || !other.source) throw new Error('La figura de origen no esta cargada.');
    return this.adopt(SkeletonUtils.clone(other.source));
  }

  #adopt(object) {
    this.clear();

    // Los FBX de Mixamo vienen en centimetros: se compensa aqui para que las
    // medidas internas esten en metros antes de normalizar la altura.
    object.updateMatrixWorld(true);
    const rawBox = new THREE.Box3().setFromObject(object);
    const rawHeight = rawBox.max.y - rawBox.min.y;
    if (rawHeight > 20) object.scale.multiplyScalar(0.01);

    this.holder.add(object);
    this.source = object;
    this.holder.updateMatrixWorld(true);

    // --- Esqueleto y mallas del archivo -----------------------------------
    const skins = [];
    object.traverse((o) => {
      if (o.isSkinnedMesh) skins.push(o);
      if (o.isMesh || o.isSkinnedMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        o.frustumCulled = false;
      }
    });
    if (!skins.length) throw new Error('El archivo no contiene ninguna malla con esqueleto.');

    this.skeleton = skins[0].skeleton;
    const resolved = resolveBones(this.skeleton);
    this.bones = resolved.bones;
    this.missing = resolved.missing;
    this.missingRequired = resolved.missingRequired;

    this.#captureRest();
    this.#assignMeshes(skins);
    this.#buildVariants();
    this.#buildBoneBounds();
    this.#measureRest();

    this.loaded = true;
    this.applyTransform();
    this.cambiarGeometria(this.settings.get('figure.variant'));
    this.applyShading();
    this.applyGhost();
    this.applyHelper();
  }

  /**
   * Guarda la pose de reposo en el espacio de enlace del esqueleto. Se obtiene
   * invirtiendo `boneInverses` en lugar de leer las matrices actuales: asi el
   * reposo es correcto aunque el archivo llegue en una pose distinta.
   */
  #captureRest() {
    const bindWorld = new Map();
    this.skeleton.bones.forEach((bone, i) => {
      bindWorld.set(bone, this.skeleton.boneInverses[i].clone().invert());
    });
    this.bindWorld = bindWorld;

    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    const parentQuat = new THREE.Quaternion();

    for (const bone of this.skeleton.bones) {
      const m = bindWorld.get(bone);
      m.decompose(pos, quat, scl);
      this.rest.position.set(bone, pos.clone());
      this.rest.world.set(bone, quat.clone());
      // El tamano y la traslacion locales se leen del hueso, no de la matriz de
      // enlace: al capturar el reposo nadie ha tocado la pose todavia, asi que
      // son los del archivo, y descomponer una matriz con escala no uniforme
      // no siempre devuelve el mismo valor.
      this.rest.scale.set(bone, bone.scale.clone());
      this.rest.offset.set(bone, bone.position.clone());

      const pm = bindWorld.get(bone.parent);
      if (pm) pm.decompose(new THREE.Vector3(), parentQuat, new THREE.Vector3());
      else parentQuat.identity();
      this.rest.local.set(bone, parentQuat.clone().invert().multiply(quat));
    }

    // Traslacion local original de la cadera: la captura puede desplazarla.
    this.restHipsLocal = this.bones.hips ? this.bones.hips.position.clone() : new THREE.Vector3();

    // --- Base corporal: ejes izquierda/arriba/frente del modelo en reposo ---
    const p = (key) => this.rest.position.get(this.bones[key]) ?? null;
    const up = new THREE.Vector3(0, 1, 0);
    const left = new THREE.Vector3(1, 0, 0);
    const a = p('hips');
    const b = p('spine2') ?? p('neck') ?? p('head');
    if (a && b) up.copy(b).sub(a).normalize();
    const ls = p('leftShoulder') ?? p('leftArm') ?? p('leftUpLeg');
    const rs = p('rightShoulder') ?? p('rightArm') ?? p('rightUpLeg');
    if (ls && rs) left.copy(ls).sub(rs).normalize();
    // Ortogonalizacion de Gram-Schmidt y tercer eje por producto vectorial.
    left.addScaledVector(up, -left.dot(up)).normalize();
    const forward = new THREE.Vector3().crossVectors(left, up).normalize();
    this.basis.setFromRotationMatrix(new THREE.Matrix4().makeBasis(left, up, forward));
  }

  /** Reparte las mallas del archivo entre las tres variantes. */
  #assignMeshes(skins) {
    this.meshes = { anatomia: [], maniqui: [], esqueleto: [] };
    for (const skin of skins) {
      const n = skin.name.toLowerCase();
      let variant = 'anatomia';
      for (const [key, patterns] of Object.entries(MESH_NAMES)) {
        if (patterns.some((pat) => n.includes(pat))) { variant = key; break; }
      }
      this.meshes[variant].push(skin);
      this.baseMaterials.set(skin, skin.material);
    }
    // Si el archivo no distingue mallas, todo lo cargado es la piel/anatomia.
    if (!this.meshes.anatomia.length) {
      this.meshes.anatomia = skins.filter((s) => !this.meshes.maniqui.includes(s) && !this.meshes.esqueleto.includes(s));
    }
  }

  /** Genera por codigo las variantes que el archivo no trae. */
  #buildVariants() {
    if (!this.meshes.maniqui.length) {
      const geo = buildVariantGeometry(this.skeleton, this.bones, PROFILES.maniqui);
      const mat = new THREE.MeshStandardMaterial({
        color: this.settings.get('materials.maniqui.color'), roughness: 0.52, metalness: 0.04,
      });
      const mesh = makeVariantMesh(geo, this.skeleton, mat, 'Mesh_Maniqui');
      this.holder.add(mesh);
      this.meshes.maniqui.push(mesh);
      this.baseMaterials.set(mesh, mat);
      this.generated = { ...(this.generated ?? {}), maniqui: true };
    }
    if (!this.meshes.esqueleto.length) {
      const geo = buildVariantGeometry(this.skeleton, this.bones, PROFILES.esqueleto);
      const mat = new THREE.MeshStandardMaterial({
        color: this.settings.get('materials.esqueleto.color'), roughness: 0.68, metalness: 0,
      });
      const mesh = makeVariantMesh(geo, this.skeleton, mat, 'Mesh_Esqueleto');
      this.holder.add(mesh);
      this.meshes.esqueleto.push(mesh);
      this.baseMaterials.set(mesh, mat);
      this.generated = { ...(this.generated ?? {}), esqueleto: true };
    }
  }

  /** Lista de todas las mallas, sin importar la variante. */
  get allMeshes() {
    const m = this.meshes ?? {};
    return [...(m.anatomia ?? []), ...(m.maniqui ?? []), ...(m.esqueleto ?? [])];
  }

  get visibleMeshes() {
    return this.meshes[this.settings.get('figure.variant')] ?? this.meshes.anatomia;
  }

  /**
   * Piel por hueso de la variante que se esta viendo: es la que mide la caja
   * envolvente y decide el apoyo en el suelo. Si esa variante no trajo pesos se
   * usa la primera que si.
   */
  get skinBounds() {
    const b = this.boneBounds ?? {};
    const variant = this.settings.get('figure.variant');
    return b[variant]?.length ? b[variant]
      : (b.anatomia?.length ? b.anatomia : (b.maniqui?.length ? b.maniqui : (b.esqueleto ?? [])));
  }

  // ------------------------------------------------------- transformaciones ---

  /**
   * Normaliza la altura y ancla la figura al suelo (o la centra).
   *
   * La altura se mide SIEMPRE sobre la figura en reposo (`restHeight`): si se
   * midiera la pose actual, agacharse haria crecer al personaje para que su caja
   * siguiera midiendo los metros pedidos. El anclaje, en cambio, si es cosa de la
   * pose: lo mantiene al dia `tick()` en cada fotograma.
   */
  applyTransform() {
    if (!this.loaded) return;
    this.holder.rotation.set(0, 0, 0);
    this.holder.position.x = 0;
    this.holder.position.z = 0;
    this.holder.scale.setScalar(this.placement.height / this.restHeight);
    this.root.updateMatrixWorld(true);
    this.#unionBones(this.contentBox);
    this.holder.position.y = this.#anchorOffset();
    this.root.updateMatrixWorld(true);
    this.#spreadBounds();
  }

  /**
   * Desplazamiento vertical del contenido segun el anclaje elegido:
   *   suelo  → el punto mas bajo de la pose queda en y = 0 (los pies apoyados);
   *   centro → el volumen queda centrado en el origen;
   *   libre  → el archivo se queda donde lo puso su autor.
   */
  #anchorOffset() {
    if (this.contentBox.isEmpty()) return 0;
    const k = this.holder.scale.y || 1;
    switch (this.placement.anchor) {
      case 'centro': return -((this.contentBox.min.y + this.contentBox.max.y) / 2) * k;
      case 'libre': return 0;
      default: return -this.contentBox.min.y * k;
    }
  }

  /**
   * Vuelve a medir la figura y corrige el anclaje si la pose ha cambiado. Lo
   * llama el bucle de dibujo (a traves de `FigureSet.tick`) en cada fotograma:
   * sin esto una figura agachada se quedaba flotando y una en cuclillas hundida,
   * porque el anclaje solo se recalculaba al tocar su colocacion.
   */
  tick() {
    if (!this.loaded || !this.skinBounds.length) return;
    this.root.updateMatrixWorld(true);
    this.#unionBones(this.contentBox);
    const y = this.#anchorOffset();
    // Umbral de medio milimetro: evita reescribir la matriz cuando la pose esta
    // quieta y el redondeo del calculo baila en el ultimo decimal.
    if (Math.abs(y - this.holder.position.y) > 0.0005) {
      this.holder.position.y = y;
      this.root.updateMatrixWorld(true);
    }
    this.#spreadBounds();
  }

  /** Recalcula el volumen envolvente teniendo en cuenta la pose actual. */
  refreshBounds() {
    if (!this.loaded) return this.box;
    this.root.updateMatrixWorld(true);
    if (!this.skinBounds.length) {
      // Modelo sin pesos utilizables: se cae al recorrido de vertices de three.
      for (const mesh of this.allMeshes) mesh.boundingBox = null;
      this.box.setFromObject(this.source);
      this.localBox.copy(this.box).applyMatrix4(_m.copy(this.root.matrixWorld).invert());
      // Y se rellena la caja del contenido, que es la que lee `bounds()`.
      this.contentBox.copy(this.box).applyMatrix4(_m.copy(this.holder.matrixWorld).invert());
      return this.box;
    }
    this.#unionBones(this.contentBox);
    this.#spreadBounds();
    return this.box;
  }

  /**
   * Volumen envolvente para la interfaz. Con `live` apagado se devuelve la caja
   * de la figura en reposo, que es la que mide el area del modelo sin la pose.
   * @param {{live?: boolean, space?: 'objeto'|'mundo'}} [o]
   * @returns {{box: THREE.Box3, matrix: THREE.Matrix4|null}} `matrix` es la del
   *   sistema en el que esta expresada la caja (null = coordenadas de mundo).
   */
  bounds({ live = true, space = 'objeto' } = {}) {
    const base = live ? this.contentBox : this.restBox;
    _cajaTmp.copy(base);
    if (_cajaTmp.isEmpty()) _cajaTmp.copy(this.contentBox);
    // Del espacio del contenido al del `root`: altura y anclaje.
    _cajaTmp.applyMatrix4(this.holder.matrix);
    if (space === 'mundo') {
      return { box: _cajaTmp.applyMatrix4(this.root.matrixWorld), matrix: null };
    }
    return { box: _cajaTmp, matrix: this.root.matrixWorld };
  }

  /** Pasa la caja del contenido al espacio del `root` y al de mundo. */
  #spreadBounds() {
    this.localBox.copy(this.contentBox).applyMatrix4(this.holder.matrix);
    this.box.copy(this.localBox).applyMatrix4(this.root.matrixWorld);
  }

  /**
   * Union de la piel de cada hueso en el espacio del contenido (el del `holder`,
   * antes de la altura y el anclaje). Es la medida barata del volumen: no
   * recorre ningun vertice, solo unos puntos por hueso.
   */
  #unionBones(out, variante = null) {
    out.makeEmpty();
    const lista = variante && this.boneBounds[variante]?.length ? this.boneBounds[variante] : this.skinBounds;
    if (!lista.length) return out;
    _m.copy(this.holder.matrixWorld).invert();
    for (const entry of lista) {
      _mm.multiplyMatrices(_m, entry.bone.matrixWorld);
      const p = entry.points;
      for (let i = 0; i < p.length; i += 3) {
        _vTmp.set(p[i], p[i + 1], p[i + 2]).applyMatrix4(_mm);
        out.expandByPoint(_vTmp);
      }
    }
    return out;
  }

  /**
   * Reparte la piel entre los huesos que la mueven y guarda, por hueso, los
   * vertices extremos en 26 direcciones: la silueta del trozo de piel que ese
   * hueso arrastra, en su propio espacio. Un vertice cuenta para TODOS los huesos
   * que lo mueven, no solo para el de mas peso, porque su posicion final es una
   * mezcla de las de todos ellos.
   *
   * Con esto el volumen de la figura se recalcula en cada fotograma: medir la
   * piel de verdad (`Box3.setFromObject` sobre una malla con esqueleto) recorre
   * decenas de miles de vertices y cuesta milisegundos.
   */
  #buildBoneBounds() {
    this.boneBounds = { anatomia: [], maniqui: [], esqueleto: [] };
    const bones = this.skeleton?.bones ?? [];
    if (!bones.length) return;
    const inverses = this.skeleton.boneInverses;

    // Una lista por variante: la caja envolvente y el anclaje miden la malla que
    // se esta viendo. Los volumenes generados del maniqui sobresalen algunos
    // centimetros de la piel, y con una sola lista comun la figura quedaba
    // flotando sobre el suelo al mostrar la anatomia.
    for (const [variante, mallas] of Object.entries(this.meshes)) {
      /** @type {(number[]|null)[]} lista de coordenadas por hueso */
      const total = bones.map(() => null);
      for (const mesh of mallas) {
        const puntos = this.#meshBonePoints(mesh, bones.length, inverses);
        if (!puntos) continue;
        for (let i = 0; i < puntos.length; i++) {
          if (!puntos[i]) continue;
          (total[i] ??= []).push(...puntos[i]);
        }
      }
      const lista = [];
      for (let i = 0; i < bones.length; i++) {
        if (total[i]?.length) lista.push({ bone: bones[i], points: new Float32Array(total[i]) });
      }
      this.boneBounds[variante] = lista;
    }
  }

  /**
   * Puntos extremos por hueso de una sola malla, cacheados por geometria. Se
   * calculan los 13 pares de extremos (maximo y minimo de cada direccion) y se
   * quitan los repetidos: en la practica quedan entre 8 y 20 puntos por hueso.
   */
  #meshBonePoints(mesh, count, inverses) {
    const geo = mesh.geometry;
    const pos = geo?.attributes?.position;
    const idx = geo?.attributes?.skinIndex;
    const wei = geo?.attributes?.skinWeight;
    if (!pos || !idx || !wei) return null;
    const cached = BONE_BOUNDS_CACHE.get(geo);
    if (cached && cached.length === count) return cached;

    const D = HULL_DIRS.length;
    // `pre[i]` lleva el vertice de la geometria al espacio del hueso i de una
    // sola pasada: es el mismo par de matrices para toda la malla.
    const pre = inverses.map((inv) => inv.clone().multiply(mesh.bindMatrix));
    /** Por hueso: el punto mas alejado en cada direccion (max y min). */
    const hi = new Array(count).fill(null);
    const lo = new Array(count).fill(null);
    const hiVal = new Array(count).fill(null);
    const loVal = new Array(count).fill(null);

    for (let v = 0; v < pos.count; v++) {
      _i4.fromBufferAttribute(idx, v);
      _w4.fromBufferAttribute(wei, v);
      for (let k = 0; k < 4; k++) {
        if (_w4.getComponent(k) < WEIGHT_MIN) continue;
        const b = _i4.getComponent(k);
        if (!(b >= 0 && b < count)) continue;
        _vTmp.fromBufferAttribute(pos, v).applyMatrix4(pre[b]);
        if (!hi[b]) {
          hi[b] = new Float32Array(D * 3);
          lo[b] = new Float32Array(D * 3);
          hiVal[b] = new Float32Array(D).fill(-Infinity);
          loVal[b] = new Float32Array(D).fill(Infinity);
        }
        const { x, y, z } = _vTmp;
        for (let d = 0; d < D; d++) {
          const dir = HULL_DIRS[d];
          const s = x * dir[0] + y * dir[1] + z * dir[2];
          if (s > hiVal[b][d]) {
            hiVal[b][d] = s;
            hi[b][d * 3] = x; hi[b][d * 3 + 1] = y; hi[b][d * 3 + 2] = z;
          }
          if (s < loVal[b][d]) {
            loVal[b][d] = s;
            lo[b][d * 3] = x; lo[b][d * 3 + 1] = y; lo[b][d * 3 + 2] = z;
          }
        }
      }
    }

    const puntos = new Array(count).fill(null);
    for (let b = 0; b < count; b++) {
      if (!hi[b]) continue;
      const vistos = new Set();
      const lista = [];
      for (const fuente of [hi[b], lo[b]]) {
        for (let d = 0; d < D; d++) {
          const x = fuente[d * 3];
          const y = fuente[d * 3 + 1];
          const z = fuente[d * 3 + 2];
          // Rejilla de un decimo de milimetro: los extremos de varias
          // direcciones suelen caer en el mismo vertice.
          const clave = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
          if (vistos.has(clave)) continue;
          vistos.add(clave);
          lista.push(x, y, z);
        }
      }
      puntos[b] = lista;
    }
    BONE_BOUNDS_CACHE.set(geo, puntos);
    return puntos;
  }

  /**
   * Mide la figura en reposo. Se pone el esqueleto en la pose de enlace, se mide
   * y se devuelve la pose tal como estaba: asi la altura pedida en el panel
   * significa siempre «de pie mide tantos metros», sin depender de la pose.
   */
  #measureRest() {
    if (!this.skinBounds.length) {
      this.holder.updateMatrixWorld(true);
      this.restBox.setFromObject(this.source);
      this.restHeight = Math.max(0.01, this.restBox.max.y - this.restBox.min.y);
      return;
    }
    const bones = this.skeleton.bones;
    const pose = bones.map((b) => b.quaternion.clone());
    const sitio = bones.map((b) => b.position.clone());
    const tam = bones.map((b) => b.scale.clone());

    this.resetToRest();
    // Sin la deformacion del usuario ni el estirado del IK: la altura del panel
    // significa siempre «de pie mide tantos metros», no «tantos con esta
    // escala», que si no cambiar de variante reescalaria la figura.
    for (const b of bones) {
      const r = this.rest.scale.get(b);
      if (r) b.scale.copy(r);
    }
    this.root.updateMatrixWorld(true);
    // Siempre con la anatomia: si se midiera la variante visible, cambiar de
    // malla reescalaria la figura al normalizar su altura.
    this.#unionBones(this.restBox, 'anatomia');
    this.restHeight = Math.max(0.01, this.restBox.max.y - this.restBox.min.y);

    bones.forEach((b, i) => {
      b.quaternion.copy(pose[i]);
      b.position.copy(sitio[i]);
      b.scale.copy(tam[i]);
    });
    this.root.updateMatrixWorld(true);
  }

  // ------------------------------------------------------------ variantes ---

  /**
   * API que pide el plan: alterna la malla visible manteniendo la pose, porque
   * las tres variantes comparten el mismo objeto Skeleton.
   */
  cambiarGeometria(tipo) {
    if (!this.meshes[tipo]) return;
    this.settings.set('figure.variant', tipo);
    this.#applyMaterials();
    // Cada variante tiene su propio volumen: el apoyo en el suelo y la caja
    // envolvente se rehacen con la malla que pasa a estar a la vista.
    if (this.loaded) this.applyTransform();
  }

  setOpacity(value) {
    this.settings.set('figure.opacity', value);
  }

  setShading(mode) {
    this.settings.set('figure.shading', mode);
  }

  applyShading() { this.#applyMaterials(); }
  applyOpacity() { this.#applyMaterials(); }
  applyGhost() { this.#applyMaterials(); }

  /**
   * Material de la ranura de la variante (materials.anatomia, .maniqui, .esqueleto).
   * Cachea por malla y preajuste, y ajusta el resto de parametros en caliente
   * para no recompilar el shader en cada movimiento de un deslizador.
   */
  #slotMaterial(mesh, variant) {
    const slot = this.settings.get(`materials.${variant}`) ?? {};
    const preset = slot.preset ?? 'original';
    this.materialCache ??= new Map();
    const key = `${mesh.uuid}:slot:${preset}`;

    let mat = this.materialCache.get(key);
    if (!mat) {
      // 'original' devuelve null: se conserva el material que trae el archivo.
      mat = crearMaterial(preset, slot) ?? this.baseMaterials.get(mesh) ?? mesh.material;
      this.materialCache.set(key, mat);
    }

    if (preset === 'original') {
      // Las variantes generadas por codigo no tienen textura, asi que el color
      // de la ranura si les afecta; a la malla del archivo no se le toca.
      if (this.generated?.[variant]) aplicarParametros(mat, { color: slot.color });
    } else {
      aplicarParametros(mat, { ...slot, opacity: undefined });
    }
    return mat;
  }

  /** Material efectivo: estilo global si hay uno activo, si no la ranura. */
  #materialFor(mesh, variant, mode) {
    const preset = ESTILO_A_PRESET[mode];
    if (!preset) return this.#slotMaterial(mesh, variant);

    this.materialCache ??= new Map();
    const key = `${mesh.uuid}:${mode}`;
    let mat = this.materialCache.get(key);
    if (!mat) {
      mat = crearMaterial(preset) ?? this.baseMaterials.get(mesh) ?? mesh.material;
      this.materialCache.set(key, mat);
    }
    if (ESTILO_TENIDO.has(preset)) {
      aplicarParametros(mat, { color: this.settings.get('figure.clayColor') });
    }
    return mat;
  }

  /** Material de silueta para el modo fantasma. */
  #ghostMaterial() {
    this.ghostMat ??= new THREE.MeshBasicMaterial({
      color: '#9fb6cf', transparent: true, depthWrite: false, side: THREE.FrontSide,
    });
    this.ghostMat.opacity = this.settings.get('figure.ghostOpacity');
    return this.ghostMat;
  }

  /** Unico punto donde se decide visibilidad, material y transparencia. */
  #applyMaterials() {
    if (!this.loaded) return;
    const s = this.settings;
    const variant = s.get('figure.variant');
    const mode = s.get('figure.shading');
    const opacity = s.get('figure.opacity');
    const ghost = s.get('figure.showGhost') && variant !== 'anatomia';

    for (const [key, list] of Object.entries(this.meshes)) {
      for (const mesh of list) {
        const isActive = key === variant;
        const isGhost = !isActive && ghost && key === 'anatomia';
        mesh.visible = isActive || isGhost;
        if (!mesh.visible) continue;

        if (isGhost) {
          mesh.material = this.#ghostMaterial();
          mesh.castShadow = false;
          continue;
        }

        const mat = this.#materialFor(mesh, key, mode);
        mesh.material = mat;
        // Las mallas translucidas o de alambre no deben oscurecer la escena.
        mesh.castShadow = proyectaSombra(mat.userData?.presetId ?? mode);

        // Deslizador general del plan multiplicado por el de la ranura, para
        // poder ver el esqueleto interno bajo una musculatura semitransparente.
        const slotOpacity = this.settings.get(`materials.${key}.opacity`) ?? 1;
        aplicarOpacidad(mat, opacity * slotOpacity);
      }
    }
  }

  applyHelper() {
    const want = this.settings.get('figure.showSkeletonHelper');
    if (want && !this.helper && this.skeleton) {
      this.helper = new THREE.SkeletonHelper(this.skeleton.bones[0]);
      this.helper.material.linewidth = 2;
      this.helper.material.depthTest = false;
      this.helper.renderOrder = 10;
      this.root.add(this.helper);
    }
    if (this.helper) this.helper.visible = !!want;
  }

  // ------------------------------------------------------------- consultas ---

  /** Punto de interes en coordenadas de mundo, para autofoco y encuadres. */
  focusPoint(target = 'figura', out = new THREE.Vector3()) {
    if (!this.loaded) return out.set(0, 0.95, 0);
    const world = (key) => {
      const bone = this.bones[key];
      return bone ? bone.getWorldPosition(new THREE.Vector3()) : null;
    };
    switch (target) {
      case 'cabeza': {
        const p = world('head');
        return p ? out.copy(p) : out.copy(this.box.getCenter(new THREE.Vector3()));
      }
      case 'torso': {
        const p = world('spine1') ?? world('spine');
        return p ? out.copy(p) : out.copy(this.box.getCenter(new THREE.Vector3()));
      }
      case 'manos': {
        const a = world('leftHand');
        const b = world('rightHand');
        if (a && b) return out.copy(a).add(b).multiplyScalar(0.5);
        return out.copy(a ?? b ?? this.box.getCenter(new THREE.Vector3()));
      }
      case 'pies': {
        const a = world('leftFoot');
        const b = world('rightFoot');
        if (a && b) return out.copy(a).add(b).multiplyScalar(0.5);
        return out.copy(a ?? b ?? this.box.getCenter(new THREE.Vector3()));
      }
      default:
        return this.box.getCenter(out);
    }
  }

  /**
   * Huesos disponibles para el posado manual, con etiqueta legible. Las 30
   * falanges se piden aparte porque llenarian la vista de manejadores.
   * @param {{fingers?: boolean}} [opciones]
   */
  posableBones({ fingers = false } = {}) {
    const claves = fingers ? [...POSABLE_BONES, ...POSABLE_FINGERS] : POSABLE_BONES;
    return claves.filter((k) => this.bones[k]).map((k) => ({
      key: k,
      label: BONE_LABELS[k] ?? k,
      bone: this.bones[k],
      finger: POSABLE_FINGERS.includes(k),
    }));
  }

  // ------------------------------------------------------------ deformacion ---

  /** Factor de deformacion de un hueso: (1,1,1) si no esta deformado. */
  boneDeform(key, out = new THREE.Vector3()) {
    const f = this.deform.get(key);
    return f ? out.copy(f) : out.set(1, 1, 1);
  }

  /** ¿Hay algun hueso con la escala cambiada? */
  get deformed() {
    return this.deform.size > 0;
  }

  /**
   * Cambia la escala local de un hueso. Los factores neutros se borran del mapa
   * para que la pose guardada no se llene de unos. Devuelve `true` si algo
   * cambio, para que quien llame sepa si tiene que registrar el paso.
   */
  setBoneScale(key, scale) {
    if (!this.bones[key]) return false;
    const x = factorDeform(scale?.x ?? 1);
    const y = factorDeform(scale?.y ?? 1);
    const z = factorDeform(scale?.z ?? 1);
    if (sinDeformar(x, y, z)) {
      if (!this.deform.delete(key)) return false;
    } else {
      const f = this.deform.get(key);
      if (f && Math.abs(f.x - x) < 1e-9 && Math.abs(f.y - y) < 1e-9 && Math.abs(f.z - z) < 1e-9) {
        return false;
      }
      this.deform.set(key, new THREE.Vector3(x, y, z));
    }
    this.applyDeform();
    return true;
  }

  /**
   * Reescribe `bone.scale` de todo el esqueleto: reposo por la deformacion del
   * usuario. Los hijos de un hueso deformado se contra-escalan para que la
   * deformacion se quede en ese hueso (el «segment scale compensate» de Maya,
   * o el «inherit scale: none» de Blender) en vez de heredarse a la cadena
   * entera: engordar la rodilla no engorda tambien el pie.
   *
   * Multiplicar y dividir componente a componente conmuta, asi que el orden del
   * mapa no importa. Devuelve `false` si aun no hay esqueleto, para que el rig
   * de IK sepa que tiene que apanarse con sus propias medidas de reposo.
   *
   * La compensacion depende del giro de cada hijo, asi que hay que volver a pasar
   * por aqui cuando cambie la pose de un hijo de un hueso deformado: el posado
   * manual lo hace en cada arrastre, y cargar una pose al escribir sus escalas.
   */
  applyDeform() {
    if (!this.skeleton) return false;
    for (const bone of this.skeleton.bones) {
      const r = this.rest.scale.get(bone);
      if (r) bone.scale.copy(r);
      else bone.scale.set(1, 1, 1);
    }
    for (const [key, f] of this.deform) {
      const bone = this.bones[key];
      if (!bone) continue;
      bone.scale.multiply(f);
      for (const hijo of bone.children) {
        if (hijo.isBone) hijo.scale.divide(compensacion(f, hijo.quaternion));
      }
    }
    return true;
  }

  /** Copia serializable de la deformacion. */
  deformState() {
    const out = {};
    for (const [key, f] of this.deform) out[key] = [f.x, f.y, f.z];
    return out;
  }

  /** Restaura una deformacion guardada (lo que devuelve `deformState()`). */
  setDeformState(state) {
    this.deform.clear();
    for (const [key, arr] of Object.entries(state ?? {})) {
      if (!Array.isArray(arr) || !this.bones[key]) continue;
      const x = factorDeform(arr[0] ?? 1);
      const y = factorDeform(arr[1] ?? 1);
      const z = factorDeform(arr[2] ?? 1);
      if (sinDeformar(x, y, z)) continue;
      this.deform.set(key, new THREE.Vector3(x, y, z));
    }
    this.applyDeform();
    return this;
  }

  /** Quita la deformacion de un hueso, o de todos si no se pasa clave. */
  clearDeform(key = null) {
    const habia = key ? this.deform.delete(key) : this.deform.size > 0;
    if (!key) this.deform.clear();
    if (habia) this.applyDeform();
    return habia;
  }

  /** Devuelve la pose actual como rotaciones locales serializables. */
  getPose() {
    const rotations = {};
    for (const [key, bone] of Object.entries(this.bones)) {
      const q = bone.quaternion;
      rotations[key] = [q.x, q.y, q.z, q.w];
    }
    const hips = this.bones.hips;
    return {
      rotations,
      hipsOffset: hips ? [hips.position.x, hips.position.y, hips.position.z] : null,
      scales: this.deformState(),
      created: Date.now(),
    };
  }

  /** Aplica una pose guardada. `blend` permite mezclar con la actual. */
  setPose(pose, blend = 1) {
    if (!pose?.rotations) return;
    const tmp = new THREE.Quaternion();
    for (const [key, arr] of Object.entries(pose.rotations)) {
      const bone = this.bones[key];
      if (!bone || !arr) continue;
      tmp.set(arr[0], arr[1], arr[2], arr[3]);
      if (blend >= 1) bone.quaternion.copy(tmp);
      else bone.quaternion.slerp(tmp, blend);
    }
    if (pose.hipsOffset && this.bones.hips) this.bones.hips.position.fromArray(pose.hipsOffset);
    // Las escalas solo se tocan si la pose las trae: las poses guardadas antes
    // de que existiera la deformacion no borran la que haya puesta ahora.
    if (pose.scales) this.setDeformState(pose.scales);
  }

  /** Vuelve a la pose de enlace del archivo (T de Mixamo). */
  resetToRest() {
    for (const [bone, quat] of this.rest.local) bone.quaternion.copy(quat);
    // Tambien las traslaciones locales: asi deshace un estirado del IK que
    // hubiera dejado los eslabones mas largos de lo que vienen en el archivo.
    for (const [bone, pos] of this.rest.offset) bone.position.copy(pos);
    if (this.bones.hips && this.restHipsLocal) this.bones.hips.position.copy(this.restHipsLocal);
  }

  // ------------------------------------------------------------- limpieza ---

  clear() {
    if (this.helper) {
      this.root.remove(this.helper);
      this.helper.dispose?.();
      this.helper = null;
    }
    for (const mesh of this.allMeshes ?? []) {
      mesh.geometry?.dispose?.();
    }
    for (const mat of this.materialCache?.values() ?? []) mat.dispose?.();
    this.materialCache = new Map();
    this.holder.clear();
    this.meshes = { anatomia: [], maniqui: [], esqueleto: [] };
    this.baseMaterials = new Map();
    this.rest = {
      local: new Map(),
      world: new Map(),
      position: new Map(),
      scale: new Map(),
      offset: new Map(),
    };
    this.deform.clear();
    this.boneBounds = { anatomia: [], maniqui: [], esqueleto: [] };
    this.restHeight = 1;
    this.restBox.makeEmpty();
    this.contentBox.makeEmpty();
    this.localBox.makeEmpty();
    this.box.makeEmpty();
    this.bones = {};
    this.missing = [];
    this.missingRequired = [];
    this.skeleton = null;
    this.generated = null;
    this.source = null;
    this.loaded = false;
  }

  dispose() {
    for (const off of this.offs ?? []) off?.();
    this.offs = [];
    this.clear();
    this.ghostMat?.dispose();
    this.root.parent?.remove(this.root);
  }
}
