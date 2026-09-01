/**
 * ATOM · Avisos flotantes
 * Mensajes cortos y no bloqueantes en la esquina inferior derecha.
 */
import { icon } from './icons.js';
import { el } from './widgets.js';

const ICON_BY_KIND = { ok: 'circle-check', err: 'circle-x', warn: 'triangle-alert', info: 'info' };
let host = null;

export function initToasts(node) {
  host = node;
}

/**
 * @param {string} message Texto (admite HTML simple).
 * @param {'ok'|'err'|'warn'|'info'} kind
 * @param {number} ms Duracion; 0 mantiene el aviso hasta que se pulsa.
 */
export function toast(message, kind = 'info', ms = 3600) {
  if (!host) return () => {};
  const node = el('div', { class: 'toast ' + kind, role: 'status' }, [
    icon(ICON_BY_KIND[kind] ?? 'info', 15),
    el('div', { html: message }),
  ]);
  const dismiss = () => {
    if (!node.isConnected) return;
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 220);
  };
  node.addEventListener('click', dismiss);
  host.append(node);
  if (ms > 0) setTimeout(dismiss, ms);
  return dismiss;
}
