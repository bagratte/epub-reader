import '../../vendor/foliate-js/view.js'
import { FootnoteHandler } from '../../vendor/foliate-js/footnotes.js'
import { contentCSS, type Settings } from './settings.ts'

export interface Relocation {
  cfi: string
  fraction: number
  label: string
  /** TOC href of the section now on screen, for highlighting the contents list. */
  tocHref?: string
}

export interface TocEntry {
  label: string
  href?: string
  subitems?: TocEntry[]
}

export interface SearchHit {
  cfi: string
  excerpt: { pre: string; match: string; post: string }
}

export interface SearchGroup {
  label: string
  hits: SearchHit[]
}

/**
 * Thin typed wrapper over <foliate-view>, which ships no types and has a few
 * sharp edges (see CLAUDE.md). Everything the app touches goes through here.
 */
/**
 * foliate's own default for `--_max-inline-size`: the widest a text column
 * gets, and in paginated mode the divisor deciding how many columns fit.
 */
const MEASURE_PX = 720

/** Large enough that the cap never binds, so `gap` alone sets the margins. */
const UNCAPPED_MEASURE = 100_000

export class Reader {
  #view: any
  #onRelocate?: (r: Relocation) => void
  #footnotes = new FootnoteHandler()
  /** foliate's close() is not idempotent — Paginator.destroy() nulls its own
   *  view and then dereferences it on a second call. Track state ourselves. */
  #opened = false

  constructor(element: Element, onFootnote: (view: HTMLElement) => void) {
    this.#view = element

    this.#view.addEventListener('relocate', (e: CustomEvent) => {
      const { cfi, fraction, tocItem } = e.detail
      this.#onRelocate?.({
        cfi, fraction,
        label: tocItem?.label ?? '',
        tocHref: tocItem?.href,
      })
    })

    // Footnote links open in place rather than navigating away from the page.
    this.#view.addEventListener('link', (e: CustomEvent) => {
      this.#footnotes.handle(this.#view.book, e)?.catch(() => {
        // Not a footnote after all, or it wouldn't resolve — let it navigate.
        this.#view.goTo(e.detail.href).catch(() => {})
      })
    })
    // 'before-render' is the one that matters: the popover's view is created
    // detached, and a detached paginator never renders. foliate fires this so
    // the host can attach it first. Listening only to 'render' means the
    // promise never settles and the note silently never opens.
    this.#footnotes.addEventListener('before-render', (e: Event) => {
      onFootnote((e as CustomEvent).detail.view)
    })

    this.#view.addEventListener('external-link', (e: CustomEvent) => {
      // Opening arbitrary URLs from an untrusted book is not something we do.
      e.preventDefault()
    })
  }

  async open(file: File, settings: Settings, start?: string) {
    // foliate's open() appends a renderer without removing the previous one,
    // so reusing a view across books stacks paginators: each keeps the old
    // book's iframe alive and still fires `relocate` on resize, for the wrong
    // book. close() is foliate's own teardown; it just never calls it itself.
    this.close()

    await this.#view.open(file)
    this.#opened = true
    this.applySettings(settings)

    // The paginator loads nothing until told to. Without this the view stays
    // blank with no error — foliate's own demo does the same thing. Going
    // straight to a saved position counts, and avoids rendering page one only
    // to jump away from it.
    if (start) {
      try {
        await this.#view.goTo(start)
        return
      } catch {
        // A CFI stops resolving if the file was replaced. Fall back to the
        // start rather than showing nothing.
      }
    }
    this.#view.renderer.next()
  }

  /** Safe to call while a book is open; foliate re-renders in place. */
  applySettings(settings: Settings) {
    const renderer = this.#view.renderer
    if (!renderer) return
    renderer.setAttribute('flow', settings.flow)
    renderer.setAttribute('margin', `${settings.margin}px`)
    // `margin` is vertical only — `gap` is what moves the left and right edges.
    renderer.setAttribute('gap', `${settings.gap}%`)
    renderer.setAttribute('max-column-count', String(settings.maxColumns))
    // Scrolled mode otherwise caps the text at --_max-inline-size and centres
    // it, so on a wide window that cap sets the side whitespace and `gap` is
    // swallowed whole — the horizontal control appears to do nothing until the
    // window is narrow enough that gap beats the cap. Lift it here so `gap`
    // governs; paginated mode keeps it, where it also decides how many columns
    // fit across the view.
    renderer.setAttribute(
      'max-inline-size',
      settings.flow === 'scrolled' ? `${UNCAPPED_MEASURE}px` : `${MEASURE_PX}px`,
    )
    renderer.setStyles?.(contentCSS(settings))
  }

  onRelocate(fn: (r: Relocation) => void) {
    this.#onRelocate = fn
  }

  get toc(): TocEntry[] {
    return this.#view.book?.toc ?? []
  }

  get metadata() {
    return this.#view.book?.metadata
  }

  /**
   * Streams grouped hits so the panel can fill in as the book is scanned —
   * a full-book search on a long novel takes a noticeable moment.
   */
  async *search(query: string): AsyncGenerator<SearchGroup | { progress: number }> {
    for await (const result of this.#view.search({ query, scope: 'book' })) {
      if (result === 'done') return
      if ('progress' in result) yield { progress: result.progress }
      else if (result.subitems) yield { label: result.label, hits: result.subitems }
    }
  }

  clearSearch() { this.#view.clearSearch?.() }

  /** Direction-aware: in an RTL book these swap. Use for left/right controls. */
  goLeft() { return this.#view.goLeft() }
  goRight() { return this.#view.goRight() }

  goTo(target: string) { return this.#view.goTo(target) }

  /** Frees the book's iframe and listeners. Safe to call when nothing is open. */
  close() {
    if (!this.#opened) return
    this.#opened = false
    this.#view.close()
  }
}
