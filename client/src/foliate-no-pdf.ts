/**
 * Stub replacing foliate-js/pdf.js at build time.
 *
 * That module does `new URL(`vendor/pdfjs/${path}`, import.meta.url)`, which
 * Vite's import-glob transform tries to resolve as a glob and rejects. We only
 * render EPUBs, and foliate only imports it for a PDF, so aliasing it away
 * costs nothing and keeps pdf.js out of the bundle.
 *
 * To add PDF support later: drop this alias and vendor pdfjs properly.
 */
export const makePDF = (): never => {
  throw new Error('PDF rendering is not enabled in this build')
}
