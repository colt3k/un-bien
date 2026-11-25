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
/** A launch asked for and not yet answered by a room. */
const PENDING_LAUNCH_KEY = "unbien.web.pendingLaunch.v1"
/** Viewer preferences. Named after the app's (`hideReasoning`) so a preference
 *  means the same thing on both devices. */
const PREFS_KEY = "unbien.web.prefs.v1"
const ALLOW_VERSION_KEY = "unbien.web.allow-version"
/** The last QR scan attempt. See `ScanAttempt` below for why it is stored. */
const SCAN_ATTEMPT_KEY = "unbien.web.scanAttempt.v1"

/**
 * The last QR scan, as it happened.
 *
 * Stored because the interesting part of a scan is what the phone did, and a
 * phone can lose that: iOS Safari is free to unload the page while the camera
 * UI owns the screen, and then the `change` handler never runs and the failure
 * leaves no trace anywhere. Writing the attempt BEFORE the decode means the one
 * case that explains "the camera opened and nothing happened" is the one case
 * that still gets reported.
 *
 * Deliberately NOT stored: the pairing URI itself. It is a single-use
 * credential, and a diagnostic that outlives it is a liability.
 */
export interface ScanAttempt {
  at: number
  /** `started` is written before the decode and never updated if the page dies
   *  during it. `done` means the decode returned and the verdict is real. */
  stage: "started" | "done"
  fileType: string
  fileSize: number
  width?: number
  height?: number
  passes?: number[]
  ms?: number
  decoded?: number
  outcome:
    | "in-flight"
    | "pairing-code"
    | "no-code"
    | "foreign-code"
    | "error"
    /** The picker closed without handing a file over. On Android that is what
     *  pressing BACK from the camera's review screen means — the shot was
     *  taken, and never attached. */
    | "cancelled"
    /** A file arrived that the client will not try to decode. */
    | "not-an-image"
  /** The failure's own words. Never a pairing URI. */
  error?: string
  /** What the picker called the file, when one arrived. */
  fileName?: string
}

export function lastScanAttempt(): ScanAttempt | null {
  return readJson<ScanAttempt>(SCAN_ATTEMPT_KEY) ?? null
}

export function rememberScanAttempt(attempt: ScanAttempt): void {
  writeJson(SCAN_ATTEMPT_KEY, attempt)
}

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
  /** The page this one was opened ON TOP of — recorded only for a launcher's
   *  panel, and only one level deep (an `under` never carries its own). Closing
   *  the panel puts it back as the page a reload reopens; DETACH is the control
   *  that means stop, and it drops the pair. */
  under?: LastRoom
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

/** A `session_launch` we asked for and have not seen a room for yet.
 *
 *  Worth storing because the correlation outlives the page: the machine echoes
 *  the request id in the room it produces (`launchReq`, matched by
 *  `launchedRoom`), so a reload can still recognise the session it started and
 *  open it. Without the record, a refresh in the middle of a launch loses the
 *  question — the page can no longer tell "still starting" from "refused" from
 *  "never asked", and the session that did start sits unexplained in the list. */
export interface PendingLaunch {
  id: string
  epk: string
  cwd: string
  askedAt: number
}

/** How long a launch stays worth waiting for. Deliberately far longer than the
 *  panel's own note (60s): a cold start on a loaded machine is exactly when the
 *  reader gives up on the tab and reloads, and an exact `launchReq` match cannot
 *  be mistaken for anyone else's session. */
export const PENDING_LAUNCH_TTL_MS = 10 * 60_000

/** The launch still outstanding, or nothing if it has gone stale. Expired
 *  records are dropped on the way out rather than left to be re-read forever. */
export function pendingLaunch(now = Date.now()): PendingLaunch | undefined {
  const held = readJson<PendingLaunch>(PENDING_LAUNCH_KEY)
  if (!held || !held.id || !held.epk) return undefined
  if (
    typeof held.askedAt !== "number" ||
    now - held.askedAt > PENDING_LAUNCH_TTL_MS
  ) {
    kv.remove(PENDING_LAUNCH_KEY)
    return undefined
  }
  return held
}

export function rememberPendingLaunch(pending: PendingLaunch): void {
  writeJson(PENDING_LAUNCH_KEY, pending)
}

export function forgetPendingLaunch(): void {
  kv.remove(PENDING_LAUNCH_KEY)
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
