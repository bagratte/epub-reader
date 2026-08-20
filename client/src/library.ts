import type { Book } from '../../shared/types.ts'
import { coverUrl } from './api.ts'

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K, props: Partial<HTMLElementTagNameMap[K]> = {},
) => Object.assign(document.createElement(tag), props)

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

export function renderShelf(shelf: HTMLElement, books: Book[]) {
  shelf.replaceChildren(...books.map(book => {
    const link = el('a', { href: `#/book/${book.id}` })
    link.append(
      cover(book),
      el('div', { className: 'title', textContent: book.title ?? book.filename }),
    )
    if (book.author) link.append(el('div', { className: 'author', textContent: book.author }))

    const item = el('li', { className: 'book' })
    item.append(link)
    return item
  }))
}
