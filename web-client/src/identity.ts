import {
  ed25519KeypairFromSeed,
  encodeEd25519PublicKey,
  generateEd25519Keypair,
  type Ed25519Keypair,
} from "@geohar/un-bien/client"
import { readJson, writeJson } from "./storage.js"

/**
 * This browser's own owner identity — one Ed25519 keypair per browser profile,
 * the same role `unbien-cli` keeps in `~/.local/state/un-bien/proxy-identity.json`.
 * It pairs on its own token and is revoked on its own, so losing the laptop's
 * CLI never implies re-pairing the phone, and vice versa.
 *
 * Storage is deliberately the SAME shape as the CLI's file ({seed, publicKey})
 * so an operator can move a device identity between them on purpose.
 *
 * HONEST LIMITATION: localStorage is plaintext — readable to anything with the
 * profile, and not hardware-backed. A native client would put this key in the
 * Android Keystore / iOS Secure Enclave. Until then this device's trust is
 * "whatever can read this browser profile", which is exactly why
 * `/unbien revoke <shortid>` on the machine has to stay easy to reach.
 */
const IDENTITY_KEY = "unbien.web.identity.v1"

interface StoredIdentity {
  seed: string
  publicKey: string
}

let cached: Ed25519Keypair | null = null

export function deviceIdentity(): Ed25519Keypair {
  if (cached) return cached

  const stored = readJson<StoredIdentity>(IDENTITY_KEY)
  if (stored?.seed) {
    cached = ed25519KeypairFromSeed(Buffer.from(stored.seed, "base64"))
    return cached
  }

  const keypair = generateEd25519Keypair()
  writeJson(IDENTITY_KEY, {
    seed: Buffer.from(keypair.secretKey.slice(0, 32)).toString("base64"),
    publicKey: Buffer.from(keypair.publicKey).toString("base64"),
  } satisfies StoredIdentity)
  cached = keypair
  return keypair
}

/** This device's public key in the relay's canonical (padded, standard) base64. */
export function devicePublicKey(): string {
  return encodeEd25519PublicKey(deviceIdentity().publicKey)
}
