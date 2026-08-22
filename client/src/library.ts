import type { Book } from '../../shared/types.ts'
import { coverUrl } from './api.ts'

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K, props: Partial<HTMLElementTagNameMap[K]> = {},
) => Object.assign(document.createElement(tag), props)

export interface ShelfOptions {
  /** The backend is not answering: the shelf is from the last good response,
   *  and nothing on it can be opened, since the bytes live behind it. */
  offline: boolean
  /** Remove the book from the library. Resolves true if it actually went. */
  onDelete: (book: Book) => Promise<boolean>
}

function cover(book: Book): HTMLElement {
  if (book.hasCover) {
    return el('img', {
      className: 'art',
      src: coverUrl(book.id),
      alt: '',
      loading: 'lazy',
      decoding: 'async',
    })
  }
  // No cover in the EPUB — set the title in type instead of showing a gap.
  const blank = el('div', { className: 'art blank' })
  blank.append(
    el('b', { textContent: book.title ?? book.filename }),
    el('span', { textContent: book.author ?? '' }),
  )
  return blank
}

/** A thin rule under the cover; absent entirely for an unopened book. */
function progressBar(book: Book): HTMLElement | null {
  if (!book.progress) return null
  const pct = Math.round(book.progress.fraction * 100)
  const bar = el('div', { className: 'progress' })
  bar.style.setProperty('--pct', `${pct}%`)
  bar.title = `${pct}% read`
  return bar
}

/**
 * Deleting is not undoable and the control sits on a card the user was very
 * likely aiming to open, so it asks first.
 */
function deleteButton(book: Book, options: ShelfOptions): HTMLElement {
  const name = book.title ?? book.filename
  const button = el('button', {
    className: 'delete-btn',
    type: 'button',
    textContent: '\u00d7',
    title: 'Remove from library',
  })
  button.setAttribute('aria-label', `Remove ${name} from the library`)

  button.addEventListener('click', async e => {
    e.preventDefault()
    e.stopPropagation()
    if (!confirm(`Remove \u201c${name}\u201d from the library?\n\n`
      + 'The file and your reading position are deleted from the server.')) return

    button.disabled = true
    button.textContent = '\u2026'
    // On success the shelf is repainted from scratch, so only failure needs
    // the button put back.
    if (!await options.onDelete(book)) {
      button.disabled = false
      button.textContent = '\u00d7'
    }
  })
  return button
}

export function renderShelf(shelf: HTMLElement, books: Book[], options: ShelfOptions) {
  shelf.replaceChildren(...books.map(book => {

    const link = el('a', { href: `#/book/${book.id}` })
    const art = el('div', { className: 'artwrap' })
    art.append(cover(book))
    const bar = progressBar(book)
    if (bar) art.append(bar)

    link.append(art, el('div', { className: 'title', textContent: book.title ?? book.filename }))
    if (book.author) link.append(el('div', { className: 'author', textContent: book.author }))

    const item = el('li', { className: 'book' })
    item.classList.toggle('unreachable', options.offline)
    item.append(link, deleteButton(book, options))
    return item
  }))
}
