/**
 * ATOM · Orbe organico animado para el boton flotante del asistente IA
 * ---------------------------------------------------------------------------
 * Dibuja un nucleo op-art con franjas concentricas suaves, halo reactivo y
 * estela luminosa acorde con el acento de la interfaz (--accent).
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
    this.phase = Math.random() * Math.PI * 2;
    this.raf = 0;
    this.disposed = false;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'atom-ai-orb';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.#syncSize();

    this._onMove = (ev) => {
      const rect = this.canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const cx = rect.left + rect.width * 0.5;
      const cy = rect.top + rect.height * 0.5;
      const dx = Math.max(-1, Math.min(1, (ev.clientX - cx) / 140));
      const dy = Math.max(-1, Math.min(1, (ev.clientY - cy) / 140));
      this.look.x += (dx - this.look.x) * 0.25;
      this.look.y += (dy - this.look.y) * 0.25;
    };
    this._onEnter = () => { this.hover = true; };
    this._onLeave = () => { this.hover = false; };

    if (typeof window !== 'undefined') {
      window.addEventListener('pointermove', this._onMove, { passive: true });
    }
    this.canvas.addEventListener('pointerenter', this._onEnter);
    this.canvas.addEventListener('pointerleave', this._onLeave);
    this.#tick();
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
    if (this.disposed) return;
    this.phase += this.thinking ? 0.085 : 0.028;
    this.#draw();
    if (typeof requestAnimationFrame === 'function') {
      this.raf = requestAnimationFrame(() => this.#tick());
    }
  }

  #draw() {
    const ctx = this.canvas.getContext?.('2d');
    if (!ctx) return;

    const w = this.canvas.width;
    const h = this.canvas.height;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const r = Math.min(w, h) * 0.42;

    ctx.clearRect(0, 0, w, h);

    // Resplandor exterior suave
    const glow = ctx.createRadialGradient(cx, cy, r * 0.45, cx, cy, r * 1.18);
    glow.addColorStop(0, this.thinking ? 'rgba(78, 201, 176, 0.38)' : 'rgba(0, 120, 212, 0.34)');
    glow.addColorStop(0.65, this.thinking ? 'rgba(197, 134, 192, 0.16)' : 'rgba(77, 170, 252, 0.12)');
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.18, 0, Math.PI * 2);
    ctx.fill();

    // Silueta organica modulada
    ctx.save();
    ctx.beginPath();
    const steps = 48;
    const amp = this.thinking ? 0.075 : (this.hover ? 0.055 : 0.036);
    for (let i = 0; i <= steps; i += 1) {
      const a = (i / steps) * Math.PI * 2;
      const wobble = 1
        + Math.sin(a * 3 + this.phase) * amp
        + Math.cos(a * 2 - this.phase * 1.3) * (amp * 0.65);
      const px = cx + Math.cos(a) * r * wobble;
      const py = cy + Math.sin(a) * r * wobble;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();

    // Relleno de estudio oscuro con reflejo azulado
    const bg = ctx.createRadialGradient(
      cx - r * 0.25 + this.look.x * r * 0.15,
      cy - r * 0.25 + this.look.y * r * 0.15,
      r * 0.1,
      cx,
      cy,
      r * 1.05,
    );
    bg.addColorStop(0, '#2a4158');
    bg.addColorStop(0.55, '#19222d');
    bg.addColorStop(1, '#101216');
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.clip();

    // Anillos op-art descentrados hacia la mirada del cursor
    const ox = this.look.x * r * 0.24;
    const oy = this.look.y * r * 0.24;
    const rings = 5;
    for (let i = 0; i < rings; i += 1) {
      const k = 1 - i / rings;
      const ringR = r * (0.22 + k * 0.68);
      const shift = Math.sin(this.phase + i * 0.8) * r * 0.06;
      ctx.beginPath();
      ctx.arc(cx + ox * (1 - k * 0.4) + shift, cy + oy * (1 - k * 0.4), ringR, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(1.2, r * 0.07);
      ctx.strokeStyle = i % 2 === 0
        ? (this.thinking ? 'rgba(78, 201, 176, 0.78)' : 'rgba(77, 170, 252, 0.72)')
        : 'rgba(255, 255, 255, 0.18)';
      ctx.stroke();
    }

    // Nucleo brillante
    ctx.beginPath();
    ctx.arc(cx + ox * 0.9, cy + oy * 0.9, r * (this.thinking ? 0.2 : 0.16), 0, Math.PI * 2);
    ctx.fillStyle = this.thinking ? '#4ec9b0' : '#4daafc';
    ctx.fill();
    ctx.restore();

    // Borde nitido
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.96, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1, r * 0.045);
    ctx.strokeStyle = this.thinking ? 'rgba(78, 201, 176, 0.65)' : 'rgba(77, 170, 252, 0.48)';
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
