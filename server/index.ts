import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { createReadStream } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { scanLibrary, type LibraryEntry } from './library.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const LIBRARY_DIR = process.env.LIBRARY_DIR ?? join(root, 'library')
const PORT = Number(process.env.PORT ?? 8787)
// Bind to loopback by default; in production set HOST to the VPN interface,
// never 0.0.0.0. See PLAN.md → Security.
const HOST = process.env.HOST ?? '127.0.0.1'

const app = Fastify({ logger: true })

let books: Map<string, LibraryEntry> = new Map()

app.get('/api/books', async () =>
  [...books.values()].map(({ path: _path, ...book }) => book))

app.get<{ Params: { id: string } }>('/api/books/:id/file', async (req, reply) => {
  const entry = books.get(req.params.id)
  if (!entry) return reply.code(404).send({ error: 'not found' })

  return reply
    .type('application/epub+zip')
    // The id *is* the content hash, so it is a perfect strong ETag.
    .header('etag', `"${entry.id}"`)
    .header('cache-control', 'private, max-age=0, must-revalidate')
    .send(createReadStream(entry.path))
})

app.post('/api/library/scan', async () => {
  books = await scanLibrary(LIBRARY_DIR)
  return { count: books.size }
})

// In dev, Vite serves the client and proxies /api here. In production we serve
// the built SPA ourselves.
const clientDir = join(root, 'dist/client')
if (process.env.NODE_ENV === 'production') {
  await app.register(fastifyStatic, { root: clientDir })
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith('/api/')
      ? reply.code(404).send({ error: 'not found' })
      : reply.sendFile('index.html'))
}

books = await scanLibrary(LIBRARY_DIR)
app.log.info({ count: books.size, dir: LIBRARY_DIR }, 'library scanned')
await app.listen({ port: PORT, host: HOST })
