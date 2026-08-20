import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root: 'client',
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
  },
  server: {
    port: 5180,
    strictPort: true,
    // foliate-js lives outside the Vite root, so it must be explicitly allowed
    fs: { allow: [root] },
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
    },
  },
})
