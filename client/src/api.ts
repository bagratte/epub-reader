import type { Book } from '../../shared/types.ts'

export async function listBooks(): Promise<Book[]> {
  const res = await fetch('/api/books')
  if (!res.ok) throw new Error(`listBooks: ${res.status}`)
  return res.json()
}

/**
 * Fetch the whole EPUB. On a LAN a few MB is nothing, and it keeps the offline
 * upgrade to a single change here: check OPFS first, else fetch.
 *
 * Returns a File rather than a Blob because foliate-js sniffs the format from
 * `.name` — a bare Blob throws in makeBook().
 */
export async function fetchBookFile(book: Book): Promise<File> {
  const res = await fetch(`/api/books/${book.id}/file`)
  if (!res.ok) throw new Error(`fetchBookFile: ${res.status}`)
  return new File([await res.blob()], book.filename, {
    type: 'application/epub+zip',
  })
}
