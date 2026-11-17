/**
 * ATOM · Boton flotante orgánico y ventana de chat IA movible/redimensionable
 * ---------------------------------------------------------------------------
 * Portado de Zence-R2 (FloatingAssistant.tsx) a DOM puro y tematizado con la
 * paleta Dark Modern de ATOM. Permite dialogar, adjuntar o pegar bocetos e
 * imagenes, capturar el visor actual (incluidos trazos del lapiz), dictar
 * por voz y ejecutar acciones directas sobre la escena 3D.
 */
import { el } from './widgets.js';
import { icon } from './icons.js';
import { OrganicOrb } from './OrganicOrb.js';
import { streamChat } from '../ai/chat.js';
import {
  activeProvider,
  aiConfig,
  chosenModel,
  hasCredential,
  probeServerKeys,
  providerLabel,
  serverKeys,
} from '../ai/config.js';
import {
  ATOM_QUICK_SEEDS,
  buildAtomSystemPrompt,
  buildOfflineQuickActions,
  executeAtomActions,
  extractAtomActions,
} from '../ai/atomAgent.js';

const POS_PREFIX = 'posu.ai.pos.';
const SIZE_KEY = 'posu.ai.winSize';
const CHATS_KEY = 'posu.ai.chats.v1';

const MARGIN = 10;
const DRAG_THRESHOLD = 4;
const HANDLE_W = 50;
const HANDLE_H = 50;
const MIN_WIN_W = 310;
const MIN_WIN_H = 300;
const MAX_WIN_W = 720;
const MAX_WIN_H = 820;
const DEFAULT_WIN_W = 396;
const DEFAULT_WIN_H = 500;
const MAX_CONVERSATIONS = 16;

function clamp(n, min, max) {
  return Math.min(Math.max(n, min), max);
}

function clampPos(pos, width, height) {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 720;
  return {
    x: clamp(pos.x, MARGIN, Math.max(MARGIN, vw - width - MARGIN)),
    y: clamp(pos.y, MARGIN, Math.max(MARGIN, vh - height - MARGIN)),
  };
}

function clampSize(size, origin) {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 720;
  const maxW = Math.max(MIN_WIN_W, Math.min(MAX_WIN_W, vw - origin.x - MARGIN));
  const maxH = Math.max(MIN_WIN_H, Math.min(MAX_WIN_H, vh - origin.y - MARGIN));
  return {
    width: Math.round(clamp(size.width, MIN_WIN_W, maxW)),
    height: Math.round(clamp(size.height, MIN_WIN_H, maxH)),
  };
}

function defaultHandlePos() {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 720;
  return clampPos({ x: vw - HANDLE_W - 18, y: vh - HANDLE_H - 42 }, HANDLE_W, HANDLE_H);
}

function defaultWindowPos(handle, w, h) {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 720;
  const aboveY = handle.y - h - 10;
  const belowY = handle.y + HANDLE_H + 10;
  const y = aboveY >= MARGIN ? aboveY : (belowY + h <= vh - MARGIN ? belowY : vh - h - 18);
  const x = clamp(handle.x + HANDLE_W - w, MARGIN, vw - w - MARGIN);
  return clampPos({ x, y }, w, h);
}

function loadJson(key) {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveJson(key, value) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* noop */ }
}

function loadPos(key, fallback) {
  const parsed = loadJson(POS_PREFIX + key);
  if (parsed && Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) return parsed;
  return fallback;
}

function savePos(key, pt) {
  saveJson(POS_PREFIX + key, pt);
}

function loadWinSize() {
  const parsed = loadJson(SIZE_KEY);
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 720;
  if (parsed && Number.isFinite(parsed.width) && Number.isFinite(parsed.height)) {
    return {
      width: clamp(parsed.width, MIN_WIN_W, Math.max(MIN_WIN_W, vw - 24)),
      height: clamp(parsed.height, MIN_WIN_H, Math.max(MIN_WIN_H, vh - 24)),
    };
  }
  return {
    width: Math.min(DEFAULT_WIN_W, Math.max(MIN_WIN_W, vw - 24)),
    height: Math.min(DEFAULT_WIN_H, Math.max(MIN_WIN_H, vh - 24)),
  };
}

function makeConv(idx) {
  return {
    id: `conv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    title: `Chat ${idx}`,
    updatedAt: Date.now(),
    turns: [],
  };
}

function loadConversations() {
  const parsed = loadJson(CHATS_KEY);
  if (parsed && Array.isArray(parsed.conversations) && parsed.conversations.length > 0) {
    const clean = parsed.conversations.slice(0, MAX_CONVERSATIONS).map((c, idx) => ({
      id: typeof c.id === 'string' && c.id ? c.id : `conv-${idx}`,
      title: typeof c.title === 'string' && c.title.trim() ? c.title : `Chat ${idx + 1}`,
      updatedAt: Number.isFinite(c.updatedAt) ? c.updatedAt : Date.now(),
      turns: Array.isArray(c.turns) ? c.turns.filter((t) => t && (t.role === 'user' || t.role === 'assistant')) : [],
    }));
    const activeId = typeof parsed.activeId === 'string' && clean.some((c) => c.id === parsed.activeId)
      ? parsed.activeId
      : clean[0].id;
    return { conversations: clean, activeId };
  }
  const initial = makeConv(1);
  return { conversations: [initial], activeId: initial.id };
}

function saveConversations(conversations, activeId) {
  // No persistimos base64 pesados en localStorage para no llenar la cuota; solo resumen visual
  const slim = conversations.map((c) => ({
    ...c,
    turns: c.turns.map((t) => {
      const copy = { ...t };
      if (Array.isArray(t.images) && t.images.length > 0) {
        copy.imageCount = t.images.length;
        delete copy.images;
      }
      return copy;
    }),
  }));
  saveJson(CHATS_KEY, { conversations: slim, activeId });
}

function summarizeTitle(prompt, hadImage = false) {
  const clean = prompt.replace(/\s+/g, ' ').trim();
  if (!clean && hadImage) return 'Boceto visual';
  if (clean.length <= 28) return clean;
  return `${clean.slice(0, 26)}…`;
}

/** Comprime cualquier imagen o captura a maximo 1024px en JPEG/PNG data URL. */
async function compressImageSource(imgOrBlob, maxDim = 1024) {
  const toBitmap = async (src) => {
    if (src instanceof HTMLCanvasElement) return src;
    if (typeof createImageBitmap === 'function' && src instanceof Blob) {
      return await createImageBitmap(src);
    }
    return await new Promise((resolve, reject) => {
      const img = new Image();
      const url = src instanceof Blob ? URL.createObjectURL(src) : String(src);
      img.onload = () => {
        if (src instanceof Blob) URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = (err) => {
        if (src instanceof Blob) URL.revokeObjectURL(url);
        reject(err);
      };
      img.src = url;
    });
  };

  const bmp = await toBitmap(imgOrBlob);
  const w0 = bmp.width || bmp.naturalWidth || 512;
  const h0 = bmp.height || bmp.naturalHeight || 512;
  const ratio = Math.min(1, maxDim / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * ratio));
  const h = Math.max(1, Math.round(h0 * ratio));

  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#181818';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  if (typeof bmp.close === 'function') bmp.close();
  return c.toDataURL('image/jpeg', 0.85);
}

/** Captura combinada del visor 3D + guias/trazos del lapiz. */
async function captureViewportSnapshot(app) {
  const vp = app?.viewport;
  const glCanvas = document.getElementById('gl-canvas');
  if (!glCanvas) return null;

  // Fuerza un frame inmediato para evitar que WebGL este borrado
  try {
    if (vp?.postfx?.enabled && vp.postfx.render) {
      vp.postfx.render();
    } else if (vp?.renderer && vp?.scene && vp?.cameras?.active) {
      vp.renderer.render(vp.scene, vp.cameras.active);
    }
  } catch { /* noop */ }

  const comp = document.createElement('canvas');
  comp.width = glCanvas.width || 800;
  comp.height = glCanvas.height || 600;
  const ctx = comp.getContext('2d');
  ctx.drawImage(glCanvas, 0, 0, comp.width, comp.height);

  const sketchCanvas = document.getElementById('sketch-canvas');
  if (sketchCanvas && sketchCanvas.width > 0 && sketchCanvas.height > 0) {
    ctx.drawImage(sketchCanvas, 0, 0, comp.width, comp.height);
  }
  return await compressImageSource(comp, 1024);
}

export class FloatingAI {
  /**
   * @param {object} app contexto global de ATOM
   * @param {{ mount?: HTMLElement, onOpenSettings?: () => void }} [opts]
   */
  constructor(app, { mount = document.body, onOpenSettings } = {}) {
    this.app = app;
    this.mount = mount;
    this.onOpenSettings = onOpenSettings ?? (() => app?.hooks?.openAiSettings?.());

    const stored = loadConversations();
    this.conversations = stored.conversations;
    this.activeConvId = stored.activeId;
    this.open = false;
    this.busy = false;
    this.listening = false;
    this.draft = '';
    this.attachments = []; // [{ id, name, dataUrl }]
    this.errorMsg = '';
    this.abort = null;
    this.speech = null;
    this.voiceBase = '';
    this.suppressClick = false;
    this.dragCleanup = null;

    this.handlePos = clampPos(loadPos('handle', defaultHandlePos()), HANDLE_W, HANDLE_H);
    this.winSize = loadWinSize();
    this.winPos = clampPos(
      loadPos('window', defaultWindowPos(this.handlePos, this.winSize.width, this.winSize.height)),
      this.winSize.width,
      this.winSize.height,
    );

    this.orbHandle = new OrganicOrb({ size: 44, thinking: false });
    this.orbMini = new OrganicOrb({ size: 22, thinking: false });

    this.handleBtn = el('button', {
      type: 'button',
      class: 'atom-ai-handle',
      'aria-label': 'Abrir asistente IA de ATOM',
      title: 'Asistente IA ATOM · Arrastrable',
    }, this.orbHandle.canvas);

    this.pop = el('aside', {
      class: 'atom-ai-pop hidden',
      role: 'dialog',
      'aria-label': 'Asistente IA de ATOM',
      onAnimationend: () => this.pop.classList.remove('is-entering'),
    });

    this.fileInput = el('input', {
      type: 'file',
      accept: 'image/*',
      multiple: true,
      class: 'hidden',
      onChange: async (e) => {
        const files = [...(e.target.files ?? [])];
        e.target.value = '';
        await this.#addFiles(files);
      },
    });

    this.mount.append(this.handleBtn, this.pop, this.fileInput);
    this.#bindHandle();
    this.#renderWindow();
    this.#syncPositions();

    void probeServerKeys();
    this.unsubCfg = aiConfig.subscribe(() => this.#renderFooterAndStatus());
    this.unsubSrv = serverKeys.subscribe(() => this.#renderFooterAndStatus());

    this._onResize = () => {
      this.handlePos = clampPos(this.handlePos, HANDLE_W, HANDLE_H);
      this.winSize = clampSize(this.winSize, this.winPos);
      this.winPos = clampPos(this.winPos, this.winSize.width, this.winSize.height);
      this.#syncPositions();
    };
    window.addEventListener('resize', this._onResize);
  }

  get activeConv() {
    return this.conversations.find((c) => c.id === this.activeConvId) ?? this.conversations[0];
  }

  #syncPositions() {
    this.handleBtn.style.left = `${this.handlePos.x}px`;
    this.handleBtn.style.top = `${this.handlePos.y}px`;
    this.pop.style.left = `${this.winPos.x}px`;
    this.pop.style.top = `${this.winPos.y}px`;
    this.pop.style.width = `${this.winSize.width}px`;
    this.pop.style.height = `${this.winSize.height}px`;
  }

  toggle(force) {
    this.open = typeof force === 'boolean' ? force : !this.open;
    this.handleBtn.classList.toggle('is-open', this.open);
    this.pop.classList.toggle('hidden', !this.open);
    if (this.open) {
      this.pop.classList.add('is-entering');
      this.winPos = clampPos(this.winPos, this.winSize.width, this.winSize.height);
      this.#syncPositions();
      this.#scrollLogBottom();
      requestAnimationFrame(() => this.textareaEl?.focus());
    } else {
      this.pop.classList.remove('is-entering');
      this.#stopDictation();
    }
  }

  #bindHandle() {
    this.handleBtn.addEventListener('pointerdown', (ev) => {
      this.#startDrag(ev, 'handle', this.handleBtn, this.handlePos, (next) => {
        this.handlePos = next;
      }, true);
    });
    this.handleBtn.addEventListener('click', () => {
      if (this.suppressClick) return;
      this.toggle();
    });
  }

  #startDrag(ev, key, nodeEl, origin, setPos, isHandle) {
    if (ev.button !== 0 || !nodeEl) return;
    if (!isHandle && ev.target?.closest?.('button, a, input, textarea, select')) return;
    ev.preventDefault();
    this.dragCleanup?.();

    const pointerId = ev.pointerId;
    const startX = ev.clientX;
    const startY = ev.clientY;
    let moved = false;
    let rafId = 0;
    let dx = 0;
    let dy = 0;
    const w = nodeEl.offsetWidth || (isHandle ? HANDLE_W : this.winSize.width);
    const h = nodeEl.offsetHeight || (isHandle ? HANDLE_H : this.winSize.height);

    try { nodeEl.setPointerCapture(pointerId); } catch { /* noop */ }

    const applyTransform = () => {
      rafId = 0;
      const clamped = clampPos({ x: origin.x + dx, y: origin.y + dy }, w, h);
      nodeEl.style.transform = `translate3d(${clamped.x - origin.x}px, ${clamped.y - origin.y}px, 0)`;
    };

    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (rafId) cancelAnimationFrame(rafId);
      try {
        if (nodeEl.hasPointerCapture(pointerId)) nodeEl.releasePointerCapture(pointerId);
      } catch { /* noop */ }
      this.dragCleanup = null;
    };

    const onMove = (mEv) => {
      if (mEv.pointerId !== pointerId) return;
      dx = mEv.clientX - startX;
      dy = mEv.clientY - startY;
      if (!moved) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        moved = true;
        nodeEl.classList.remove('is-entering');
        nodeEl.classList.add('is-dragging');
      }
      if (!rafId) rafId = requestAnimationFrame(applyTransform);
    };

    const onUp = (uEv) => {
      if (uEv.pointerId !== pointerId && uEv.type !== 'pointercancel') return;
      cleanup();
      nodeEl.classList.remove('is-dragging');
      if (moved) {
        this.suppressClick = isHandle;
        const final = clampPos({ x: origin.x + (uEv.clientX - startX), y: origin.y + (uEv.clientY - startY) }, w, h);
        nodeEl.style.left = `${final.x}px`;
        nodeEl.style.top = `${final.y}px`;
        nodeEl.style.transform = '';
        setPos(final);
        savePos(key, final);
        setTimeout(() => { this.suppressClick = false; }, 120);
      } else {
        nodeEl.style.transform = '';
      }
    };

    this.dragCleanup = () => {
      cleanup();
      nodeEl.classList.remove('is-dragging');
      nodeEl.style.transform = '';
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  #startResize(ev, axis) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    this.dragCleanup?.();

    const targetEl = ev.currentTarget;
    const pointerId = ev.pointerId;
    const startX = ev.clientX;
    const startY = ev.clientY;
    const startSize = {
      width: this.pop.offsetWidth || this.winSize.width,
      height: this.pop.offsetHeight || this.winSize.height,
    };
    let rafId = 0;
    let dx = 0;
    let dy = 0;

    this.pop.classList.add('is-dragging');
    try { targetEl.setPointerCapture(pointerId); } catch { /* noop */ }

    const apply = () => {
      rafId = 0;
      const next = clampSize({
        width: axis === 'xy' ? startSize.width + dx : startSize.width,
        height: startSize.height + dy,
      }, this.winPos);
      this.pop.style.width = `${next.width}px`;
      this.pop.style.height = `${next.height}px`;
    };

    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (rafId) cancelAnimationFrame(rafId);
      try {
        if (targetEl.hasPointerCapture(pointerId)) targetEl.releasePointerCapture(pointerId);
      } catch { /* noop */ }
      this.dragCleanup = null;
    };

    const onMove = (mEv) => {
      if (mEv.pointerId !== pointerId) return;
      dx = mEv.clientX - startX;
      dy = mEv.clientY - startY;
      if (!rafId) rafId = requestAnimationFrame(apply);
    };

    const onUp = (uEv) => {
      if (uEv.pointerId !== pointerId && uEv.type !== 'pointercancel') return;
      cleanup();
      this.pop.classList.remove('is-dragging');
      const final = clampSize({
        width: axis === 'xy' ? startSize.width + (uEv.clientX - startX) : startSize.width,
        height: startSize.height + (uEv.clientY - startY),
      }, this.winPos);
      this.winSize = final;
      saveJson(SIZE_KEY, final);
      this.#syncPositions();
    };

    this.dragCleanup = () => {
      cleanup();
      this.pop.classList.remove('is-dragging');
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  /* ── Adjuntos e inspeccion visual ──────────────────────────────────────── */

  async #addFiles(files) {
    for (const file of files) {
      if (!file || !String(file.type || '').startsWith('image/')) continue;
      if (this.attachments.length >= 3) {
        this.errorMsg = 'Máximo 3 imágenes adjuntas por mensaje.';
        break;
      }
      try {
        const dataUrl = await compressImageSource(file, 1024);
        this.attachments.push({
          id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: file.name || 'boceto.jpg',
          dataUrl,
        });
      } catch {
        this.errorMsg = 'No se pudo procesar esa imagen.';
      }
    }
    this.#renderAttachments();
    this.#renderFooterAndStatus();
  }

  async #captureVisor() {
    if (this.attachments.length >= 3) {
      this.errorMsg = 'Máximo 3 imágenes adjuntas por mensaje.';
      this.#renderFooterAndStatus();
      return;
    }
    try {
      const dataUrl = await captureViewportSnapshot(this.app);
      if (!dataUrl) return;
      this.attachments.push({
        id: `att-${Date.now()}`,
        name: 'visor-actual.jpg',
        dataUrl,
      });
      this.#renderAttachments();
      this.textareaEl?.focus();
    } catch {
      this.errorMsg = 'No se pudo capturar el visor.';
      this.#renderFooterAndStatus();
    }
  }

  /* ── Renderizado de partes de la ventana ───────────────────────────────── */

  #renderWindow() {
    this.convsEl = el('div', { class: 'atom-ai-convs' });
    this.logEl = el('div', { class: 'atom-ai-log' });
    this.footWarnEl = el('div', { class: 'atom-ai-foot-warn hidden' });
    this.attachStripEl = el('div', { class: 'atom-ai-attach-strip hidden' });

    this.micBtn = el('button', {
      type: 'button',
      class: 'btn atom-ai-tool-btn atom-ai-mic',
      title: 'Dictar por voz',
      onClick: () => this.#toggleDictation(),
    }, icon('mic', 14));

    this.textareaEl = el('textarea', {
      rows: 1,
      placeholder: 'Pide poses, figuras, luz o pega un boceto…',
      onInput: (e) => { this.draft = e.target.value; },
      onKeydown: (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          void this.#sendPrompt(this.draft);
        }
      },
      onPaste: async (e) => {
        const items = [...(e.clipboardData?.items ?? [])];
        const imageFiles = items
          .filter((it) => it.type?.startsWith('image/'))
          .map((it) => it.getAsFile())
          .filter(Boolean);
        if (imageFiles.length > 0) {
          e.preventDefault();
          await this.#addFiles(imageFiles);
        }
      },
    });

    this.sendBtn = el('button', {
      type: 'submit',
      class: 'btn is-primary atom-ai-send',
      text: 'Enviar',
    });

    const grip = el('div', {
      class: 'atom-ai-grip',
      onPointerdown: (ev) => this.#startDrag(ev, 'window', this.pop, this.winPos, (next) => {
        this.winPos = next;
      }, false),
    }, [
      el('div', { class: 'atom-ai-orb-slot' }, this.orbMini.canvas),
      this.convsEl,
      el('div', { class: 'atom-ai-head-actions' }, [
        el('button', {
          type: 'button',
          class: 'atom-ai-new-btn',
          title: 'Nueva conversación',
          onClick: () => this.#newConversation(),
        }, [icon('plus', 11), el('span', { text: 'Nueva' })]),
        el('button', {
          type: 'button',
          class: 'icon-btn tiny',
          title: 'Configurar API y modelos (Ajustes)',
          onClick: () => this.onOpenSettings(),
        }, icon('settings', 13)),
        el('button', {
          type: 'button',
          class: 'icon-btn tiny',
          title: 'Cerrar',
          onClick: () => this.toggle(false),
        }, icon('x', 13)),
      ]),
    ]);

    const form = el('form', {
      class: 'atom-ai-form',
      onSubmit: (e) => {
        e.preventDefault();
        if (this.busy) this.#stopChat();
        else void this.#sendPrompt(this.draft);
      },
    }, [
      el('div', { class: 'atom-ai-form-tools' }, [
        el('button', {
          type: 'button',
          class: 'btn atom-ai-tool-btn',
          title: 'Adjuntar boceto o imagen (también puedes pegar con Ctrl+V o soltar aquí)',
          onClick: () => this.fileInput.click(),
        }, icon('paperclip', 14)),
        el('button', {
          type: 'button',
          class: 'btn atom-ai-tool-btn',
          title: 'Capturar visor actual como referencia',
          onClick: () => void this.#captureVisor(),
        }, icon('camera', 14)),
        this.micBtn,
      ]),
      this.textareaEl,
      this.sendBtn,
    ]);

    const resizeB = el('div', {
      class: 'atom-ai-resize-b',
      title: 'Arrastra para cambiar la altura',
      onPointerdown: (e) => this.#startResize(e, 'y'),
    });
    const resizeBr = el('div', {
      class: 'atom-ai-resize-br',
      title: 'Arrastra para redimensionar',
      onPointerdown: (e) => this.#startResize(e, 'xy'),
    });

    // Drag & drop de imagenes directo sobre el panel flotante
    this.pop.addEventListener('dragover', (e) => {
      if ([...(e.dataTransfer?.types ?? [])].includes('Files')) {
        e.preventDefault();
        this.pop.classList.add('is-file-over');
      }
    });
    this.pop.addEventListener('dragleave', () => this.pop.classList.remove('is-file-over'));
    this.pop.addEventListener('drop', async (e) => {
      this.pop.classList.remove('is-file-over');
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.some((f) => String(f.type || '').startsWith('image/'))) {
        e.preventDefault();
        e.stopPropagation();
        await this.#addFiles(files);
      }
    });

    this.pop.replaceChildren(
      grip,
      this.logEl,
      this.footWarnEl,
      this.attachStripEl,
      form,
      resizeB,
      resizeBr,
    );

    this.#renderConvTabs();
    this.#renderLog();
    this.#renderAttachments();
    this.#renderFooterAndStatus();
  }

  #renderConvTabs() {
    const nodes = this.conversations.map((c) => el('div', {
      class: `atom-ai-conv-item ${c.id === this.activeConvId ? 'is-active' : ''}`,
    }, [
      el('button', {
        type: 'button',
        class: 'atom-ai-conv-btn',
        title: c.title,
        text: c.title,
        onClick: () => this.#selectConversation(c.id),
      }),
      this.conversations.length > 1 || c.turns.length > 0
        ? el('button', {
          type: 'button',
          class: 'atom-ai-conv-del',
          title: 'Cerrar chat',
          onClick: (ev) => this.#deleteConversation(c.id, ev),
        }, icon('x', 10))
        : null,
    ]));
    this.convsEl.replaceChildren(...nodes);
  }

  #renderLog() {
    const turns = this.activeConv?.turns ?? [];
    if (turns.length === 0) {
      this.logEl.replaceChildren(el('div', { class: 'atom-ai-empty' }, [
        el('p', {
          text: 'Describe la escena que buscas o adjunta/pega un boceto: colocaré figuras, poses, ángulos de cámara, perspectiva y luz en vivo.',
        }),
        el('div', { class: 'atom-ai-seeds' }, ATOM_QUICK_SEEDS.map((seed) => el('button', {
          type: 'button',
          class: 'atom-ai-seed',
          onClick: () => {
            if (seed.id === 'sketch-hint') {
              this.draft = seed.prompt;
              this.textareaEl.value = seed.prompt;
              this.fileInput.click();
              return;
            }
            void this.#sendPrompt(seed.prompt);
          },
        }, [icon('sparkles', 12), el('span', { text: seed.label })]))),
      ]));
      return;
    }

    const turnNodes = turns.map((t) => {
      const thumbs = Array.isArray(t.images) && t.images.length > 0
        ? el('div', { class: 'atom-ai-turn-imgs' }, t.images.map((src) => el('img', { src, alt: 'Boceto' })))
        : (t.imageCount > 0 ? el('span', { class: 'atom-ai-img-note', text: `📎 ${t.imageCount} imagen(es)` }) : null);

      const chips = Array.isArray(t.actions) && t.actions.length > 0
        ? el('div', { class: 'atom-ai-actions-applied' }, t.actions.map((a) => el('span', {
          class: 'atom-ai-action-chip',
          text: `✓ ${a}`,
        })))
        : null;

      return el('div', { class: `atom-ai-turn ${t.role === 'user' ? 'is-user' : ''}` }, [
        thumbs,
        el('div', { class: 'atom-ai-bubble', text: t.text || (t.role === 'assistant' && this.busy ? 'Analizando escena…' : '…') }),
        chips,
      ]);
    });

    this.logEl.replaceChildren(...turnNodes);
    this.#scrollLogBottom();
  }

  #scrollLogBottom() {
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  #renderAttachments() {
    if (this.attachments.length === 0) {
      this.attachStripEl.classList.add('hidden');
      this.attachStripEl.replaceChildren();
      return;
    }
    this.attachStripEl.classList.remove('hidden');
    this.attachStripEl.replaceChildren(...this.attachments.map((att) => el('div', { class: 'atom-ai-attach-chip' }, [
      el('img', { src: att.dataUrl, alt: att.name }),
      el('span', { text: att.name }),
      el('button', {
        type: 'button',
        class: 'atom-ai-attach-del',
        title: 'Quitar imagen',
        onClick: () => {
          this.attachments = this.attachments.filter((x) => x.id !== att.id);
          this.#renderAttachments();
        },
      }, icon('x', 10)),
    ])));
  }

  #renderFooterAndStatus() {
    const provider = activeProvider();
    const authed = hasCredential(provider);

    this.orbHandle.setThinking(this.busy);
    this.orbMini.setThinking(this.busy);

    if (this.sendBtn) {
      this.sendBtn.textContent = this.busy ? 'Parar' : 'Enviar';
      this.sendBtn.classList.toggle('is-stop', this.busy);
    }

    if (this.errorMsg) {
      this.footWarnEl.className = 'atom-ai-foot-warn is-bad';
      this.footWarnEl.replaceChildren(
        el('span', { text: this.errorMsg }),
        el('button', { type: 'button', text: 'Ajustes IA', onClick: () => this.onOpenSettings() }),
      );
      return;
    }

    if (!authed && !String(provider).startsWith('custom:')) {
      this.footWarnEl.className = 'atom-ai-foot-warn';
      this.footWarnEl.replaceChildren(
        el('span', { text: `${providerLabel(provider)} sin conectar (puedes activar free-pi gratis en 1 paso)` }),
        el('button', { type: 'button', text: 'Conectar', onClick: () => this.onOpenSettings() }),
      );
      return;
    }

    this.footWarnEl.className = 'atom-ai-foot-warn hidden';
    this.footWarnEl.replaceChildren();
  }

  /* ── Conversaciones y envio ────────────────────────────────────────────── */

  #updateConv(convId, updater, nextTitle) {
    this.conversations = this.conversations.map((c) => {
      if (c.id !== convId) return c;
      const turnsNext = updater(c.turns);
      const shouldRetitle = nextTitle && c.turns.length === 0 && /^Chat \d+$/.test(c.title);
      return {
        ...c,
        title: shouldRetitle ? nextTitle : c.title,
        updatedAt: Date.now(),
        turns: turnsNext,
      };
    });
    saveConversations(this.conversations, this.activeConvId);
    this.#renderConvTabs();
    if (convId === this.activeConvId) this.#renderLog();
  }

  #newConversation() {
    this.#stopChat();
    this.errorMsg = '';
    if (this.activeConv && this.activeConv.turns.length === 0) {
      this.textareaEl?.focus();
      return;
    }
    const created = makeConv(this.conversations.length + 1);
    this.conversations = [created, ...this.conversations].slice(0, MAX_CONVERSATIONS);
    this.activeConvId = created.id;
    saveConversations(this.conversations, this.activeConvId);
    this.#renderConvTabs();
    this.#renderLog();
    this.#renderFooterAndStatus();
    this.textareaEl?.focus();
  }

  #selectConversation(id) {
    if (id === this.activeConvId) return;
    this.#stopChat();
    this.errorMsg = '';
    this.activeConvId = id;
    saveConversations(this.conversations, this.activeConvId);
    this.#renderConvTabs();
    this.#renderLog();
    this.#renderFooterAndStatus();
  }

  #deleteConversation(id, ev) {
    ev.stopPropagation();
    if (id === this.activeConvId) {
      this.#stopChat();
      this.errorMsg = '';
    }
    const rest = this.conversations.filter((c) => c.id !== id);
    if (rest.length === 0) {
      const fresh = makeConv(1);
      this.conversations = [fresh];
      this.activeConvId = fresh.id;
    } else {
      this.conversations = rest;
      if (id === this.activeConvId) this.activeConvId = rest[0].id;
    }
    saveConversations(this.conversations, this.activeConvId);
    this.#renderConvTabs();
    this.#renderLog();
    this.#renderFooterAndStatus();
  }

  #stopChat() {
    this.abort?.abort();
    this.abort = null;
    this.busy = false;
    this.#renderFooterAndStatus();
  }

  async #sendPrompt(rawText) {
    const q = (rawText || '').trim();
    const imgs = this.attachments.map((a) => a.dataUrl);
    if ((!q && imgs.length === 0) || this.busy || !this.activeConv) return;

    this.#stopDictation();
    const convId = this.activeConv.id;
    const prevTurns = [...this.activeConv.turns];
    const autoTitle = summarizeTitle(q, imgs.length > 0);
    const displayText = q || 'Analiza este boceto y compón la escena en ATOM.';

    this.draft = '';
    this.textareaEl.value = '';
    this.attachments = [];
    this.errorMsg = '';
    this.#renderAttachments();

    const userTurn = {
      id: `u-${Date.now()}`,
      role: 'user',
      text: displayText,
      ...(imgs.length > 0 ? { images: imgs } : {}),
    };
    const assistantId = `a-${Date.now()}`;

    const provider = activeProvider();
    const authed = hasCredential(provider);
    if (!authed && !String(provider).startsWith('custom:')) {
      const offline = imgs.length === 0 ? buildOfflineQuickActions(displayText) : null;
      if (offline) {
        const applied = await executeAtomActions(offline.actions, this.app);
        this.#updateConv(convId, (prev) => [
          ...prev,
          userTurn,
          { id: assistantId, role: 'assistant', text: offline.reply, actions: applied },
        ], autoTitle);
        return;
      }
      this.#updateConv(convId, (prev) => [
        ...prev,
        userTurn,
        {
          id: assistantId,
          role: 'assistant',
          text: `Falta conectar un proveedor de IA (${providerLabel(provider)}). Pulsa el botón de ajustes arriba para activar free-pi gratis en 1 paso o pegar tu API key.`,
        },
      ], autoTitle);
      return;
    }

    this.busy = true;
    this.#updateConv(convId, (prev) => [
      ...prev,
      userTurn,
      { id: assistantId, role: 'assistant', text: '' },
    ], autoTitle);
    this.#renderFooterAndStatus();

    const ac = new AbortController();
    this.abort = ac;

    try {
      const toWireTurn = (t) => {
        if (Array.isArray(t.images) && t.images.length > 0 && t.role === 'user') {
          return {
            role: 'user',
            content: [
              { type: 'text', text: t.text },
              ...t.images.map((url) => ({ type: 'image_url', image_url: { url } })),
            ],
          };
        }
        return { role: t.role, content: t.text };
      };

      const history = [
        { role: 'system', content: buildAtomSystemPrompt(this.app) },
        ...prevTurns.slice(-8).map(toWireTurn),
        toWireTurn(userTurn),
      ];

      let accumulated = '';
      const fullReply = await streamChat({
        messages: history,
        provider,
        model: chosenModel(provider) || undefined,
        signal: ac.signal,
        onDelta: (chunk) => {
          accumulated += chunk;
          const visible = accumulated.replace(/<atom_actions>[\s\S]*$/i, '').trim();
          this.#updateConv(convId, (prev) =>
            prev.map((t) => (t.id === assistantId ? { ...t, text: visible || '…' } : t)),
          );
        },
      });

      const { cleanText, actions } = extractAtomActions(fullReply || accumulated);
      const applied = actions.length > 0 ? await executeAtomActions(actions, this.app) : [];
      this.#updateConv(convId, (prev) =>
        prev.map((t) => (t.id === assistantId
          ? { ...t, text: cleanText || (applied.length > 0 ? 'Escena actualizada.' : '(Sin respuesta)'), actions: applied }
          : t)),
      );
    } catch (e) {
      if (!ac.signal.aborted) {
        const msg = e instanceof Error ? e.message : 'No se pudo conectar con el proveedor de IA.';
        this.errorMsg = msg;
        this.#updateConv(convId, (prev) =>
          prev.map((t) => (t.id === assistantId ? { ...t, text: `Error: ${msg}` } : t)),
        );
      }
    } finally {
      this.abort = null;
      this.busy = false;
      this.#renderFooterAndStatus();
    }
  }

  /* ── Dictado por voz ───────────────────────────────────────────────────── */

  #stopDictation() {
    const rec = this.speech;
    this.speech = null;
    if (rec) {
      try { rec.stop(); } catch { /* noop */ }
    }
    this.listening = false;
    this.micBtn?.classList.remove('is-listening');
    this.textareaEl?.classList.remove('is-listening');
  }

  #toggleDictation() {
    if (this.listening) {
      this.#stopDictation();
      return;
    }
    const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Rec) {
      this.errorMsg = 'Tu navegador no soporta dictado por voz (usa Chrome o Edge).';
      this.#renderFooterAndStatus();
      return;
    }
    this.errorMsg = '';
    this.#renderFooterAndStatus();
    this.voiceBase = this.draft.trim() ? `${this.draft.trimEnd()} ` : '';

    const rec = new Rec();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'es-ES';

    rec.onresult = (event) => {
      let spoken = '';
      for (let i = 0; i < event.results.length; i += 1) {
        const res = event.results[i];
        if (res?.[0]?.transcript) spoken += res[0].transcript;
      }
      this.draft = `${this.voiceBase}${spoken.trimStart()}`;
      this.textareaEl.value = this.draft;
    };
    rec.onerror = (ev) => {
      this.#stopDictation();
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        this.errorMsg = 'Permiso de micrófono denegado en el navegador.';
        this.#renderFooterAndStatus();
      }
    };
    rec.onend = () => this.#stopDictation();

    this.speech = rec;
    try {
      rec.start();
      this.listening = true;
      this.micBtn.classList.add('is-listening');
      this.textareaEl.classList.add('is-listening');
      this.textareaEl.focus();
    } catch {
      this.#stopDictation();
      this.errorMsg = 'No se pudo iniciar el micrófono.';
      this.#renderFooterAndStatus();
    }
  }

  dispose() {
    this.#stopChat();
    this.#stopDictation();
    this.dragCleanup?.();
    this.unsubCfg?.();
    this.unsubSrv?.();
    this.orbHandle.dispose();
    this.orbMini.dispose();
    window.removeEventListener('resize', this._onResize);
    this.handleBtn.remove();
    this.pop.remove();
    this.fileInput.remove();
  }
}
