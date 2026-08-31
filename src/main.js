/**
 * POSU · Punto de entrada
 * ---------------------------------------------------------------------------
 * Arranca los modulos en el orden en que se necesitan (visor 3D → personaje →
 * captura → interfaz), los conecta mediante el objeto `app` y expone las
 * acciones que usan los paneles y los atajos de teclado. Aqui vive tambien el
 * bucle de captura: un unico `onFrame` que pide un fotograma al detector, se lo
 * pasa al motor de pose y redibuja el esqueleto y las guias.
 */

import './styles/theme.css';
import './styles/app.css';

import { DEFAULTS, STORAGE_KEY, MODEL_LIBRARY } from './config.js';
import { Settings } from './core/Settings.js';
import { Viewport } from './core/Viewport.js';
import { FigureSet, MAX_FIGURAS, libraryUrl } from './model/FigureSet.js';
import { PoseEngine } from './pose/PoseEngine.js';
import { PoseLibrary } from './pose/PoseLibrary.js';
import { PoseDetector } from './mocap/PoseDetector.js';
import { HandTracker } from './mocap/HandTracker.js';
import { MocapSource } from './mocap/MocapSource.js';
import { Overlay2D } from './mocap/Overlay2D.js';
import { ManualPosing } from './posing/ManualPosing.js';
import { HandRig, HAND_PRESET_BY_ID } from './model/HandRig.js';
import { Guides } from './guides/Guides.js';
import { SceneEditor } from './scene/SceneEditor.js';
import { UI } from './ui/UI.js';
import { StatusBar } from './ui/StatusBar.js';
import { pickFile } from './ui/panels.js';
import { initToasts, toast } from './ui/Toast.js';
import { errorText } from './core/errors.js';
import { hydrateIcons } from './ui/icons.js';

/* ── Pantalla de arranque ──────────────────────────────────────────────── */

const bootEl = document.getElementById('boot');
const bootFill = document.getElementById('boot-bar-fill');
const bootMsg = document.getElementById('boot-msg');
const boot = (pct, message) => {
  if (bootFill) bootFill.style.width = Math.round(pct * 100) + '%';
  if (message && bootMsg) bootMsg.textContent = message;
};
const bootDone = () => {
  boot(1);
  bootEl?.classList.add('is-done');
  document.getElementById('app')?.removeAttribute('aria-busy');
  if (!bootEl) return;
  // Deja de recibir clics al momento: mientras se desvanece sigue cubriendo la
  // pagina entera. Y se retira en cuanto acabe la transicion, sin esperar al
  // temporizador, para que un compositor atascado no deje una capa opaca encima
  // de la interfaz.
  bootEl.style.pointerEvents = 'none';
  const fuera = () => bootEl.remove();
  bootEl.addEventListener('transitionend', fuera, { once: true });
  setTimeout(fuera, 600);
};

/** Mensaje de error definitivo, en la pantalla de arranque si sigue visible. */
const bootError = (text) => {
  console.error('[POSU]', text);
  const msg = document.getElementById('boot-msg');
  if (!msg) return;
  msg.textContent = text;
  msg.classList.add('is-error');
  document.getElementById('boot')?.classList.remove('is-done');
};

/** Descarga un Blob con el nombre indicado. */
function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const isModelFile = (name) => /\.(glb|gltf|fbx)$/i.test(name);

async function main() {
  hydrateIcons(document);
  initToasts(document.getElementById('toasts'));

  const settings = new Settings(DEFAULTS, STORAGE_KEY);
  // La captura nunca arranca congelada por un valor heredado de la sesion.
  settings.set('mocap.frozen', false, { silent: true });

  boot(0.08, 'Preparando el motor 3D…');
  const viewport = new Viewport(document.getElementById('gl-canvas'), settings);

  /* ── Contexto grafico perdido ───────────────────────────────────────── */

  // Hay controladores (tipicamente Linux con GPU hibrida, y tambien equipos que
  // acaban dibujando por software) que tumban el contexto en el primer dibujo:
  // los programas dejan de enlazar, la consola se llena de «VALIDATE_STATUS
  // false» y el visor se queda en negro. La primera vez se reintenta en modo
  // compatible; si vuelve a caerse se avisa y no se insiste, para no dejar la
  // pagina recargandose en bucle.
  const RETRY_KEY = 'posu.compat.retry';
  const reintentado = (() => {
    try { return sessionStorage.getItem(RETRY_KEY) === '1'; } catch { return false; }
  })();

  viewport.onContextLost = (gpu) => {
    if (settings.get('quality.compat') === true || reintentado) {
      const detalle = gpu ? ` (${gpu})` : '';
      bootError(`El navegador ha perdido el contexto grafico${detalle}. Prueba con otro navegador o actualiza el controlador de la tarjeta grafica.`);
      toast('Se ha perdido el contexto grafico', 'err');
      return;
    }
    settings.set('quality.compat', true);
    settings.save();
    try { sessionStorage.setItem(RETRY_KEY, '1'); } catch { /* modo privado */ }
    toast('Fallo grafico: se activa el modo compatible y se recarga…', 'warn');
    setTimeout(() => location.reload(), 1200);
  };
  viewport.onContextRestored = () => toast('Contexto grafico recuperado', 'ok');

  /* ── El navegador deja de dibujar ───────────────────────────────────── */

  // Sintoma tipico: la ventana se queda en negro (o con el ultimo fotograma
  // congelado), la consola limpia y la aplicacion viva por dentro. Pasa cuando
  // el compositor del sistema deja de presentar la pagina; el visor ya ha vuelto
  // a pedir el bucle, aqui se empuja tambien a repintar el resto de la interfaz.
  let avisadoParon = false;
  viewport.onRenderStall = () => {
    const raiz = document.getElementById('app');
    if (raiz) {
      // Un cambio de opacidad imperceptible obliga al navegador a componer un
      // fotograma nuevo de toda la pagina, no solo del lienzo 3D.
      raiz.style.opacity = '0.999';
      setTimeout(() => { raiz.style.opacity = ''; }, 60);
    }
    if (avisadoParon) return;
    avisadoParon = true;
    toast('El navegador habia dejado de dibujar; se ha reanudado el visor', 'warn');
  };

  // El modo compatible se decide al crear el renderizador: cambiarlo a mano
  // solo surte efecto al recargar.
  settings.on('quality.compat', () => toast('Recarga la pagina para aplicar el modo compatible', 'warn'));

  /* ── Figuras ────────────────────────────────────────────────────────── */

  // `FigureSet` es el dueno de los personajes vivos: crea, carga, clona y
  // destruye. El resto del programa solo pregunta por la figura activa, que es
  // la que recibe la captura por camara, las poses, el posado manual y las
  // manos. Los avisos llegan por estas devoluciones de llamada, que se disparan
  // siempre despues de montar `app` y la interfaz.
  const figures = new FigureSet({
    settings,
    viewport,
    onProgress: (texto) => { boot(0.4, texto); app.ui?.setStatus?.(texto); },
    onLoaded: (id, ch) => onFigureLoaded(id, ch),
    onError: (id, err) => {
      app.ui?.setStatus?.('No se pudo cargar el modelo', 'err');
      toast(`No se pudo cargar el modelo: ${errorText(err)}`, 'err');
    },
    onChange: () => {
      app.scene?.rebuild();
      app.hooks.refreshScene?.();
      app.hooks.refreshFigures?.();
      app.statusbar?.setFigure?.();
    },
  });
  // Sesion nueva (o anterior a las figuras multiples): se siembra una figura con
  // los ajustes heredados, asi que la escena nunca esta vacia.
  figures.seed();

  // El autofoco pregunta a la figura activa donde esta la cabeza, las manos, etc.
  viewport.cameras.focusProvider = (target, out) => {
    const ch = figures.active;
    return ch?.loaded ? ch.focusPoint(target, out) : null;
  };

  const engine = new PoseEngine(settings, null);
  const detector = new PoseDetector(settings);
  const overlay = new Overlay2D(document.getElementById('mocap-overlay'), settings);
  const guides = new Guides(document.getElementById('guide-canvas'), settings, viewport);

  const app = {
    settings, viewport, figures, engine, detector, overlay, guides,
    hooks: {}, actions: {},
  };
  // Compatibilidad y comodidad en consola: `posu.character` es la figura activa.
  Object.defineProperty(app, 'character', { get: () => figures.active, enumerable: true });


  detector.onFallback = (aviso) => {
    toast(aviso, 'warn');
    settings.set('mocap.delegate', 'CPU');
  };

  const source = new MocapSource(settings, {
    video: document.getElementById('mocap-video'),
    image: document.getElementById('mocap-image'),
    onStatus: (st) => onSourceStatus(st),
  });
  app.source = source;

  const library = new PoseLibrary(null, { onChange: () => app.hooks.refreshPoses?.() });
  app.library = library;

  const posing = new ManualPosing({
    settings, viewport, character: null,
    onSelect: (entry) => settings.set('ui.selectedBone', entry?.label ?? entry?.key ?? ''),
  });
  app.posing = posing;
  settings.on('ui.manualPosing', (v) => posing.setEnabled(v === true));
  // Rig de manos: deduce los ejes de flexion del propio esqueleto y aplica los
  // valores de `hands.*`. El guardia evita que copiar una mano en la otra
  // vuelva a entrar en el mismo suscriptor.
  const hands = new HandRig(null, settings);
  app.hands = hands;
  // Rastreador de dedos por camara: usa su propio modelo de MediaPipe y
  // escribe sobre el mismo rig, asi que se carga solo si se pide.
  const tracker = new HandTracker(settings, hands);
  app.tracker = tracker;
  tracker.onCount = (n) => app.hooks.handCount?.(n);
  let enHands = false;
  const rigWrite = (fn) => {
    if (enHands) return;
    enHands = true;
    try { fn(); } finally { enHands = false; }
  };
  const ladoEditado = () => (settings.get('hands.edit') === 'right' ? 'right' : 'left');

  settings.on('hands.*', (value, prev, path) => {
    const parts = String(path).split('.');
    if (parts[1] === 'edit') return;                      // solo cambia la vista
    if (parts[1] === 'fingers') {
      posing.rebuild();
      posing.setEnabled(settings.get('ui.manualPosing') === true);
      if (value === true && settings.get('ui.manualPosing') !== true) {
        toast('Activa el posado manual para usar los manejadores de falange');
      }
      return;
    }
    if (parts[1] === 'link') {
      if (value === true) rigWrite(() => hands.mirror(ladoEditado()));
      return;
    }
    if (enHands) return;
    const side = parts[1] === 'right' ? 'right' : 'left';
    rigWrite(() => {
      // Tocar un dedo a mano deja de ser un gesto de la lista.
      if (parts[2] && parts[2] !== 'preset') settings.set(`hands.${side}.preset`, 'libre');
      if (settings.get('hands.link') === true) hands.mirror(side);
      hands.apply();
    });
  });

  /* ── Figura activa ──────────────────────────────────────────────────── */

  /**
   * Reparte la figura activa entre los modulos que trabajan sobre un personaje.
   * `rehacer` es para cuando el esqueleto es nuevo (se ha cargado o cambiado el
   * modelo) aunque el objeto `Character` sea el mismo.
   */
  function repartirActiva({ rehacer = false } = {}) {
    const ch = figures.active;
    engine.setCharacter(ch);
    library.setCharacter(ch);
    posing.setCharacter(ch);
    hands.setCharacter(ch);
    guides.setCharacter(ch);

    if (rehacer) {
      engine.reset();
      posing.clearHistory();
      posing.rebuild();
      if (ch?.loaded) hands.rebuild();
    }
    posing.setEnabled(settings.get('ui.manualPosing') === true);
    if (hands.ready) hands.apply();

    // La rejilla de modelos del panel Figura senala el de la figura activa.
    const def = figures.activeDef;
    if (def?.model) settings.set('figure.model', def.model);

    app.hooks.refreshScene?.();
    app.hooks.refreshFigures?.();
    app.statusbar?.setFigure?.();
    viewport.invalidateShadows();
  }

  /** Avisa de los huesos que faltan, solo de los que la aplicacion necesita. */
  function avisaHuesos(ch) {
    if (ch?.missingRequired?.length) {
      console.warn('[Modelo] huesos sin correspondencia:', ch.missingRequired);
      toast(`Faltan ${ch.missingRequired.length} huesos del esqueleto estandar`, 'warn');
    } else if (ch?.missing?.length) {
      console.info('[Modelo] huesos opcionales ausentes:', ch.missing);
    }
  }

  /** Una figura ha terminado de cargar (alta, duplicado o cambio de modelo). */
  function onFigureLoaded(id, ch) {
    app.scene?.rebuild();           // su caja ya se puede pinchar en el visor
    if (id !== figures.activeId) { viewport.invalidateShadows(); return; }
    repartirActiva({ rehacer: true });
    avisaHuesos(ch);
  }

  settings.on('figure.active', () => repartirActiva({ rehacer: true }));

  /* ── Acciones de la interfaz ────────────────────────────────────────── */

  const actions = app.actions;

  actions.loadModelFile = async () => {
    const file = await pickFile('.glb,.gltf,.fbx');
    if (file) await loadCharacter(file);
  };
  actions.loadLibraryModel = async (id) => {
    const entry = MODEL_LIBRARY.find((e) => e.id === id);
    if (!entry) return false;
    // `figure.model` es la plantilla de las figuras nuevas y lo que marca la
    // rejilla del panel; el modelo real de la figura lo escribe `loadInto`.
    settings.set('figure.model', entry.id);
    const ok = await loadCharacter(entry.url);
    if (ok) toast('Figura: ' + entry.label, 'ok');
    return ok;
  };
  actions.resetModel = () => {
    settings.set('figure.model', 'character');
    return loadCharacter(libraryUrl('character'));
  };

  actions.handleDroppedFile = async (file) => {
    if (isModelFile(file.name)) return loadCharacter(file);
    const ok = await source.useFile(file);
    if (!ok) return;
    settings.set('mocap.source', source.kind === 'imagen' ? 'imagen' : 'video');
    await startCapture();
  };

  actions.startCapture = () => startCapture();
  actions.stopCapture = () => stopCapture();
  actions.loadMediaFile = async () => {
    const file = await pickFile('image/*,video/*');
    if (!file) return;
    await actions.handleDroppedFile(file);
  };
  actions.detectStill = async () => {
    if (source.kind !== 'imagen') {
      toast('Carga primero una imagen de referencia', 'warn');
      return;
    }
    const frame = await source.detectStill(detector);
    if (!frame?.landmarks?.length) {
      toast('No se ha reconocido ninguna figura en la imagen', 'warn');
      return;
    }
    settings.set('mocap.frozen', false);
    engine.update(frame, 1 / 30);
    viewport.invalidateShadows();
    overlay.draw(source, frame);
    toast('Pose extraida de la imagen', 'ok');
  };

  actions.frameFigure = () => {
    const ch = figures.active;
    if (!ch?.loaded) return;
    ch.refreshBounds();
    viewport.frame(ch.box);
  };
  actions.resetCamera = () => {
    settings.reset('camera');
    viewport.cameras.setView('tres cuartos');
    actions.frameFigure();
  };
  actions.setView = (name) => {
    viewport.cameras.setView(name);
  };

  actions.resetPose = () => {
    posing.mark?.();
    engine.release();
    hands.apply();          // el reposo borra los dedos: se recuperan los valores
    viewport.invalidateShadows();
    toast('Pose de reposo restaurada');
  };
  actions.handPreset = (id) => {
    if (!hands.ready) { toast('El personaje cargado no trae dedos', 'warn'); return; }
    const objetivo = settings.get('hands.link') === true ? null : ladoEditado();
    rigWrite(() => hands.applyPreset(objetivo, id));
    viewport.invalidateShadows();
    toast('Gesto: ' + (HAND_PRESET_BY_ID[id]?.label ?? id).toLowerCase());
  };
  actions.mirrorHand = () => {
    if (!hands.ready) { toast('El personaje cargado no trae dedos', 'warn'); return; }
    const side = ladoEditado();
    rigWrite(() => hands.mirror(side));
    viewport.invalidateShadows();
    toast(side === 'left' ? 'Mano izquierda copiada en la derecha' : 'Mano derecha copiada en la izquierda');
  };
  actions.presetPose = (tipo) => {
    settings.set('mocap.frozen', true);
    library.preset(tipo);
    viewport.invalidateShadows();
    toast(tipo === 't' ? 'Pose T aplicada' : 'Pose A aplicada');
  };
  actions.undo = () => {
    if (!posing.canUndo) return;
    posing.undo();
  };

  actions.capturePose = (name) => {
    const item = library.capture(name ?? '');
    if (!item) {
      toast('Todavia no hay un modelo cargado', 'warn');
      return;
    }
    figures.snapshotPoses();
    app.hooks.refreshPoses?.();
    toast(`Guardada «${item.name}»`, 'ok');
  };
  actions.applyPose = (id) => {
    settings.set('mocap.frozen', true);
    if (library.apply(id)) {
      figures.snapshotPoses();
      viewport.invalidateShadows();
      toast('Pose aplicada');
    }
  };
  actions.deletePose = (id) => {
    library.remove(id);
    app.hooks.refreshPoses?.();
  };
  actions.exportPoses = () => {
    if (!library.list().length) {
      toast('No hay poses que exportar', 'warn');
      return;
    }
    download(new Blob([library.exportJSON()], { type: 'application/json' }), `posu-poses-${stamp()}.json`);
  };
  actions.importPoses = async () => {
    const file = await pickFile('.json,application/json');
    if (!file) return;
    const count = library.importJSON(await file.text());
    app.hooks.refreshPoses?.();
    toast(count ? `${count} pose(s) importada(s)` : 'El archivo no contiene poses validas', count ? 'ok' : 'err');
  };

  actions.screenshot = async (transparent = false) => {
    try {
      const blob = await viewport.screenshot({ scale: 2, transparent });
      if (!blob) throw new Error('sin datos');
      download(blob, `posu-${stamp()}.png`);
      toast('Captura guardada', 'ok');
    } catch (err) {
      console.error('[Captura de pantalla]', err);
      toast('No se pudo generar la imagen', 'err');
    }
  };
  actions.copySettings = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(settings.state, null, 2));
      toast('Ajustes copiados al portapapeles', 'ok');
    } catch {
      toast('El navegador no permite copiar al portapapeles', 'warn');
    }
  };
  actions.resetAll = async () => {
    stopCapture();
    settings.reset();
    // `reset` deja `scene.figures` vacio: se vuelve a sembrar una figura.
    figures.seed();
    await figures.sync();
    engine.release();
    toast('Ajustes restablecidos');
  };

  /* ── Escena del usuario: figuras, solidos y luces ───────────────────── */

  // Se crea antes de la interfaz porque los paneles preguntan por app.scene.
  const sceneEditor = new SceneEditor({
    settings,
    viewport,
    figures,
    // El posado manual solo se queda el clic si hay un manejador de
    // articulacion debajo; en el resto del visor se puede seguir eligiendo
    // figuras, solidos y luces con el raton.
    blocked: (event) => settings.get('ui.manualPosing') === true && !!event && posing.picks(event),
    onSelect: () => app.hooks.refreshScene?.(),
    // Al elegir un elemento pinchandolo en el visor se abre su panel: si no, la
    // seleccion se hacia a ciegas y habia que ir a la lista de escena.
    onPick: () => app.hooks.revealScene?.(),
  });
  app.scene = sceneEditor;

  actions.addObject = (type) => {
    sceneEditor.addObject(type);
    toast('Solido insertado. W mover · E girar · R escalar');
  };
  actions.addLight = (type) => {
    sceneEditor.addLight(type);
    toast('Luz insertada. Colocala con el gizmo (W)');
  };

  /* ── Varias figuras ─────────────────────────────────────────────────── */

  actions.addFigure = async () => {
    if (figures.count >= MAX_FIGURAS) {
      toast(`No se pueden tener mas de ${MAX_FIGURAS} figuras en la escena`, 'warn');
      return null;
    }
    const id = await figures.add({});
    if (!id) return null;
    sceneEditor.select(id);
    toast('Figura anadida. W mover · E girar');
    return id;
  };
  actions.duplicateFigure = async (id) => {
    const origen = id || figures.activeId;
    if (figures.count >= MAX_FIGURAS) {
      toast(`No se pueden tener mas de ${MAX_FIGURAS} figuras en la escena`, 'warn');
      return null;
    }
    const nuevo = await figures.duplicate(origen);
    if (!nuevo) {
      toast('La figura todavia no esta cargada', 'warn');
      return null;
    }
    sceneEditor.select(nuevo);
    toast('Figura duplicada con su pose', 'ok');
    return nuevo;
  };
  actions.removeFigure = (id) => {
    const objetivo = id || figures.activeId;
    if (!figures.remove(objetivo)) {
      toast('La escena necesita al menos una figura', 'warn');
      return false;
    }
    toast('Figura eliminada');
    return true;
  };
  /** Elige la figura que recibe camara, poses, posado manual y manos. */
  actions.setActiveFigure = (id) => {
    if (!id) return false;
    figures.setActive(id);
    sceneEditor.select(id);
    return true;
  };

  actions.selectItem = (id) => sceneEditor.select(id);
  actions.alignPerspective = () => {
    if (!guides.perspective.active) { toast('Elige antes un modo de perspectiva'); return; }
    guides.perspective.alignCamera();
    toast('Camara alineada al modo de perspectiva');
  };
  actions.duplicateItem = (id) => { if (id) sceneEditor.duplicate(id); };
  actions.removeItem = (id) => { if (id) sceneEditor.remove(id); };
  actions.clearScene = () => {
    // Las figuras no se borran: la escena siempre tiene al menos una.
    const n = (settings.get('scene.objects')?.length ?? 0) + (settings.get('scene.lights')?.length ?? 0);
    if (!n) return;
    sceneEditor.clearAll();
    toast('Solidos y luces eliminados');
  };

  /* ── Interfaz ───────────────────────────────────────────────────────── */

  boot(0.2, 'Montando la interfaz…');
  const ui = new UI(app);
  app.ui = ui;
  const statusbar = new StatusBar(document.getElementById('statusbar'), app);
  app.statusbar = statusbar;

  /** Refleja en la interfaz el estado real de la fuente de captura. */
  function onSourceStatus(st) {
    const live = !!st.active;
    app.hooks.captureState?.(live);
    if (st.error) {
      ui.setStatus(st.error, 'err');
      statusbar.setCapture('error', 'err');
      toast(st.error, 'err');
      return;
    }
    if (!live) {
      ui.setStatus('Captura detenida');
      statusbar.setCapture('inactiva');
      overlay.clear();
      ui.setMocapFps(0);
      return;
    }
    const size = st.size?.width ? ` · ${st.size.width}×${st.size.height}` : '';
    const label = st.kind === 'webcam' ? (st.label || 'Camara') : st.label || st.kind;
    ui.setStatus(`${st.kind === 'imagen' ? 'Imagen' : st.kind === 'video' ? 'Video' : 'Camara'}: ${label}${size}`, 'ok');
    statusbar.setCapture(st.kind === 'webcam' ? 'camara en directo' : st.kind, 'ok');
  }

  /* ── Bucle de captura ───────────────────────────────────────────────── */

  let lastFrame = null;
  let detectorReady = false;
  // Se mide la frecuencia real de inferencia, no la teorica: con el limitador
  // del delegado CPU el coste por deteccion ya no dice a que ritmo se analiza.
  let detWindow = 0;
  let detCount = 0;

  viewport.onFrame((dt) => {
    // Guias 2D: el propio modulo corta pronto si no hay ninguna activa.
    guides.draw();

    if (!source.active) return;

    if (source.kind === 'imagen') {
      overlay.draw(source, source.still);
      statusbar.setConfidence(engine.confidence);
      return;
    }

    if (detectorReady) {
      const frame = detector.detectVideo(source.element, performance.now());
      if (frame?.landmarks?.length) {
        lastFrame = frame;
        engine.update(frame, dt);
        // La figura se mueve: hay que rehacer el mapa de sombras.
        viewport.invalidateShadows();
        detCount++;
      } else if (lastFrame && !detector.throttled && detector.lastError) {
        // Un fallo persistente no debe dejar la figura congelada sin aviso.
        statusbar.setConfidence(engine.confidence);
      }
      // Los dedos van por su cuenta: aunque el cuerpo no se detecte en este
      // fotograma, las manos siguen mandando (y con su propio limitador).
      tracker.update(source.element, performance.now(), lastFrame);
      if (tracker.count) viewport.invalidateShadows();
      detWindow += dt;
      if (detWindow >= 1) {
        ui.setMocapFps(detCount / detWindow);
        app.hooks.detectorInfo?.(detector.describe());
        detWindow = 0;
        detCount = 0;
      }
    }
    overlay.draw(source, lastFrame, tracker.hands);
    statusbar.setConfidence(engine.confidence);
  });

  /* ── Arranque y parada de la captura ────────────────────────────────── */

  async function startCapture() {
    const kind = settings.get('mocap.source');
    try {
      if (kind === 'webcam') {
        ui.setStatus('Abriendo la camara…');
        const ok = await source.startWebcam({ deviceId: settings.get('mocap.deviceId') });
        if (!ok) return false;
      } else if (!source.active) {
        // Imagen o video: hace falta un archivo antes de poder analizar.
        const file = await pickFile(kind === 'imagen' ? 'image/*' : 'video/*');
        if (!file) return false;
        if (!(await source.useFile(file))) return false;
      }

      ui.setStatus('Cargando el modelo de deteccion…');
      detectorReady = false;
      await detector.ensure(source.detectorMode, (msg) => ui.setStatus(msg));
      detectorReady = true;
      await ensureTracker();       // segundo modelo, solo si los dedos estan activos
      settings.set('mocap.frozen', false);
      onSourceStatus({ kind: source.kind, active: source.active, label: source.label, size: source.size });

      app.hooks.detectorInfo?.(detector.describe());
      if (source.kind === 'imagen') await actions.detectStill();
      return true;
    } catch (err) {
      console.error('[Captura]', err);
      ui.setStatus('No se pudo iniciar la captura', 'err');
      toast(`No se pudo iniciar la captura: ${errorText(err)}`, 'err');
      return false;
    }
  }

  function stopCapture() {
    source.stop();
    detectorReady = false;
    lastFrame = null;
    engine.reset();
    if (tracker.count) { tracker.count = 0; app.hooks.handCount?.(0); hands.apply(); }
    tracker.hands = [];
    overlay.clear();
    ui.setMocapFps(0);
    statusbar.setConfidence(0);
  }

  /* ── Recarga de los modelos de deteccion ────────────────────────────── */

  /** Carga el modelo de manos si los dedos por camara estan activados. */
  async function ensureTracker() {
    if (settings.get('mocap.hands') !== true) return false;
    try {
      await tracker.ensure((msg) => ui.setStatus(msg));
      return true;
    } catch (err) {
      console.error('[Manos]', err);
      toast('No se pudo cargar el modelo de manos: ' + errorText(err), 'err');
      settings.set('mocap.hands', false);
      return false;
    }
  }

  // El delegado y la calidad no se pueden cambiar en caliente: hay que volver
  // a crear el detector. Si la captura esta en marcha se hace al momento para
  // que el cambio se note sin tener que pararla y arrancarla a mano.
  let recargando = false;
  settings.on(['mocap.delegate', 'mocap.modelQuality'], async () => {
    if (!source.active || source.kind === 'imagen' || recargando) return;
    recargando = true;
    detectorReady = false;
    try {
      await detector.ensure(source.detectorMode, (msg) => ui.setStatus(msg));
      detectorReady = true;
      if (tracker.stale) { tracker.dispose(); await ensureTracker(); }
      ui.setStatus('Detector: ' + detector.describe(), 'ok');
      toast('Deteccion recargada · ' + detector.describe(), 'ok');
    } catch (err) {
      console.error('[Detector]', err);
      ui.setStatus('No se pudo recargar el detector', 'err');
      toast('No se pudo recargar el detector: ' + errorText(err), 'err');
    } finally {
      recargando = false;
    }
  });

  // Activar los dedos por camara descarga su modelo la primera vez; al
  // apagarlos las manos recuperan la postura elegida en el panel.
  settings.on('mocap.hands', async (value) => {
    if (value === true) {
      if (!hands.ready) {
        toast('El personaje cargado no trae dedos', 'warn');
        settings.set('mocap.hands', false);
        return;
      }
      if (source.active && source.kind !== 'imagen') await ensureTracker();
      return;
    }
    if (tracker.count) app.hooks.handCount?.(0);
    tracker.count = 0;
    tracker.hands = [];
    hands.apply();
  });

  /* ── Carga del personaje ────────────────────────────────────────────── */

  /**
   * Carga un modelo en la figura activa: una URL de la biblioteca o un archivo
   * soltado en la ventana. El reparto a los modulos y el aviso de huesos los
   * hace `onFigureLoaded`, que tambien salta al cargar las figuras al arrancar.
   */
  async function loadCharacter(src) {
    const id = figures.activeId;
    if (!id) return false;
    const label = typeof src === 'string' ? 'modelo incluido' : src.name;
    ui.setStatus(`Cargando ${label}…`);
    try {
      await figures.loadInto(id, src, {
        onProgress: (ev) => {
          if (ev?.total) boot(0.3 + 0.6 * (ev.loaded / ev.total), 'Cargando la figura…');
        },
      });
    } catch (err) {
      console.error('[Modelo]', err);
      ui.setStatus('No se pudo cargar el modelo', 'err');
      toast(`No se pudo cargar el modelo: ${errorText(err)}`, 'err');
      return false;
    }
    actions.frameFigure();
    ui.setStatus(typeof src === 'string' ? 'Listo' : `Figura cargada: ${label}`, 'ok');
    return true;
  }

  /* ── Secuencia de arranque ──────────────────────────────────────────── */

  boot(0.3, 'Cargando la figura…');
  await figures.sync();
  actions.frameFigure();

  boot(0.95, 'Ultimos ajustes…');
  viewport.start();
  bootDone();

  if (settings.get('mocap.autoStart') === true && settings.get('mocap.source') === 'webcam') {
    startCapture();
  }

  // Libera la camara al cerrar la pestana y guarda la pose de cada figura.
  window.addEventListener('beforeunload', () => {
    source.dispose();
    figures.snapshotPoses();
    settings.save();
  });

  // Utilidad de depuracion: `window.posu` permite inspeccionar todo en consola.
  window.posu = app;

  /**
   * Radiografia del estado grafico para pegar en la consola cuando algo se ve
   * mal: dice si el bucle sigue vivo, cuanto hace del ultimo fotograma, que
   * elemento ocupa el centro de la pantalla y si la interfaz esta maquetada.
   * Se usa escribiendo `posu.diagnostico()`.
   */
  app.diagnostico = () => {
    const centro = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    const barra = document.querySelector('.titlebar')?.getBoundingClientRect();
    const info = {
      gpu: viewport.gpuName || 'desconocida',
      perfil: viewport.profile.tier,
      compatible: settings.get('quality.compat') === true,
      bucle: viewport.running,
      contextoPerdido: viewport.contextLost === true,
      ultimoFotogramaHace: Math.round(performance.now() - viewport.watchdog.stamp) + ' ms',
      parones: viewport.watchdog.stalls,
      fps: Math.round(viewport.stats.fps),
      visor: viewport.size,
      pixelRatio: viewport.renderer.getPixelRatio(),
      ventana: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
      pestana: document.visibilityState,
      pantallaArranque: !!document.getElementById('boot'),
      barraTitulo: barra ? `${Math.round(barra.width)}×${Math.round(barra.height)}` : 'no existe',
      enElCentro: centro ? centro.tagName.toLowerCase() + (centro.id ? '#' + centro.id : '') : 'nada',
    };
    console.table(info);
    return info;
  };
}

main().catch((err) => {
  console.error('[POSU] fallo en el arranque:', err);
  const msg = document.getElementById('boot-msg');
  if (msg) {
    msg.textContent = `No se pudo iniciar: ${errorText(err)}`;
    msg.classList.add('is-error');
  }
});
