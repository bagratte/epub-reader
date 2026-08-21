import { defineConfig, type Plugin } from 'vite'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

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

/**
 * Lets <foliate-view> use a renderer other than the paginator.
 *
 * view.js hard-codes `document.createElement('foliate-paginator')` and appends
 * it into a *closed* shadow root, so the choice cannot be overridden from
 * outside — the element is unreachable. One line of rewriting turns it into an
 * attribute, which is what selects the continuous-scroll renderer.
 *
 * Throwing when the pattern is missing is deliberate: a submodule bump that
 * moves this line should fail the build rather than silently drop the feature.
 */
const pluggableRenderer = (): Plugin => ({
  name: 'foliate-pluggable-renderer',
  enforce: 'pre',
  transform(code, id) {
    if (!id.replace(/\\/g, '/').endsWith('foliate-js/view.js')) return
    const from = "this.renderer = document.createElement('foliate-paginator')"
    const to = "this.renderer = document.createElement("
      + "this.getAttribute('renderer') || 'foliate-paginator')"
    if (!code.includes(from)) {
      throw new Error(
        'foliate-js view.js no longer contains the renderer line this plugin '
        + 'rewrites. Check vendor/foliate-js/view.js and update the pattern.',
      )
    }
    return { code: code.replace(from, to), map: null }
  },
})

/**
 * Emits the service worker with its precache list filled in.
 *
 * Hand-rolled instead of vite-plugin-pwa/Workbox: the caching policy is three
 * rules (see client/sw.js) and the only thing the SW cannot know by itself is
 * the hashed asset names, which is exactly what this supplies.
 */
const emitServiceWorker = (): Plugin => ({
  name: 'emit-service-worker',
  apply: 'build',
  generateBundle(_options, bundle) {
    const assets = Object.keys(bundle).map(name => '/' + name)
    const precache = [
      '/',
      '/index.html',
      '/manifest.webmanifest',
      '/icon-192.png',
      '/icon-512.png',
      '/apple-touch-icon.png',
      ...assets.filter(name => !name.endsWith('.html')),
    ]
    // Derive the version from the content-hashed filenames, so an unchanged
    // rebuild keeps the same cache and doesn't churn every client.
    const version = createHash('sha256')
      .update(precache.sort().join('\n'))
      .digest('hex')
      .slice(0, 12)

    const source = readFileSync(root + 'client/sw.js', 'utf8')
      .replace('self.__PRECACHE__', JSON.stringify(precache))
      .replace('self.__VERSION__', JSON.stringify(version))

    this.emitFile({ type: 'asset', fileName: 'sw.js', source })
  },
})

export default defineConfig({
  root: 'client',
  plugins: [stubFoliatePdf(), pluggableRenderer(), emitServiceWorker()],
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
