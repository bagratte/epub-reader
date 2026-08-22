import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))

// Optional, and read before anything below: a .env in the repo root, same
// shape as .env.example. Node's own parser, no dependency. Missing is normal —
// the defaults here are the development setup.
try { process.loadEnvFile(join(ROOT, '.env')) } catch { /* no .env */ }

/**
 * The database is the whole library: books, covers, positions, one file.
 *
 * The name says URL for consistency with the other apps here; the value is a
 * path, relative to the repo root unless absolute. A `sqlite:///path` or
 * `file:path` form is accepted too, so a URL copied from elsewhere does not
 * fail in some confusing way later.
 */
const toPath = (value: string) =>
  resolve(ROOT, value.replace(/^sqlite:\/\/\/?/, '').replace(/^file:\/{0,2}/, ''))

export const DB_FILE = toPath(process.env.DATABASE_URL ?? 'library.db')

/**
 * Where the pre-blob layout kept its EPUBs. Read exactly once, by the
 * migration that moves them into the database — nothing looks at this
 * directory afterwards, and it can be deleted once a server has started.
 */
export const LEGACY_LIBRARY_DIR = process.env.LIBRARY_DIR ?? join(ROOT, 'library')
