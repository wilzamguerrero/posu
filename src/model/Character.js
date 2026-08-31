/**
 * POSU · Personaje
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

    // variante -> mallas de esa variante (un archivo puede traer varias).
    this.meshes = { anatomia: [], maniqui: [], esqueleto: [] };
    this.baseMaterials = new Map(); // malla -> material original del archivo
    this.skeleton = null;
    this.bones = {};
    this.missing = [];          // todas las claves sin hueso
    this.missingRequired = []; // solo las que la aplicacion necesita
    this.rest = { local: new Map(), world: new Map(), position: new Map() };
    this.basis = new THREE.Quaternion();
    this.helper = null;
    this.ghost = null;
    this.box = new THREE.Box3();
    this.loaded = false;
    this.sourceScale = 1;

    this.#bind();
  }

  #bind() {
    const s = this.settings;
    s.on('figure.variant', (v) => this.cambiarGeometria(v));
    s.on(['figure.shading', 'figure.clayColor'], () => this.applyShading());
    // Cada variante tiene su propia ranura de material: anatomia incluida.
    s.on('materials.*', () => this.applyShading());
    s.on('figure.opacity', () => this.applyOpacity());
    s.on(['figure.showGhost', 'figure.ghostOpacity'], () => this.applyGhost());
    s.on('figure.showSkeletonHelper', () => this.applyHelper());
    s.on(['figure.height', 'figure.turn', 'figure.anchor'], () => this.applyTransform());
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

  // ------------------------------------------------------- transformaciones ---

  /** Normaliza altura, giro y anclaje al suelo. */
  applyTransform() {
    if (!this.loaded) return;
    const s = this.settings;
    this.holder.scale.setScalar(1);
    this.holder.rotation.set(0, 0, 0);
    this.holder.position.set(0, 0, 0);
    this.holder.updateMatrixWorld(true);

    // Solo se mide el contenido del archivo: las variantes generadas comparten
    // el mismo esqueleto y podrian tener extremos ligeramente distintos.
    const raw = new THREE.Box3().setFromObject(this.source);
    const h = Math.max(0.01, raw.max.y - raw.min.y);
    const k = s.get('figure.height') / h;

    this.holder.scale.setScalar(k);
    this.holder.rotation.y = THREE.MathUtils.degToRad(s.get('figure.turn'));
    // "suelo": plantas de los pies en y=0. "centro": figura centrada en el origen.
    this.holder.position.y = s.get('figure.anchor') === 'centro'
      ? -((raw.min.y + raw.max.y) / 2) * k
      : -raw.min.y * k;
    this.holder.updateMatrixWorld(true);

    this.refreshBounds();
  }

  /** Recalcula el volumen envolvente teniendo en cuenta la pose actual. */
  refreshBounds() {
    if (!this.loaded) return this.box;
    for (const mesh of this.allMeshes) mesh.boundingBox = null;
    this.root.updateMatrixWorld(true);
    this.box.setFromObject(this.source);
    return this.box;
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
  }

  /** Vuelve a la pose de enlace del archivo (T de Mixamo). */
  resetToRest() {
    for (const [bone, quat] of this.rest.local) bone.quaternion.copy(quat);
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
    this.rest = { local: new Map(), world: new Map(), position: new Map() };
    this.bones = {};
    this.missing = [];
    this.missingRequired = [];
    this.skeleton = null;
    this.generated = null;
    this.source = null;
    this.loaded = false;
  }

  dispose() {
    this.clear();
    this.ghostMat?.dispose();
    this.root.parent?.remove(this.root);
  }
}
