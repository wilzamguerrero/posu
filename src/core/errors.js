/**
 * ATOM · Texto legible para cualquier error
 * ---------------------------------------------------------------------------
 * MediaPipe y los cargadores de three rechazan a veces con un `Event` en vez de
 * con un `Error`: interpolarlo da el inutil "[object Event]". Esta funcion
 * traduce lo que llegue a una frase que se pueda ensenar en un aviso.
 */

/** @param {unknown} err @returns {string} */
export function errorText(err) {
  if (err == null) return 'error desconocido';
  if (typeof err === 'string') return err;

  // ErrorEvent trae el error real dentro; ProgressEvent de red no trae nada.
  if (typeof ErrorEvent !== 'undefined' && err instanceof ErrorEvent) {
    return err.message || errorText(err.error) || 'error de script';
  }
  if (typeof Event !== 'undefined' && err instanceof Event) {
    const tipo = err.type || 'error';
    const destino = err.target?.src ? ` (${String(err.target.src).split('/').pop()})` : '';
    if (tipo === 'error') return `no se pudo descargar el recurso${destino}`;
    if (tipo === 'abort') return 'descarga cancelada';
    if (tipo === 'timeout') return 'la descarga tardo demasiado';
    return `evento ${tipo}${destino}`;
  }

  if (typeof err === 'object') {
    const e = /** @type {any} */ (err);
    if (typeof e.message === 'string' && e.message) return e.message;
    if (typeof e.reason === 'string' && e.reason) return e.reason;
    if (e.reason) return errorText(e.reason);
    if (typeof e.name === 'string' && e.name) return e.name;
    if (typeof e.status === 'number') return `respuesta ${e.status} del servidor`;
    try {
      const json = JSON.stringify(err);
      if (json && json !== '{}') return json.slice(0, 160);
    } catch { /* referencias circulares */ }
    return Object.prototype.toString.call(err).replace(/^\[object |\]$/g, '');
  }
  return String(err);
}

/** Igual que `errorText` pero con la primera letra en mayuscula. */
export function errorTitle(err) {
  const t = errorText(err);
  return t.charAt(0).toUpperCase() + t.slice(1);
}
