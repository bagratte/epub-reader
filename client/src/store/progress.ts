import type { Progress } from '../../../shared/types.ts'
import { getLocal, putLocal, type LocalProgress } from './local.ts'
import { deviceName } from './device.ts'

const PUSH_DELAY_MS = 1000

async function getRemote(bookId: string): Promise<Progress | null> {
  try {
    const res = await fetch(`/api/progress/${bookId}`)
    // 204 means the book has never been opened anywhere.
    if (res.status === 204 || !res.ok) return null
    return await res.json()
  } catch {
    return null // offline or server down; local is authoritative for now
  }
}

async function putRemote(record: LocalProgress): Promise<Progress | null> {
  try {
    const res = await fetch(`/api/progress/${record.bookId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cfi: record.cfi,
        fraction: record.fraction,
        device: record.device,
      }),
    })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

/**
 * Local-first reading position.
 *
 * Every relocate writes IndexedDB synchronously-ish and marks the record
 * pending; the network push is debounced. UI code never talks to the server
 * directly, which is what keeps the offline upgrade additive: the only thing
 * missing today is a retry loop over pending records.
 */
export class ProgressStore {
  #device = deviceName()
  #timer: ReturnType<typeof setTimeout> | undefined
  #dirty: LocalProgress | undefined
  /** Per-book high-water mark, seeded on load. The server is authoritative;
   *  this only keeps the value sane between pushes. */
  #furthest = new Map<string, number>()

  /**
   * Position to resume at, merging what this device knows with what the server
   * knows. A pending local record wins outright — it holds writes the server
   * has not seen — which avoids comparing a device clock against a server one.
   */
  async load(bookId: string): Promise<Progress | null> {
    const [local, remote] = await Promise.all([getLocal(bookId), getRemote(bookId)])
    const resolved = local?.pending
      ? local
      : remote && local
        ? (remote.updatedAt >= local.updatedAt ? remote : local)
        : remote ?? local

    this.#furthest.set(bookId, Math.max(
      resolved?.furthest ?? 0, local?.furthest ?? 0, remote?.furthest ?? 0))
    return resolved
  }

  /** Call on every relocate. Cheap: one IndexedDB put, debounced network. */
  record(bookId: string, cfi: string, fraction: number) {
    const furthest = Math.max(fraction, this.#furthest.get(bookId) ?? 0)
    this.#furthest.set(bookId, furthest)

    const record: LocalProgress = {
      bookId,
      cfi,
      fraction,
      furthest,
      updatedAt: Date.now(),
      device: this.#device,
      pending: true,
    }
    this.#dirty = record
    void putLocal(record)

    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => void this.#push(), PUSH_DELAY_MS)
  }

  async #push() {
    const record = this.#dirty
    if (!record) return
    const accepted = await putRemote(record)
    // Only clear the flag if nothing newer arrived while the request was out.
    if (accepted && this.#dirty === record) {
      this.#dirty = undefined
      await putLocal({ ...accepted, pending: false })
    }
  }

  /**
   * Last-gasp send when the tab is going away. `keepalive` lets the request
   * outlive the page, which a normal fetch does not. sendBeacon would also
   * survive but can only issue POST, and this endpoint is a PUT.
   */
  flush() {
    const record = this.#dirty
    if (!record) return
    clearTimeout(this.#timer)
    void fetch(`/api/progress/${record.bookId}`, {
      method: 'PUT',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cfi: record.cfi,
        fraction: record.fraction,
        device: record.device,
      }),
    }).catch(() => {})
  }
}
