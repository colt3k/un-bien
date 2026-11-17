/**
 * Load FIRST, before anything that touches the un-bien client core: the core
 * canonicalizes Ed25519 keys and encodes envelope payloads through `Buffer`,
 * which a browser does not have. Import order is load-bearing — a module that
 * reaches for `Buffer` at import time would otherwise see `undefined`.
 */
import { Buffer as NodeBuffer } from "buffer"

if (typeof globalThis.Buffer === "undefined") {
  // Narrowed through unknown: the polyfill class is structurally the node
  // global, but its .d.ts is not the same declaration @types/node provides.
  globalThis.Buffer = NodeBuffer as unknown as typeof globalThis.Buffer
}

export {}
