import { Reader } from './reader.ts'
import { fetchBookFile, listBooks } from './api.ts'

const $ = <T extends Element>(sel: string) => document.querySelector<T>(sel)!

const statusEl = $<HTMLElement>('#status')
const labelEl = $<HTMLElement>('#label')
const pctEl = $<HTMLElement>('#pct')

async function main() {
  const books = await listBooks()
  if (!books.length) {
    statusEl.textContent = 'No books found. Drop an .epub into library/ and restart the server.'
    return
  }

  // M1: just open the first book. M2 adds the library grid and routing.
  const book = books[0]
  statusEl.textContent = `Loading ${book.filename}…`

  const reader = new Reader($('#view'))
  reader.onRelocate(({ fraction, label }) => {
    labelEl.textContent = label
    pctEl.textContent = `${Math.round(fraction * 100)}%`
  })

  await reader.open(await fetchBookFile(book))
  statusEl.textContent = ''
  document.title = reader.metadata?.title ?? book.filename

  $('#prev').addEventListener('click', () => reader.goLeft())
  $('#next').addEventListener('click', () => reader.goRight())
  document.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') reader.goLeft()
    else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') reader.goRight()
    else return
    e.preventDefault()
  })
}

main().catch(err => {
  console.error(err)
  statusEl.textContent = `Error: ${err.message}`
})
