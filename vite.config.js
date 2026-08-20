import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    assetsInlineLimit: 0, // keep the .bin grid blocks as real files
  },
  server: {
    port: 5173,
  },
});
