interface ImportMetaEnv {
  readonly PROD: boolean
  readonly DEV: boolean
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}

/**
 * foliate-js ships no types. Rather than sprinkle @ts-expect-error, declare the
 * modules we import as untyped — `Reader` is the one place that touches them,
 * and it re-exports a typed surface.
 */
declare module '*/vendor/foliate-js/view.js'
declare module '*/vendor/foliate-js/footnotes.js' {
  export class FootnoteHandler extends EventTarget {
    detectFootnotes: boolean
    handle(book: unknown, event: Event): Promise<void> | undefined
  }
}
