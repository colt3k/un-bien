/**
 * Tiny key/value seam over `localStorage`, with an in-memory fallback so the
 * pure modules stay testable under Node (no web storage there).
 */
interface Kv {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

const memory = new Map<string, string>()

const inMemory: Kv = {
  get: (key) => memory.get(key) ?? null,
  set: (key, value) => void memory.set(key, value),
  remove: (key) => void memory.delete(key),
}

const web: Kv | null =
  typeof globalThis.localStorage !== "undefined"
    ? {
        get: (key) => globalThis.localStorage.getItem(key),
        set: (key, value) => globalThis.localStorage.setItem(key, value),
        remove: (key) => globalThis.localStorage.removeItem(key),
      }
    : null

export const kv: Kv = web ?? inMemory

/** Read a JSON value, treating "absent or unparseable" as absent. */
export function readJson<T>(key: string): T | undefined {
  const raw = kv.get(key)
  if (raw === null) return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

export function writeJson(key: string, value: unknown): void {
  kv.set(key, JSON.stringify(value))
}
