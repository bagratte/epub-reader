import { requestPersistence } from './store/books.ts'

/**
 * Registers the service worker, which is what lets the app open with no
 * network at all: a registered worker answers the navigation request from
 * cache before any DNS, TCP or TLS happens.
 *
 * Only in production. Vite's dev server has no build manifest to precache,
 * and a stale worker in dev is a debugging trap.
 */
export async function registerServiceWorker(): Promise<boolean> {
  if (!import.meta.env.PROD) return false
  // Service workers need a secure context. localhost counts; a plain-http LAN
  // address does not — see PLAN.md → Invariants.
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return false
  try {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' })
    // Best-effort: on iOS this is what keeps Safari from clearing the reader
    // (worker registration included) after seven days of not opening it.
    await requestPersistence()
    return true
  } catch {
    return false
  }
}

type Listener = (online: boolean) => void

/**
 * `navigator.onLine` only knows whether an interface is up, which on a VPN is
 * exactly the wrong question — the phone has wifi but the home server is
 * unreachable. Treat a failed request as the real signal and let the events
 * be a hint.
 */
export class Connectivity extends EventTarget {
  #online = navigator.onLine

  constructor() {
    super()
    addEventListener('online', () => this.set(true))
    addEventListener('offline', () => this.set(false))
  }

  get online() { return this.#online }

  set(online: boolean) {
    if (online === this.#online) return
    this.#online = online
    this.dispatchEvent(new CustomEvent('change', { detail: online }))
  }

  onChange(fn: Listener) {
    this.addEventListener('change', e => fn((e as CustomEvent).detail))
  }

  /** Ask the server directly rather than trusting the interface state. */
  async probe(): Promise<boolean> {
    try {
      const res = await fetch('/api/books', { method: 'HEAD', cache: 'no-store' })
      this.set(res.ok)
      return res.ok
    } catch {
      this.set(false)
      return false
    }
  }
}
