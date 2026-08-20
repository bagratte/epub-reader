import type { Reader, TocEntry } from '../reader.ts'

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K, props: Partial<HTMLElementTagNameMap[K]> = {},
) => Object.assign(document.createElement(tag), props)

/**
 * One drawer, two modes. Contents and search both answer "where do I go next",
 * so they share a panel: typing switches the list to results, clearing the
 * field returns it to the table of contents.
 */
export class ContentsPanel {
  #root: HTMLElement
  #input: HTMLInputElement
  #list: HTMLElement
  #note: HTMLElement
  #reader?: Reader
  #onNavigate: (target: string) => void
  #currentHref?: string
  /** Bumped on every query so a slow search can't paint over a newer one. */
  #searchToken = 0

  constructor(root: HTMLElement, onNavigate: (target: string) => void) {
    this.#root = root
    this.#onNavigate = onNavigate
    this.#input = root.querySelector('input')!
    this.#list = root.querySelector('.panel-list')!
    this.#note = root.querySelector('.panel-note')!

    let debounce: ReturnType<typeof setTimeout>
    this.#input.addEventListener('input', () => {
      clearTimeout(debounce)
      debounce = setTimeout(() => this.#run(this.#input.value.trim()), 250)
    })
    this.#input.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return
      if (this.#input.value) {
        this.#input.value = ''
        this.#run('')
      } else this.close()
    })
  }

  get isOpen() { return !this.#root.hidden }

  attach(reader: Reader) {
    this.#reader = reader
    this.#input.value = ''
    this.#renderToc()
  }

  open() {
    this.#root.hidden = false
    this.#input.focus()
    // Only on open: doing this on every relocate would fight the user's own
    // scrolling while they browse the list.
    this.#revealCurrent()
  }

  #revealCurrent() {
    const current = this.#list.querySelector<HTMLElement>('a.current')
    current?.scrollIntoView({ block: 'center' })
  }

  close() {
    this.#root.hidden = true
    this.#reader?.clearSearch()
  }

  toggle() { this.isOpen ? this.close() : this.open() }

  /** Highlights the entry for the section currently on screen. */
  setCurrent(href?: string) {
    this.#currentHref = href
    for (const a of this.#list.querySelectorAll<HTMLElement>('a[data-href]')) {
      a.classList.toggle('current', a.dataset.href === href)
    }
  }

  #entry(item: TocEntry, depth: number): HTMLElement {
    const row = el('li')
    const link = el('a', { textContent: item.label?.trim() || '—' })
    link.href = 'javascript:void 0'
    link.style.setProperty('--depth', String(depth))
    if (item.href) {
      link.dataset.href = item.href
      link.classList.toggle('current', item.href === this.#currentHref)
      link.addEventListener('click', e => {
        e.preventDefault()
        this.#onNavigate(item.href!)
      })
    } else {
      link.classList.add('inert')
    }
    row.append(link)

    if (item.subitems?.length) {
      const sub = el('ul')
      sub.append(...item.subitems.map(child => this.#entry(child, depth + 1)))
      row.append(sub)
    }
    return row
  }

  #renderToc() {
    this.#searchToken++
    this.#reader?.clearSearch()
    const toc = this.#reader?.toc ?? []
    this.#note.textContent = toc.length ? '' : 'This book has no table of contents.'
    const list = el('ul')
    list.append(...toc.map(item => this.#entry(item, 0)))
    this.#list.replaceChildren(list)
  }

  async #run(query: string) {
    if (!query) return this.#renderToc()
    if (!this.#reader) return

    const token = ++this.#searchToken
    this.#list.replaceChildren()
    this.#note.textContent = 'Searching…'

    const list = el('ul', { className: 'results' })
    this.#list.replaceChildren(list)
    let count = 0

    for await (const result of this.#reader.search(query)) {
      if (token !== this.#searchToken) return
      if ('progress' in result) {
        this.#note.textContent = `Searching… ${Math.round(result.progress * 100)}%`
        continue
      }
      for (const hit of result.hits) {
        count++
        const row = el('li')
        const link = el('a')
        link.href = 'javascript:void 0'
        link.append(
          el('span', { className: 'hit-where', textContent: result.label || '' }),
          el('span', { className: 'hit-text' }),
        )
        const text = link.querySelector('.hit-text')!
        text.append(
          document.createTextNode(hit.excerpt.pre),
          el('mark', { textContent: hit.excerpt.match }),
          document.createTextNode(hit.excerpt.post),
        )
        link.addEventListener('click', e => {
          e.preventDefault()
          this.#onNavigate(hit.cfi)
        })
        row.append(link)
        list.append(row)
      }
    }

    if (token !== this.#searchToken) return
    this.#note.textContent = count
      ? `${count} ${count === 1 ? 'result' : 'results'}`
      : `Nothing found for “${query}”`
  }
}
