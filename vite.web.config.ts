// Vite config for the browser build of AUTOcarl: the SAME renderer as the
// Electron app, mounted by src/web/main.tsx with the window.api shim in
// place of the preload bridge. Output is a fully static site in web-dist/.
//
//   npx vite build -c vite.web.config.ts
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: resolve(__dirname, 'src/web'),
  // Relative asset URLs so the bundle works from any mount path (e.g. /autocarl/).
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, 'web-dist'),
    emptyOutDir: true,
  },
});
