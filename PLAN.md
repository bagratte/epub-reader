# EPUB Reader — Plan

An in-browser EPUB reader served from a home server, reachable from phone and
laptop over the home VPN.

## Settled decisions

| Decision | Choice | Why |
|---|---|---|
| Renderer | **foliate-js**, vendored as a git submodule | Actively maintained; epub.js hasn't published since 2023. Handles CFI, RTL/vertical, fixed-layout, search, footnotes. The `foliate-js` package on npm is a stale third-party republish — do not use it. |
| Topology | Home server, VPN as perimeter, **no auth** | One server = one source of truth. There are no replicas, so there is no sync problem to solve. |
| Offline | **Online-only in v1**, structured so offline is additive | See "Invariants" below — the retrofit is ~3 days *if* those hold. |
| Server | Node + TypeScript, Fastify, `node:sqlite` | Shared types with the client; the API is small. Node ships SQLite now, so no native dependency. |
| Client | Vite + vanilla TS, no framework | `<foliate-view>` is a web component; a framework would only sit between us and the renderer. |
| Flow modes | Both paginated and scrolled | It's a foliate-js toggle, not a fork in the design. |
| Profiles | Deferred (single reader) | Adding later = change `progress` PK to `(profile_id, book_id)`. One migration. |

## Invariants that keep offline cheap

These are the only things expensive to retrofit. Everything else about offline
is additive.

1. **Local-first storage.** The client writes position to IndexedDB on every
   `relocate` and a sync layer mirrors it to the server. It never reads or
   writes the server directly from UI code. This *is* the offline design minus
   the retry queue.
2. **Stable book IDs.** SHA-256 of file content, assigned server-side. Never
   derive an ID from a file path — reorganizing the library would orphan every
   cached book and progress row.
3. **Settle the origin before storing anything meaningful locally.** Browser
   storage is origin-scoped; moving from `http://192.168.x.x:8080` to
   `https://books.<tailnet>.ts.net` orphans all of it. HTTPS is optional for
   v1, mandatory the day we want a service worker.

## Architecture

```
┌─ home box ────────────────────────────────┐
│  Fastify                                  │
│   ├─ static SPA (built by Vite)           │
│   ├─ /api/books, /api/books/:id/file      │
│   ├─ /api/progress/:bookId                │
│   ├─ SQLite  (books, progress)            │
│   └─ library/*.epub  on disk              │
└───────────────────────────────────────────┘
              ▲  HTTP over VPN
              │
   ┌──────────┴──────────┐
   │  browser            │
   │   <foliate-view>    │
   │   IndexedDB (local-first position)
   └─────────────────────┘
```

Books are fetched whole as a Blob and handed to `view.open(blob)`. On a LAN a
few MB is nothing, and it keeps the offline upgrade obvious: check OPFS first,
fall back to fetch.

## Data model

```sql
CREATE TABLE books (
  id          TEXT PRIMARY KEY,      -- sha256 hex of file content
  path        TEXT NOT NULL UNIQUE,  -- relative to library root
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
  cfi         TEXT NOT NULL,         -- from foliate relocate event
  fraction    REAL NOT NULL,         -- 0..1
  furthest    REAL NOT NULL,         -- monotonic high-water mark
  updated_at  INTEGER NOT NULL,      -- server-assigned ms; never trust device clocks
  device      TEXT
);
```

`furthest` is cheap insurance and the thing to compare against when asking
"am I behind?" — it costs one column now and is awkward to backfill later.

## API

```
GET  /api/books               -> Book[] (incl. progress summary for the grid)
GET  /api/books/:id           -> Book
GET  /api/books/:id/file      -> application/epub+zip, ETag, Range
GET  /api/books/:id/cover     -> image/*
GET  /api/progress/:bookId    -> Progress | 404
PUT  /api/progress/:bookId    -> { cfi, fraction, device } ; server stamps updated_at
POST /api/library/scan        -> { added, removed, updated }
```

## Repo layout

```
epub-reader/
├── vendor/foliate-js/        git submodule, pinned commit
├── shared/types.ts           Book, Progress — imported by client AND server
├── server/
│   ├── index.ts              Fastify, static, CSP headers
│   ├── db.ts                 node:sqlite + migrations
│   ├── epub-meta.ts          container.xml -> OPF -> title/author/cover
│   ├── library.ts            scan, hash, OPF parse, cover extract
│   └── routes/
├── client/
│   ├── index.html
│   └── src/
│       ├── main.ts           hash router: #/  and  #/book/:id
│       ├── reader.ts         wraps <foliate-view>
│       ├── library.ts        grid
│       ├── api.ts
│       └── store/
│           ├── local.ts      IndexedDB
│           └── progress.ts   ProgressStore: local write + debounced mirror
└── library/                  the .epub files (gitignored)
```

Metadata is parsed **server-side** (`fflate` + a small OPF reader, ~100 lines)
rather than reusing foliate-js's parser, which needs a DOM. The alternative —
extracting on first open in the browser — would leave the library grid empty
until every book had been opened once.

Scanning caches by `(path, size, mtime)` so startup doesn't re-hash the whole
library every time.

## Progress write path

- on `relocate` → write IndexedDB immediately; debounce ~1s → `PUT`
- on `visibilitychange` / `pagehide` → flush with `fetch(..., { keepalive: true })`
- on book open → `GET` server + read local, take the newer `updated_at`

No conflict prompt in v1: one reader, one server, and `updated_at` is
server-assigned. The prompt only earns its place once there are offline
replicas that can diverge.

**Implemented as:** every relocate writes IndexedDB and marks the record
`pending`; the network PUT is debounced 1s. `pending` is what makes the merge
work without ever comparing a device clock to a server clock — a pending record
holds writes the server has not seen, so it wins outright. Otherwise the higher
`updated_at` wins, and both of those come from the server. This is also exactly
the hook the offline retry queue needs: today nothing ever retries a pending
record, and that is the only missing piece.

`GET /api/progress/:id` returns **204, not 404**, when a book has never been
opened. 404 is defensible but paints a red error in devtools every single time
an unread book is opened, which buries real failures.

Flushing on `pagehide`/`visibilitychange` uses `fetch(..., { keepalive: true })`.
`sendBeacon` also survives teardown but can only issue POST, and this is a PUT.

## Security

EPUB content is untrusted HTML in an iframe. foliate-js refuses to run scripted
content, but CSP is the actual boundary — set it server-side, start strict, and
loosen only what the console proves is needed:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; frame-src blob:; object-src 'none'
```

Bind the listener to the VPN interface, **not** `0.0.0.0`. "No auth" is fine
behind a tunnel; it stops being fine the moment a wildcard bind meets a
misconfigured router.

## Milestones

**M0 — Skeleton** (~½ day)
Repo init, Vite client + Fastify server with dev proxy, foliate-js submodule,
`shared/types.ts`.

**M1 — Render a book** (~1 day)
One hardcoded EPUB. `GET /api/books/:id/file` → Blob → `view.open()`. Prev/next,
keyboard, click zones. *You can read a book end to end.*

**M2 — Library** ✅
Scan, hash, OPF parse, cover extraction and caching. Grid UI, routing,
back-navigation. CSP landed here rather than M4 — see below.

**M3 — Progress** ✅
Schema, endpoints, IndexedDB local-first store, restore on open, progress bars
in the grid. *Close the laptop, open the phone, continue.*

**M4 — Reading UX** ✅
TOC drawer, settings (font size/family/line height/margins, light/sepia/dark,
paginated vs scrolled) persisted in localStorage, in-book search, footnote
popovers.

**Offline** ✅ — service worker, OPFS book cache, retry queue.

**Later, in rough priority order**
HTTPS via `tailscale cert` — **now required, not optional**: service workers
need a secure context, so offline silently does nothing on a plain-http LAN
address. · annotations and highlights (a mergeable set — reconsider a CRDT if
it lands) · profiles.

## Open questions

- **HTTPS timing** — trivial on Tailscale, more annoying on plain WireGuard.
  Needed before offline, optional before that.
- **Library size** — a few hundred books changes nothing; tens of thousands
  would want pagination and a lazier scan.

---

## Implementation notes

Status: **M0–M4 complete, plus offline.** The reader works with the server
switched off: the app opens, saved books read, and positions queue and sync
when it comes back. What remains is annotations, profiles, and HTTPS for
anything that isn't localhost.

Non-obvious things found while wiring foliate-js — all cost time to rediscover:

- **`view.open()` needs a `File`, not a `Blob`.** `makeBook()` sniffs format via
  `name.endsWith('.cbz')`, which throws on a bare Blob. `api.ts` wraps the
  response in a `File`.
- **The paginator renders nothing until `renderer.next()` is called.** No error,
  no warning — just a blank view. foliate's own `reader.js` does the same thing
  at line 121.
- **`renderer` does not exist until after `open()` resolves.** `flow`, `gap`,
  `margin` and `setStyles()` all have to come after.
- **Use `goLeft()`/`goRight()` for spatial controls**, not `prev()`/`next()`.
  They swap correctly in RTL books; the logical pair does not.
- **Port 8080 is occupied by Syncthing on this machine.** Server defaults to
  8787.
- **Node 24.18 here does not strip types** despite the version; using `tsx`.
- **Vite binds `::1` only.** Fine for dev; `--host` will be needed to reach it
  from a phone.

### More foliate-js quirks (M2)

- **`view.close()` is not idempotent.** `Paginator.destroy()` sets its own
  `#view = null` and then dereferences it on a second call. `Reader` tracks an
  `#opened` flag rather than calling it twice.
- **`view.open()` never removes the previous renderer.** Reusing one
  `<foliate-view>` across books stacks paginators — each retaining the old
  book's iframe and still firing `relocate` on resize, for the wrong book.
  `close()` is the fix and foliate simply never calls it itself.
- **Resizing *during* a book load** throws `Cannot destructure property 'style'
  of 'el'` from `columnize()` — the ResizeObserver fires before the section
  document exists. Non-fatal, and it recovers. Resizing a settled book is
  clean apart from the browser's benign "ResizeObserver loop completed"
  notice. Not patched; it's vendor code.

### M3 notes

- `view.goTo(cfi)` works as the *first* navigation, so resuming skips
  `renderer.next()` entirely rather than rendering page one and jumping away
  from it. It's wrapped in a try/catch: a CFI stops resolving if the file was
  replaced, and falling back to the start beats showing nothing.
- The relocate handler checks the load token before recording. Without it a
  late relocate from a book the user already navigated away from overwrites the
  new book's position.

### M4 notes

- **`FootnoteHandler` needs `before-render`, not just `render`.** The popover's
  view is created *detached*, and a detached paginator never renders — so the
  handler's promise never settles and the note silently never opens. foliate
  fires `before-render` precisely so the host can attach it first. Listening
  only to `render` looks correct and does nothing.
- **No Project Gutenberg book carries `epub:type="noteref"`**, so footnotes
  can't be tested with them at all. `fixtures/footnotes.epub` is a minimal
  EPUB 3 built for it; see `fixtures/README.md`.
- Contents and search share one drawer. They answer the same question — where
  do I go — and splitting them would be two panels doing one job.
- Themes live in `settings.ts` as one palette table that feeds both the app's
  CSS custom properties and the CSS injected into the book's iframe, so a theme
  cannot half-apply.
- Test hooks: the book's iframe sits inside a **closed** shadow root, so it is
  unreachable from page JS and absent from Playwright's a11y snapshot. Drive it
  through `page.frames()` and find the `blob:` frame.

### Offline notes

**Split by what the data is**, not by convenience:

| What | Where | Why |
|---|---|---|
| App shell, JS/CSS | Cache API, via the service worker | Precached by hash at build time |
| Covers | Cache API, cache-first forever | Keyed by content hash, can't go stale |
| Book files | OPFS, managed by the app | Large, and the user should see and evict them |
| Reading position | IndexedDB + retry queue | Must survive with no server at all |

- **The service worker is hand-rolled**, not Workbox. The whole policy is three
  rules; the one thing a worker can't know by itself is the hashed asset names,
  and the `emitServiceWorker` plugin in `vite.config.ts` supplies exactly that.
- **Navigations are network-first with a cache fallback.** Cache-first opens
  marginally faster but leaves the page running one build behind until a second
  reload — which cost real debugging time here, because a test ran the previous
  bundle and looked like a code bug. The server is on the same LAN, so that
  trade is not worth making. The cached shell is still what makes the reader
  open with no network at all.
- **`navigator.onLine` is the wrong question on a VPN.** It reports whether an
  interface is up; the phone can have wifi and still not reach home. Treat a
  failed request as the real signal and use the events only as a hint —
  `Connectivity.probe()` asks the server directly.
- **Book files are content-hashed**, so a cached file can never be a stale
  version of the same id. There is nothing to revalidate, which is why the
  OPFS path is a plain read with no freshness check.
- Icons are generated by `npm run icons`. There is no rasteriser on this
  machine, so `scripts/make-icons.mjs` evaluates signed-distance fields into a
  pixel buffer and encodes the PNG with `node:zlib` — no dependencies.

### Our own bugs worth remembering

- `#reader { display: flex }` silently beat the UA's `[hidden] { display: none }`,
  leaving reader chrome floating over the library. There's now a global
  `[hidden] { display: none !important }`.
- Covers were served as `image/jpg`, which is not a media type. The extension
  map is reversed explicitly in `coverMediaType()`.
- The footnote popover survived a change of book. Panel teardown is now one
  `closeOverlays()` used by both view transitions, rather than each caller
  remembering the list.
- The contents drawer opened at chapter 1 while the reader was at chapter 41.
  It scrolls the current entry into view on open — and only on open, or it
  fights the user's own scrolling.
- **A removed book wedged the whole sync queue.** A position for a book that
  had been taken out of `library/` was rejected 404 forever, and `drain()`
  treated every failure as "server unreachable" and stopped — so one dead
  record blocked every position behind it indefinitely. `putRemote` now
  distinguishes *rejected* (the server answered and said no: drop the record
  and carry on) from *unreachable* (stop; try later). Only found by running
  the app with real leftover state — no test had a stale record in it.
- **A write that failed while "online" was never retried.** Nothing told
  `Connectivity` about it, so the record sat pending until the next real
  network transition, which on a desktop may never come. A failed write now
  marks us unreachable and a successful one marks us back, which is what the
  note above about `navigator.onLine` always claimed to mean.
- **The retry queue skipped the one record that needed it.** `drain()` treated
  the in-memory `#dirty` record as "in flight" and skipped its book — but
  `#dirty` is the last *unacknowledged* write, which after going offline is
  precisely the position you want sent. It now flushes `#dirty` first and then
  drains the rest.

### Security

The CSP is **implemented** and applied to every response.

It is load-bearing rather than defence-in-depth: foliate-js renders book content
in an iframe with `sandbox="allow-same-origin allow-scripts"`, which the browser
warns "can escape its sandboxing" — correctly. foliate-js needs same-origin to
walk the document for CFIs, so the sandbox attribute cannot be the boundary.

`blob:` is required in `script-src`, `frame-src`, `img-src` **and `style-src`**.
The last one is easy to miss and fails silently: a book's own stylesheets are
loaded as blob: URLs, so without it every EPUB renders unstyled with only a
console error to show for it. Allowing it is safe here — CSS cannot execute, and
`img-src` stays same-origin, so there's no exfiltration path.

Note that Vite's dev server does **not** apply these headers — only Fastify does.
Test the CSP against `npm run build` + `NODE_ENV=production npm start`, never
`npm run dev`. Verified: three books open with zero `securitypolicyviolation`
events.

### Build

foliate-js's `pdf.js` breaks `vite build` (it uses `new URL(\`vendor/pdfjs/…\`,
import.meta.url)`, which Vite's import-glob transform rejects). A `resolveId`
plugin in `vite.config.ts` swaps it for a stub. An alias cannot do this —
foliate imports it as `'./pdf.js'` and Vite aliases the specifier, not the
resolved path. Undo the stub if PDF support is ever wanted.
