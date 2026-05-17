import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

// Shotblocks v2 web UI. Loaded by the C++ plugin (shotblocks_v2.xdl64)
// via a file:// URL into C4D's HtmlViewerCustomGui. The build output goes
// to dist/index.html as a SINGLE self-contained HTML file with all JS,
// CSS, and assets inlined. deploy.ps1 mirrors dist/ into the plugin's
// web/ folder.
//
// Why singleFile: under file://, Chromium treats each file as its own
// origin, so ES module imports (Vite's default output) fail with
// CORS-style errors and the page renders blank. Inlining everything
// into one HTML file dodges the whole problem.
export default defineConfig({
  plugins: [
    react(),
    viteSingleFile(),
  ],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // singleFile requires these — produce one chunk, inline everything.
    assetsInlineLimit: 100000000,
    cssCodeSplit: false,
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
})
