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
- `functions/api/` se despliega solo con el mismo comando: son las dos rutas del
  buscador de imágenes (`img-search` e `img-proxy`), que en `npm run dev` y en
  `npm run preview` las sirve un plugin de `vite.config.js` con el mismo módulo
  compartido (`server/imageSearch.mjs`). El proxy solo atiende peticiones de la
  propia página (`Sec-Fetch-Site`), solo reenvía respuestas `image/*` de hasta
  12 MB y rechaza cualquier destino que no sea http/https público.
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
| Cambiar de panel (Figura, Escena, Cámara, Luz, Captura, Poses, Guías, Dibujo, Ajustes) | fila de iconos en lo alto del panel lateral |
| Elegir herramienta (seleccionar, posar, lápiz…) y sus opciones | las dos columnas que flotan en el borde del visor |
| Cambiar malla (anatomía / maniquí / esqueleto) | barra del visor o teclas `1` `2` `3` |
| Opacidad y sombreado (arcilla, toon, rayos X, alambre) | panel **Figura** |
| Perspectiva ↔ ortográfica | tecla `O` |
| Focal, sensor, descentrado, viñeteo, distorsión de barril, desenfoque | panel **Cámara** |
| Posición X/Y/Z de la luz principal, relleno y contra | panel **Luz** |
| Iniciar la cámara, motor de retargeting, suavizado | panel **Captura** o tecla `B` |
| Buscar una imagen de referencia en la web | tecla `Espacio` o la lupa de la barra del visor |
| Congelar la pose | tecla `C` |
| Posar huesos a mano con el gizmo | tecla `G`; deshacer con `Ctrl+Z` |
| Posar arrastrando manos y pies (cinemática inversa) | tecla `I`; `W` mueve el control, `E` gira la punta |
| Clavar o soltar el control elegido (pies en el suelo al agacharse) | tecla `X` o panel **Poses › Cinemática inversa** |
| Enseñar solo los controles que hay junto al puntero | tecla `N` o panel **Poses › Pose manual** |
| Squash y stretch (la cadena se estira para llegar y se aplasta al plegarse) | panel **Poses › Cinemática inversa** |
| Ejes del gizmo (mundo / propios) para objetos **y para huesos** | panel **Escena › Manipulador** o `Alt+X` |
| Caja envolvente al pasar el ratón, del elemento elegido o de todos | panel **Escena › Caja envolvente** o el botón **Caja** |
| Línea de acción, ritmos brazo a brazo y hombro a pierna (cruzado, por su lado o por el costado), fantasma exagerado | panel **Guías › Línea de acción** |
| Dibujar sobre el visor con presión de pluma | tecla `D`; `Alt` para orbitar sin salir |
| Gestos de mano, curvatura por dedo, apertura y pulgar | panel **Figura › Manos** |
| Mover las falanges con tus propios dedos | panel **Captura › Dedos por cámara** |
| Delegado GPU/CPU, ritmo de análisis y recorte cuadrado | panel **Captura › Detector** |
| Guardar, aplicar, exportar e importar poses | panel **Poses** |
| Canon de cabezas, tercios, dorada, diagonales, encuadre seguro | panel **Guías** |
| Grosor del lápiz, borrador, deshacer el trazo | panel **Dibujo** o `[` `]` y `Ctrl+Z` |
| Captura PNG (con o sin fondo) | `Ctrl+S` / panel **Ajustes** |

Arrastra sobre el visor un `.glb`/`.fbx` para cargar tu propia figura, o una
imagen/vídeo para extraer su pose.

El buscador (`Espacio`) hace lo mismo sin salir de la página: escribes la pose
que necesitas, pulsas una miniatura y esa imagen entra en el monitor de captura,
de donde el detector saca la postura para la figura activa. Pregunta a la vez a
Bing, DuckDuckGo, Wikimedia Commons, Openverse y los archivos abiertos del Art
Institute of Chicago, el Cleveland Museum of Art y el Met, y devuelve una sola
rejilla entrelazada (hasta 120 imágenes) con una fila de fuentes para quedarte
solo con las de un sitio; la Wellcome Collection queda fuera de la mezcla y se
elige a mano en **Captura › Buscador**. No hay ninguna clave de API y las
imágenes se descargan por el propio dominio (`/api/img-proxy`), porque una imagen
de otro dominio sin CORS no se puede subir a una textura de WebGL.

## Arquitectura

```
src/
  config.js            valores por defecto y constantes (una sola fuente de verdad)
  core/                Settings, Viewport, CameraRig, Lighting, Stage, PostFX, shaders
  core/errors.js       traduce Event/ErrorEvent a texto legible
  model/               Character (carga GLB/FBX, mallas compartidas, materiales), HandRig, boneMap, variants
  pose/                DirectRetargeter, KalidokitRetargeter, PoseEngine, OneEuroFilter, PoseLibrary, ik (solucionadores)
  mocap/               PoseDetector y HandTracker (MediaPipe), SquarePad, MocapSource, Overlay2D
  posing/              ManualPosing (gizmo de huesos con historial), IKRig (cadenas de cinemática inversa), proximity (cercanía al puntero en pantalla)
  draw/                Sketch (lápiz sobre el visor) y stroke.js (geometría del trazo)
  scene/               SceneEditor, Bounds (cajas envolventes), primitivas, luces insertables
  guides/              Guides, Perspective y ActionLine (acción, ritmos y fantasma)
  search/              ImageSearch (cliente del buscador de imágenes)
  ui/                  panels, UI, Readout, widgets, icons (Lucide), Toast, SearchBar
  styles/              theme.css (tokens de VS Code Dark Modern) + app.css
  main.js              arranque y bucle de captura
server/                motor del buscador y del proxy de imágenes (sin dependencias)
functions/api/         las dos rutas en Cloudflare Pages: img-search e img-proxy
```

- **Un solo esqueleto, tres mallas.** Las variantes se generan sobre el
  `THREE.Skeleton` del archivo con `AttachedBindMode` y `bindMatrix` identidad,
  así que cambiar de malla nunca pierde la pose.
- **La figura se mide en cada fotograma.** Al cargar el modelo se reparte la piel
  entre los huesos que la mueven y se guardan, por hueso, sus vértices extremos en
  26 direcciones (envoltorio de 26 caras, ver `Character.#buildBoneBounds`). Con
  eso el volumen envolvente se recalcula transformando unos mil puntos —0,07 ms
  por figura— en vez de recorrer la piel deformada, que cuesta milisegundos. De
  ahí salen tres cosas que antes no cuadraban: la caja sigue a la pose, el anclaje
  al suelo mantiene los pies apoyados aunque la figura se agache, y la **altura en
  metros se mide siempre con la figura en reposo**, así que posarla ya no la
  reescala. Cada variante tiene su propio volumen: se mide la malla que se ve.
- **Cinemática inversa como en un rig.** Con `I` aparecen rombos en manos, pies,
  pecho y cabeza: se arrastra el extremo y el resto de la cadena se acomoda, en vez
  de girar tres huesos por brazo. Brazos y piernas se resuelven con la **ley de
  cosenos** en tres pasos —doblar el codo para que la distancia cuadre, apuntar el
  conjunto al objetivo y girar sobre el eje hombro-objetivo para llevar el codo a su
  polo—; ese tercer paso gira alrededor de la recta donde ya está la mano, así que
  no la puede mover, y el hueso de la punta nunca se escribe, de modo que la muñeca
  y el pie se siguen girando a mano encima (`E`). El torso y el cuello usan FABRIK,
  donde no hay fórmula cerrada. Todo se resuelve **girando** huesos, nunca
  estirándolos —salvo que se pida el squash y stretch, que es lo de abajo—: el
  esqueleto no se puede romper. Los objetivos viven en el espacio
  del `holder`, no en el del mundo, porque en el mundo levantar un pie movería el
  anclaje al suelo, que movería el objetivo, que volvería a mover el anclaje. Un
  control sin clavar sigue a su extremidad, así que la cinemática inversa no pelea
  con la captura ni con la biblioteca de poses; clavarlo (`X`) es lo contrario, y es
  lo que permite hundir la cadera con el cubo grande y que los pies no se despeguen
  del suelo. El polo del codo o la rodilla no se guarda: se deduce del pliegue de
  ahora, y con el miembro estirado manda la anatomía medida en la pose de reposo.
- **Squash y stretch, si se pide.** Es la única excepción a lo de no estirar
  huesos, y nace apagada. Con ella puesta, antes de resolver se mide cuánto le falta
  a la cadena para llegar y se alargan sus eslabones en esa proporción, de modo que
  el solucionador —que lee los huesos tal como están— sigue devolviendo una solución
  de giros. Solo entra en juego en los dos extremos, cuando el objetivo queda más
  lejos de lo que da el miembro o más cerca de lo que puede plegarse, así que
  encenderla no cambia ninguna pose que ya llegaba. El factor se mide siempre sobre
  el largo natural apuntado al construir la cadena, nunca sobre el estirado de ahora,
  que si no el brazo se alargaría un poco más en cada solución; y el grosor se
  compensa con una escala **uniforme** en el hueso raíz (`1/√k`), que por ser
  uniforme no cizalla la piel de un miembro doblado como haría una escala por ejes.
  Todo se rehace desde el reposo en cada cambio, porque el cuello es a la vez la
  punta del torso y la raíz de la cabeza y los dos factores tienen que multiplicarse
  en ese hueso. Una pose guardada lleva solo giros, así que el estirado viaja aparte
  (`IKRig.stretchState`) y aplicar una pose de la biblioteca devuelve los largos.
- **Solo los controles que hacen falta.** Una figura entera pasa de cuarenta
  manejadores y de espaldas se tapan unos a otros. Con `N` solo se ven los del
  entorno del puntero: cada manejador se proyecta a pantalla y se mide su distancia
  al ratón en **altos de visor** —no en píxeles, para que se porte igual en un
  portátil que en un monitor grande—, con un borde en el que entran creciendo en vez
  de encenderse de golpe. Vale para las dos formas de posar, hueso a hueso y
  arrastrando la mano. El manejador elegido y los controles clavados no se esconden
  nunca, que si no habría que buscarlos a ciegas. La lista de lo que acepta el ratón
  se rehace en el mismo sitio donde se decide qué se ve, porque el `Raycaster` de
  three ignora `.visible` y un manejador invisible seguiría robando el clic.
- **Una herramienta, sus opciones al lado.** La barra del visor son dos columnas:
  la de herramientas y, pegada a ella, la de las opciones de la elegida, que cambia
  con ella (`UI.#toolModel`). Las tres primeras —seleccionar, posar, lápiz— son
  **modos del puntero**: elegirlas enciende el modo y apaga los otros dos, y elegir
  el lápiz ya deja dibujar. Las demás solo cambian las opciones, así que se puede
  encender una guía sin soltar el lápiz: la herramienta elegida se marca con fondo
  y el modo en marcha con el acento a la izquierda.
- **El lápiz no depende de la presión.** Si la pluma la envía, gobierna el grosor
  (y, si se quiere, la opacidad); si no —ratón, trackpad o pluma sin sensor—, el
  grosor sale de la velocidad del trazo y de las rampas de entrada y salida, que
  es lo que hace que una línea de ratón no parezca un tubo. El puntero se atrapa
  en la fase de captura del documento, de modo que el lápiz se adelanta a la
  órbita y a la selección sin desconectarlas (`Alt` las devuelve).
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

### Añadir figuras a la biblioteca

Copia el `.glb` (o `.gltf`/`.fbx`) en **`public/models/`** y aparecerá en el panel
**Figura › Modelo** con el nombre del archivo sin la extensión — `xbot.glb` sale
como «xbot». No hay lista, índice, manifiesto ni tabla de nombres en ninguna
parte: el plugin `atom-model-list` de [`vite.config.js`](vite.config.js) lee el
directorio, así que añadir, quitar o **renombrar** un archivo se refleja sin
tocar código.

- `npm run dev` lee `public/models` y recarga la página en cuanto sueltas el
  archivo.
- `npm run preview` lee `dist/models`, así que también ahí se ve al recargar,
  sin reconstruir.
- **`dist/` es salida generada**: `npm run build` la borra y la vuelve a crear
  desde `public/`. Lo que pongas solo en `dist/models` se pierde en la siguiente
  build; el sitio de los modelos es `public/models`.
- En un servidor estático sin esa ruta (Cloudflare Pages) vale la lista que quedó
  dentro del paquete al construir.
- Si el mismo nombre existe en dos formatos, gana el `.glb`.
- Los nombres con espacios o acentos valen: se muestran tal cual y la URL se
  codifica sola.

## Requisitos

Navegador con WebGL 2 y WebAssembly: Chrome/Edge 113+, Firefox 115+, Safari 17+.
La ejecución en GPU del detector cae automáticamente a CPU si el equipo no la
admite.
