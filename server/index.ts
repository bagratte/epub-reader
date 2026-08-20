import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { createReadStream } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { openDb, type BookRow } from './db.ts'
import { scanLibrary } from './library.ts'
import type { Book } from '../shared/types.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const LIBRARY_DIR = process.env.LIBRARY_DIR ?? join(root, 'library')
const CACHE_DIR = process.env.CACHE_DIR ?? join(root, '.cache')
const COVER_DIR = join(CACHE_DIR, 'covers')
const DB_FILE = process.env.DB_FILE ?? join(CACHE_DIR, 'library.db')
const PORT = Number(process.env.PORT ?? 8787)
// Loopback by default. In production set HOST to the VPN interface address —
// never 0.0.0.0. See PLAN.md → Security.
const HOST = process.env.HOST ?? '127.0.0.1'

const app = Fastify({ logger: true })
const db = openDb(DB_FILE)

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

const toBook = (row: BookRow): Book => ({
  id: row.id,
  filename: row.path,
  size: row.size,
  title: row.title ?? undefined,
  author: row.author ?? undefined,
  language: row.language ?? undefined,
  hasCover: row.cover_path != null,
})

const bookById = (id: string) =>
  db.prepare('SELECT * FROM books WHERE id = ?').get(id) as unknown as BookRow | undefined

app.get('/api/books', async () => {
  const rows = db.prepare(`
    SELECT * FROM books
    ORDER BY COALESCE(NULLIF(author, ''), 'zzz'), COALESCE(NULLIF(title, ''), path)
  `).all() as unknown as BookRow[]
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
