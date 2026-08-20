/* eslint-env serviceworker */
/**
 * Hand-rolled rather than Workbox: the whole policy is three rules, and the
 * only hard part — knowing the hashed asset names — is solved by the build
 * plugin in vite.config.ts, which replaces __PRECACHE__ and __VERSION__.
 */

const PRECACHE = self.__PRECACHE__
const VERSION = self.__VERSION__
const SHELL = `shell-${VERSION}`
const COVERS = 'covers-v1'

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL)
      .then(cache => cache.addAll(PRECACHE))
      // A new build should take over without the user hunting for a reload.
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== SHELL && key !== COVERS) await caches.delete(key)
    }
    await self.clients.claim()
  })())
})

const isCover = url => /^\/api\/books\/[0-9a-f]{64}\/cover$/.test(url.pathname)

self.addEventListener('fetch', event => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // Book files come from OPFS, not here — they are large and managed
  // explicitly by the app so the user can see and evict them.
  if (url.pathname.endsWith('/file')) return

  // Navigations: network first, cache as fallback.
  //
  // Cache-first would open marginally faster but leaves the page running one
  // build behind until a second reload — the server is on the same LAN, so
  // that trade is not worth making. The cached shell is still what lets the
  // reader open with no network at all: no DNS, no TCP, no TLS.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(request)
        if (res.ok) {
          const cache = await caches.open(SHELL)
          cache.put('/index.html', res.clone())
        }
        return res
      } catch {
        const hit = await caches.match('/index.html', { cacheName: SHELL })
        if (hit) return hit
        throw new Error('offline and no cached shell')
      }
    })())
    return
  }

  // Covers are keyed by content hash, so a hit can never be stale.
  if (isCover(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(COVERS)
      const hit = await cache.match(request)
      if (hit) return hit
      const res = await fetch(request)
      if (res.ok) cache.put(request, res.clone())
      return res
    })())
    return
  }

  // Progress must never be served stale, and a 204 is a real answer.
  if (url.pathname.startsWith('/api/progress/')) return

  // Remaining API calls: network first, no fallback — callers already handle
  // failure (listBooks falls back to its own cached shelf).
  if (url.pathname.startsWith('/api/')) return

  // Built assets are content-hashed; cache-first is safe and fast.
  event.respondWith(
    caches.match(request, { cacheName: SHELL }).then(hit => hit ?? fetch(request)),
  )
})
