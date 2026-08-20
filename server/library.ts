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

      let coverPath: string | null = null
      if (meta.cover) {
        const ext = EXT_BY_MEDIA_TYPE[meta.cover.mediaType] ?? 'bin'
        coverPath = `${id}.${ext}`
        await writeFile(join(coverDir, coverPath), meta.cover.data)
      }

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
