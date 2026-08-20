import type { Progress } from '../../../shared/types.ts'
import { getLocal, pendingLocal, putLocal, type LocalProgress } from './local.ts'
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
  #draining = false
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

  async #push(): Promise<boolean> {
    const record = this.#dirty
    if (!record) return false
    const accepted = await putRemote(record)
    if (!accepted) return false
    // Only clear the handle if nothing newer arrived while the request was out.
    if (this.#dirty === record) this.#dirty = undefined
    await putLocal({ ...accepted, pending: false })
    return true
  }

  /**
   * Push everything written while the server was unreachable.
   *
   * Deliberately simple: a queued write applied late can clobber a newer write
   * from another device. With one reader and a personal library that is a
   * non-issue, and `furthest` — which the server only ever raises — means the
   * high-water mark survives it regardless.
   */
  async drain(): Promise<number> {
    if (this.#draining) return 0
    this.#draining = true
    try {
      // Flush this session's own unacknowledged write first — it is both the
      // freshest and, when reconnecting mid-book, the one that matters most.
      // A successful push marks it not-pending, so the loop below won't
      // resend it.
      let sent = (await this.#push()) ? 1 : 0

      for (const record of await pendingLocal()) {
        const accepted = await putRemote(record)
        if (!accepted) break // still unreachable — keep the rest queued
        await putLocal({ ...accepted, pending: false })
        sent++
      }
      return sent
    } finally {
      this.#draining = false
    }
  }

  /** Number of positions waiting to reach the server. */
  pendingCount(): Promise<number> {
    return pendingLocal().then(all => all.length)
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
