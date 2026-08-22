import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { join } from 'node:path'
import { DB_FILE, LEGACY_LIBRARY_DIR, ROOT } from './config.ts'
import { bookColumns, openDb, type BookRow, type ProgressRow } from './db.ts'
import { addBook, InvalidBookError, removeBook } from './library.ts'
import type { Book, Progress } from '../shared/types.ts'
const PORT = Number(process.env.PORT ?? 8787)
// Loopback by default. In production set HOST to the VPN interface address —
// never 0.0.0.0. See CLAUDE.md → Deployment.
const HOST = process.env.HOST ?? '127.0.0.1'

const app = Fastify({ logger: true })
const db = openDb(DB_FILE, LEGACY_LIBRARY_DIR)

/**
 * Uploads arrive as a raw body rather than multipart: there is no second form
 * field to justify the dependency, and the whole file has to be in memory
 * anyway because both the content hash and the OPF parse need all of it.
 *
 * The cap is generous — an image-heavy book can run to tens of megabytes —
 * but finite, so a stray POST cannot exhaust the server.
 */
const MAX_UPLOAD = 256 * 1024 * 1024

app.addContentTypeParser(
  'application/epub+zip',
  { parseAs: 'buffer', bodyLimit: MAX_UPLOAD },
  (_req, body, done) => { done(null, body) },
)

/**
 * foliate-js renders book content in an iframe with both allow-scripts and
 * allow-same-origin, which defeats sandbox isolation — it needs same-origin to
 * walk the document for CFIs. So this CSP is the actual boundary against
 * hostile EPUB content, not defence-in-depth.
 *
 * blob: is required: foliate-js loads each section as a blob: URL.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' blob:",
  // blob: is needed for the book's own stylesheets, which foliate loads as
  // blob: URLs. Without it EPUB CSS is silently dropped and books render
  // unstyled. Safe here: CSS can't execute, and img-src stays same-origin.
  "style-src 'self' 'unsafe-inline' blob:",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "frame-src 'self' blob:",
  "connect-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

app.addHook('onSend', async (_req, reply) => {
  reply.header('content-security-policy', CSP)
  reply.header('x-content-type-options', 'nosniff')
  reply.header('referrer-policy', 'no-referrer')
})

/** node:sqlite hands back a Uint8Array; Fastify sends a Buffer as bytes and
 *  anything else as JSON. Wrap the same memory rather than copying it. */
const asBuffer = (bytes: Uint8Array) =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)

type BookWithProgress = BookRow & {
  fraction: number | null
  furthest: number | null
  progress_updated_at: number | null
}

const toBook = (row: BookWithProgress): Book => ({
  id: row.id,
  filename: row.filename,
  size: row.size,
  title: row.title ?? undefined,
  author: row.author ?? undefined,
  language: row.language ?? undefined,
  hasCover: row.cover_type != null,
  progress: row.progress_updated_at == null ? undefined : {
    fraction: row.fraction!,
    furthest: row.furthest!,
    updatedAt: row.progress_updated_at,
  },
})

const toProgress = (row: ProgressRow): Progress => ({
  bookId: row.book_id,
  cfi: row.cfi,
  fraction: row.fraction,
  furthest: row.furthest,
  updatedAt: row.updated_at,
  device: row.device ?? undefined,
})

// Explicitly not `b.*`: that would read every book's bytes to draw a shelf.
const BOOK_SELECT = `
  SELECT ${bookColumns('b.')},
         p.fraction, p.furthest, p.updated_at AS progress_updated_at
  FROM books b LEFT JOIN progress p ON p.book_id = b.id
`

const bookById = (id: string) =>
  db.prepare(`${BOOK_SELECT} WHERE b.id = ?`).get(id) as unknown as BookWithProgress | undefined

app.get('/api/books', async () => {
  const rows = db.prepare(`
    ${BOOK_SELECT}
    ORDER BY COALESCE(NULLIF(b.author, ''), 'zzz'), COALESCE(NULLIF(b.title, ''), b.filename)
  `).all() as unknown as BookWithProgress[]
  return rows.map(toBook)
})

app.get<{ Params: { id: string } }>('/api/books/:id', async (req, reply) => {
  const row = bookById(req.params.id)
  return row ? toBook(row) : reply.code(404).send({ error: 'not found' })
})

/**
 * node:sqlite has no incremental blob I/O, so the whole book is read at once
 * and the read blocks the event loop — measured at ~3 ms for 9.5 MB, and a
 * client fetches a given book once because the id is a content hash and the
 * copy lands in OPFS.
 */
app.get<{ Params: { id: string } }>('/api/books/:id/file', async (req, reply) => {
  const row = db.prepare('SELECT data FROM books WHERE id = ?')
    .get(req.params.id) as unknown as { data: Uint8Array } | undefined
  if (!row) return reply.code(404).send({ error: 'not found' })

  return reply
    .type('application/epub+zip')
    // The id is the content hash, so it is a perfect strong ETag.
    .header('etag', `"${req.params.id}"`)
    .header('cache-control', 'private, max-age=0, must-revalidate')
    .send(asBuffer(row.data))
})

app.get<{ Params: { id: string } }>('/api/books/:id/cover', async (req, reply) => {
  const row = db.prepare('SELECT cover, cover_type FROM books WHERE id = ?')
    .get(req.params.id) as unknown as
      { cover: Uint8Array | null; cover_type: string | null } | undefined
  if (!row?.cover) return reply.code(404).send({ error: 'no cover' })

  return reply
    // Stored when the cover was extracted, so there is no extension to map
    // back to a media type — which is where 'image/jpg' used to come from.
    .type(row.cover_type ?? 'application/octet-stream')
    .header('etag', `"${req.params.id}-cover"`)
    // Covers are keyed by content hash, so they can never go stale.
    .header('cache-control', 'private, max-age=31536000, immutable')
    .send(asBuffer(row.cover))
})

app.get<{ Params: { id: string } }>('/api/progress/:id', async (req, reply) => {
  const row = db.prepare('SELECT * FROM progress WHERE book_id = ?')
    .get(req.params.id) as unknown as ProgressRow | undefined
  // 204 rather than 404: "never opened" is a normal answer, and a 404 paints a
  // red error in devtools every time an unread book is opened.
  return row ? toProgress(row) : reply.code(204).send()
})

app.put<{ Params: { id: string }; Body: { cfi: string; fraction: number; device?: string } }>(
  '/api/progress/:id',
  {
    schema: {
      body: {
        type: 'object',
        required: ['cfi', 'fraction'],
        additionalProperties: false,
        properties: {
          cfi: { type: 'string', minLength: 1, maxLength: 4096 },
          fraction: { type: 'number', minimum: 0, maximum: 1 },
          device: { type: 'string', maxLength: 128 },
        },
      },
    },
  },
  async (req, reply) => {
    if (!bookById(req.params.id)) return reply.code(404).send({ error: 'no such book' })

    const { cfi, fraction, device } = req.body
    // updated_at is assigned here, never taken from the client — device clocks
    // drift and this timestamp is what ordering depends on.
    const updatedAt = Date.now()

    db.prepare(`
      INSERT INTO progress (book_id, cfi, fraction, furthest, updated_at, device)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(book_id) DO UPDATE SET
        cfi = excluded.cfi,
        fraction = excluded.fraction,
        -- high-water mark only ever climbs
        furthest = MAX(progress.furthest, excluded.fraction),
        updated_at = excluded.updated_at,
        device = excluded.device
    `).run(req.params.id, cfi, fraction, fraction, updatedAt, device ?? null)

    const row = db.prepare('SELECT * FROM progress WHERE book_id = ?')
      .get(req.params.id) as unknown as ProgressRow
    return toProgress(row)
  },
)

app.post<{ Querystring: { name?: string }; Body: Buffer }>(
  '/api/books',
  { bodyLimit: MAX_UPLOAD },
  async (req, reply) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return reply.code(400).send({ error: 'empty upload' })
    }

    try {
      const { book, duplicate } = addBook(db, req.body, req.query.name ?? 'book.epub')
      // 200 for a duplicate, 201 for a new file: the client says "already in
      // your library" rather than claiming to have added it twice.
      return reply.code(duplicate ? 200 : 201).send(toBook(bookById(book.id)!))
    } catch (err) {
      if (!(err instanceof InvalidBookError)) throw err
      req.log.warn({ err: err.message, name: req.query.name }, 'upload rejected')
      return reply.code(400).send({ error: `Not a readable EPUB: ${err.message}` })
    }
  },
)

app.delete<{ Params: { id: string } }>('/api/books/:id', async (req, reply) => {
  const removed = removeBook(db, req.params.id)
  return removed ? reply.code(204).send() : reply.code(404).send({ error: 'not found' })
})

// In dev, Vite serves the client and proxies /api here. In production we serve
// the built SPA ourselves.
if (process.env.NODE_ENV === 'production') {
  await app.register(fastifyStatic, { root: join(ROOT, 'dist/client') })
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith('/api/')
      ? reply.code(404).send({ error: 'not found' })
      : reply.sendFile('index.html'))
}

const [stats] = db.prepare(
  'SELECT COUNT(*) AS books, COALESCE(SUM(size), 0) AS bytes FROM books',
).all() as { books: number; bytes: number }[]
app.log.info({ ...stats, db: DB_FILE }, 'library opened')

await app.listen({ port: PORT, host: HOST })
