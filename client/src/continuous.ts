/**
 * A continuous-scroll renderer for <foliate-view>.
 *
 * foliate's own paginator holds exactly one section in the DOM at a time, in
 * scrolled flow as much as paginated: scrolling stops dead at a chapter
 * boundary and only next()/prev() cross it. This renders the whole book as one
 * scroller instead.
 *
 * The load-bearing decision is that **each section keeps its own document**,
 * exactly as the paginator gives it. `view.js` builds the CFI from
 * `{ index, range }` — a section index plus a Range inside that section's own
 * document — so keeping one document per section means CFIs, the TOC, search,
 * footnotes and progress all keep working with no changes anywhere else.
 * Stitching the book into a single merged document would have broken every one
 * of them.
 *
 * The rest is a virtualised list. Every section gets a slot of the right
 * height; only sections near the viewport hold a live iframe. A slot starts at
 * an estimated height and switches to its measured one the first time it is
 * rendered — and once measured it never moves again, so the scrollbar settles
 * as you read rather than drifting forever.
 *
 * It implements the same interface `view.js` expects of a renderer: open(),
 * goTo(), next(), prev(), getContents(), scrollToAnchor(), destroy(),
 * setStyles(), the layout attributes, and the load / relocate /
 * create-overlayer events.
 */

interface Section {
  load?: () => string | Promise<string>
  unload?: () => void
  size?: number
  linear?: string
}

interface Book {
  sections?: Section[]
  dir?: string
}

/** How far outside the viewport a section stays live, in viewport heights. */
const KEEP_SCREENS = 2

/** Nothing renders shorter than this, so a slot is always hittable. */
const MIN_SLOT_PX = 120

/**
 * Starting guess for rendered pixels per byte of section source, used until a
 * book has had a few sections measured. Roughly what a Gutenberg chapter comes
 * out at; it self-corrects after the first measurement.
 */
const INITIAL_PX_PER_BYTE = 0.25

/** Fall back to this when a section reports no size. */
const ASSUMED_SECTION_BYTES = 4000

/** Give up waiting on a section's document rather than wedge its slot. */
const LOAD_TIMEOUT_MS = 8000

/**
 * How long after a navigation the target keeps being re-applied while
 * surrounding sections are measured and their slots resize.
 */
const ANCHOR_SETTLE_MS = 2500

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

function setImportant(el: HTMLElement, styles: Record<string, string>) {
  for (const [key, value] of Object.entries(styles)) {
    el.style.setProperty(key, value, 'important')
  }
}

/** Firefox spells this differently, and neither name is universal. */
function caretRange(doc: Document, x: number, y: number): Range | null {
  const anyDoc = doc as any
  try {
    if (anyDoc.caretRangeFromPoint) return anyDoc.caretRangeFromPoint(x, y)
    const pos = anyDoc.caretPositionFromPoint?.(x, y)
    if (!pos) return null
    const range = doc.createRange()
    range.setStart(pos.offsetNode, pos.offset)
    range.collapse(true)
    return range
  } catch {
    return null
  }
}

/**
 * Last resort when caret hit-testing gives nothing — an empty page, a point
 * over a margin. Walks for the first element crossing the line instead.
 */
function rangeNear(doc: Document, top: number): Range | null {
  try {
    for (const el of doc.body.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, div, blockquote')) {
      const rect = el.getBoundingClientRect()
      if (rect.height > 0 && rect.bottom > top) {
        const range = doc.createRange()
        range.selectNodeContents(el)
        range.collapse(true)
        return range
      }
    }
    const range = doc.createRange()
    range.selectNodeContents(doc.body)
    range.collapse(true)
    return range
  } catch {
    return null
  }
}

/**
 * Widen a collapsed range enough to be sure it has client rects.
 *
 * Every CFI naming a point rather than a span — which is every saved reading
 * position — resolves to a collapsed range, and a collapsed range is not
 * reliably measurable: Chromium gives a caret rect, but foliate's paginator
 * carries this same workaround with the comment "collapsed range doesn't
 * return client rects sometimes (or always?)". A zero rect here would read as
 * an offset of zero and scroll to the top of the section, which is a restore
 * that looks like it worked while losing the reader's place — so don't rely
 * on the browser being generous.
 */
function uncollapse(target: any): any {
  if (!target?.collapsed) return target
  const { endOffset, endContainer } = target
  if (endContainer.nodeType === 1) {
    const node = endContainer.childNodes[endOffset]
    return node?.nodeType === 1 ? node : endContainer
  }
  if (endOffset + 1 < endContainer.length) target.setEnd(endContainer, endOffset + 1)
  else if (endOffset > 1) target.setStart(endContainer, endOffset - 1)
  else return endContainer.parentNode
  return target
}

/**
 * Where an anchor sits inside its own section, or null if it cannot be
 * measured — a detached document, or a node with no box. The section's
 * document is never scrolled internally, so a client rect is already the
 * offset from the top of the section.
 *
 * Measures a clone: uncollapse() mutates, and the caller may still want the
 * original range to select with.
 */
function anchorTop(target: any): number | null {
  const measured = uncollapse(target?.cloneRange?.() ?? target)
  const rects: DOMRect[] = [...(measured?.getClientRects?.() ?? [])]
  // A range starting right after a line break gets an extra empty rect at the
  // end of the previous line; the first one with real area is the right one.
  const rect = rects.find(r => r.width > 0 && r.height > 0) ?? rects[0]
  return rect ? rect.top : null
}

/** One section's live iframe, plus the slot holding its place in the scroller. */
class SectionView {
  index: number
  slot: HTMLElement
  iframe: HTMLIFrameElement
  overlayer: any = null
  styles: [HTMLStyleElement, HTMLStyleElement] | null = null
  observer: ResizeObserver | null = null

  constructor(index: number, slot: HTMLElement, iframe: HTMLIFrameElement) {
    this.index = index
    this.slot = slot
    this.iframe = iframe
  }

  get document(): Document | null {
    return this.iframe.contentDocument
  }
}

export class Continuous extends HTMLElement {
  static observedAttributes = [
    'flow', 'gap', 'margin', 'max-inline-size', 'max-block-size', 'max-column-count',
  ]

  #root = this.attachShadow({ mode: 'open' })
  #scroller!: HTMLElement
  #slots: HTMLElement[] = []
  #views = new Map<number, SectionView>()
  /** Sections being loaded, each mapped to the load nobody else should repeat. */
  #loading = new Map<number, Promise<void>>()
  /** Where a navigation is heading. Protected from release until it lands. */
  #pinned: number | null = null
  #heights: number[] = []
  #measured: boolean[] = []

  #hostResize: ResizeObserver | null = null
  #scrollTimer: ReturnType<typeof setTimeout> | undefined
  #relayoutTimer: ReturnType<typeof setTimeout> | undefined
  #destroyed = false

  #styles: string | [string, string] = ''
  #gap = 6
  #margin = 48
  #maxInlineSize = 720
  #index = 0
  #pxPerByte = INITIAL_PX_PER_BYTE
  #samples = 0
  /** Whether the first relocate has gone out, so the UI starts up populated. */
  #started = false
  /**
   * Where a navigation was actually aiming, kept alive while heights settle.
   * A slot's offset is only as good as the estimates of every slot above it,
   * so scrolling once and walking away lands the reader a chapter out.
   */
  #pending: { index: number; offset: number; anchor?: any } | null = null
  #pendingUntil = 0

  sections: Section[] = []
  book: Book | null = null

  constructor() {
    super()
    this.#root.innerHTML = `
      <style>
        /* foliate-view's shadow root carries no stylesheet, so the renderer
           has to size itself — exactly as the paginator does. Without the
           explicit 100% height the host collapses, the scroller has no
           height, and an IntersectionObserver rooted on it never fires. */
        :host {
          display: block;
          box-sizing: border-box;
          position: relative;
          overflow: hidden;
          width: 100%;
          height: 100%;
        }
        #scroller {
          position: absolute;
          inset: 0;
          overflow-y: auto;
          overflow-x: hidden;
          overscroll-behavior: contain;
        }
        .slot { position: relative; width: 100%; box-sizing: border-box; }
        .slot > iframe { display: block; width: 100%; border: 0; }
      </style>
      <div id="scroller"></div>
    `
    this.#scroller = this.#root.getElementById('scroller')!

    this.#scroller.addEventListener('scroll', () => {
      this.dispatchEvent(new Event('scroll'))
      clearTimeout(this.#scrollTimer)
      this.#scrollTimer = setTimeout(() => {
        this.#reconcile()
        this.#report('scroll')
      }, 120)
    })
  }

  // --- lifecycle -------------------------------------------------------------

  open(book: Book) {
    this.book = book
    this.sections = book.sections ?? []
    this.#buildSlots()

    // A resize changes the horizontal gap and therefore every measured height.
    // It also fires once when the element is first attached, which is what
    // gets the first reconcile done with a root that has a real size.
    this.#hostResize = new ResizeObserver(() => {
      clearTimeout(this.#relayoutTimer)
      this.#relayoutTimer = setTimeout(() => this.#relayoutAll(), 120)
    })
    this.#hostResize.observe(this)
    // Deliberately no initial goTo(). view.js appends this element and the
    // caller may immediately goTo() a saved CFI; an auto-navigation to
    // section 0 races that and wins about half the time, dumping the reader
    // back at the top of the book. The first reconcile — driven by the resize
    // that attachment causes — materialises whatever is at the current scroll
    // offset, which is the right thing whether or not anyone navigated.
  }

  destroy() {
    this.#destroyed = true
    clearTimeout(this.#scrollTimer)
    clearTimeout(this.#relayoutTimer)
    this.#hostResize?.disconnect()
    this.#hostResize = null
    for (const index of [...this.#views.keys()]) this.#release(index)
    this.#views.clear()
    this.#loading.clear()
    this.#slots = []
    this.#scroller.replaceChildren()
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null) {
    const number = parseFloat(value ?? '')
    if (name === 'gap' && !Number.isNaN(number)) this.#gap = number
    else if (name === 'margin' && !Number.isNaN(number)) this.#margin = number
    else if (name === 'max-inline-size' && !Number.isNaN(number)) this.#maxInlineSize = number
    else return
    if (this.#slots.length) {
      clearTimeout(this.#relayoutTimer)
      this.#relayoutTimer = setTimeout(() => this.#relayoutAll(), 0)
    }
  }

  // --- slots -----------------------------------------------------------------

  #buildSlots() {
    this.#slots = this.sections.map((_, index) => {
      const slot = document.createElement('div')
      slot.className = 'slot'
      slot.dataset.index = String(index)
      const height = this.#estimate(index)
      this.#heights[index] = height
      this.#measured[index] = false
      slot.style.height = `${height}px`
      slot.style.padding = `${this.#margin}px 0`
      return slot
    })
    this.#scroller.replaceChildren(...this.#slots)
  }

  #estimate(index: number) {
    const bytes = this.sections[index]?.size ?? ASSUMED_SECTION_BYTES
    return Math.max(MIN_SLOT_PX, Math.round(bytes * this.#pxPerByte) + this.#margin * 2)
  }

  /**
   * Resize a slot, keeping whatever the reader is looking at still. Growing a
   * slot above the viewport pushes everything below it down, which would drag
   * the text out from under them mid-sentence.
   */
  #setHeight(index: number, height: number, measured: boolean) {
    const slot = this.#slots[index]
    if (!slot) return
    const previous = this.#heights[index] ?? 0
    if (previous === height && this.#measured[index] === measured) return

    const above = slot.offsetTop < this.#scroller.scrollTop
    this.#heights[index] = height
    this.#measured[index] = measured
    slot.style.height = `${height}px`
    if (above) this.#scroller.scrollTop += height - previous
  }

  /**
   * Fold a real measurement into the running estimate, then re-guess the slots
   * that have never been rendered. Only ones below the viewport: re-guessing
   * above it would shuffle the page under the reader for no gain.
   */
  #calibrate(index: number, contentHeight: number) {
    const bytes = this.sections[index]?.size
    if (!bytes) return
    const sample = contentHeight / bytes
    this.#samples++
    this.#pxPerByte += (sample - this.#pxPerByte) / Math.min(this.#samples, 12)

    const scrollTop = this.#scroller.scrollTop
    for (let i = 0; i < this.#slots.length; i++) {
      if (this.#measured[i]) continue
      const slot = this.#slots[i]!
      if (slot.offsetTop <= scrollTop) continue
      this.#setHeight(i, this.#estimate(i), false)
    }
  }

  // --- materialising ---------------------------------------------------------

  /**
   * Decide which sections should be live, from scroll position alone.
   *
   * This began as an IntersectionObserver and was not reliable: view.js calls
   * renderer.open() *before* appending the element, so the observer was built
   * on a detached, zero-sized root, and slot heights then move underneath it
   * as sections get measured. Leave notifications went missing and released
   * nothing, so the whole book ended up live. Comparing offsets directly is
   * both deterministic and cheap — a few hundred slots at worst, per scroll
   * tick.
   */
  /**
   * Put the scroll back on the last navigation's target. Called after each
   * measurement, because replacing an estimate with a real height above the
   * target moves it. Recomputing from the slot's current offset is right even
   * when sections further up are still guesses — they only have to be stable,
   * not correct.
   */
  #reapply() {
    const pending = this.#pending
    if (!pending) return
    if (Date.now() > this.#pendingUntil) {
      this.#pending = null
      return
    }
    const slot = this.#slots[pending.index]
    if (!slot) return
    // An image or a late font inside the target section moves the anchor as
    // much as a resized slot above it does, so re-measure rather than trust
    // the offset taken at navigation time. Keep the last good one when the
    // anchor cannot be measured — the section may have been released.
    if (pending.anchor) {
      const top = anchorTop(pending.anchor)
      if (top != null) pending.offset = top
    }
    this.#scroller.scrollTop = slot.offsetTop + this.#margin + pending.offset
  }

  #reconcile() {
    if (this.#destroyed || !this.#slots.length) return
    const viewport = this.#scroller.clientHeight
    if (!viewport) return

    const keep = viewport * KEEP_SCREENS
    const from = this.#scroller.scrollTop - keep
    const to = this.#scroller.scrollTop + viewport + keep

    for (let i = 0; i < this.#slots.length; i++) {
      const slot = this.#slots[i]!
      const top = slot.offsetTop
      const bottom = top + (this.#heights[i] ?? 0)
      if (bottom >= from && top <= to) void this.#materialise(i)
      else this.#release(i)
    }

    // Nothing has told the app where we are yet, so the chapter label and
    // percentage would sit empty until the reader happened to scroll.
    if (!this.#started && this.#views.size) {
      this.#started = true
      this.#report('navigation')
    }
  }

  /**
   * Bring a section to life, or hand back the load already doing it.
   *
   * Returning early when one is in flight — which is what this did — makes
   * `await materialise(i)` a lie: goTo() resumed with the section still
   * loading and no document to measure its anchor in, and silently scrolled
   * to the top of it instead.
   */
  #materialise(index: number): Promise<void> {
    if (this.#destroyed || this.#views.has(index)) return Promise.resolve()
    const inFlight = this.#loading.get(index)
    if (inFlight) return inFlight

    const load = this.#load(index).finally(() => {
      // A release, or a later load for the same section, may already own the
      // entry — only ever retire our own.
      if (this.#loading.get(index) === load) this.#loading.delete(index)
    })
    this.#loading.set(index, load)
    return load
  }

  async #load(index: number) {
    const section = this.sections[index]
    const slot = this.#slots[index]
    if (!section?.load || !slot) return

    try {
      const src = await section.load()
      if (this.#destroyed || !this.#loading.has(index)) return

      const iframe = document.createElement('iframe')
      // Matches the paginator: same-origin is required to walk the document
      // for CFIs, and allow-scripts works around a WebKit event bug. The CSP,
      // not this attribute, is the real boundary — see CLAUDE.md → Security.
      iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts')
      iframe.setAttribute('scrolling', 'no')
      iframe.style.height = '0'

      const view = new SectionView(index, slot, iframe)
      await new Promise<void>(resolve => {
        // Inserting an iframe fires a load event for its initial about:blank
        // document, before the real one arrives. Taking that event means
        // styling and measuring a blank document — and the section's own
        // document then lands with no styles and a height of zero, which is a
        // blank screen with a correct-looking progress bar. Wait for a
        // document that is not about:blank, and give up rather than hang.
        const done = () => {
          iframe.removeEventListener('load', onLoad)
          clearTimeout(timer)
          resolve()
        }
        const onLoad = () => {
          if (iframe.contentDocument?.URL === 'about:blank') return
          done()
        }
        const timer = setTimeout(done, LOAD_TIMEOUT_MS)
        iframe.addEventListener('load', onLoad)
        iframe.src = typeof src === 'string' ? src : ''
        slot.append(iframe)
      })

      const doc = view.document
      // A release can land while the iframe was loading. Honour it, or the
      // section joins #views with nothing left to take it out again.
      if (this.#destroyed || !doc || !this.#loading.has(index)) {
        iframe.remove()
        return
      }

      this.#injectStyles(view, doc)
      this.#layout(view)
      this.#views.set(index, view)

      this.dispatchEvent(new CustomEvent('load', { detail: { doc, index } }))
      this.dispatchEvent(new CustomEvent('create-overlayer', {
        detail: {
          doc, index,
          attach: (overlayer: any) => {
            view.overlayer = overlayer
            slot.append(overlayer.element)
          },
        },
      }))

      this.#measure(view)

      // Images and late-loading fonts change the height after first paint.
      view.observer = new ResizeObserver(() => this.#measure(view))
      view.observer.observe(doc.documentElement)
      doc.fonts?.ready?.then(() => this.#measure(view)).catch(() => {})
    } catch {
      // A section that will not load must not take the scroller down with it.
      // Its slot keeps its estimated height and stays blank.
    }
  }

  #release(index: number) {
    // Never release the section being reported on — relocate would lose its
    // range — nor the one a navigation is on its way to. A reconcile runs
    // while goTo() awaits its section, and the target is by definition far
    // from the current scroll position, so it is exactly what this loop would
    // otherwise throw away: cancelling the load that goTo is waiting on and
    // landing the reader at the top of the chapter instead of in it.
    if (index === this.#index || index === this.#pinned) return
    this.#loading.delete(index)
    const view = this.#views.get(index)
    if (!view) return

    this.#views.delete(index)
    view.observer?.disconnect()
    view.overlayer?.element?.remove()
    view.iframe.remove()
    try {
      this.sections[index]?.unload?.()
    } catch {
      // Already unloaded, or the book is closing.
    }
  }

  #injectStyles(view: SectionView, doc: Document) {
    if (!doc.head) return
    const before = doc.createElement('style')
    const after = doc.createElement('style')
    doc.head.prepend(before)
    doc.head.append(after)
    view.styles = [before, after]
    this.#writeStyles(view)
  }

  #writeStyles(view: SectionView) {
    if (!view.styles) return
    const [before, after] = view.styles
    if (Array.isArray(this.#styles)) {
      before.textContent = this.#styles[0]
      after.textContent = this.#styles[1]
    } else {
      after.textContent = this.#styles
    }
  }

  // --- layout ----------------------------------------------------------------

  /**
   * The horizontal gap, in px. foliate expands the percentage by g/(1-g) so
   * that outer padding and column gap come out visually equal; matching it
   * here means the same percentage looks the same in both flows.
   */
  #gapPx() {
    const g = clamp(this.#gap, 0, 45) / 100
    return Math.round(-g / (g - 1) * this.#scroller.clientWidth)
  }

  #layout(view: SectionView) {
    const doc = view.document
    if (!doc?.documentElement || !doc.body) return
    const gap = this.#gapPx()

    setImportant(doc.documentElement, {
      'box-sizing': 'border-box',
      'padding': `0 ${gap}px`,
      'margin': '0',
      'column-width': 'auto',
      'height': 'auto',
      'width': 'auto',
      'overflow': 'hidden',
      'overflow-wrap': 'break-word',
    })
    setImportant(doc.body, {
      'max-width': `${this.#maxInlineSize}px`,
      'max-height': 'none',
      'height': 'auto',
      'margin': 'auto',
    })

    // Keep a full-page illustration from running off the bottom of the screen.
    const limit = Math.max(160, this.#scroller.clientHeight - this.#margin * 2)
    for (const el of doc.body.querySelectorAll('img, svg, video')) {
      setImportant(el as HTMLElement, {
        'max-width': '100%',
        'max-height': `${limit}px`,
        'object-fit': 'contain',
        'box-sizing': 'border-box',
      })
    }

    view.slot.style.padding = `${this.#margin}px 0`
  }

  #measure(view: SectionView) {
    const doc = view.document
    if (this.#destroyed || !doc?.documentElement) return
    const height = Math.ceil(doc.documentElement.getBoundingClientRect().height)
    if (!height) {
      // Not laid out yet. One retry, rather than leaving the slot blank.
      requestAnimationFrame(() => {
        if (!this.#destroyed && this.#views.get(view.index) === view) this.#measure(view)
      })
      return
    }

    view.iframe.style.height = `${height}px`
    this.#setHeight(view.index, height + this.#margin * 2, true)
    this.#calibrate(view.index, height)
    // A measurement moves every slot below it, so the window has changed.
    this.#reconcile()
    // ...and it moved the target of any navigation still settling.
    this.#reapply()
  }

  #relayoutAll() {
    if (this.#destroyed) return
    for (const slot of this.#slots) slot.style.padding = `${this.#margin}px 0`
    for (const view of this.#views.values()) {
      this.#layout(view)
      this.#measure(view)
    }
    this.#reconcile()
  }

  // --- position --------------------------------------------------------------

  #currentIndex(): number {
    const scrollTop = this.#scroller.scrollTop
    let found = 0
    for (let i = 0; i < this.#slots.length; i++) {
      const slot = this.#slots[i]!
      if (slot.offsetTop <= scrollTop + this.#margin) found = i
      else break
    }
    return found
  }

  #visibleRange(view: SectionView): Range | null {
    const doc = view.document
    if (!doc?.body) return null
    const top = this.#scroller.scrollTop - view.slot.offsetTop - this.#margin
    const height = doc.documentElement.getBoundingClientRect().height || 1
    const y = clamp(top + 2, 1, height - 2)
    const x = Math.max(1, doc.documentElement.clientWidth / 2)
    return caretRange(doc, x, y) ?? rangeNear(doc, top)
  }

  #report(reason: string) {
    if (this.#destroyed || !this.#slots.length) return
    const index = this.#currentIndex()
    this.#index = index

    const slot = this.#slots[index]!
    const height = this.#heights[index] || 1
    const fraction = clamp((this.#scroller.scrollTop - slot.offsetTop) / height, 0, 1)
    const view = this.#views.get(index)
    const range = view ? this.#visibleRange(view) : null

    this.dispatchEvent(new CustomEvent('relocate', {
      detail: { reason, range, index, fraction },
    }))
  }

  // --- the renderer interface view.js calls ----------------------------------

  async goTo({ index, anchor, select }: { index: number; anchor?: any; select?: boolean }) {
    if (index == null || index < 0 || index >= this.sections.length) return
    this.#pinned = index
    try {
      await this.#goTo(index, anchor, select)
    } finally {
      this.#pinned = null
    }
  }

  async #goTo(index: number, anchor?: any, select?: boolean) {
    await this.#materialise(index)
    if (this.#destroyed) return

    const slot = this.#slots[index]
    if (!slot) return
    const view = this.#views.get(index)
    let offset = 0
    let resolved: any

    if (view?.document) {
      const doc = view.document
      const target = typeof anchor === 'function' ? anchor(doc) : anchor
      if (typeof target === 'number') {
        const content = (this.#heights[index] ?? 0) - this.#margin * 2
        offset = target * content
      } else if (target) {
        // A Range or an Element. Measured rather than read off a bounding
        // rect, because a collapsed range has none — see anchorTop().
        const top = anchorTop(target)
        if (top != null) offset = top
        resolved = target
        if (select && target.startContainer) this.#select(doc, target)
      }
    }

    this.#pending = { index, offset, anchor: resolved }
    this.#pendingUntil = Date.now() + ANCHOR_SETTLE_MS
    this.#scroller.scrollTop = slot.offsetTop + this.#margin + offset
    this.#index = index
    this.#reconcile()
    this.#report('navigation')
  }

  async scrollToAnchor(anchor: any, select?: boolean) {
    const doc: Document | undefined =
      anchor?.startContainer?.ownerDocument ?? anchor?.ownerDocument
    for (const view of this.#views.values()) {
      if (view.document !== doc) continue
      const top = anchorTop(anchor)
      if (top != null) {
        this.#scroller.scrollTop = view.slot.offsetTop + this.#margin + top
      }
      if (select && view.document) this.#select(view.document, anchor)
      this.#report('anchor')
      return
    }
  }

  #select(doc: Document, range: Range) {
    try {
      const selection = doc.defaultView?.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    } catch {
      // Selection across a shadow boundary can throw; the scroll still happened.
    }
  }

  async next(distance?: number) {
    this.#scrollBy(distance ?? this.#scroller.clientHeight * 0.9)
  }

  async prev(distance?: number) {
    this.#scrollBy(-(distance ?? this.#scroller.clientHeight * 0.9))
  }

  #scrollBy(delta: number) {
    // Deliberate movement wins over a navigation that is still settling.
    this.#pending = null
    this.#scroller.scrollTo({ top: this.#scroller.scrollTop + delta, behavior: 'smooth' })
  }

  getContents() {
    return [...this.#views.values()]
      .sort((a, b) => a.index - b.index)
      .map(view => ({ index: view.index, overlayer: view.overlayer, doc: view.document }))
  }

  setStyles(styles: string | [string, string]) {
    this.#styles = styles
    for (const view of this.#views.values()) {
      this.#writeStyles(view)
      // The new type size changes every height.
      view.document?.fonts?.ready?.then(() => this.#measure(view)).catch(() => {})
      this.#measure(view)
    }
  }

  focusView() {
    this.#views.get(this.#index)?.document?.defaultView?.focus()
  }
}

customElements.define('foliate-continuous', Continuous)
