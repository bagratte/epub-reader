import { defineConfig, type Plugin } from 'vite'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))

/**
 * foliate-js/pdf.js does `new URL(`vendor/pdfjs/${path}`, import.meta.url)`,
 * which Vite's import-glob transform tries to resolve as a glob and rejects,
 * breaking the production build. We render EPUBs only, and foliate imports
 * that module solely for PDFs, so swap it for a stub.
 *
 * An alias can't do this: foliate imports it as './pdf.js', and Vite aliases
 * the specifier rather than the resolved path.
 */
const stubFoliatePdf = (): Plugin => ({
  name: 'stub-foliate-pdf',
  enforce: 'pre',
  resolveId(source, importer) {
    if (source === './pdf.js' && importer?.includes('foliate-js')) {
      return root + 'client/src/foliate-no-pdf.ts'
    }
  },
})

export default defineConfig({
  root: 'client',
  plugins: [stubFoliatePdf()],
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
