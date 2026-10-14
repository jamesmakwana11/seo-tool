import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  // Relative asset URLs for static review hosting (VITE_ROUTER=hash); absolute by default.
  base: process.env.VITE_ROUTER === 'hash' || process.env.VITE_ROUTER === 'memory' ? './' : '/',
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { port: 5173, proxy: { '/api': 'http://localhost:4000' } },
  build: { chunkSizeWarningLimit: 900 },
  test: { environment: 'jsdom', setupFiles: ['./test/setup.ts'], globals: false },
} as never);
