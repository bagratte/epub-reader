/**
 * Book files cached in the Origin Private File System.
 *
 * OPFS rather than the Cache API because these are large binaries we want to
 * name, count, and evict deliberately — and unlike the File System Access API
 * it works on every browser we care about, phones included.
 */

const DIR = 'books'

async function dir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory()
    return await root.getDirectoryHandle(DIR, { create: true })
  } catch {
    return null // OPFS unavailable (very old browser, or a hardened profile)
  }
}

/** Ask the browser not to evict us. Safari caps uninstalled sites at 7 days. */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (await navigator.storage.persisted?.()) return true
    return (await navigator.storage.persist?.()) ?? false
  } catch {
    return false
  }
}

export async function getCached(id: string, filename: string): Promise<File | null> {
  const d = await dir()
  if (!d) return null
  try {
    const handle = await d.getFileHandle(id)
    const file = await handle.getFile()
    // foliate sniffs format from `.name`, and OPFS names it by id.
    return new File([file], filename, { type: 'application/epub+zip' })
  } catch {
    return null
  }
}

export async function putCached(id: string, blob: Blob): Promise<boolean> {
  const d = await dir()
  if (!d) return false
  try {
    const handle = await d.getFileHandle(id, { create: true })
    const writable = await handle.createWritable()
    await writable.write(blob)
    await writable.close()
    return true
  } catch {
    // Quota, most likely. Caching is best-effort; reading still works online.
    return false
  }
}

export async function removeCached(id: string): Promise<void> {
  const d = await dir()
  await d?.removeEntry(id).catch(() => {})
}

export async function cachedIds(): Promise<Set<string>> {
  const d = await dir()
  const ids = new Set<string>()
  if (!d) return ids
  try {
    // @ts-expect-error - keys() is present in every engine that has OPFS,
    // but is missing from the DOM lib in this TypeScript version.
    for await (const name of d.keys()) ids.add(name as string)
  } catch {
    // Fall through with whatever we collected.
  }
  return ids
}

export async function cachedBytes(): Promise<number> {
  const d = await dir()
  if (!d) return 0
  let total = 0
  try {
    // @ts-expect-error - see cachedIds()
    for await (const [, handle] of d.entries()) {
      total += (await (handle as FileSystemFileHandle).getFile()).size
    }
  } catch {
    // Partial total is fine; this only drives a status line.
  }
  return total
}
