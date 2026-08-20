import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { Book } from '../shared/types.ts'

export interface LibraryEntry extends Book {
  path: string
}

/**
 * M1: scan the library directory and identify books by content hash.
 * M2 replaces this with a SQLite-backed scan that caches by (path, size, mtime)
 * and parses the OPF for title/author/cover.
 */
export async function scanLibrary(dir: string): Promise<Map<string, LibraryEntry>> {
  const entries = new Map<string, LibraryEntry>()
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return entries
  }

  for (const filename of names) {
    if (extname(filename).toLowerCase() !== '.epub') continue
    const path = join(dir, filename)
    const info = await stat(path)
    if (!info.isFile()) continue

    const id = createHash('sha256').update(await readFile(path)).digest('hex')
    entries.set(id, { id, filename, size: info.size, path })
  }
  return entries
}
