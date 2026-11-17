/**
 * ATOM · Orbe minimalista interactivo para el asistente IA
 * ---------------------------------------------------------------------------
 * Esfera limpia con un unico iris/pupila que sigue suavemente el puntero,
 * parpadeo sutil y arco dinamico de estado al pasar el raton o pensar.
 */

export class OrganicOrb {
  /**
   * @param {{ size?: number, thinking?: boolean }} [opts]
   */
  constructor({ size = 46, thinking = false } = {}) {
    this.size = size;
    this.thinking = thinking;
    this.hover = false;
    this.look = { x: 0, y: 0 };
    this.targetLook = { x: 0, y: 0 };
    this.phase = Math.random() * Math.PI * 2;
    this.blink = 1; // 1 = abierto, ~0.12 = parpadeo
    this.blinkAt = 140 + Math.random() * 180;
    this.frameCount = 0;
    this.raf = 0;
    this.disposed = false;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'atom-ai-orb';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.#syncSize();
    this.ctx = this.canvas.getContext?.('2d') ?? null;

    this._onMove = (ev) => {
      const rect = this.canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const cx = rect.left + rect.width * 0.5;
      const cy = rect.top + rect.height * 0.5;
      const dx = ev.clientX - cx;
      const dy = ev.clientY - cy;
      const dist = Math.hypot(dx, dy);
      const maxReach = 180;
      const norm = dist > 1 ? Math.min(1, dist / maxReach) : 0;
      this.targetLook.x = dist > 1 ? (dx / dist) * norm : 0;
      this.targetLook.y = dist > 1 ? (dy / dist) * norm : 0;
    };
    this._onEnter = () => { this.hover = true; };
    this._onLeave = () => { this.hover = false; };

    if (typeof window !== 'undefined') {
      window.addEventListener('pointermove', this._onMove, { passive: true });
    }
    this.canvas.addEventListener('pointerenter', this._onEnter);
    this.canvas.addEventListener('pointerleave', this._onLeave);
    if (this.ctx) this.#tick();
  }

  setThinking(v) {
    this.thinking = Boolean(v);
  }

  #syncSize() {
    const dpr = typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1;
    this.canvas.width = Math.round(this.size * dpr);
    this.canvas.height = Math.round(this.size * dpr);
    this.canvas.style.width = `${this.size}px`;
    this.canvas.style.height = `${this.size}px`;
  }

  #tick() {
    if (this.disposed || !this.ctx) return;
    this.frameCount += 1;
    this.phase += this.thinking ? 0.08 : 0.025;

    // Seguimiento fluido de la mirada
    this.look.x += (this.targetLook.x - this.look.x) * 0.16;
    this.look.y += (this.targetLook.y - this.look.y) * 0.16;

    // Parpadeo breve natural cada pocos segundos (solo en reposo)
    if (!this.thinking && this.frameCount >= this.blinkAt) {
      const t = this.frameCount - this.blinkAt;
      if (t <= 4) this.blink = Math.max(0.14, 1 - t * 0.22);
      else if (t <= 9) this.blink = Math.min(1, 0.14 + (t - 4) * 0.18);
      else {
        this.blink = 1;
        this.blinkAt = this.frameCount + 220 + Math.random() * 260;
      }
    } else if (this.thinking) {
      this.blink += (1 - this.blink) * 0.25;
    }

    this.#draw();
    if (typeof requestAnimationFrame === 'function') {
      this.raf = requestAnimationFrame(() => this.#tick());
    }
  }

  #draw() {
    const ctx = this.ctx;
    if (!ctx) return;

    const w = this.canvas.width;
    const h = this.canvas.height;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const baseR = Math.min(w, h) * 0.41;
    const pulse = this.thinking
      ? 1 + Math.sin(this.phase * 2) * 0.035
      : 1 + Math.sin(this.phase) * 0.015;
    const r = baseR * pulse;

    const accentRgb = this.thinking ? '78, 201, 176' : '77, 170, 252';
    const accentHex = this.thinking ? '#4ec9b0' : '#4daafc';

    ctx.clearRect(0, 0, w, h);

    // 1. Resplandor ambiental discreto
    const glow = ctx.createRadialGradient(cx, cy, r * 0.6, cx, cy, r * 1.24);
    glow.addColorStop(0, `rgba(${accentRgb}, ${this.hover || this.thinking ? 0.34 : 0.2})`);
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.24, 0, Math.PI * 2);
    ctx.fill();

    // 2. Esfera limpia de fondo oscuro
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    const fillGrad = ctx.createRadialGradient(
      cx - r * 0.28,
      cy - r * 0.28,
      r * 0.08,
      cx,
      cy,
      r,
    );
    fillGrad.addColorStop(0, '#252c36');
    fillGrad.addColorStop(0.7, '#181c22');
    fillGrad.addColorStop(1, '#101216');
    ctx.fillStyle = fillGrad;
    ctx.fill();
    ctx.clip();

    // 3. Pupila / ojo unico que mira al cursor (acotado para no tocar el borde)
    const irisR = r * (this.thinking ? 0.32 : (this.hover ? 0.34 : 0.3));
    const maxOffset = Math.max(0, r - irisR - r * 0.16);
    const ex = cx + this.look.x * maxOffset;
    const ey = cy + this.look.y * maxOffset;

    ctx.save();
    ctx.translate(ex, ey);
    ctx.scale(1, this.blink);

    // Un solo aro fino de iris + nucleo limpio (sin circulos amontonados)
    ctx.beginPath();
    ctx.arc(0, 0, irisR * 1.38, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1, r * 0.065);
    ctx.strokeStyle = `rgba(${accentRgb}, 0.55)`;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, 0, irisR * 0.72, 0, Math.PI * 2);
    ctx.fillStyle = accentHex;
    ctx.fill();

    // Brillo especular diminuto para darle vida de lente/ojo
    ctx.beginPath();
    ctx.arc(-irisR * 0.24, -irisR * 0.24, Math.max(1, irisR * 0.2), 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.fill();

    ctx.restore();
    ctx.restore();

    // 4. Borde unico exterior + arco dinamico rotatorio
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1, r * 0.06);
    ctx.strokeStyle = `rgba(${accentRgb}, ${this.hover ? 0.52 : 0.34})`;
    ctx.stroke();

    ctx.beginPath();
    const arcLen = this.thinking ? Math.PI * 0.85 : Math.PI * 0.48;
    ctx.arc(cx, cy, r, this.phase, this.phase + arcLen);
    ctx.lineWidth = Math.max(1.2, r * 0.075);
    ctx.lineCap = 'round';
    ctx.strokeStyle = accentHex;
    ctx.stroke();
  }

  dispose() {
    this.disposed = true;
    if (this.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.raf);
    if (typeof window !== 'undefined') window.removeEventListener('pointermove', this._onMove);
    this.canvas.removeEventListener('pointerenter', this._onEnter);
    this.canvas.removeEventListener('pointerleave', this._onLeave);
  }
}
