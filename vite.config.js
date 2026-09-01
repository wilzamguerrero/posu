import { defineConfig } from 'vite';
import { resolve, join, basename } from 'node:path';
import fs from 'node:fs';

/** Extensiones de figura que el cargador de `Character` sabe abrir. */
const MODEL_EXT = /\.(glb|gltf|fbx)$/i;

/** Ruta que responde con los nombres de la carpeta. Fuera de `models/`. */
const MODELS_ROUTE = '/@atom/model-list';

/** Modulo virtual con la lista de archivos: no existe en el disco. */
const MODELS_ID = 'virtual:atom-models';
const MODELS_RESOLVED = '\0' + MODELS_ID;

/** Nombres de figura de un directorio, en orden alfabetico. */
function scanDir(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => MODEL_EXT.test(f))
      .sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base', numeric: true }));
  } catch {
    return [];
  }
}

/**
 * Lista de figuras leida de la carpeta.
 * ---------------------------------------------------------------------------
 * `models/` no pasa por el empaquetador (Vite copia esa carpeta tal cual), asi
 * que `import.meta.glob` no puede verla. Este plugin la lee de dos maneras, y en
 * ninguna de las dos se guarda la lista en ningun archivo:
 *
 *   · `GET /@atom/model-list` relee el directorio en cada peticion. Lo sirve el
 *     servidor de desarrollo (leyendo `public/models`) y tambien `npm run
 *     preview` (leyendo `dist/models`), asi que anadir, quitar o renombrar un
 *     archivo se ve al recargar, sin reconstruir nada.
 *   · el modulo virtual `virtual:atom-models` lleva la lista dentro del paquete,
 *     como respaldo para un servidor estatico que no tiene esa ruta.
 *
 * En desarrollo, ademas, al tocar la carpeta se recarga la pagina sola.
 */
function modelList() {
  const publicDir = resolve('public/models');
  let outModels = resolve('dist/models');

  const serve = (server, dir) => {
    server.middlewares.use(MODELS_ROUTE, (_req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ files: scanDir(dir) }));
    });
  };

  return {
    name: 'atom-model-list',
    configResolved(config) { outModels = resolve(config.build.outDir, 'models'); },
    resolveId(id) { return id === MODELS_ID ? MODELS_RESOLVED : null; },
    load(id) {
      if (id !== MODELS_RESOLVED) return null;
      return `export default ${JSON.stringify(scanDir(publicDir))};\n`;
    },
    configureServer(server) {
      serve(server, publicDir);
      server.watcher.add(publicDir);
      const tocado = (file) => {
        if (!MODEL_EXT.test(file) || resolve(file) !== join(publicDir, basename(file))) return;
        // El modulo virtual ya no vale: se descarta y se recarga la pagina.
        const graph = server.environments?.client?.moduleGraph ?? server.moduleGraph;
        const mod = graph?.getModuleById?.(MODELS_RESOLVED);
        if (mod) graph.invalidateModule(mod);
        server.ws.send({ type: 'full-reload' });
      };
      server.watcher.on('add', tocado);
      server.watcher.on('unlink', tocado);
    },
    // `preview` sirve lo construido: la carpeta que hay que leer es la de salida.
    configurePreviewServer(server) { serve(server, outModels); },
  };
}

export default defineConfig({
  // Rutas relativas: la build funciona igual en Cloudflare Pages, en un
  // subdirectorio o abierta desde un servidor estatico cualquiera.
  base: './',
  plugins: [modelList()],
  resolve: {
    alias: {
      // El entry point por defecto de kalidokit usa imports sin extension.
      // Apuntamos al bundle ESM ya resuelto.
      kalidokit: resolve('node_modules/kalidokit/dist/kalidokit.es.js'),
      '@': resolve('src'),
    },
  },
  server: { host: true, port: 5173 },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          mediapipe: ['@mediapipe/tasks-vision'],
          kalidokit: ['kalidokit'],
        },
      },
    },
  },
});
