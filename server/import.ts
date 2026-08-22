/**
 * Bulk ingest from the shell: `npm run import -- <file-or-directory>...`
 *
 * The replacement for the old library-directory scan. It shares addBook with
 * the upload route, so a book imported here is indistinguishable from one
 * added in the browser — and because the id is the content hash, running it
 * twice over the same files adds nothing.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join, basename } from 'node:path'
import { DB_FILE, LEGACY_LIBRARY_DIR } from './config.ts'
import { openDb } from './db.ts'
import { addBook, InvalidBookError } from './library.ts'

const targets = process.argv.slice(2)
if (targets.length === 0) {
  console.error('usage: npm run import -- <file-or-directory>...')
  process.exit(2)
}

/** One path in, every .epub under it out. Not recursive: a library is a flat
 *  pile of files, and descending into arbitrary trees invites surprises. */
async function epubsAt(target: string): Promise<string[]> {
  const info = await stat(target)
  if (!info.isDirectory()) return [target]

  const names = await readdir(target)
  return names
    .filter(name => extname(name).toLowerCase() === '.epub')
    .sort()
    .map(name => join(target, name))
}

const db = openDb(DB_FILE, LEGACY_LIBRARY_DIR)
let added = 0, duplicate = 0, failed = 0

for (const target of targets) {
  let files: string[]
  try {
    files = await epubsAt(target)
  } catch (err) {
    console.error(`${target}: ${(err as Error).message}`)
    failed++
    continue
  }

  for (const file of files) {
    try {
      const result = addBook(db, await readFile(file), basename(file))
      if (result.duplicate) duplicate++
      else added++
      console.log(`${result.duplicate ? 'have' : 'add '}  ${basename(file)}`)
    } catch (err) {
      // One malformed EPUB must not abort the run — there are always some.
      failed++
      const why = err instanceof InvalidBookError ? err.message : String(err)
      console.error(`fail  ${basename(file)}: ${why}`)
    }
  }
}

console.log(`\n${added} added, ${duplicate} already present, ${failed} failed`)
db.close()
