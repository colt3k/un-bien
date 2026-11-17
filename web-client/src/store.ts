import { readJson, writeJson } from "./storage.js"

/**
 * What this browser remembers: relays (with the relay's pinned identity), paired
 * machines, and the monotonic version for this device's `pairing_set` push.
 * Mirrors `unbien-cli/src/store.ts` in role; the files are separate because the
 * two are separate owner devices.
 */
const RELAYS_KEY = "unbien.web.relays.v1"
const PEERS_KEY = "unbien.web.peers.v1"
const ALLOW_VERSION_KEY = "unbien.web.allow-version"

export interface RememberedRelay {
  url: string
  /** The relay's Ed25519 pubkey, recorded TOFU at the FIRST pair over this
   *  relay and verified on every reconnect (`identity_ack`). A mismatch means
   *  the relay at this URL is not the one you paired with. */
  pubkey?: string
  addedAt: number
}

export interface PairedPeer {
  /** The machine's pi public key — the outer envelope's routing `peer`. */
  epk: string
  /** Device name this client presented (`/unbien devices` shows it). */
  deviceName: string
  /** The pi SESSION's display name — same string the room card shows, because
   *  `pair_ok.session_name` and `room_meta.name` are the same value on the
   *  machine (extension/src/session/relay_lifecycle.ts `_emitPairOk`). Kept as
   *  a fallback label only. */
  machineName?: string
  /** The machine's own name (`pair_ok.hostname`) — the right label for the
   *  machine card, since one machine can host many sessions. */
  hostname?: string
  /** What is driving the session, e.g. "Pi coding agent" + version. */
  harness?: string
  /** Capabilities advertised by `pair_ok.capabilities`, known BEFORE attach. */
  caps?: string[]
  relayUrl: string
  /** The room the invite pointed at; rooms rotate, so this is only a hint. */
  roomHint?: string
  pairedAt: number
}

export function listRelays(): RememberedRelay[] {
  return readJson<RememberedRelay[]>(RELAYS_KEY) ?? []
}

export function rememberRelay(url: string, pubkey?: string): RememberedRelay {
  const relay: RememberedRelay = { url, addedAt: Date.now() }
  const pin = pubkey ?? relayPinFor(url)
  if (pin) relay.pubkey = pin
  writeJson(RELAYS_KEY, [...listRelays().filter((r) => r.url !== url), relay])
  return relay
}

export function forgetRelay(url: string): void {
  writeJson(
    RELAYS_KEY,
    listRelays().filter((r) => r.url !== url),
  )
}

/** The pinned relay pubkey for a URL, if one was recorded while pairing. */
export function relayPinFor(url: string): string | undefined {
  return listRelays().find((r) => r.url === url)?.pubkey
}

export function recordRelayPin(url: string, pubkey: string): void {
  const relays = listRelays()
  const relay = relays.find((r) => r.url === url)
  if (!relay) return
  if (relay.pubkey && relay.pubkey !== pubkey) return // first pin wins; never overwrite
  relay.pubkey = pubkey
  writeJson(RELAYS_KEY, relays)
}

export function listPeers(): PairedPeer[] {
  return readJson<PairedPeer[]>(PEERS_KEY) ?? []
}

export function rememberPeer(peer: PairedPeer): void {
  writeJson(PEERS_KEY, [...listPeers().filter((p) => p.epk !== peer.epk), peer])
}

export function forgetPeer(epk: string): void {
  writeJson(
    PEERS_KEY,
    listPeers().filter((p) => p.epk !== epk),
  )
}

/**
 * Monotonic version for this device's `pairing_set` push. Raw epoch seconds
 * collide when two clients of the same device push in the same second and the
 * relay's stale-version guard silently drops one — so the counter never goes
 * backwards (same reasoning as the CLI's persisted floor).
 */
export function nextAllowVersion(): number {
  const floor = readJson<number>(ALLOW_VERSION_KEY) ?? 0
  const version = Math.max(Math.floor(Date.now() / 1000), floor + 1)
  writeJson(ALLOW_VERSION_KEY, version)
  return version
}
