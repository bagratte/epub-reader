import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { createReadStream } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { openDb, type BookRow, type ProgressRow } from './db.ts'
import { addBook, InvalidBookError, removeBook, scanLibrary } from './library.ts'
import type { Book, Progress } from '../shared/types.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const LIBRARY_DIR = process.env.LIBRARY_DIR ?? join(root, 'library')
const CACHE_DIR = process.env.CACHE_DIR ?? join(root, '.cache')
const COVER_DIR = join(CACHE_DIR, 'covers')
const DB_FILE = process.env.DB_FILE ?? join(CACHE_DIR, 'library.db')
const PORT = Number(process.env.PORT ?? 8787)
// Loopback by default. In production set HOST to the VPN interface address —
// never 0.0.0.0. See CLAUDE.md → Deployment.
const HOST = process.env.HOST ?? '127.0.0.1'

const app = Fastify({ logger: true })
const db = openDb(DB_FILE)

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

/** Reverse of the extension map in library.ts. 'jpg' is not a media type. */
const COVER_MEDIA_TYPES: Record<string, string> = {
  jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif',
}
const coverMediaType = (file: string) =>
  COVER_MEDIA_TYPES[file.split('.').pop() ?? ''] ?? 'application/octet-stream'

type BookWithProgress = BookRow & {
  fraction: number | null
  furthest: number | null
  progress_updated_at: number | null
}

const toBook = (row: BookWithProgress): Book => ({
  id: row.id,
  filename: row.path,
  size: row.size,
  title: row.title ?? undefined,
  author: row.author ?? undefined,
  language: row.language ?? undefined,
  hasCover: row.cover_path != null,
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

const BOOK_SELECT = `
  SELECT b.*, p.fraction, p.furthest, p.updated_at AS progress_updated_at
  FROM books b LEFT JOIN progress p ON p.book_id = b.id
`

const bookById = (id: string) =>
  db.prepare(`${BOOK_SELECT} WHERE b.id = ?`).get(id) as unknown as BookWithProgress | undefined

app.get('/api/books', async () => {
  const rows = db.prepare(`
    ${BOOK_SELECT}
    ORDER BY COALESCE(NULLIF(b.author, ''), 'zzz'), COALESCE(NULLIF(b.title, ''), b.path)
  `).all() as unknown as BookWithProgress[]
  return rows.map(toBook)
})

app.get<{ Params: { id: string } }>('/api/books/:id', async (req, reply) => {
  const row = bookById(req.params.id)
  return row ? toBook(row) : reply.code(404).send({ error: 'not found' })
})

app.get<{ Params: { id: string } }>('/api/books/:id/file', async (req, reply) => {
  const row = bookById(req.params.id)
  if (!row) return reply.code(404).send({ error: 'not found' })

  return reply
    .type('application/epub+zip')
    // The id is the content hash, so it is a perfect strong ETag.
    .header('etag', `"${row.id}"`)
    .header('cache-control', 'private, max-age=0, must-revalidate')
    .send(createReadStream(join(LIBRARY_DIR, row.path)))
})

app.get<{ Params: { id: string } }>('/api/books/:id/cover', async (req, reply) => {
  const row = bookById(req.params.id)
  if (!row?.cover_path) return reply.code(404).send({ error: 'no cover' })

  return reply
    .type(coverMediaType(row.cover_path))
    .header('etag', `"${row.id}-cover"`)
    // Covers are keyed by content hash, so they can never go stale.
    .header('cache-control', 'private, max-age=31536000, immutable')
    .send(createReadStream(join(COVER_DIR, row.cover_path)))
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
      const { book, duplicate } = await addBook(
        db, LIBRARY_DIR, COVER_DIR, req.body, req.query.name ?? 'book.epub')
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
  const removed = await removeBook(db, LIBRARY_DIR, COVER_DIR, req.params.id)
  return removed ? reply.code(204).send() : reply.code(404).send({ error: 'not found' })
})

app.post('/api/library/scan', async () => scanLibrary(db, LIBRARY_DIR, COVER_DIR))

// In dev, Vite serves the client and proxies /api here. In production we serve
// the built SPA ourselves.
if (process.env.NODE_ENV === 'production') {
  await app.register(fastifyStatic, { root: join(root, 'dist/client') })
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith('/api/')
      ? reply.code(404).send({ error: 'not found' })
      : reply.sendFile('index.html'))
}

const scan = await scanLibrary(db, LIBRARY_DIR, COVER_DIR)
app.log.info({ ...scan, dir: LIBRARY_DIR }, 'library scanned')
for (const f of scan.failed) app.log.warn(f, 'could not read book')

await app.listen({ port: PORT, host: HOST })
