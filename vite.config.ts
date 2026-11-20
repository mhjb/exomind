import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  root: 'web',
  plugins: [react()],
  // The app shows its version at the top right of the band (house style).
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: { outDir: '../dist', emptyOutDir: true, chunkSizeWarningLimit: 2000 },
});
