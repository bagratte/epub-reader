const KEY = 'reader.device'

/**
 * A stable, human-ish label for this browser, so a future "continue from your
 * phone?" prompt has something to name. Local only — no auth, no identity.
 */
export function deviceName(): string {
  let name = localStorage.getItem(KEY)
  if (!name) {
    const ua = navigator.userAgent
    const kind = /Android|iPhone|iPad|Mobile/i.test(ua) ? 'phone' : 'desktop'
    name = `${kind}-${Math.random().toString(36).slice(2, 6)}`
    localStorage.setItem(KEY, name)
  }
  return name
}
