import type { Book } from '../../shared/types.ts'
import { getCached, putCached } from './store/books.ts'

export interface ScanResult {
  added: number
  updated: number
  removed: number
  failed: { path: string; error: string }[]
}

/** Last good /api/books response, so the shelf renders without a server. */
const SHELF_KEY = 'reader.shelf'

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${url}: ${res.status}`)
  return res.json() as Promise<T>
}

export async function listBooks(): Promise<Book[]> {
  try {
    const books = await json<Book[]>('/api/books')
    try { localStorage.setItem(SHELF_KEY, JSON.stringify(books)) } catch { /* quota */ }
    return books
  } catch (err) {
    const cached = cachedShelf()
    if (cached) return cached
    throw err
  }
}

export function cachedShelf(): Book[] | null {
  try {
    const raw = localStorage.getItem(SHELF_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export async function getBook(id: string): Promise<Book> {
  try {
    return await json<Book>(`/api/books/${id}`)
  } catch (err) {
    const book = cachedShelf()?.find(b => b.id === id)
    if (book) return book
    throw err
  }
}

export const rescan = () => json<ScanResult>('/api/library/scan', { method: 'POST' })
export const coverUrl = (id: string) => `/api/books/${id}/cover`

/**
 * OPFS first, network second. The id is a content hash, so a cached file can
 * never be a stale version of the same id — there is nothing to revalidate.
 *
 * Returns a File rather than a Blob because foliate-js sniffs the format from
 * `.name` — a bare Blob throws in makeBook().
 */
export async function fetchBookFile(book: Book, opts: { cache?: boolean } = {}): Promise<File> {
  const cached = await getCached(book.id, book.filename)
  if (cached) return cached

  const res = await fetch(`/api/books/${book.id}/file`)
  if (!res.ok) throw new Error(`fetchBookFile: ${res.status}`)
  const blob = await res.blob()

  if (opts.cache) await putCached(book.id, blob)

  return new File([blob], book.filename, { type: 'application/epub+zip' })
}

/** Explicit "keep this for offline", separate from opening it. */
export async function downloadForOffline(book: Book): Promise<boolean> {
  const res = await fetch(`/api/books/${book.id}/file`)
  if (!res.ok) throw new Error(`download: ${res.status}`)
  return putCached(book.id, await res.blob())
}
