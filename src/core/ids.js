/**
 * ATOM · Identificadores de los elementos de la escena
 * ---------------------------------------------------------------------------
 * Figuras, solidos y luces comparten el mismo generador: sus ids conviven en
 * `scene.selected` y en la misma lista de la interfaz, asi que dos contadores
 * distintos podrian repetir un id creado en el mismo milisegundo.
 */

let contador = 0;

/** Id corto y unico dentro de la sesion: "it1a2b3c0". */
export const nuevoId = () => `it${Date.now().toString(36)}${(contador++).toString(36)}`;
