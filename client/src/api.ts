import type { Book } from '../../shared/types.ts'
import { getCached, putCached } from './store/books.ts'

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

/**
 * Adding and removing mirror putRemote's three-way answer rather than a plain
 * throw: "the server said no" and "there is no server" call for different
 * words on screen, and only the second means we have gone offline.
 */
export type UploadResult =
  | { status: 'added' | 'duplicate'; book: Book }
  | { status: 'rejected'; message: string }
  | { status: 'unreachable' }

/** The server's `{ error }` body, if it sent one. */
async function reason(res: Response): Promise<string> {
  try {
    const body = await res.json() as { error?: string; message?: string }
    return body.error ?? body.message ?? `HTTP ${res.status}`
  } catch {
    return `HTTP ${res.status}`
  }
}

/**
 * Sent as a raw body — the filename rides in the query string, since it is the
 * only other thing the server needs and multipart would buy nothing.
 * content-type is set explicitly because File.type is empty on some platforms.
 */
export async function uploadBook(file: File): Promise<UploadResult> {
  let res: Response
  try {
    res = await fetch(`/api/books?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/epub+zip' },
      body: file,
    })
  } catch {
    return { status: 'unreachable' }
  }

  if (!res.ok) return { status: 'rejected', message: await reason(res) }
  // 201 created it; 200 means these bytes were already here under some name.
  return { status: res.status === 201 ? 'added' : 'duplicate', book: await res.json() as Book }
}

export type DeleteResult =
  | { status: 'ok' }
  | { status: 'rejected'; message: string }
  | { status: 'unreachable' }

export async function deleteBook(id: string): Promise<DeleteResult> {
  let res: Response
  try {
    res = await fetch(`/api/books/${id}`, { method: 'DELETE' })
  } catch {
    return { status: 'unreachable' }
  }
  // 404 means it is already gone, which is what the caller wanted.
  if (res.ok || res.status === 404) return { status: 'ok' }
  return { status: 'rejected', message: await reason(res) }
}
