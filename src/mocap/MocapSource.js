/**
 * MocapSource
 * ===========
 * Gestiona el origen de imagen para la captura: camara web, un archivo de video
 * o una imagen fija (el plan pide poder "cargar imagenes" ademas de la camara).
 *
 * Solo se ocupa del medio: abrir la camara, enumerar dispositivos, reproducir un
 * archivo y avisar de los cambios de estado. La inferencia la hace PoseDetector
 * y la aplicacion de la pose PoseEngine, de forma que cada pieza se puede probar
 * por separado.
 */

import { errorText } from '../core/errors.js';

const isImage = (file) => /^image\//.test(file?.type ?? '');
const isVideo = (file) => /^video\//.test(file?.type ?? '');

export class MocapSource {
  /**
   * @param {import('../core/Settings.js').Settings} settings
   * @param {{onStatus?: (state: object) => void}} [opts]
   */
  constructor(settings, { onStatus, video, image } = {}) {
    this.settings = settings;
    this.onStatus = onStatus ?? null;

    /** @type {'webcam'|'video'|'imagen'|null} */
    this.kind = null;
    this.active = false;
    this.error = null;
    this.label = '';

    this.stream = null;
    this.objectUrl = null;
    /** Resultado cacheado cuando la fuente es una imagen fija. */
    this.still = null;

    // Se reutilizan los elementos del monitor de captura si existen: asi el
    // usuario ve el video real (volteado por CSS) y no una copia redibujada.
    this.video = video ?? document.createElement('video');
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.loop = true;
    this.video.autoplay = true;
    this.image = image ?? new Image();

    this.devices = [];
    this.#applyMirrorClass();
    settings.on('mocap.mirror', () => this.#applyMirrorClass());
  }

  /** El espejo del monitor se hace por CSS sobre el propio elemento de video. */
  #applyMirrorClass() {
    this.video.classList?.toggle('no-mirror', !this.settings.get('mocap.mirror'));
  }

  get element() {
    return this.kind === 'imagen' ? this.image : this.video;
  }

  get size() {
    if (this.kind === 'imagen') {
      return { width: this.image.naturalWidth || 0, height: this.image.naturalHeight || 0 };
    }
    return { width: this.video.videoWidth || 0, height: this.video.videoHeight || 0 };
  }

  /** Modo de ejecucion que necesita el detector para esta fuente. */
  get detectorMode() {
    return this.kind === 'imagen' ? 'IMAGE' : 'VIDEO';
  }

  #status() {
    this.onStatus?.({
      kind: this.kind,
      active: this.active,
      label: this.label,
      error: this.error,
      size: this.size,
    });
  }

  /** Lista las camaras disponibles. Requiere permiso previo para ver los nombres. */
  async listDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      this.devices = all
        .filter((d) => d.kind === 'videoinput')
        .map((d, i) => ({ id: d.deviceId, label: d.label || `Camara ${i + 1}` }));
    } catch (err) {
      console.warn('[Captura] no se pudieron enumerar los dispositivos:', err);
      this.devices = [];
    }
    return this.devices;
  }

  /** Abre la camara web. Devuelve true si quedo reproduciendo. */
  async startWebcam({ deviceId } = {}) {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.error = 'Este navegador no permite acceder a la camara.';
      this.#status();
      return false;
    }
    this.stop({ keepStatus: true });
    const id = deviceId ?? this.settings.get('mocap.deviceId');
    const constraints = {
      audio: false,
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 60 },
        ...(id ? { deviceId: { exact: id } } : { facingMode: 'user' }),
      },
    };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      // Si el dispositivo guardado ya no existe se reintenta con el que haya.
      if (id) {
        this.settings.set('mocap.deviceId', '');
        return this.startWebcam({ deviceId: '' });
      }
      this.error = err?.name === 'NotAllowedError'
        ? 'Permiso de camara denegado.'
        : `No se pudo abrir la camara: ${errorText(err)}`;
      this.kind = null;
      this.active = false;
      this.#status();
      return false;
    }

    this.kind = 'webcam';
    this.error = null;
    this.still = null;
    this.video.srcObject = this.stream;
    this.video.loop = false;
    const track = this.stream.getVideoTracks()[0];
    this.label = track?.label ?? 'Camara';
    if (track?.getSettings) {
      const real = track.getSettings().deviceId;
      if (real) this.settings.set('mocap.deviceId', real);
    }
    await this.#play();
    await this.listDevices();
    return this.active;
  }

  /** Usa un archivo del disco: imagen o video. */
  async useFile(file) {
    if (!file) return false;
    if (!isImage(file) && !isVideo(file)) {
      this.error = 'Formato no admitido. Usa una imagen o un video.';
      this.#status();
      return false;
    }
    this.stop({ keepStatus: true });
    this.objectUrl = URL.createObjectURL(file);
    this.label = file.name;
    this.error = null;
    this.still = null;

    if (isImage(file)) {
      this.kind = 'imagen';
      const ok = await new Promise((resolve) => {
        this.image.onload = () => resolve(true);
        this.image.onerror = () => resolve(false);
        this.image.src = this.objectUrl;
      });
      this.active = ok;
      this.image.classList?.toggle('is-active', ok);
      if (!ok) this.error = 'No se pudo leer la imagen.';
      this.settings.set('mocap.source', 'imagen');
      this.#status();
      return ok;
    }

    this.kind = 'video';
    this.video.srcObject = null;
    this.video.loop = true;
    this.video.src = this.objectUrl;
    this.settings.set('mocap.source', 'video');
    await this.#play();
    return this.active;
  }

  async #play() {
    try {
      await new Promise((resolve, reject) => {
        if (this.video.readyState >= 2) return resolve();
        const cleanup = () => {
          this.video.removeEventListener('loadeddata', ok);
          this.video.removeEventListener('error', bad);
        };
        const ok = () => { cleanup(); resolve(); };
        const bad = () => { cleanup(); reject(new Error('no se pudo leer la fuente')); };
        this.video.addEventListener('loadeddata', ok, { once: true });
        this.video.addEventListener('error', bad, { once: true });
      });
      await this.video.play();
      this.active = true;
    } catch (err) {
      this.error = `No se pudo reproducir la fuente: ${errorText(err)}`;
      this.active = false;
    }
    this.#status();
  }

  /** Corre la deteccion una sola vez sobre la imagen fija y guarda el resultado. */
  async detectStill(detector) {
    if (this.kind !== 'imagen' || !this.active) return null;
    await detector.ensure('IMAGE');
    this.still = detector.detectImage(this.image);
    return this.still;
  }

  pause() {
    if (this.kind !== 'imagen') this.video.pause();
  }

  resume() {
    if (this.kind !== 'imagen') this.video.play().catch(() => {});
  }

  stop({ keepStatus = false } = {}) {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    this.video.pause?.();
    this.video.srcObject = null;
    if (this.video.src) this.video.removeAttribute('src');
    this.video.load?.();
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.active = false;
    this.still = null;
    this.image.classList?.remove('is-active');
    if (!keepStatus) {
      this.kind = null;
      this.label = '';
      this.#status();
    }
  }

  dispose() {
    this.stop();
    this.image.removeAttribute('src');
  }
}
