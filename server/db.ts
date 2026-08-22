import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readEpubMeta } from './epub-meta.ts'

/** Everything about a book except the bytes. Never `SELECT *` — that pulls the
 *  whole EPUB and its cover into memory for a shelf listing. */
const BOOK_FIELDS = [
  'id', 'filename', 'size', 'title', 'author', 'language', 'identifier',
  'cover_type', 'added_at',
]

export const bookColumns = (prefix = '') =>
  BOOK_FIELDS.map(field => prefix + field).join(', ')

type Migration = string | ((db: DatabaseSync, legacyLibraryDir?: string) => void)

/**
 * Schema migrations, applied in order. `user_version` records how many have
 * run, so adding a migration is append-only — never edit one that has shipped.
 */
const MIGRATIONS: Migration[] = [
  `
  CREATE TABLE books (
    id          TEXT PRIMARY KEY,      -- sha256 of file content
    path        TEXT NOT NULL UNIQUE,  -- relative to the library root
    size        INTEGER NOT NULL,
    mtime       INTEGER NOT NULL,      -- with size, lets scan skip re-hashing
    title       TEXT,
    author      TEXT,
    language    TEXT,
    identifier  TEXT,                  -- dc:identifier, informational only
    cover_path  TEXT,
    added_at    INTEGER NOT NULL
  );

  CREATE TABLE progress (
    book_id     TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
    cfi         TEXT NOT NULL,
    fraction    REAL NOT NULL,
    furthest    REAL NOT NULL,
    updated_at  INTEGER NOT NULL,      -- server-assigned; device clocks lie
    device      TEXT
  );
  `,

  /**
   * Books and covers move into the database; the library directory and the
   * cover cache go away. A rebuild rather than ALTER: `path` carried a UNIQUE
   * constraint that only made sense while it was a filesystem path, and an
   * implicit index cannot be dropped in place.
   *
   * `legacyLibraryDir` is where the old layout kept its files. A row whose
   * file is gone is dropped — a book row with no bytes is one that can never
   * be opened, and pretending otherwise just moves the failure later.
   */
  (db, legacyLibraryDir) => {
    db.exec(`
      CREATE TABLE books_v2 (
        id          TEXT PRIMARY KEY,   -- sha256 of the bytes in data
        filename    TEXT NOT NULL,      -- display and download name only
        size        INTEGER NOT NULL,   -- = length(data), kept for the shelf
        data        BLOB NOT NULL,
        title       TEXT,
        author      TEXT,
        language    TEXT,
        identifier  TEXT,               -- dc:identifier, informational only
        cover       BLOB,
        cover_type  TEXT,               -- media type of cover, e.g. image/jpeg
        added_at    INTEGER NOT NULL
      );
    `)

    const insert = db.prepare(`
      INSERT INTO books_v2
        (id, filename, size, data, title, author, language, identifier,
         cover, cover_type, added_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const legacy = db.prepare('SELECT * FROM books').all() as unknown as {
      id: string; path: string; title: string | null; author: string | null
      language: string | null; identifier: string | null; added_at: number
    }[]

    for (const row of legacy) {
      let bytes: Buffer | null = null
      try {
        if (legacyLibraryDir) bytes = readFileSync(join(legacyLibraryDir, row.path))
      } catch { /* handled below */ }

      if (!bytes) {
        console.warn(`migration: dropping "${row.path}" — file not found in the old library dir`)
        continue
      }

      // Re-extract rather than copy the cached cover file: the bytes are here
      // anyway, and it leaves nothing behind in .cache to clean up.
      let cover: { mediaType: string; data: Uint8Array } | undefined
      try { cover = readEpubMeta(bytes).cover } catch { /* keep the book, lose the cover */ }

      insert.run(
        row.id, row.path, bytes.length, bytes,
        row.title, row.author, row.language, row.identifier,
        cover?.data ?? null, cover?.mediaType ?? null, row.added_at,
      )
    }

    db.exec('DROP TABLE books')
    db.exec('ALTER TABLE books_v2 RENAME TO books')
    // Foreign keys are off during migration (see openDb), so a dropped book
    // leaves its progress row behind rather than cascading.
    db.exec('DELETE FROM progress WHERE book_id NOT IN (SELECT id FROM books)')
  },
]

export function openDb(file: string, legacyLibraryDir?: string): DatabaseSync {
  mkdirSync(dirname(file), { recursive: true })
  // Foreign keys stay OFF while migrating: rebuilding a table drops the old
  // one, and an enforced ON DELETE CASCADE takes every progress row with it.
  // It has to be the constructor option — node:sqlite turns foreign keys on by
  // default, and the PRAGMA is a no-op inside the migrations' transaction.
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: false })

  // Deliberately NOT WAL: the library is meant to be one file you can copy,
  // and WAL leaves a -wal and a -shm alongside it that only disappear on a
  // clean close — which a killed dev server never gets. The rollback journal
  // writes a -journal only for the duration of a transaction and removes it on
  // commit. journal_mode is stored in the database, so this also converts a
  // file that was created in WAL mode.
  //
  // What it costs: a writer takes an exclusive lock, so a second process — the
  // import CLI, or a sqlite3 session — can collide with the server. The
  // timeout makes those wait instead of failing. Inside the server there is no
  // contention to have: node:sqlite is synchronous and there is one connection.
  db.exec('PRAGMA journal_mode = DELETE')
  db.exec('PRAGMA busy_timeout = 5000')

  const [{ user_version: version }] = db
    .prepare('PRAGMA user_version').all() as { user_version: number }[]

  for (let i = version; i < MIGRATIONS.length; i++) {
    const migration = MIGRATIONS[i]!
    db.exec('BEGIN')
    try {
      if (typeof migration === 'string') db.exec(migration)
      else migration(db, legacyLibraryDir)
      // PRAGMA won't take a bound parameter, and i is a loop index, not input.
      db.exec(`PRAGMA user_version = ${i + 1}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  // Books are the bulk of the file now, so deleting one has to give the space
  // back. Incremental rather than FULL: FULL moves pages on every commit, and
  // the pages here are megabytes of EPUB. Switching modes needs a VACUUM, so
  // this runs once, outside any transaction, and is a no-op afterwards.
  const [{ auto_vacuum: autoVacuum }] = db
    .prepare('PRAGMA auto_vacuum').all() as { auto_vacuum: number }[]
  if (autoVacuum !== 2) {
    db.exec('PRAGMA auto_vacuum = INCREMENTAL')
    db.exec('VACUUM')
  }

  db.exec('PRAGMA foreign_keys = ON')
  return db
}

/** A book row without its blobs — what every query but the file and cover
 *  routes should ask for. See BOOK_COLUMNS. */
export interface BookRow {
  id: string
  filename: string
  size: number
  title: string | null
  author: string | null
  language: string | null
  identifier: string | null
  cover_type: string | null
  added_at: number
}

export interface ProgressRow {
  book_id: string
  cfi: string
  fraction: number
  furthest: number
  updated_at: number
  device: string | null
}
