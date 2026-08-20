import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Schema migrations, applied in order. `user_version` records how many have
 * run, so adding a migration is append-only — never edit one that has shipped.
 */
const MIGRATIONS: string[] = [
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
]

export function openDb(file: string): DatabaseSync {
  mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')

  const [{ user_version: version }] = db
    .prepare('PRAGMA user_version').all() as { user_version: number }[]

  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[i]!)
      // PRAGMA won't take a bound parameter, and i is a loop index, not input.
      db.exec(`PRAGMA user_version = ${i + 1}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
  return db
}

export interface BookRow {
  id: string
  path: string
  size: number
  mtime: number
  title: string | null
  author: string | null
  language: string | null
  identifier: string | null
  cover_path: string | null
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
