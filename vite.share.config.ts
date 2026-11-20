// Builds the public viewer for shared notes into cloudflare/dist (deployed to Cloudflare Pages).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web/share',
  // .env.local sits at the top of the checkout, not in web/share (see .env.example).
  envDir: new URL('.', import.meta.url).pathname,
  plugins: [react()],
  build: { outDir: '../../cloudflare/dist', emptyOutDir: true, chunkSizeWarningLimit: 2000 },
});
