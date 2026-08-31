/**
 * PoseDetector
 * ============
 * Envoltorio del Pose Landmarker de MediaPipe (BlazePose GHUM). Toda la
 * inferencia ocurre en el navegador del usuario: el runtime WASM se sirve desde
 * /wasm y los pesos oficiales se descargan una sola vez y quedan en la cache
 * del navegador. No hay servidor de por medio.
 *
 * El detector entrega dos listas de 33 puntos por fotograma:
 *   - `landmarks`:      normalizados a la imagen (0..1), utiles para dibujar
 *                       el esqueleto encima del video y para el desplazamiento.
 *   - `worldLandmarks`: en metros y centrados en la cadera, que son los que
 *                       usan los motores de retargeting para deducir angulos.
 *
 * Particularidades del delegado CPU (importantes, porque es el respaldo cuando
 * no hay WebGL o la GPU esta bloqueada):
 *   - El grafo por CPU solo admite region de interes cuadrada. Con un video de
 *     16:9 lanza "Using NORM_RECT without IMAGE_DIMENSIONS is only supported
 *     for the square ROI" y no devuelve nada. Se le pasa entonces un lienzo
 *     cuadrado con bandas negras y se deshace la deformacion en los puntos.
 *   - Va mucho mas lento, asi que se limita la frecuencia de inferencia y se
 *     reutiliza el ultimo fotograma entre deteccion y deteccion.
 *   - Cambiar de delegado o de calidad obliga a recrear el detector: no se
 *     puede tocar en caliente con setOptions.
 */

import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import { POSE_MODELS, WASM_PATH } from '../config.js';
import { errorText } from '../core/errors.js';
import { SquarePad, sizeOf } from './SquarePad.js';

/** Lado maximo del lienzo cuadrado que se envia al detector. */
const SQUARE_MAX = { VIDEO: 512, IMAGE: 1024 };

export class PoseDetector {
  /** @param {import('../core/Settings.js').Settings} settings */
  constructor(settings) {
    this.settings = settings;
    this.landmarker = null;
    this.fileset = null;
    this.mode = 'VIDEO';
    this.signature = '';
    this.busy = false;
    this.ready = false;
    this.lastError = null;
    this.forceCpu = false;      // respaldo automatico cuando la GPU falla
    this._pending = null;

    // Limitador de frecuencia y lienzo cuadrado para el delegado CPU.
    this.lastDetect = 0;
    this.throttled = false;     // el ultimo intento se salto por frecuencia
    this.usingSquare = false;
    this.detections = 0;
    this.square = new SquarePad(SQUARE_MAX.VIDEO);
    /** @type {((aviso: string) => void)|null} Se llama al caer a CPU. */
    this.onFallback = null;

    // Elegir delegado o calidad a mano anula el respaldo automatico por CPU y
    // deja el detector marcado como caducado: quien manda la captura (main.js)
    // lo recreara mostrando el progreso.
    settings.on(['mocap.delegate', 'mocap.modelQuality'], () => {
      this.forceCpu = false;
      this.lastError = null;
    });

    // Los umbrales se pueden cambiar en caliente; el modelo y el delegado no.
    settings.on(['mocap.minDetection', 'mocap.minPresence', 'mocap.minTracking'], () => {
      if (!this.landmarker) return;
      try {
        this.landmarker.setOptions(this.#thresholds());
      } catch (err) {
        console.warn('[MediaPipe] no se pudieron aplicar los umbrales:', err);
      }
    });
  }

  #thresholds() {
    const s = this.settings;
    return {
      minPoseDetectionConfidence: s.get('mocap.minDetection'),
      minPosePresenceConfidence: s.get('mocap.minPresence'),
      minTrackingConfidence: s.get('mocap.minTracking'),
    };
  }

  /** Delegado que se esta usando de verdad (el respaldo manda sobre el ajuste). */
  get delegate() {
    return this.forceCpu ? 'CPU' : (this.settings.get('mocap.delegate') === 'CPU' ? 'CPU' : 'GPU');
  }

  /** True si el detector cargado ya no corresponde a los ajustes actuales. */
  get stale() {
    return Boolean(this.landmarker) && this.signature !== this.#signature(this.mode);
  }

  /** Detecciones por segundo a las que se aspira. 0 en los ajustes = automatico. */
  get targetFps() {
    const pedido = Number(this.settings.get('mocap.detectFps')) || 0;
    if (pedido > 0) return pedido;
    return this.delegate === 'CPU' ? 15 : 60;
  }

  /** Resumen corto para la barra de estado y los avisos. */
  describe() {
    const q = this.settings.get('mocap.modelQuality');
    const extra = this.usingSquare ? ' · recorte cuadrado' : '';
    return `${q} · ${this.delegate}${this.forceCpu ? ' (respaldo)' : ''} · ${this.targetFps} fps${extra}`;
  }

  /** Mensaje legible del ultimo fallo, sin "[object Event]". */
  get errorMessage() {
    return this.lastError ? errorText(this.lastError) : '';
  }

  /** ¿Hay que enviar un lienzo cuadrado? Por CPU es obligatorio. */
  #squareWanted() {
    const modo = this.settings.get('mocap.square');
    if (modo === 'si') return true;
    if (modo === 'no') return false;
    return this.delegate === 'CPU';
  }

  /** Tamano real en pixeles de un video, imagen, lienzo o bitmap. */
  static sizeOf(el) {
    return sizeOf(el);
  }

  /** Encuadra la fuente en un lienzo cuadrado del tamano maximo del modo. */
  #squarePad(el, mode) {
    return this.square.input(el, SQUARE_MAX[mode] ?? SQUARE_MAX.VIDEO);
  }

  /**
   * Deshace el encuadre cuadrado: los puntos normalizados vuelven a estar en
   * coordenadas del video original. `worldLandmarks` esta en metros y no se toca.
   */
  #unpad(frame) {
    return this.square.unpadFrame(frame);
  }
  #signature(mode) {
    const s = this.settings;
    const delegate = this.forceCpu ? 'CPU' : s.get('mocap.delegate');
    return `${s.get('mocap.modelQuality')}|${delegate}|${mode}`;
  }

  /**
   * Crea (o recrea) el detector si hace falta.
   * @param {'VIDEO'|'IMAGE'} mode
   * @param {(msg: string) => void} [onProgress]
   */
  async ensure(mode = this.mode, onProgress) {
    const wanted = this.#signature(mode);
    if (this.landmarker && wanted === this.signature) {
      this.mode = mode;
      return this.landmarker;
    }
    // Una sola creacion en vuelo: evita descargar el modelo dos veces si el
    // usuario cambia de calidad mientras se esta cargando.
    if (this._pending) {
      try { await this._pending; } catch { /* se reintenta abajo */ }
      if (this.landmarker && this.#signature(mode) === this.signature) {
        this.mode = mode;
        return this.landmarker;
      }
    }
    this._pending = this.#create(mode, wanted, onProgress);
    try {
      return await this._pending;
    } finally {
      this._pending = null;
    }
  }

  async #create(mode, signature, onProgress) {
    const s = this.settings;
    const quality = s.get('mocap.modelQuality');
    const delegate = this.forceCpu ? 'CPU' : s.get('mocap.delegate');

    onProgress?.('Cargando runtime de MediaPipe…');
    this.fileset ??= await FilesetResolver.forVisionTasks(WASM_PATH);

    const options = {
      baseOptions: {
        modelAssetPath: POSE_MODELS[quality] ?? POSE_MODELS.full,
        delegate,
      },
      runningMode: mode,
      numPoses: 1,
      outputSegmentationMasks: false,
      ...this.#thresholds(),
    };

    onProgress?.(`Cargando modelo ${quality}…`);
    const previous = this.landmarker;
    try {
      this.landmarker = await PoseLandmarker.createFromOptions(this.fileset, options);
    } catch (err) {
      // Si falla la GPU (drivers, WebGL bloqueado, maquina virtual) se reintenta
      // por CPU antes de dar el error por perdido.
      if (delegate === 'GPU' && !this.forceCpu) {
        console.warn('[MediaPipe] la GPU no esta disponible, se usa CPU:', errorText(err));
        this.forceCpu = true;
        this.onFallback?.('Sin GPU disponible: la deteccion pasa a CPU (' + errorText(err) + ')');
        return this.#create(mode, this.#signature(mode), onProgress);
      }
      this.ready = false;
      this.lastError = err;
      throw err;
    }
    previous?.close?.();
    this.mode = mode;
    this.signature = signature;
    this.ready = true;
    this.lastError = null;
    this.lastDetect = 0;
    this.detections = 0;
    return this.landmarker;
  }

  /**
   * Detecta sobre un fotograma de video.
   * @returns {{landmarks: Array, worldLandmarks: Array}|null}
   */
  detectVideo(video, timestampMs) {
    this.throttled = false;
    if (!this.landmarker || this.mode !== 'VIDEO' || this.busy) return null;
    if (!video || video.readyState < 2 || !video.videoWidth) return null;

    // Limitador: por CPU una inferencia puede costar 60 ms, asi que intentarlo
    // en cada fotograma solo consigue atascar el hilo y hundir el visor.
    const periodo = 1000 / this.targetFps;
    if (timestampMs - this.lastDetect < periodo - 1) {
      this.throttled = true;
      return null;
    }
    this.lastDetect = timestampMs;

    this.busy = true;
    try {
      const cuadrado = this.#squareWanted() ? this.#squarePad(video, 'VIDEO') : null;
      this.usingSquare = Boolean(cuadrado);
      if (!cuadrado) this.square.reset();
      const out = this.landmarker.detectForVideo(cuadrado ?? video, timestampMs);
      const frame = this.#unpad(this.#firstPose(out));
      if (frame) this.detections++;
      return frame;
    } catch (err) {
      this.lastError = err;
      // El fallo tipico del delegado CPU con video 16:9 se arregla solo en
      // cuanto se le manda un lienzo cuadrado; se activa y se reintenta luego.
      const texto = errorText(err);
      if (/square ROI|IMAGE_DIMENSIONS/i.test(texto) && this.settings.get('mocap.square') === 'no') {
        console.warn('[MediaPipe] este delegado exige region cuadrada; se activa el recorte');
        this.settings.set('mocap.square', 'auto');
      } else {
        console.warn('[MediaPipe] error en detectForVideo:', texto);
      }
      return null;
    } finally {
      this.busy = false;
    }
  }

  /** Detecta sobre una imagen fija (HTMLImageElement, canvas o ImageBitmap). */
  detectImage(image) {
    if (!this.landmarker || this.mode !== 'IMAGE') return null;
    try {
      const cuadrado = this.#squareWanted() ? this.#squarePad(image, 'IMAGE') : null;
      this.usingSquare = Boolean(cuadrado);
      if (!cuadrado) this.square.reset();
      const frame = this.#unpad(this.#firstPose(this.landmarker.detect(cuadrado ?? image)));
      if (frame) this.detections++;
      return frame;
    } catch (err) {
      this.lastError = err;
      console.warn('[MediaPipe] error en detect:', errorText(err));
      return null;
    }
  }

  #firstPose(result) {
    const landmarks = result?.landmarks?.[0];
    if (!landmarks?.length) return null;
    return {
      landmarks,
      worldLandmarks: result.worldLandmarks?.[0] ?? null,
    };
  }

  dispose() {
    this.landmarker?.close?.();
    this.landmarker = null;
    this.ready = false;
    this.signature = '';
    this.square.dispose();
  }
}
