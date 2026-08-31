// Hook de resolucion sincrono: kalidokit publica imports estilo bundler (sin
// extension y de directorio), que Node ESM no admite tal cual.
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (err?.code !== 'ERR_UNSUPPORTED_DIR_IMPORT' && err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
      for (const alt of [specifier + '.js', specifier.replace(/\/?$/, '/index.js')]) {
        try { return nextResolve(alt, context); } catch { /* siguiente */ }
      }
      throw err;
    }
  },
});
