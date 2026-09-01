# ATOM

Aplicación web para estudio de dibujo del natural: captura tu pose con la cámara
(o desde una fotografía), la transfiere a una figura 3D con **anatomía, maniquí y
esqueleto** intercambiables sobre el mismo rig de Mixamo, y te da control
fotográfico completo de cámara y luz para plantear cualquier ejercicio de
proporción o claroscuro.

Todo el procesamiento ocurre **en tu navegador**: ningún fotograma sale del
equipo y no hace falta servidor ni backend.

## Puesta en marcha

```bash
npm install          # instala dependencias
npm run dev          # servidor de desarrollo (http://localhost:5173)
npm run build        # genera dist/
npm run preview      # sirve dist/ para comprobarlo
npm test             # pruebas de ejecucion sin navegador (tests/)
```

Las pruebas de `tests/` cargan el GLB real y ejercitan el retargeting, la camara
fisica, la luz, el escenario y el cableado de la interfaz en Node (jsdom). No
cubren lo que exige WebGL, webcam o WASM: eso hay que comprobarlo en el navegador
con `npm run dev`.

`npm run dev` y `npm run build` copian antes el runtime WASM de MediaPipe a
`public/wasm/` (`scripts/copy-wasm.mjs`), de modo que la inferencia no depende de
ninguna CDN externa. El modelo de pose (`.task`) sí se descarga la primera vez
desde `storage.googleapis.com` y queda en la caché del navegador.

## Publicar en Cloudflare Pages

```bash
npx wrangler login
npm run deploy       # build + wrangler pages deploy dist
```

- `wrangler.toml` declara `pages_build_output_dir = "dist"`.
- `public/_headers` fija las cachés y **evita a propósito** las cabeceras
  `COEP`/`COOP`: con ellas activas el navegador bloquearía la descarga del modelo
  `.task` de Google, que no responde con `Cross-Origin-Resource-Policy`.
- Ningún archivo del build supera el límite de 25 MiB por fichero de Pages
  (el mayor es `vision_wasm_internal.wasm`, ~11 MB).
- La cámara exige contexto seguro: funciona en `https://…pages.dev` y en
  `localhost`, no por `http://` en red local.

## Cómo se usa

| Acción | Dónde |
| --- | --- |
| Cambiar malla (anatomía / maniquí / esqueleto) | barra del visor o teclas `1` `2` `3` |
| Opacidad y sombreado (arcilla, toon, rayos X, alambre) | panel **Figura** |
| Perspectiva ↔ ortográfica | tecla `O` |
| Focal, sensor, descentrado, viñeteo, distorsión de barril, desenfoque | panel **Cámara** |
| Posición X/Y/Z de la luz principal, relleno y contra | panel **Luz** |
| Iniciar la cámara, motor de retargeting, suavizado | panel **Captura** o tecla `B` |
| Congelar la pose | tecla `Espacio` |
| Posar huesos a mano con el gizmo | tecla `G`; deshacer con `Ctrl+Z` |
| Gestos de mano, curvatura por dedo, apertura y pulgar | panel **Figura › Manos** |
| Mover las falanges con tus propios dedos | panel **Captura › Dedos por cámara** |
| Delegado GPU/CPU, ritmo de análisis y recorte cuadrado | panel **Captura › Detector** |
| Guardar, aplicar, exportar e importar poses | panel **Poses** |
| Canon de cabezas, tercios, dorada, diagonales, encuadre seguro | panel **Guías** |
| Captura PNG (con o sin fondo) | `Ctrl+S` / panel **Ajustes** |

Arrastra sobre el visor un `.glb`/`.fbx` para cargar tu propia figura, o una
imagen/vídeo para extraer su pose.

## Arquitectura

```
src/
  config.js            valores por defecto y constantes (una sola fuente de verdad)
  core/                Settings, Viewport, CameraRig, Lighting, Stage, PostFX, shaders
  core/errors.js       traduce Event/ErrorEvent a texto legible
  model/               Character (carga GLB/FBX, mallas compartidas, materiales), HandRig, boneMap, variants
  pose/                DirectRetargeter, KalidokitRetargeter, PoseEngine, OneEuroFilter, PoseLibrary
  mocap/               PoseDetector y HandTracker (MediaPipe), SquarePad, MocapSource, Overlay2D
  posing/              ManualPosing (gizmo de huesos con historial)
  scene/               SceneEditor, primitivas geométricas, luces insertables
  guides/              Guides y Perspective (reglas de proporción, composición y fuga)
  ui/                  panels, UI, Readout, widgets, icons (Lucide), Toast
  styles/              theme.css (tokens de VS Code Dark Modern) + app.css
  main.js              arranque y bucle de captura
```

- **Un solo esqueleto, tres mallas.** Las variantes se generan sobre el
  `THREE.Skeleton` del archivo con `AttachedBindMode` y `bindMatrix` identidad,
  así que cambiar de malla nunca pierde la pose.
- **Dos motores de retargeting.** El *directo* deduce cada rotación de la
  dirección medida entre puntos respecto a la pose de reposo (independiente del
  rig); *Kalidokit* aporta sus ángulos para torso, brazos, piernas y manos y usa
  el directo como base para cuello, cabeza y clavículas.
- **Sin temblor.** Los puntos se filtran con One Euro (adaptativo) y las
  rotaciones se interpolan con `slerp` normalizado al tiempo de fotograma.
- **Dedos sin ajustes por archivo.** Los ejes de flexión y de apertura de cada
  falange se deducen de la geometría de reposo (eje de la mano, línea de los
  nudillos y normal de la palma), no de los ejes locales de Mixamo, que varían
  de un archivo a otro. Del `HandTracker` solo llegan ángulos medidos entre
  segmentos, así que la mano detectada no tiene que parecerse a la del modelo.
- **Respaldo por CPU de verdad.** Si no hay GPU el detector cae a CPU, avisa, y
  se adapta: el grafo de CPU solo acepta región cuadrada, así que la imagen se
  encuadra con bandas negras (`SquarePad`) y los puntos se devuelven después a
  las coordenadas del vídeo; además se limita el ritmo de inferencia (15 fps la
  pose, 8 las manos) y se reutiliza el último fotograma entre detecciones.

## Modelo incluido

`public/models/character.glb` (1,4 MB) se genera desde `mixamo/tpose.fbx`:

```bash
npm run convert
```

La carpeta `mixamo/` con los FBX de origen no va en el repositorio (380 MB, y
GitHub rechaza archivos de mas de 100 MB): esta en `.gitignore`. Los `.glb` ya
convertidos si estan versionados, asi que el proyecto funciona sin ella.

El script convierte FBX → glTF y optimiza con `gltf-transform`. Cualquier archivo
con el esqueleto estándar `mixamorig…` sirve igual.

## Requisitos

Navegador con WebGL 2 y WebAssembly: Chrome/Edge 113+, Firefox 115+, Safari 17+.
La ejecución en GPU del detector cae automáticamente a CPU si el equipo no la
admite.
