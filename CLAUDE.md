# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

An in-browser EPUB reader served from a home server, reached from phone and
laptop over a home VPN. No auth — the VPN is the perimeter. Feature-complete:
library, reading position sync, contents, search, typography and themes,
footnotes, and full offline.

Everything below was expensive to learn. Add to it when you find something the
next session would otherwise rediscover.

## Commands

```bash
git submodule update --init      # vendor/foliate-js — the client won't build without it
npm install

npm run dev                      # API on :8787 + Vite on :5180
npm run typecheck                # tsc --noEmit; the only static gate
npm run build                    # Vite → dist/client, and emits sw.js
NODE_ENV=production npm start    # Fastify serves the built SPA + API on one port
npm run icons                    # regenerate PWA icons into client/public/
```

Vite binds `::1` only, so use `http://localhost:5180`, not `127.0.0.1`.
Port 8080 is taken by Syncthing on the dev machine, hence 8787.
Node 24 here does not strip TypeScript despite the version, hence `tsx`.

Server env vars: `PORT`, `HOST`, `LIBRARY_DIR`, `CACHE_DIR`, `DB_FILE`.

### Dev mode is not production

`npm run dev` serves **without the CSP and without the service worker** — both
are production-only. Never assess security or offline behaviour from the dev
server; build and run in production mode instead.

## Verifying changes

There is no test framework. Work is verified by driving the running app in a
browser (Playwright) and reading the console — that is how nearly every bug
below was found. Type-check, then actually open a book.

Two things make this awkward, and both have bitten before:

- The book renders in an iframe inside a **closed** shadow root. It is
  unreachable from page JS and absent from Playwright's accessibility snapshot.
  Reach it via `page.frames()` and find the `blob:` frame.
- Tests that start from clean state miss a whole class of bug. Two sync-queue
  defects only appeared when the app ran against real leftover IndexedDB state.

`fixtures/footnotes.epub` exists because no Project Gutenberg book carries
`epub:type="noteref"`, so footnotes cannot otherwise be exercised.

## Architecture

Three parts: a Fastify server, a vanilla-TS client, and **foliate-js vendored as
a git submodule** (`vendor/foliate-js`). The npm package of that name is a stale
third-party republish — do not use it. epub.js was rejected: no release since
2023.

```
server/   Fastify · node:sqlite · scans library/, parses OPF, serves files
shared/   types.ts imported by BOTH sides — the contract
client/   Vite + vanilla TS; no framework (foliate-view is a web component)
```

Metadata is parsed **server-side** (`fflate` + a small OPF reader in
`epub-meta.ts`) rather than with foliate-js, which needs a DOM. Parsing in the
browser on first open would leave the library grid empty until every book had
been opened once. Scanning caches by `(path, size, mtime)`, so a warm rescan
re-hashes nothing.

### Content-hash IDs are the spine

A book's id is the SHA-256 of its file. That one decision explains a lot of the
code: it is the DB primary key, a perfect strong ETag, the OPFS cache filename,
the cover cache key, and the progress key. Because an id can never denote
different bytes, **nothing cached ever needs revalidating**. Never derive an id
from a path — reorganising the library would orphan every cached book and
progress row.

### Adding and removing books

Books arrive two ways and must end up indistinguishable: dropped into
`library/` by hand and picked up by a scan, or uploaded from the browser.
`addBook()` shares the scan's metadata path deliberately so the two cannot
drift.

`POST /api/books` takes the file as a **raw body** with the filename in
`?name=`, not multipart — there is no second form field to justify the
dependency, and the whole file has to be buffered anyway because both the
SHA-256 and the OPF parse need all of it. `MAX_UPLOAD` caps it at 256 MB.

Because the id is the content hash, re-uploading the same bytes is a no-op
returning the book already stored: **200 means duplicate, 201 means created**,
which is the only thing separating them at the API.

An uploaded filename is untrusted input that becomes a path. `safeName()`
reduces it to a bare basename — no directories, no traversal, always `.epub` —
and `freeName()` resolves collisions with `-2`, `-3`, checking the disk as well
as the table, because a file the scan has not seen yet is still a file.

`DELETE /api/books/:id` unlinks the file **before** dropping the row. The other
order looks safer and is not: if the unlink fails, the next scan re-adds the
book, and it returns with its progress already cascaded away. On the client,
deleting also clears the OPFS copy and the local progress record — including
the debounced in-flight write, or a pending flush would recreate a position for
a book that no longer exists.

### Reading position is local-first

The client writes IndexedDB on every relocate and marks the record `pending`;
the network PUT is debounced 1s. UI code never talks to the server directly.

`pending` is the load-bearing idea: a pending record holds writes the server has
not seen, so it wins a merge outright and the code never has to compare a device
clock against a server clock. Otherwise the higher `updated_at` wins, and both
come from the server. `furthest` is a high-water mark the server only ever
raises.

Flush on `pagehide`/`visibilitychange` uses `fetch(..., { keepalive: true })`.
`sendBeacon` also survives teardown but can only issue POST, and this is a PUT.

`GET /api/progress/:id` returns **204, not 404**, for a book never opened. 404 is
defensible but paints a red error in devtools every time an unread book is
opened, which buries real failures.

### Storage is split by what the data is

| What | Where |
|---|---|
| App shell, JS/CSS | Cache API, via the service worker |
| Covers | Cache API, cache-first forever |
| Book files | OPFS (`store/books.ts`) — large, user-evictable |
| Reading position | IndexedDB + retry queue |
| Display settings | localStorage |
| Library metadata | SQLite on the server; last response mirrored to localStorage |

`navigator.onLine` is the wrong question on a VPN — it only knows whether an
interface is up, and the phone can have wifi while home is unreachable. A failed
request is the real signal; see `offline.ts`.

The service worker is hand-rolled, not Workbox: the policy is three rules, and
the only thing a worker cannot know for itself is the hashed asset names, which
the `emitServiceWorker` plugin in `vite.config.ts` injects. **Navigations are
network-first with a cache fallback** — cache-first leaves the page one build
behind until a second reload, which once cost hours because a test silently ran
the previous bundle and looked like a code bug.

### Continuous scroll is our own renderer

`client/src/continuous.ts` (`<foliate-continuous>`) replaces the paginator in
scrolled flow. foliate's paginator holds **one section at a time** in either
flow, so scrolling stops dead at a chapter boundary and only `next()`/`prev()`
crosses it.

The decision that makes this cheap: **each section keeps its own document.**
`view.js` builds the CFI from `{ index, range }` — a section index plus a Range
inside that section's own document — so one-document-per-section means CFIs,
the TOC, search, footnotes and progress all keep working untouched. Merging the
book into a single document would have broken every one of them.

The rest is a virtualised list: every section gets a slot, only sections within
`KEEP_SCREENS` of the viewport hold a live iframe, and a slot's estimated
height (bytes × a self-calibrating ratio) is replaced by its measured height
the first time it renders.

`view.js` hard-codes `foliate-paginator` and appends into a **closed** shadow
root, so the renderer cannot be swapped from outside. The `pluggableRenderer`
plugin in `vite.config.ts` rewrites that one line into an attribute read. It
throws if the pattern is missing, so a submodule bump fails the build rather
than silently losing the feature.

Changing flow **re-opens the book**, because `view.js` chooses the renderer
once, inside `open()`. `Reader` keeps the `File` and the last CFI to do it
invisibly.

Things that cost time here, all of them non-obvious:

- **Inserting an iframe fires a `load` for its initial `about:blank`.** Taking
  that event means styling and measuring a blank document; the real one then
  arrives unstyled with height 0 — a blank screen with a correct-looking
  progress bar. Set `src` before insertion and ignore `about:blank` loads.
- **The renderer must size itself.** foliate-view's shadow root carries no
  stylesheet. Without `:host { height: 100% }` the host collapses to zero.
- **`renderer.open()` is called before the element is appended**, so anything
  needing layout is measuring a detached, zero-sized tree. This is what made an
  `IntersectionObserver` unusable for windowing — it silently stopped
  reporting. Windowing now compares scroll offsets directly, which is
  deterministic and cheap.
- **Never auto-navigate in `open()`.** The caller restores a saved CFI
  immediately afterwards, and an internal `goTo(section 0)` races it and wins
  often enough to dump the reader at the top of the book.
- **A navigation has to be re-applied while heights settle.** A slot's offset
  is only as good as the estimates above it, so scrolling once lands a chapter
  out; `#reapply()` re-pins the target on every measurement for
  `ANCHOR_SETTLE_MS`.

Worth knowing: **a failed restore silently overwrites the saved position**,
because arriving at the top of the book relocates and the debounced write
follows. That is not specific to this renderer, but it destroys the evidence
whenever restore breaks — capture the CFI before reloading when testing it.

## foliate-js quirks

`client/src/reader.ts` is the **only** file that touches foliate-js, and
re-exports a typed surface. Keep it that way. The library ships no types and has
sharp edges:

- **`view.open()` needs a `File`, not a `Blob`.** `makeBook()` sniffs format via
  `name.endsWith('.cbz')`, which throws on a bare Blob.
- **The paginator renders nothing until `renderer.next()`.** No error, no
  warning, just a blank view.
- **`renderer` does not exist until `open()` resolves.** `flow`, `gap`, `margin`
  and `setStyles()` must all come after.
- **`view.open()` never removes the previous renderer.** Reusing one view across
  books stacks paginators, each retaining the old book's iframe and still firing
  `relocate` on resize, for the wrong book. `close()` is the fix; foliate never
  calls it itself.
- **`view.close()` is not idempotent.** `Paginator.destroy()` nulls its own view
  then dereferences it on a second call. `Reader` tracks `#opened` instead.
- **`FootnoteHandler` needs `before-render`, not just `render`.** The popover's
  view is created detached, and a detached paginator never renders — so the
  handler's promise never settles and the note silently never opens.
- **`margin` is vertical only.** The paginator's `--_margin` feeds
  `grid-template-rows` and nothing else. Horizontal space is `gap` — a
  percentage that is both the outer left/right padding and the inter-column
  gap, and which also becomes `padding: 0 Npx` in scrolled mode. Two separate
  settings, `margin` and `gap`, for what the UI calls vertical and horizontal
  margins.
- **In scrolled mode `gap` is overruled by `max-inline-size`.** foliate caps
  the text at 720px and centres it with `margin: auto`, so on a wide window
  that cap — not `gap` — sets the side whitespace, and a horizontal-margin
  control looks broken. `reader.ts` lifts the cap for scrolled flow only;
  paginated keeps it, where it also decides how many columns fit.
- **Use `goLeft()`/`goRight()` for spatial controls**, not `prev()`/`next()`;
  they swap correctly in RTL books.
- `view.goTo(cfi)` works as the *first* navigation, so resuming skips
  `renderer.next()` rather than rendering page one and jumping away from it.
- Resizing *during* a load throws from `columnize()` — the ResizeObserver fires
  before the section document exists. Non-fatal, recovers, vendor code.

## Security

The CSP is **load-bearing, not defence-in-depth**: foliate-js renders content in
an iframe with `allow-same-origin allow-scripts`, which the browser correctly
warns defeats sandbox isolation. It needs same-origin to walk the document for
CFIs, so the sandbox attribute cannot be the boundary.

`blob:` is required in `script-src`, `frame-src`, `img-src` **and `style-src`**.
The last is easy to miss and fails silently: a book's own stylesheets load as
blob: URLs, so without it every EPUB renders unstyled with only a console error.
Allowing it is safe — CSS cannot execute and `img-src` stays same-origin.

External links from a book are blocked rather than opened.

## Build

foliate-js's `pdf.js` breaks `vite build`: it uses `new URL(\`vendor/pdfjs/…\`,
import.meta.url)`, which Vite's import-glob transform rejects. A `resolveId`
plugin swaps it for a stub. An alias cannot do this — foliate imports it as
`'./pdf.js'` and Vite aliases the specifier, not the resolved path. Undo the
stub if PDF support is ever wanted.

Icons: there is no rasteriser on this machine, so `scripts/make-icons.mjs`
evaluates signed-distance fields into a pixel buffer and encodes PNG with
`node:zlib` — no dependencies.

## Bugs worth remembering

- **A removed book wedged the whole sync queue.** A position for a book taken
  out of `library/` was rejected 404 forever, and `drain()` treated every
  failure as "unreachable" and stopped, blocking every position behind it.
  `putRemote` now separates *rejected* (drop the record, carry on) from
  *unreachable* (stop, retry later).
- **A write that failed while "online" was never retried**, because nothing told
  `Connectivity`. A failed write now marks the server unreachable and a
  successful one marks it back.
- **The retry queue skipped the one record that needed it** — `drain()` treated
  the in-memory `#dirty` record as "in flight", but it is the last
  *unacknowledged* write, which is exactly what must be sent.
- `#reader { display: flex }` silently beat the UA's `[hidden] { display: none }`.
  There is now a global `[hidden] { display: none !important }`.
- Covers were served as `image/jpg`, which is not a media type; the extension
  map is reversed explicitly in `coverMediaType()`.
- The footnote popover survived a change of book. Teardown is now one
  `closeOverlays()` used by both view transitions.

## Deployment

Bind the server to the VPN interface via `HOST` — never `0.0.0.0`. "No auth" is
fine behind a tunnel and stops being fine when a wildcard bind meets a
misconfigured router.

HTTPS is **required** for anything that is not localhost: service workers need a
secure context, so on a plain-http LAN address offline silently does nothing.
Browser storage is also origin-scoped, so changing the hostname later orphans
every cached book and queued position.

Still open: annotations/highlights (a mergeable set — a CRDT would earn its
place there), and profiles if more than one person reads (one migration:
`progress` PK becomes `(profile_id, book_id)`).

Also open, smaller: a book removed on one device leaves its OPFS copy orphaned
on every other one. Deleting through the UI cleans up locally, but nothing
reconciles OPFS against a shelf that lost a book elsewhere.
