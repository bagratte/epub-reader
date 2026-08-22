import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { readEpubMeta } from './epub-meta.ts'
import { bookColumns, type BookRow } from './db.ts'

const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')

const bookById = (db: DatabaseSync, id: string) =>
  db.prepare(`SELECT ${bookColumns()} FROM books WHERE id = ?`)
    .get(id) as unknown as BookRow | undefined

/**
 * Thrown when the uploaded bytes are not a book we can read. Distinct from any
 * other failure so the route can answer 400 rather than 500 — a bad file is
 * the client's problem, a full disk is ours.
 */
export class InvalidBookError extends Error {}

/** Longest filename stem we keep. A title used as a filename can run much
 *  longer than anyone wants to see on a shelf. */
const MAX_STEM = 120

const trimEnds = (s: string) => s.replace(/^[.\s]+|[.\s]+$/g, '')

/**
 * The filename is a label now — a display name and what the browser saves the
 * file as — not a path, so traversal and collisions stopped being questions
 * when the bytes moved into the database. It is still untrusted text that ends
 * up in headers and in the UI, hence the control-character strip and the cap.
 */
export function safeName(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? ''
  const stem = trimEnds(trimEnds(
    base.replace(/\.epub$/i, '').replace(/[\x00-\x1f<>:"|?*]/g, '-'),
  ).slice(0, MAX_STEM))
  return `${stem || 'book'}.epub`
}

export interface AddResult {
  book: BookRow
  /** These exact bytes were already in the library; nothing was written. */
  duplicate: boolean
}

/**
 * Ingest one EPUB. The only way a book enters the library, whether it came
 * from the browser or from `npm run import`.
 */
export function addBook(
  db: DatabaseSync,
  bytes: Uint8Array,
  rawName: string,
): AddResult {
  // 'PK' — an EPUB is a zip. Cheap rejection before unzipping megabytes.
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new InvalidBookError('not a zip archive')
  }

  const id = sha256(bytes)
  // The id *is* the content hash, so an identical upload is a no-op — which is
  // what re-adding the same book from a second device ought to be.
  const existing = bookById(db, id)
  if (existing) return { book: existing, duplicate: true }

  let meta
  try {
    meta = readEpubMeta(bytes)
  } catch (err) {
    // Nothing has been written yet, so a bad file leaves no trace.
    throw new InvalidBookError((err as Error).message)
  }

  db.prepare(`
    INSERT INTO books
      (id, filename, size, data, title, author, language, identifier,
       cover, cover_type, added_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, safeName(rawName), bytes.length, bytes,
    meta.title ?? null, meta.author ?? null,
    meta.language ?? null, meta.identifier ?? null,
    meta.cover?.data ?? null, meta.cover?.mediaType ?? null,
    Date.now(),
  )

  return { book: bookById(db, id)!, duplicate: false }
}

/**
 * Remove a book and everything derived from it. The progress row follows via
 * ON DELETE CASCADE, and the cover goes with the row it lives in.
 */
export function removeBook(db: DatabaseSync, id: string): boolean {
  const { changes } = db.prepare('DELETE FROM books WHERE id = ?').run(id)
  if (changes === 0) return false
  // A book is megabytes of free page; hand them back rather than leaving the
  // file permanently sized for a library that no longer exists.
  db.exec('PRAGMA incremental_vacuum')
  return true
}
