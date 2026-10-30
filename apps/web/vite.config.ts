import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig(({ mode, command }) => {
  // Every build talks to the real API server. `--mode http` is kept as an alias so existing scripts keep working.
  const prod = mode === 'http' || command === 'build';
  return {
  plugins: [
    react(),
    // Production (http) build: resolve the relative asset URLs from the site root by default. The API server replaces
    // this with the real base path when it serves index.html, so the same build works at / and under /seo-tool/.
    ...(prod && !process.env.VITE_ROUTER ? [{ name: 'sentinel-base-href', transformIndexHtml: (html: string) => html.replace('<head>', '<head>\n    <base href="/" />') }] : []),
  ],
  // Relative asset URLs: static review hosting (VITE_ROUTER=hash / memory), and the production (http) build, which the
  // API server may serve under a sub-path (APP_BASE_URL=https://host/seo-tool) — it sets <base href> in index.html.
  base: process.env.VITE_ROUTER === 'hash' || process.env.VITE_ROUTER === 'memory' || (prod && !process.env.VITE_ROUTER) ? './' : '/',
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { port: 5173, proxy: { '/api': 'http://localhost:4000' } },
  build: { chunkSizeWarningLimit: 900 },
  test: { environment: 'jsdom', setupFiles: ['./test/setup.ts'], globals: false },
  } as never;
});
