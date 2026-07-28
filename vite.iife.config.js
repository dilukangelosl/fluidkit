// CDN single-file build: <script src="https://unpkg.com/@dilukangelo/fluidkit/dist/fluidkit.iife.js">
// exposes window.fluidkit = { createFluid, dye, threshold, ramp, displacement, custom, textMask, ... }
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'fluidkit',
      formats: ['iife'],
      fileName: () => 'fluidkit.iife.js',
    },
    outDir: 'dist',
    emptyOutDir: false,
  },
})
