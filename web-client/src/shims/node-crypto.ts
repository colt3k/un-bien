/**
 * The slice of `node:crypto` the un-bien client core actually touches, and
 * nothing more. Aliased over `node:crypto` in vite.config.ts for
 * `pairing/crypto.ts` (sha512 for the Ed25519 hash hook, randomBytes) and
 * `mesh/encoding.ts` (sha256 for the owner-pk mesh slot).
 *
 * Why a shim instead of a browser-native crypto module: the core canonicalizes
 * Ed25519 keys through these primitives, and DESIGN.md §10.1 documents the
 * incident that happens when two ends disagree on an encoding (standard vs
 * URL-safe base64 → identical bytes, unequal strings → silent self-revocation).
 * Re-using the core's own helpers is the fix; this file is what makes them
 * loadable in a browser.
 */
import { sha256, sha512 } from "@noble/hashes/sha2.js"

type Algorithm = "sha256" | "sha512"

/** node's streaming Hash, narrowed to what the core calls. */
class Hasher {
  private readonly state: {
    update: (data: Uint8Array) => unknown
    digest: () => Uint8Array
  }

  constructor(algorithm: Algorithm) {
    this.state =
      algorithm === "sha512"
        ? (sha512.create() as unknown as typeof this.state)
        : (sha256.create() as unknown as typeof this.state)
  }

  update(data: Uint8Array | string): this {
    this.state.update(
      typeof data === "string" ? Buffer.from(data, "utf8") : data,
    )
    return this
  }

  /** No encoding → Uint8Array (the ed25519 hash hook). "hex" is the mesh slot
   *  hash; "base64" is here because node accepts it and a caller may. */
  digest(): Uint8Array
  digest(encoding: "hex"): string
  digest(encoding: "base64"): string
  digest(encoding?: "hex" | "base64"): Uint8Array | string {
    const bytes = this.state.digest()
    if (encoding === "hex") return toHex(bytes)
    if (encoding === "base64") return Buffer.from(bytes).toString("base64")
    return bytes
  }
}

function toHex(bytes: Uint8Array): string {
  let out = ""
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0")
  return out
}

export function createHash(algorithm: string): Hasher {
  if (algorithm !== "sha256" && algorithm !== "sha512") {
    throw new Error(
      `node:crypto shim: unsupported hash "${algorithm}" — the client core ` +
        "touches only sha256 (mesh slot) and sha512 (ed25519)",
    )
  }
  return new Hasher(algorithm)
}

/** CSPRNG from the platform (WebCrypto, available in every secure context). */
export function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  globalThis.crypto.getRandomValues(bytes)
  return bytes
}
