/**
 * ATOM · Escenario
 * ---------------------------------------------------------------------------
 * Fondo, suelo, receptor de sombras y ayudas geometricas. Tres modos de fondo:
 *
 *   degradado  cupula con degradado vertical (el mas neutro para dibujar)
 *   solido     color plano
 *   ciclorama  suelo que curva hasta la pared, como un plato de fotografia
 *
 * La sombra proyectada se recoge en un plano con `ShadowMaterial` aparte del
 * suelo: asi su intensidad es un parametro independiente del color del suelo.
 */
import * as THREE from 'three';

const BACKDROP_VERT = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vWorld = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
    gl_Position = projectionMatrix * viewMatrix * vec4( vWorld, 1.0 );
  }
`;

const BACKDROP_FRAG = /* glsl */ `
  uniform vec3 uTop;
  uniform vec3 uBottom;
  uniform float uRadius;
  varying vec3 vWorld;
  void main() {
    // Mezcla por altura normalizada, con una curva suave alrededor del horizonte.
    float h = clamp( vWorld.y / uRadius * 0.5 + 0.5, 0.0, 1.0 );
    float t = smoothstep( 0.34, 0.86, h );
    gl_FragColor = vec4( mix( uBottom, uTop, t ), 1.0 );
    // Las dos inclusiones dejan el fondo bajo las mismas reglas de mapeo de
    // tonos y espacio de color que el resto de la escena, tanto si se dibuja
    // directo a pantalla como si pasa por el compositor.
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** Construye la superficie de un ciclorama: suelo + curva + pared. */
function cycloramaGeometry({ width = 16, front = 6, back = 3.9, fillet = 1.7, height = 7 } = {}) {
  // Perfil en el plano (z, y): tramo de suelo, curva de union y pared.
  const profile = [new THREE.Vector2(front, 0)];
  const cz = -(back - fillet);
  for (let i = 0; i <= 14; i++) {
    const a = (i / 14) * (Math.PI / 2);
    profile.push(new THREE.Vector2(cz - Math.sin(a) * fillet, fillet - Math.cos(a) * fillet));
  }
  profile.push(new THREE.Vector2(cz - fillet, height));

  const positions = [];
  const uvs = [];
  const indices = [];
  const cols = 2;
  for (let r = 0; r < profile.length; r++) {
    const p = profile[r];
    for (let c = 0; c < cols; c++) {
      const x = -width / 2 + (c / (cols - 1)) * width;
      positions.push(x, p.y, p.x);
      uvs.push(c / (cols - 1), r / (profile.length - 1));
    }
  }
  for (let r = 0; r < profile.length - 1; r++) {
    const a = r * cols;
    const b = (r + 1) * cols;
    indices.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

export class Stage {
  constructor(scene, settings) {
    this.scene = scene;
    this.settings = settings;
    this.root = new THREE.Group();
    this.root.name = 'Escenario';
    scene.add(this.root);

    // Cupula de fondo: esfera invertida, sin luces ni escritura de profundidad.
    this.backdropMat = new THREE.ShaderMaterial({
      vertexShader: BACKDROP_VERT,
      fragmentShader: BACKDROP_FRAG,
      uniforms: {
        uTop: { value: new THREE.Color('#1f2429') },
        uBottom: { value: new THREE.Color('#0c0e10') },
        uRadius: { value: 60 },
      },
      side: THREE.BackSide,
      depthWrite: false,
    });
    this.backdrop = new THREE.Mesh(new THREE.SphereGeometry(60, 32, 24), this.backdropMat);
    this.backdrop.name = 'Fondo';
    this.root.add(this.backdrop);

    // Suelo visible.
    this.floorMat = new THREE.MeshStandardMaterial({ color: '#1b1d20', roughness: 0.92, metalness: 0 });
    this.floor = new THREE.Mesh(new THREE.CircleGeometry(9, 64), this.floorMat);
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.name = 'Suelo';
    this.root.add(this.floor);

    // Receptor de sombra independiente del suelo.
    this.shadowMat = new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.55, transparent: true });
    this.catcher = new THREE.Mesh(new THREE.PlaneGeometry(24, 24), this.shadowMat);
    this.catcher.rotation.x = -Math.PI / 2;
    this.catcher.position.y = 0.0015;
    this.catcher.receiveShadow = true;
    this.catcher.name = 'Sombra';
    this.root.add(this.catcher);

    // Ciclorama.
    this.cycMat = new THREE.MeshStandardMaterial({ color: '#22262b', roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
    this.cyclorama = new THREE.Mesh(cycloramaGeometry(), this.cycMat);
    this.cyclorama.receiveShadow = true;
    this.cyclorama.visible = false;
    this.cyclorama.name = 'Ciclorama';
    this.root.add(this.cyclorama);

    this.grid = this.#makeGrid(settings.get('stage.gridSize') ?? 10);
    this.root.add(this.grid);

    this.axes = new THREE.AxesHelper(1.2);
    this.axes.visible = false;
    this.root.add(this.axes);

    this.settings.on('stage.*', () => this.apply());
    this.apply();
  }

  /** Rejilla de suelo del tamano pedido, en metros. */
  #makeGrid(size) {
    const grid = new THREE.GridHelper(size, Math.round(size), 0x3a4149, 0x25292e);
    grid.position.y = 0.003;
    grid.material.transparent = true;
    grid.material.opacity = 0.7;
    grid.name = 'Rejilla';
    grid.userData.size = size;
    return grid;
  }

  apply() {
    const s = this.settings;
    const mode = s.get('stage.background');
    const base = new THREE.Color(s.get('stage.bgColor'));

    // El degradado se deriva del color base: mas claro arriba, mas oscuro abajo.
    const top = base.clone().lerp(new THREE.Color('#ffffff'), 0.14);
    const bottom = base.clone().multiplyScalar(0.42);
    this.backdropMat.uniforms.uTop.value.copy(mode === 'solido' ? base : top);
    this.backdropMat.uniforms.uBottom.value.copy(mode === 'solido' ? base : bottom);
    this.backdrop.visible = mode !== 'ciclorama';

    this.cyclorama.visible = mode === 'ciclorama';
    this.cycMat.color.set(s.get('stage.floorColor')).lerp(new THREE.Color('#ffffff'), 0.22);

    this.floor.visible = s.get('stage.floor') && mode !== 'ciclorama';
    this.floorMat.color.set(s.get('stage.floorColor'));

    const strength = s.get('stage.shadowStrength');
    this.shadowMat.opacity = strength;
    this.catcher.visible = strength > 0.001 && mode !== 'ciclorama';

    const size = Math.max(2, s.get('stage.gridSize'));
    if (this.grid.userData.size !== size) {
      this.root.remove(this.grid);
      this.grid.geometry.dispose();
      this.grid.material.dispose();
      this.grid = this.#makeGrid(size);
      this.root.add(this.grid);
    }
    this.grid.visible = s.get('stage.grid') && mode !== 'ciclorama';
    this.axes.visible = s.get('stage.axes');
  }

  /** Oculta el escenario para exportar capturas con fondo transparente. */
  setVisible(visible) {
    this.root.visible = visible;
  }

  dispose() {
    this.root.traverse((o) => {
      o.geometry?.dispose?.();
      if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
      else o.material?.dispose?.();
    });
    this.scene.remove(this.root);
  }
}
