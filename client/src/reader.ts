import '../../vendor/foliate-js/view.js'

export interface Relocation {
  cfi: string
  fraction: number
  label: string
}

export type FlowMode = 'paginated' | 'scrolled'

export interface ReadingStyle {
  /** line-height for body text. */
  spacing: number
  justify: boolean
  hyphenate: boolean
}

const DEFAULT_STYLE: ReadingStyle = { spacing: 1.5, justify: true, hyphenate: true }

/** Injected into the book's iframe document, not the app document. */
const contentCSS = ({ spacing, justify, hyphenate }: ReadingStyle) => `
  @namespace epub "http://www.idpf.org/2007/ops";
  html { color-scheme: light dark; }
  /* https://github.com/whatwg/html/issues/5426 */
  @media (prefers-color-scheme: dark) {
    a:link { color: lightblue; }
  }
  p, li, blockquote, dd {
    line-height: ${spacing};
    text-align: ${justify ? 'justify' : 'start'};
    -webkit-hyphens: ${hyphenate ? 'auto' : 'manual'};
    hyphens: ${hyphenate ? 'auto' : 'manual'};
    hanging-punctuation: allow-end last;
    widows: 2;
  }
  /* don't let the above override an explicit align attribute */
  [align="left"] { text-align: left; }
  [align="right"] { text-align: right; }
  [align="center"] { text-align: center; }
  [align="justify"] { text-align: justify; }
  pre { white-space: pre-wrap !important; }
`

/**
 * Thin wrapper over <foliate-view>. Keeps foliate's untyped surface in one
 * place so the rest of the client talks to something typed.
 */
export class Reader {
  #view: any
  #onRelocate?: (r: Relocation) => void

  constructor(element: Element) {
    this.#view = element
    this.#view.addEventListener('relocate', (e: CustomEvent) => {
      const { cfi, fraction, tocItem } = e.detail
      this.#onRelocate?.({ cfi, fraction, label: tocItem?.label ?? '' })
    })
  }

  async open(file: File, opts: { flow?: FlowMode; style?: ReadingStyle } = {}) {
    await this.#view.open(file)

    // The renderer only exists after open(), so everything below must follow it.
    const renderer = this.#view.renderer
    renderer.setAttribute('flow', opts.flow ?? 'paginated')
    renderer.setStyles?.(contentCSS(opts.style ?? DEFAULT_STYLE))

    // The paginator loads nothing until told to. Without this the view stays
    // blank with no error — foliate's own demo does the same thing.
    renderer.next()
  }

  setFlow(flow: FlowMode) {
    this.#view.renderer?.setAttribute('flow', flow)
  }

  setStyle(style: ReadingStyle) {
    this.#view.renderer?.setStyles?.(contentCSS(style))
  }

  onRelocate(fn: (r: Relocation) => void) {
    this.#onRelocate = fn
  }

  /** Direction-aware: in an RTL book these swap. Use for left/right controls. */
  goLeft() { return this.#view.goLeft() }
  goRight() { return this.#view.goRight() }

  /** Logical order, regardless of writing direction. */
  next() { return this.#view.next() }
  prev() { return this.#view.prev() }

  goTo(target: string) { return this.#view.goTo(target) }

  get metadata() { return this.#view.book?.metadata }
}
