import type { SavedView } from "./view-state.js"
import { kv, readJson, writeJson } from "./storage.js"

/**
 * What this browser remembers: relays (with the relay's pinned identity), paired
 * machines, and the monotonic version for this device's `pairing_set` push.
 * Mirrors `unbien-cli/src/store.ts` in role; the files are separate because the
 * two are separate owner devices.
 */
const RELAYS_KEY = "unbien.web.relays.v1"
const PEERS_KEY = "unbien.web.peers.v1"
/** The session this client was last driving. Reloads, phone-tab recycling and
 *  sleep should resume the transcript, not dump the user back on an empty
 *  screen at the top — and nothing else in storage says WHICH room that was. */
const LAST_ROOM_KEY = "unbien.web.lastRoom.v1"
/** Where in that session the reader was standing — see view-state.ts. The room
 *  record says what to open; this says what the page looked like when it was
 *  open, which is the part a refresh otherwise loses. */
const LAST_VIEW_KEY = "unbien.web.lastView.v1"
/** The half-typed launch form, keyed to the control room it belongs to. */
const LAUNCH_DRAFT_KEY = "unbien.web.launchDraft.v1"
/** Viewer preferences. Named after the app's (`hideReasoning`) so a preference
 *  means the same thing on both devices. */
const PREFS_KEY = "unbien.web.prefs.v1"
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

/** The session to resume when the socket comes back. */
export interface LastRoom {
  epk: string
  roomId: string
  name?: string
  /** The launcher's control room, not a session: the page to put back is the
   *  launch form, and there is no transcript to replay into it. */
  control?: boolean
}

export function lastRoom(): LastRoom | undefined {
  return readJson<LastRoom>(LAST_ROOM_KEY)
}

export function rememberLastRoom(room: LastRoom): void {
  writeJson(LAST_ROOM_KEY, room)
}

/** Drop the resume target — on unpair, or when that room is reported ended.
 *  Leaving it behind would make every boot chase a dead session. */
export function forgetLastRoom(epk?: string): void {
  if (!epk) {
    kv.remove(LAST_ROOM_KEY)
    return
  }
  const held = lastRoom()
  if (held && held.epk === epk) kv.remove(LAST_ROOM_KEY)
}

/** What had been typed into the launch form. A folder path is the one thing on
 *  that page a person had to type by hand (it is the MACHINE's filesystem, and
 *  a phone keyboard is in the way), so losing it on a refresh costs more than
 *  any other field here. */
export interface LaunchDraft {
  epk: string
  roomId: string
  cwd: string
  name: string
}

export function launchDraft(): LaunchDraft | undefined {
  return readJson<LaunchDraft>(LAUNCH_DRAFT_KEY)
}

export function rememberLaunchDraft(draft: LaunchDraft): void {
  writeJson(LAUNCH_DRAFT_KEY, draft)
}

export function forgetLaunchDraft(): void {
  kv.remove(LAUNCH_DRAFT_KEY)
}

/** The page to put back. Stored alongside the room, dropped with it: a record
 *  of a scroll position in a session that is gone is just noise. */
export function lastView(): SavedView | undefined {
  return readJson<SavedView>(LAST_VIEW_KEY)
}

export function rememberLastView(view: SavedView): void {
  writeJson(LAST_VIEW_KEY, view)
}

export function forgetLastView(): void {
  kv.remove(LAST_VIEW_KEY)
}

interface Prefs {
  hideReasoning?: boolean
  monoProse?: boolean
}

/** Thinking visibility. Like the app's, this is a VIEW preference: reasoning is
 *  always folded, so flipping it back mid-session shows what already arrived. */
export function hideReasoning(): boolean {
  return readJson<Prefs>(PREFS_KEY)?.hideReasoning === true
}

export function setHideReasoning(hide: boolean): void {
  writeJson(PREFS_KEY, { ...readJson<Prefs>(PREFS_KEY), hideReasoning: hide })
}

/** Set the transcript in one monospace grid, the way pi's terminal does it.
 *  Worth a switch rather than a change: it is the closest match to pi, and on a
 *  phone viewport monospace prose wraps far more than the proportional face. */
export function monoProse(): boolean {
  return readJson<Prefs>(PREFS_KEY)?.monoProse === true
}

export function setMonoProse(mono: boolean): void {
  writeJson(PREFS_KEY, { ...readJson<Prefs>(PREFS_KEY), monoProse: mono })
}
