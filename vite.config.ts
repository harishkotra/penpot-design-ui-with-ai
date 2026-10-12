import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { apiMiddleware } from './server/middleware';

/**
 * Mounts the local API in both the dev server and the preview server, so
 * `npm run dev` and `npm run build && npm run preview` behave identically and
 * there is only ever one port to think about.
 */
function atelierApi(): Plugin {
  return {
    name: 'atelier-api',
    configureServer(server) {
      server.middlewares.use(apiMiddleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(apiMiddleware);
    },
  };
}

export default defineConfig({
  plugins: [react(), atelierApi()],
  server: {
    port: 5173,
    strictPort: false,
    host: true,
  },
  preview: {
    port: 4173,
    strictPort: false,
    host: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});