import { Reader } from './reader.ts'
import { renderShelf } from './library.ts'
import {
  deleteBook, downloadForOffline, fetchBookFile, getBook, listBooks, uploadBook,
} from './api.ts'
import { cachedIds, removeCached } from './store/books.ts'
import { Connectivity, registerServiceWorker } from './offline.ts'
import { ProgressStore } from './store/progress.ts'
import { deviceName } from './store/device.ts'
import { ContentsPanel } from './panels/contents.ts'
import { DisplayPanel } from './panels/display.ts'
import { applyTheme, loadSettings, saveSettings, type Settings } from './settings.ts'

const $ = <T extends Element>(sel: string) => document.querySelector<T>(sel)!

const statusEl = $<HTMLElement>('#status')
const libraryEl = $<HTMLElement>('#library')
const readerEl = $<HTMLElement>('#reader')
const shelfEl = $<HTMLElement>('#shelf')
const labelEl = $<HTMLElement>('#label')
const pctEl = $<HTMLElement>('#pct')
const chromeEl = $<HTMLElement>('#chrome')
const scrimEl = $<HTMLElement>('#scrim')
const footnoteEl = $<HTMLElement>('#footnote')
const footnoteBody = $<HTMLElement>('#footnote-body')
const pickerEl = $<HTMLInputElement>('#picker')

const setStatus = (text = '') => { statusEl.textContent = text }

/** A status line that clears itself, unless something else has replaced it. */
function flashStatus(text: string, ms = 4000) {
  setStatus(text)
  setTimeout(() => { if (statusEl.textContent === text) setStatus() }, ms)
}

let settings = loadSettings()
applyTheme(settings)

let reader: Reader | undefined
const progress = new ProgressStore()
const net = new Connectivity()
// A failed write is the truest signal that the server is gone; a successful one
// that it is back. Both matter more than the browser's interface state.
progress.onReachable = reachable => net.set(reachable)
/** Guards against a slow book load finishing after the user has navigated on. */
let loadToken = 0

const contents = new ContentsPanel($('#contents'), target => {
  reader?.goTo(target).catch(() => {})
  if (isNarrow()) closePanels()
})
const display = new DisplayPanel($('#display'), settings, patch => {
  settings = { ...settings, ...patch }
  saveSettings(settings)
  applyTheme(settings)
  reader?.applySettings(settings)
})

const isNarrow = () => matchMedia('(max-width: 44rem)').matches

function closePanels() {
  contents.close()
  display.close()
  scrimEl.hidden = true
}

/** Everything that must not survive a change of book. */
function closeOverlays() {
  closePanels()
  footnoteEl.hidden = true
  footnoteBody.replaceChildren()
}

function openPanel(which: 'contents' | 'display') {
  const target = which === 'contents' ? contents : display
  const other = which === 'contents' ? display : contents
  other.close()
  if (target.isOpen) {
    target.close()
    scrimEl.hidden = true
    return
  }
  target.open()
  // Every width gets the dismiss surface. Clicking the book cannot close a
  // panel by itself: the book is an iframe in a closed shadow root, so its
  // clicks never reach this document. The scrim is what makes "click outside"
  // work at all, and it is transparent on wide screens.
  scrimEl.hidden = false
}

// --- reader chrome auto-hide -------------------------------------------------

let idleTimer: ReturnType<typeof setTimeout>
function wakeChrome() {
  chromeEl.classList.add('awake')
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (!contents.isOpen && !display.isOpen) chromeEl.classList.remove('awake')
  }, 2600)
}

// --- views -------------------------------------------------------------------

function show(view: 'library' | 'reader') {
  libraryEl.hidden = view !== 'library'
  readerEl.hidden = view !== 'reader'
}

async function paintShelf() {
  const [books, cached] = await Promise.all([listBooks(), cachedIds()])
  renderShelf(shelfEl, books, {
    cached,
    offline: !net.online,
    onToggleOffline: async (book, wanted) => {
      try {
        if (!wanted) {
          await removeCached(book.id)
          return false
        }
        const ok = await downloadForOffline(book)
        if (!ok) setStatus('Could not save — the browser refused the storage.')
        return ok
      } catch {
        setStatus('Could not save. The server is unreachable.')
        net.set(false)
        return false
      }
    },
    onDelete: async book => {
      const result = await deleteBook(book.id)
      if (result.status === 'unreachable') {
        net.set(false)
        setStatus('Could not remove — the server is unreachable.')
        return false
      }
      if (result.status === 'rejected') {
        setStatus(`Could not remove: ${result.message}`)
        return false
      }
      net.set(true)
      // The file is gone, so nothing derived from it should outlive it.
      await Promise.all([removeCached(book.id), progress.forget(book.id)])
      await paintShelf()
      flashStatus(`Removed ${book.title ?? book.filename}`)
      return true
    },
  })
}

/**
 * Upload chosen files, then repaint. Sequential on purpose: a phone on a VPN
 * gains nothing from three 20 MB POSTs at once, and one clear "3 of 5" beats
 * five overlapping ones.
 */
async function addBooks(files: File[]) {
  const epubs = files.filter(f =>
    /\.epub$/i.test(f.name) || f.type === 'application/epub+zip')
  if (!epubs.length) return flashStatus('Only .epub files can be added.')

  let added = 0
  let duplicate = 0
  let unreachable = false
  const rejected: string[] = []

  for (const [i, file] of epubs.entries()) {
    setStatus(epubs.length > 1
      ? `Adding ${i + 1} of ${epubs.length}…`
      : `Adding ${file.name}…`)

    const result = await uploadBook(file)
    if (result.status === 'unreachable') {
      // Every later upload would fail the same way; stop and say so once.
      unreachable = true
      break
    }
    net.set(true)
    if (result.status === 'rejected') rejected.push(`${file.name}: ${result.message}`)
    else if (result.status === 'duplicate') duplicate++
    else added++
  }

  // Repaint regardless: some may have landed before the server went away.
  await paintShelf().catch(() => {})

  if (unreachable) {
    net.set(false)
    return setStatus('Could not add — the server is unreachable.')
  }

  const parts: string[] = []
  if (added) parts.push(`${added} added`)
  if (duplicate) parts.push(`${duplicate} already in the library`)
  if (rejected.length === 1) parts.push(rejected[0]!)
  else if (rejected.length) parts.push(`${rejected.length} rejected — see the console`)
  if (rejected.length) console.warn('rejected uploads:', rejected)

  flashStatus(parts.join(', '), rejected.length ? 8000 : 4000)
}

async function showLibrary() {
  // Drop the open book so its iframe isn't retained while browsing the shelf.
  reader?.close()
  closeOverlays()
  show('library')
  document.title = 'Library'
  setStatus()
  try {
    await paintShelf()
    if (!net.online) setStatus('Offline — only saved books can be opened.')
  } catch (err) {
    setStatus(`Could not load library: ${(err as Error).message}`)
  }
}

async function showBook(id: string) {
  const token = ++loadToken
  show('reader')
  closeOverlays()
  labelEl.textContent = ''
  pctEl.textContent = ''
  setStatus('Loading…')

  try {
    const [book, saved] = await Promise.all([getBook(id), progress.load(id)])
    // Opening a book keeps it: the one you are reading is the one you most
    // want on the train.
    const file = await fetchBookFile(book, { cache: true })
    if (token !== loadToken) return

    reader ??= new Reader($('#view'), showFootnote)
    reader.onRelocate(({ cfi, fraction, label, tocHref }) => {
      // A late relocate from a book the user has already navigated away from
      // must not overwrite the new book's position.
      if (token !== loadToken) return
      labelEl.textContent = label
      pctEl.textContent = `${Math.round(fraction * 100)}%`
      contents.setCurrent(tocHref)
      progress.record(id, cfi, fraction)
    })

    await reader.open(file, settings, saved?.cfi)
    if (token !== loadToken) return

    contents.attach(reader)
    document.title = book.title ?? book.filename
    wakeChrome()

    if (!net.online) {
      // No 'change' fires when you were already offline on arrival, so the
      // reader would otherwise give no sign that syncing is deferred.
      const queued = await progress.pendingCount()
      setStatus(queued
        ? `Offline — ${queued} position${queued === 1 ? '' : 's'} will sync later.`
        : 'Offline — your place is being saved locally.')
      setTimeout(() => { if (token === loadToken) setStatus() }, 3600)
    } else if (saved) {
      const where = `${Math.round(saved.fraction * 100)}%`
      const who = saved.device && saved.device !== deviceName() ? ` from ${saved.device}` : ''
      setStatus(`Resumed at ${where}${who}`)
      setTimeout(() => { if (token === loadToken) setStatus() }, 3200)
    } else {
      setStatus()
    }
  } catch (err) {
    if (token === loadToken) setStatus(`Could not open book: ${(err as Error).message}`)
  }
}

// --- footnotes ---------------------------------------------------------------

function showFootnote(view: HTMLElement) {
  footnoteBody.replaceChildren(view)
  footnoteEl.hidden = false
}

function closeFootnote() {
  footnoteEl.hidden = true
  footnoteBody.replaceChildren()
}


// --- routing -----------------------------------------------------------------

function route() {
  const match = location.hash.match(/^#\/book\/([0-9a-f]{64})$/)
  if (match) showBook(match[1]!)
  else showLibrary()
}

// --- wiring ------------------------------------------------------------------

$('#back').addEventListener('click', () => { location.hash = '#/' })
$('#toc-btn').addEventListener('click', () => openPanel('contents'))
$('#display-btn').addEventListener('click', () => openPanel('display'))
scrimEl.addEventListener('click', closePanels)
footnoteEl.querySelector('.panel-close')!.addEventListener('click', closeFootnote)
$('#contents .panel-close').addEventListener('click', closePanels)

$('#add').addEventListener('click', () => pickerEl.click())

pickerEl.addEventListener('change', () => {
  const files = [...pickerEl.files ?? []]
  // Clear first: re-picking the same file fires no change event otherwise.
  pickerEl.value = ''
  if (files.length) void addBooks(files)
})

// Drop onto the shelf — the control anyone reaches for on a laptop. dragover
// has to be cancelled or the browser navigates to the file instead.
let dragDepth = 0
const draggingFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false

libraryEl.addEventListener('dragenter', e => {
  if (!draggingFiles(e)) return
  dragDepth++
  libraryEl.classList.add('dropping')
})
libraryEl.addEventListener('dragover', e => {
  if (!draggingFiles(e)) return
  e.preventDefault()
  e.dataTransfer!.dropEffect = 'copy'
})
libraryEl.addEventListener('dragleave', () => {
  // dragleave fires for every child crossed, so count rather than clear.
  if (--dragDepth <= 0) {
    dragDepth = 0
    libraryEl.classList.remove('dropping')
  }
})
libraryEl.addEventListener('drop', e => {
  if (!e.dataTransfer?.files.length) return
  e.preventDefault()
  dragDepth = 0
  libraryEl.classList.remove('dropping')
  void addBooks([...e.dataTransfer.files])
})

// Anywhere else, a dropped file must not navigate the tab away from the app.
addEventListener('dragover', e => e.preventDefault())
addEventListener('drop', e => e.preventDefault())

$('#prev').addEventListener('click', () => reader?.goLeft())
$('#next').addEventListener('click', () => reader?.goRight())

readerEl.addEventListener('pointermove', wakeChrome)
readerEl.addEventListener('pointerdown', wakeChrome)

document.addEventListener('keydown', e => {
  if (readerEl.hidden) return
  const typing = (e.target as HTMLElement)?.tagName === 'INPUT'

  if (e.key === 'Escape') {
    if (!footnoteEl.hidden) closeFootnote()
    else if (contents.isOpen || display.isOpen) closePanels()
    else location.hash = '#/'
  } else if (typing) {
    return
  } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
    reader?.goLeft()
  } else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
    reader?.goRight()
  } else if (e.key === 't') {
    openPanel('contents')
  } else if (e.key === 'd') {
    openPanel('display')
  } else if (e.key === '/') {
    if (!contents.isOpen) openPanel('contents')
  } else {
    return
  }
  e.preventDefault()
  wakeChrome()
})

// The system theme can change while the app is open; 'auto' should follow it.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (settings.theme !== 'auto') return
  applyTheme(settings)
  reader?.applySettings(settings)
})

// --- offline ----------------------------------------------------------------

async function syncPending() {
  const sent = await progress.drain()
  if (sent) setStatus(`Synced ${sent} saved position${sent === 1 ? '' : 's'}`)
  if (sent) setTimeout(() => setStatus(), 2600)
}

net.onChange(online => {
  if (online) void syncPending()
  else if (!readerEl.hidden) setStatus('Offline — your place is being saved locally.')
})

void registerServiceWorker()
// Trust the server, not the interface: on a VPN the phone can have wifi and
// still not reach home.
void net.probe().then(online => { if (online) void syncPending() })
addEventListener('online', () => void net.probe())

// Position changes are debounced, so a tab closing mid-debounce would lose the
// last page turn without this.
addEventListener('pagehide', () => progress.flush())
addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') progress.flush()
})

addEventListener('hashchange', route)
route()

export type { Settings }
