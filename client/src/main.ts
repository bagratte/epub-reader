import { Reader } from './reader.ts'
import { renderShelf } from './library.ts'
import { fetchBookFile, getBook, listBooks, rescan } from './api.ts'

const $ = <T extends Element>(sel: string) => document.querySelector<T>(sel)!

const statusEl = $<HTMLElement>('#status')
const libraryEl = $<HTMLElement>('#library')
const readerEl = $<HTMLElement>('#reader')
const shelfEl = $<HTMLElement>('#shelf')
const labelEl = $<HTMLElement>('#label')
const pctEl = $<HTMLElement>('#pct')

const setStatus = (text = '') => { statusEl.textContent = text }

let reader: Reader | undefined
/** Guards against a slow book load finishing after the user has navigated on. */
let loadToken = 0

function show(view: 'library' | 'reader') {
  libraryEl.hidden = view !== 'library'
  readerEl.hidden = view !== 'reader'
}

async function showLibrary() {
  // Drop the open book so its iframe isn't retained while browsing the shelf.
  reader?.close()
  show('library')
  document.title = 'Library'
  setStatus()
  try {
    renderShelf(shelfEl, await listBooks())
  } catch (err) {
    setStatus(`Could not load library: ${(err as Error).message}`)
  }
}

async function showBook(id: string) {
  const token = ++loadToken
  show('reader')
  labelEl.textContent = ''
  pctEl.textContent = ''
  setStatus('Loading…')

  try {
    const book = await getBook(id)
    const file = await fetchBookFile(book)
    if (token !== loadToken) return

    reader ??= new Reader($('#view'))
    reader.onRelocate(({ fraction, label }) => {
      labelEl.textContent = label
      pctEl.textContent = `${Math.round(fraction * 100)}%`
    })
    await reader.open(file)
    if (token !== loadToken) return

    document.title = book.title ?? book.filename
    setStatus()
  } catch (err) {
    if (token === loadToken) setStatus(`Could not open book: ${(err as Error).message}`)
  }
}

function route() {
  const match = location.hash.match(/^#\/book\/([0-9a-f]{64})$/)
  if (match) showBook(match[1]!)
  else showLibrary()
}

$('#back').addEventListener('click', () => { location.hash = '#/' })

$('#rescan').addEventListener('click', async () => {
  setStatus('Scanning…')
  try {
    const result = await rescan()
    renderShelf(shelfEl, await listBooks())
    const failed = result.failed.length ? `, ${result.failed.length} unreadable` : ''
    setStatus(`${result.added} added, ${result.updated} updated, ${result.removed} removed${failed}`)
  } catch (err) {
    setStatus(`Scan failed: ${(err as Error).message}`)
  }
})

document.addEventListener('keydown', e => {
  if (readerEl.hidden) return
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') reader?.goLeft()
  else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') reader?.goRight()
  else if (e.key === 'Escape') location.hash = '#/'
  else return
  e.preventDefault()
})

$('#prev').addEventListener('click', () => reader?.goLeft())
$('#next').addEventListener('click', () => reader?.goRight())

addEventListener('hashchange', route)
route()
