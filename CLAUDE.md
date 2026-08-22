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
npm run import -- <file|dir>...  # bulk-add EPUBs from the shell
```

Vite binds `::1` only, so use `http://localhost:5180`, not `127.0.0.1`.
Port 8080 is taken by Syncthing on the dev machine, hence 8787.
Node 24 here does not strip TypeScript despite the version, hence `tsx`.

Server env vars live in `.env` (gitignored; copy `.env.example`), loaded by
`process.loadEnvFile` in `server/config.ts` — no dependency, and missing is
fine. `DATABASE_URL` is the library file, a path relative to the repo root and
`library.db` by default; `PORT` and `HOST` are the rest. `LIBRARY_DIR`
survives for one purpose only — see *Everything lives in the database* below.

`DATABASE_URL` names a path, not a URL, for consistency with the other apps
here; a `sqlite:///` or `file:` prefix is stripped if one shows up.

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
server/   Fastify · node:sqlite · parses OPF, stores and serves books
shared/   types.ts imported by BOTH sides — the contract
client/   Vite + vanilla TS; no framework (foliate-view is a web component)
```

Metadata is parsed **server-side** (`fflate` + a small OPF reader in
`epub-meta.ts`) rather than with foliate-js, which needs a DOM. Parsing in the
browser on first open would leave the library grid empty until every book had
been opened once. It happens once per book, at ingest, and the result is a row.

### Everything lives in the database

There is no library directory and no cover cache: `library.db` in the repo root
holds the EPUB bytes, the covers, the metadata and the reading positions. One
file to back up, copy to another machine, or hand to `sqlite3`.

What that bought, beyond the single file: ingest is one transaction instead of
a file plus a row plus a cover file that can disagree; an uploaded filename is
a label rather than a path, so traversal and name collisions stopped being
questions rather than being defended against; and deleting a book is one
`DELETE` instead of an unlink that had to be ordered just so.

Consequences worth knowing:

- **`node:sqlite` has no incremental blob I/O.** Serving a book reads the whole
  thing into memory and blocks the event loop doing it — measured at ~3 ms for
  9.5 MB, so a 100 MB book costs ~30 ms. Acceptable because the id is a content
  hash: a device fetches a given book once and keeps it in OPFS.
- **Never `SELECT *` or `b.*` from `books`.** That reads every book's bytes to
  draw a shelf. `bookColumns()` in `db.ts` is the metadata-only column list;
  the file and cover routes select their blob explicitly and nothing else does.
- **Rollback journal, not WAL.** WAL keeps a `-wal` and a `-shm` next to the
  database and only removes them on a clean close, which a killed server never
  gets — three files for something whose whole point is being one file. The
  rollback journal writes a `-journal` for the length of a transaction and
  removes it on commit. The cost is that a writer locks out other *processes*
  (the import CLI, a `sqlite3` session), so `openDb` sets a 5 s
  `busy_timeout` to make them wait rather than fail. Inside the server there is
  nothing to contend with: `node:sqlite` is synchronous, on one connection.
- **The database is opened with `auto_vacuum = INCREMENTAL`**, and `removeBook`
  runs `PRAGMA incremental_vacuum`, so deleting a book actually returns its
  megabytes. INCREMENTAL rather than FULL: FULL relocates pages on every
  commit, and the pages here are books.
- Migrating an install from the old layout: move the database to the repo root
  as `library.db` and leave `library/` in place for one start. The migration
  in `db.ts` reads each row's file out of `LIBRARY_DIR` and into the row. A
  book whose file is missing is dropped, because a row with no bytes is one
  that can never be opened. After that start, `library/` and `.cache/` are
  dead and can be deleted.

### The database file is synced, so connections are per request

`library.db` lives in a Syncthing folder, which changes one thing about how the
server holds it. Syncthing applies a remote change by writing a temp file and
renaming it over the target. A long-lived handle would go on pointing at the
old, now-unlinked inode: stale reads, and every write landing in a file with no
name — silent, total loss of everything written after the swap. So `withDb()`
in `index.ts` opens a connection per request and closes it, which resolves the
path again each time. It costs ~0.07 ms against ~3 ms to read one book, and
costs no concurrency: `node:sqlite` is synchronous, so a connection never
served two requests at once anyway.

That fixes the handle. It does not make the sync itself safe, and these are
properties of Syncthing, not of anything the code can do:

- **Only one instance may write.** Syncthing moves whole files and cannot merge
  two SQLite databases. If two machines write, one version becomes a
  `.sync-conflict-…` file and its changes are gone from the live database.
- **A remote version replaces the local one wholesale**, rows and all. Nothing
  is merged, so a stale peer that wins a race takes the library back in time.
- **Ignore the journal.** `library.db-journal` exists only inside a write
  transaction. A peer that receives one out of step with the database it
  belongs to invites a rollback against the wrong file, so `*-journal` belongs
  in `.stignore`.
- **The whole library is one file.** A reading-position write dirties it every
  second or so while you read, and Syncthing re-hashes a changed file to find
  the blocks to send. Transfers stay small — the hashing does not, once the
  library is gigabytes.

### Content-hash IDs are the spine

A book's id is the SHA-256 of its file. That one decision explains a lot of the
code: it is the DB primary key, a perfect strong ETag, the OPFS cache filename,
and the progress key. Because an id can never denote different bytes,
**nothing cached ever needs revalidating**. It is also what makes re-adding a
book idempotent, on any device, without a second thought.

### Adding and removing books

`addBook()` is the only way a book gets in, whether it came from the upload
route or from `npm run import`, so the two cannot drift.

`POST /api/books` takes the file as a **raw body** with the filename in
`?name=`, not multipart — there is no second form field to justify the
dependency, and the whole file has to be in memory anyway because the SHA-256,
the OPF parse and the INSERT all need all of it. `MAX_UPLOAD` caps it at
256 MB.

Because the id is the content hash, re-uploading the same bytes is a no-op
returning the book already stored: **200 means duplicate, 201 means created**,
which is the only thing separating them at the API.

`safeName()` still trims an uploaded filename, but it is no longer a security
boundary: the filename is a display name and a download name, never a path.
Nothing enforces uniqueness on it either — two books may share a name, since
the id is the key.

`DELETE /api/books/:id` is one statement; the progress row follows by
`ON DELETE CASCADE` and the cover goes with the row it lives in. On the client,
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
| Book files (client copy) | OPFS (`store/books.ts`) — large, user-evictable |
| Reading position | IndexedDB + retry queue |
| Display settings | localStorage |
| Books, covers, metadata, positions | SQLite on the server — the one file |
| Library listing | last `/api/books` response mirrored to localStorage |

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

- **A removed book wedged the whole sync queue.** A position for a book that
  had been deleted was rejected 404 forever, and `drain()` treated every
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
- Covers were served as `image/jpg`, which is not a media type. The media type
  is now stored in `cover_type` at extraction, so there is no extension to map
  back and the bug cannot recur.
- **`node:sqlite` enables foreign keys by default**, unlike the SQLite CLI.
  The blob migration rebuilds `books`, and `DROP TABLE` fires `ON DELETE
  CASCADE` — so the first run silently took every reading position with it.
  `openDb` now passes `enableForeignKeyConstraints: false` and turns the pragma
  on after migrating; the pragma alone cannot do it, being a no-op inside the
  migration's transaction.
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

### Running as a service

`systemd/` holds three **user** units, the same shape as `../notes`: a service
per process and a target to group them. They run the app in **dev mode** —
`tsx watch` for the API and the Vite dev server for the page — so edits on the
box take effect without touching systemd.

```sh
ln -s ~/src/epub-reader/systemd/epub-reader.target ~/.config/systemd/user/
ln -s ~/src/epub-reader/systemd/epub-reader-backend.service ~/.config/systemd/user/
ln -s ~/src/epub-reader/systemd/epub-reader-frontend.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now epub-reader.target
loginctl enable-linger bagrat    # so it runs on a headless box with nobody logged in
journalctl --user -u epub-reader-backend -f
```

**The reader is reached at Vite's port, not Fastify's.** In dev Vite serves the
page on 5180 and proxies `/api` to Fastify on 8787, so only the frontend unit
needs to be reachable; the API stays on loopback behind that proxy. Vite binds
`::1` by default, which is the box and nothing else, so reading on the phone
means setting `VITE_HOST` in the frontend unit to the VPN interface address.
It is written as `--host ${VITE_HOST}` precisely so the flag always has an
argument: a bare `--host` is a wildcard bind, and there is no auth here.

**Dev mode means no CSP and no service worker**, both being production-only.
That is a deliberate trade for live-editing on the server, but it means the
sandbox boundary around EPUB content is absent and nothing is available
offline — so a phone with no route home has no library at all. To check either,
run production by hand: `npm run build && NODE_ENV=production npm start`, which
serves the built SPA and the API from the one port. The unit for that shape is
in git history at commit b2b9576 if it is ever wanted back.

They take the same ports as `npm run dev` (5180 and 8787), so stop the target
before running that by hand.

Backups are `library.db` and nothing else — genuinely nothing else, since
there is no WAL — but it is now the size of the whole library, so a copy is a
full copy. `cp` is fine when the server is stopped or idle; to take one while
it is being written to, use `sqlite3 library.db ".backup ..."` or
`DatabaseSync.backup`, which are transaction-aware.

Still open: annotations/highlights (a mergeable set — a CRDT would earn its
place there), and profiles if more than one person reads (one migration:
`progress` PK becomes `(profile_id, book_id)`).

Also open, smaller: a book removed on one device leaves its OPFS copy orphaned
on every other one. Deleting through the UI cleans up locally, but nothing
reconciles OPFS against a shelf that lost a book elsewhere.
