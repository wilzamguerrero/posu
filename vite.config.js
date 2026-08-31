import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  // Rutas relativas: la build funciona igual en Cloudflare Pages, en un
  // subdirectorio o abierta desde un servidor estatico cualquiera.
  base: './',
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
