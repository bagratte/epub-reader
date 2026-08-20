import type { Progress } from '../../../shared/types.ts'

export interface LocalProgress extends Progress {
  /**
   * True when this record has not been accepted by the server yet.
   *
   * It exists so that merging never has to compare a device clock against a
   * server clock: a pending record is simply newer by definition. That also
   * makes the offline write queue a small extension rather than a redesign.
   */
  pending: boolean
}

const DB_NAME = 'reader'
const DB_VERSION = 1
const STORE = 'progress'

let dbPromise: Promise<IDBDatabase> | undefined

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'bookId' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

async function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>) {
  const db = await open()
  return new Promise<T>((resolve, reject) => {
    const request = fn(db.transaction(STORE, mode).objectStore(STORE))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export const getLocal = (bookId: string) =>
  tx<LocalProgress | undefined>('readonly', s => s.get(bookId))
    .then(r => r ?? null)
    .catch(() => null)

export const putLocal = (record: LocalProgress) =>
  tx('readwrite', s => s.put(record)).then(() => undefined).catch(() => undefined)

export const allLocal = () =>
  tx<LocalProgress[]>('readonly', s => s.getAll()).catch(() => [] as LocalProgress[])
