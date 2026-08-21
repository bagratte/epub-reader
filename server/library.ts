import { createHash } from 'node:crypto'
import { readdir, readFile, stat, writeFile, mkdir, unlink } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { readEpubMeta } from './epub-meta.ts'
import type { BookRow } from './db.ts'

const EXT_BY_MEDIA_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
}

export interface ScanResult {
  added: number
  updated: number
  removed: number
  /** Files that are present but could not be read — kept, not hidden. */
  failed: { path: string; error: string }[]
}

const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')

/** Write an extracted cover into the cache dir; returns its filename. */
async function writeCover(
  coverDir: string,
  id: string,
  cover: { mediaType: string; data: Uint8Array },
): Promise<string> {
  const path = `${id}.${EXT_BY_MEDIA_TYPE[cover.mediaType] ?? 'bin'}`
  await writeFile(join(coverDir, path), cover.data)
  return path
}

/**
 * Reconcile the database against the library directory.
 *
 * Skips any file whose (size, mtime) is unchanged, so a warm scan does no
 * hashing or unzipping. A file whose content changed gets a new id, because
 * the id *is* the content hash — its progress row goes with the old id.
 */
export async function scanLibrary(
  db: DatabaseSync,
  libraryDir: string,
  coverDir: string,
): Promise<ScanResult> {
  await mkdir(coverDir, { recursive: true })

  const result: ScanResult = { added: 0, updated: 0, removed: 0, failed: [] }

  const existing = new Map(
    (db.prepare('SELECT * FROM books').all() as unknown as BookRow[])
      .map(row => [row.path, row]),
  )

  let filenames: string[]
  try {
    filenames = await readdir(libraryDir)
  } catch {
    return result
  }

  const seen = new Set<string>()

  for (const filename of filenames) {
    if (extname(filename).toLowerCase() !== '.epub') continue

    const info = await stat(join(libraryDir, filename)).catch(() => null)
    if (!info?.isFile()) continue

    seen.add(filename)
    const prior = existing.get(filename)
    const mtime = Math.floor(info.mtimeMs)
    if (prior && prior.size === info.size && prior.mtime === mtime) continue

    try {
      const bytes = await readFile(join(libraryDir, filename))
      const id = sha256(bytes)
      const meta = readEpubMeta(bytes)

      const coverPath = meta.cover ? await writeCover(coverDir, id, meta.cover) : null

      // The path is the natural key for a scan; the content hash is the id.
      // Replacing a file in place therefore changes the id, so clear any row
      // holding this path first.
      db.prepare('DELETE FROM books WHERE path = ?').run(filename)
      db.prepare(`
        INSERT INTO books
          (id, path, size, mtime, title, author, language, identifier, cover_path, added_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          path = excluded.path, size = excluded.size, mtime = excluded.mtime
      `).run(
        id, filename, info.size, mtime,
        meta.title ?? null, meta.author ?? null,
        meta.language ?? null, meta.identifier ?? null,
        coverPath, prior?.added_at ?? Date.now(),
      )

      if (prior) result.updated++
      else result.added++
    } catch (err) {
      // One malformed EPUB must not abort the scan — there are always some.
      result.failed.push({ path: filename, error: (err as Error).message })
    }
  }

  for (const [path, row] of existing) {
    if (seen.has(path)) continue
    db.prepare('DELETE FROM books WHERE path = ?').run(path)
    if (row.cover_path) await unlink(join(coverDir, row.cover_path)).catch(() => {})
    result.removed++
  }

  return result
}

// --- single-book add and remove ---------------------------------------------

/**
 * Thrown when the uploaded bytes are not a book we can read. Distinct from any
 * other failure so the route can answer 400 rather than 500 — a bad file is
 * the client's problem, a full disk is ours.
 */
export class InvalidBookError extends Error {}

/** Longest filename stem we keep. Filesystems cap around 255 bytes, and a
 *  title used as a filename can run much longer than anyone wants to see. */
const MAX_STEM = 120

const trimEnds = (s: string) => s.replace(/^[.\s]+|[.\s]+$/g, '')

/**
 * An uploaded filename is untrusted input that becomes a path. Reduce it to a
 * bare basename: no directories, no traversal, no leading dot, and always the
 * .epub extension that scanLibrary filters on.
 */
export function safeName(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? ''
  const stem = trimEnds(trimEnds(
    base.replace(/\.epub$/i, '').replace(/[\x00-\x1f<>:"|?*]/g, '-'),
  ).slice(0, MAX_STEM))
  return `${stem || 'book'}.epub`
}

/** `name.epub`, else `name-2.epub`, and so on. */
async function freeName(
  db: DatabaseSync,
  libraryDir: string,
  name: string,
): Promise<string> {
  const stem = name.slice(0, -'.epub'.length)

  for (let n = 1; n <= 999; n++) {
    const candidate = n === 1 ? name : `${stem}-${n}.epub`
    const claimed = db.prepare('SELECT 1 FROM books WHERE path = ?').get(candidate) != null
    // Check the disk too: a file the scan has not seen yet is still a file we
    // must not overwrite.
    const onDisk = await stat(join(libraryDir, candidate)).then(() => true, () => false)
    if (!claimed && !onDisk) return candidate
  }
  throw new InvalidBookError('too many books with that name')
}

export interface AddResult {
  book: BookRow
  /** These exact bytes were already in the library; nothing was written. */
  duplicate: boolean
}

/**
 * Ingest one uploaded EPUB, sharing the scan's metadata path so that a book
 * added through the browser is indistinguishable from one dropped into the
 * directory by hand.
 */
export async function addBook(
  db: DatabaseSync,
  libraryDir: string,
  coverDir: string,
  bytes: Uint8Array,
  rawName: string,
): Promise<AddResult> {
  // 'PK' — an EPUB is a zip. Cheap rejection before unzipping megabytes.
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new InvalidBookError('not a zip archive')
  }

  const id = sha256(bytes)
  // The id *is* the content hash, so an identical upload is a no-op — which is
  // what re-adding the same book from a second device ought to be.
  const existing = db.prepare('SELECT * FROM books WHERE id = ?')
    .get(id) as unknown as BookRow | undefined
  if (existing) return { book: existing, duplicate: true }

  let meta
  try {
    meta = readEpubMeta(bytes)
  } catch (err) {
    // Nothing has been written yet, so a bad file leaves no trace.
    throw new InvalidBookError((err as Error).message)
  }

  await mkdir(libraryDir, { recursive: true })
  await mkdir(coverDir, { recursive: true })

  const path = await freeName(db, libraryDir, safeName(rawName))
  await writeFile(join(libraryDir, path), bytes)
  const info = await stat(join(libraryDir, path))
  const coverPath = meta.cover ? await writeCover(coverDir, id, meta.cover) : null

  db.prepare(`
    INSERT INTO books
      (id, path, size, mtime, title, author, language, identifier, cover_path, added_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, path, info.size, Math.floor(info.mtimeMs),
    meta.title ?? null, meta.author ?? null,
    meta.language ?? null, meta.identifier ?? null,
    coverPath, Date.now(),
  )

  return {
    book: db.prepare('SELECT * FROM books WHERE id = ?').get(id) as unknown as BookRow,
    duplicate: false,
  }
}

/**
 * Remove a book and everything derived from it. The progress row follows via
 * ON DELETE CASCADE.
 */
export async function removeBook(
  db: DatabaseSync,
  libraryDir: string,
  coverDir: string,
  id: string,
): Promise<boolean> {
  const row = db.prepare('SELECT * FROM books WHERE id = ?')
    .get(id) as unknown as BookRow | undefined
  if (!row) return false

  // The file goes first. If it cannot be removed, the next scan would simply
  // re-add it — so failing loudly beats a book that vanishes and comes back
  // with its reading position cascaded away.
  try {
    await unlink(join(libraryDir, row.path))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  db.prepare('DELETE FROM books WHERE id = ?').run(id)
  if (row.cover_path) await unlink(join(coverDir, row.cover_path)).catch(() => {})
  return true
}
