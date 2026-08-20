import type { Book } from '../../shared/types.ts'

export interface ScanResult {
  added: number
  updated: number
  removed: number
  failed: { path: string; error: string }[]
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${url}: ${res.status}`)
  return res.json() as Promise<T>
}

export const listBooks = () => json<Book[]>('/api/books')
export const getBook = (id: string) => json<Book>(`/api/books/${id}`)
export const rescan = () => json<ScanResult>('/api/library/scan', { method: 'POST' })

export const coverUrl = (id: string) => `/api/books/${id}/cover`

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
