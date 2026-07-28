import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig({
  build: {
    target: 'es2022', // webgpu demo uses top-level await; all WebGPU browsers support es2022
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        webgpu: resolve(__dirname, 'webgpu.html'),
      },
    },
  },
})
