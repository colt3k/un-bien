import {
  RelayClient,
  ed25519Sign,
  encodeEd25519PublicKey,
  type Ed25519Keypair,
  type EnvelopeMessage,
} from "@geohar/un-bien/client"
import type { PairingInvite } from "./invite.js"
import {
  correlationId,
  decodeInbound,
  encodeOuter,
  stampEnvelope,
  toWsUrl,
} from "./framing.js"
import { nextAllowVersion } from "./store.js"

/**
 * The owner end of an un-bien session channel, for a browser.
 *
 * This is a port of `unbien-cli/src/client.ts` (the terminal client), keeping
 * the parts that are load-bearing and honest about failure modes:
 *
 *  - pairing is AWAITED. A fire-and-forget `pair_request` is the field-verified
 *    bug the CLI documents: the machine records the peer, the CLI remembers the
 *    machine, and `rooms_check` is still refused forever. Nothing is stored
 *    before the machine's `pair_ok`.
 *  - `rooms_check` answers `unknown_peer` when this device is not in the
 *    machine's signed allow-list. Collapsing that into "no sessions" is the bug
 *    that made a working setup look empty, so it stays a distinct result.
 *  - `get_entries` is PAGED. One call returns one page and looks like a short
 *    history; the walk ends on an empty page, with a repeated-leaf breaker.
 *  - the relay's identity is pinned TOFU at pair time and re-verified on every
 *    reconnect (`identity_ack`, nonce-bound).
 */

export type RelayStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "identity_mismatch"
  | "closed"

export interface RoomInfo {
  room_id: string
  name?: string
  cwd?: string
  started_at?: number
  /** Set when this room is a subagent child session. */
  parent?: string
  parentSessionId?: string
  sessionId?: string
  /** The room's own advertised caps (remote_terminate, models, …) — known
   *  BEFORE attach, so the UI can gate controls on discovery. */
  caps?: string[]
  /** Present for federated (remote-relay) rooms; the peer relay's name. */
  peerRelay?: string
  peer_epk?: string
}

export type RelayRoomList =
  | { status: "ok"; rooms: RoomInfo[] }
  | { status: "unknown_peer"; peer?: string }
  | { status: "refused"; detail: string }
  | { status: "timeout" }

export type PairVerdict =
  | {
      ok: true
      machine: Record<string, unknown>
      relayPubkey?: string
      /** `pair_ok.hostname` — the machine's own name, distinct from the session. */
      hostname?: string
      /** `pair_ok.session_name` — the pi session's display name. */
      sessionName?: string
      /** `pair_ok.harness` — what is driving the session. */
      harness?: string
      /** `pair_ok.capabilities` (NOT `caps`; room_meta uses `caps`). */
      capabilities?: string[]
      roomId?: string
    }
  | { ok: false; detail: string }

/** pi-ask / extension dialogs. Mirrors ExtensionUiResponseWire: routing keys off
 *  `ask.kind` first, and a rich submit sends ONLY the envelope. */
export type UiResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true }
  | {
      type: "extension_ui_response"
      id: string
      ask: Record<string, unknown>
    }

export interface SessionEvents {
  envelope: EnvelopeMessage
  control: Record<string, unknown>
  relayControl: Record<string, unknown>
  status: RelayStatus
  reconnected: undefined
}

type Listener<K extends keyof SessionEvents> = (
  payload: SessionEvents[K],
) => void

/** Minimal typed emitter — MY code needs no EventEmitter; the core keeps its own. */
class Emitter {
  private readonly listeners = new Map<string, Set<(payload: never) => void>>()

  on<K extends keyof SessionEvents>(event: K, handler: Listener<K>): void {
    const set = this.listeners.get(event) ?? new Set<(payload: never) => void>()
    set.add(handler as (payload: never) => void)
    this.listeners.set(event, set)
  }

  off<K extends keyof SessionEvents>(event: K, handler: Listener<K>): void {
    this.listeners.get(event)?.delete(handler as (payload: never) => void)
  }

  emit<K extends keyof SessionEvents>(
    event: K,
    payload: SessionEvents[K],
  ): void {
    for (const handler of this.listeners.get(event) ?? []) {
      try {
        ;(handler as (payload: SessionEvents[K]) => void)(payload)
      } catch (err) {
        console.error(`[unbien] ${String(event)} listener threw`, err)
      }
    }
  }

  clear(): void {
    this.listeners.clear()
  }
}

/** The slice of the core's `RelayClient` this class drives. Declared locally
 *  because the emitted event names (`relayIdentity`, `relayIdentityError`) are
 *  not in the core's published event map. */
interface RelayLike {
  connect(options?: { roomId?: string; roomMeta?: unknown }): Promise<void>
  on(event: "message", handler: (line: string) => void): void
  on(event: "close", handler: () => void): void
  on(event: "error", handler: (err: Error) => void): void
  on(event: "relayIdentity", handler: (identity: RelayIdentity) => void): void
  on(
    event: "relayIdentityError",
    handler: (payload: {
      reason: string
      expectedRelayPubkey?: string
      gotRelayPubkey?: string
    }) => void,
  ): void
  send(line: string, onWritten?: (err?: Error) => void): void
  sendControl(frame: Record<string, unknown>): void
  isOpen(): boolean
  close(): void
  relayIdentity(): RelayIdentity | null
}

function harnessLabel(harness: unknown): string | undefined {
  if (typeof harness === "string") return harness
  if (harness && typeof harness === "object") {
    const h = harness as Record<string, unknown>
    const name = typeof h.name === "string" ? h.name : undefined
    const version = typeof h.version === "string" ? h.version : undefined
    if (name && version) return `${name} ${version}`
    return name
  }
  return undefined
}

export interface RelayIdentity {
  relayPubkey: string
  relayName: string
  relayUrl: string
  endpoints: string[]
}

export interface SessionClientOptions {
  /** TOFU pin. When set, a relay that presents a different key is refused
   *  before any session traffic rides the socket. */
  expectRelayPubkey?: string
  /** Called with the verified relay pubkey after the first `identity_ack`. */
  onRelayIdentity?: (pubkey: string) => void
}

export class SessionClient {
  private readonly events = new Emitter()
  private relay: RelayLike
  private readonly keypair: Ed25519Keypair
  private readonly url: string
  private readonly options: SessionClientOptions

  /** The room being driven. One pairing reaches every room a machine owns, so
   *  choosing a session is a routing change, not a re-pair. */
  private room = "main"
  private status: RelayStatus = "idle"
  private closedByUser = false
  private reconnectDelayMs = 1_000
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    relayUrl: string,
    keypair: Ed25519Keypair,
    options: SessionClientOptions = {},
  ) {
    this.url = toWsUrl(relayUrl)
    this.keypair = keypair
    this.options = options
    this.relay = new RelayClient(
      this.url,
      keypair,
      options.expectRelayPubkey
        ? { expectRelayPubkey: options.expectRelayPubkey }
        : {},
    ) as unknown as RelayLike
  }

  on<K extends keyof SessionEvents>(event: K, handler: Listener<K>): void {
    this.events.on(event, handler)
  }

  getStatus(): RelayStatus {
    return this.status
  }

  getRoom(): string {
    return this.room
  }

  setRoom(roomId: string): void {
    this.room = roomId
  }

  identity(): RelayIdentity | null {
    return this.relay.relayIdentity()
  }

  // ── connection ────────────────────────────────────────────────────────────

  /** An owner subscribes to rooms rather than owning one, so no room_id in the
   *  hello. (Frames still carry a `room`; see `sendEnvelope`.) */
  async connect(): Promise<void> {
    this.setStatus("connecting")
    this.wireRelay()
    await this.relay.connect()
    this.setStatus("connected")
    this.pushPairingSet()
  }

  close(): void {
    this.closedByUser = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.setStatus("closed")
    this.relay.close()
    this.events.clear()
  }

  private wireRelay(): void {
    this.relay.on("message", (line) => this.onLine(line))
    this.relay.on("close", () => this.onClosed())
    this.relay.on("relayIdentity", (identity) => {
      this.options.onRelayIdentity?.(identity.relayPubkey)
    })
    this.relay.on("relayIdentityError", (payload) => {
      this.setStatus("identity_mismatch")
      this.events.emit("control", { type: "relay_identity_error", ...payload })
    })
  }

  /** The browser's socket can go quietly dead (tailnet idle drop, phone
   *  backgrounded). The core's watchdog force-closes after ~70s of silence, so
   *  reconnect is the normal path, not an error path. */
  private onClosed(): void {
    if (this.closedByUser) return
    // An identity mismatch is a SECURITY state, not a hiccup: the retry loop
    // must not quietly downgrade the UI to "reconnecting" and leave the user
    // thinking the relay is merely flaky.
    if (this.status !== "identity_mismatch") this.setStatus("reconnecting")
    const delay = this.reconnectDelayMs
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 15_000)
    this.reconnectTimer = setTimeout(() => {
      void this.reconnect()
    }, delay)
  }

  private async reconnect(): Promise<void> {
    if (this.closedByUser) return
    try {
      this.relay = new RelayClient(
        this.url,
        this.keypair,
        this.options.expectRelayPubkey
          ? { expectRelayPubkey: this.options.expectRelayPubkey }
          : {},
      ) as unknown as RelayLike
      this.wireRelay()
      await this.relay.connect()
      this.reconnectDelayMs = 1_000
      this.setStatus("connected")
      this.pushPairingSet()
      this.events.emit("reconnected", undefined)
    } catch {
      this.onClosed()
    }
  }

  /**
   * A device advertises the owner it belongs to (federation v2 §3): this client
   * is its own owner, so its allow-list names only itself. Without the push,
   * federated reply legs back to this device are refused at the far machine.
   * The blob is signed BY this device over the exact bytes the relay verifies.
   */
  private pushPairingSet(): void {
    const pk = encodeEd25519PublicKey(this.keypair.publicKey)
    const blobBytes = Buffer.from(
      JSON.stringify({
        machine_pk: pk,
        owners: [pk],
        version: nextAllowVersion(),
        issued_at: Date.now(),
      }),
      "utf8",
    )
    const sig = ed25519Sign(this.keypair.secretKey, new Uint8Array(blobBytes))
    this.relay.sendControl({
      type: "pairing_set",
      blob: blobBytes.toString("base64"),
      sig: Buffer.from(sig).toString("base64"),
    })
  }

  // ── pairing ───────────────────────────────────────────────────────────────

  pairAwaited(
    invite: PairingInvite,
    deviceName: string,
    timeoutMs = 15_000,
  ): Promise<PairVerdict> {
    // Address the machine the invite came from, and the room its pi owns.
    this.routingPeer = invite.epk
    this.room = invite.roomId
    return new Promise((resolve) => {
      const settle = (verdict: PairVerdict): void => {
        clearTimeout(timer)
        this.events.off("control", onControl)
        resolve(verdict)
      }
      const onControl = (frame: Record<string, unknown>): void => {
        if (frame.type === "pair_ok") {
          settle({
            ok: true,
            machine: frame,
            relayPubkey: this.identity()?.relayPubkey,
            hostname:
              typeof frame.hostname === "string" ? frame.hostname : undefined,
            sessionName:
              typeof frame.session_name === "string"
                ? frame.session_name
                : undefined,
            harness: harnessLabel(frame.harness),
            capabilities: Array.isArray(frame.capabilities)
              ? (frame.capabilities as string[])
              : undefined,
            roomId:
              typeof frame.room_id === "string" ? frame.room_id : undefined,
          })
        } else if (frame.type === "pair_error") {
          settle({
            ok: false,
            detail: String(frame.message ?? frame.code ?? "rejected"),
          })
        } else if (frame.type === "relay_identity_error") {
          settle({
            ok: false,
            detail:
              "the relay at this URL is not the one you paired with (pinned " +
              `${String(frame.expectedRelayPubkey ?? "?").slice(0, 12)}…, got ` +
              `${String(frame.gotRelayPubkey ?? "unverified").slice(0, 12)}…). ` +
              "If you rotated the relay deliberately, forget the relay and re-pair.",
          })
        }
        // any other control frame: keep waiting for the machine's verdict
      }
      const timer = setTimeout(() => {
        this.events.off("control", onControl)
        settle({
          ok: false,
          detail: "timed out — run `/unbien pair` again for a fresh code",
        })
      }, timeoutMs)

      this.events.on("control", onControl)
      // The one non-envelope frame a client ever sends — nothing exists before it.
      this.sendStock({
        type: "pair_request",
        id: correlationId(),
        token: invite.token,
        device_name: deviceName,
      })
    })
  }

  // ── discovery ─────────────────────────────────────────────────────────────

  /** Snapshot a machine's open rooms, honestly. */
  listRooms(epk: string, timeoutMs = 5_000): Promise<RelayRoomList> {
    return new Promise((resolve) => {
      const settle = (result: RelayRoomList): void => {
        clearTimeout(timer)
        this.events.off("relayControl", onControl)
        resolve(result)
      }
      const onControl = (frame: Record<string, unknown>): void => {
        if (frame.type === "error") {
          const code = typeof frame.code === "string" ? frame.code : "error"
          if (code === "unknown_peer") {
            settle({
              status: "unknown_peer",
              peer: typeof frame.peer === "string" ? frame.peer : undefined,
            })
          } else {
            settle({ status: "refused", detail: code })
          }
          return
        }
        if (frame.type !== "rooms" || frame.peer !== epk) return
        const rooms = Array.isArray(frame.rooms)
          ? (frame.rooms as RoomInfo[])
          : []
        settle({ status: "ok", rooms })
      }
      const timer = setTimeout(() => settle({ status: "timeout" }), timeoutMs)
      this.events.on("relayControl", onControl)
      this.relay.send(JSON.stringify({ type: "rooms_check", peers: [epk] }))
    })
  }

  /** Live room announcements for a machine (room_announced / room_ended). The
   *  relay intersects this request with the target machine's allow-list, so an
   *  unpaired device silently gets nothing — which is why the snapshot above is
   *  the primary path and this only keeps it fresh. */
  subscribeRooms(peers: string[]): void {
    if (peers.length === 0) return
    this.relay.send(JSON.stringify({ type: "subscribe_rooms", peers }))
  }

  // ── the session channel ───────────────────────────────────────────────────

  /** Ask the machine to replay panels + pending dialogs for this session. */
  requestSync(): void {
    this.sendUb("session_sync", { id: correlationId() })
  }

  /** Walk the persisted transcript. Paged; a single call is one page. */
  async getEntries(
    since?: string,
    maxPages = 200,
  ): Promise<{ entries: unknown[]; leafId?: string }> {
    const all: unknown[] = []
    let cursor: string | undefined = since
    for (let page = 0; page < maxPages; page++) {
      let data: { entries?: unknown[]; leafId?: string } | undefined
      try {
        data = await this.request<{ entries?: unknown[]; leafId?: string }>(
          "get_entries",
          cursor ? { since: cursor } : {},
        )
      } catch {
        break // timeout or error: keep whatever we already walked
      }
      const entries = data?.entries ?? []
      const leaf = data?.leafId
      if (entries.length === 0 || !leaf) break
      all.push(...entries)
      if (leaf === cursor) break // leaf did not advance — the walk is spinning
      cursor = leaf
    }
    return { entries: all, leafId: cursor }
  }

  /** Issue a pi rpc verb and await its correlated `response`. */
  request<T>(
    type: string,
    params: Record<string, unknown> = {},
    timeoutMs = 15_000,
  ): Promise<T | undefined> {
    const id = correlationId()
    return new Promise((resolve, reject) => {
      const onEnvelope = (env: EnvelopeMessage): void => {
        const rpc = env.rpc
        if (typeof rpc !== "object" || rpc === null) return
        const frame = rpc as Record<string, unknown>
        if (frame.type !== "response" || frame.id !== id) return
        cleanup()
        if (frame.success === false) {
          reject(new Error(String(frame.error ?? `${type} failed`)))
          return
        }
        resolve(frame.data as T | undefined)
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`${type}: timed out`))
      }, timeoutMs)
      const cleanup = (): void => {
        clearTimeout(timer)
        this.events.off("envelope", onEnvelope)
      }
      this.events.on("envelope", onEnvelope)
      this.sendEnvelope({ rpc: { type, id, ...params } })
    })
  }

  /** Drive the agent. `prompt`/`steer`/`abort` are pi's own rpc verbs. */
  prompt(message: string): void {
    this.sendEnvelope({ rpc: { type: "prompt", id: correlationId(), message } })
  }

  steer(message: string): void {
    this.sendEnvelope({ rpc: { type: "steer", id: correlationId(), message } })
  }

  /** Queue for after the current turn ends. */
  queue(message: string): void {
    this.sendEnvelope({
      rpc: {
        type: "prompt",
        id: correlationId(),
        message,
        streamingBehavior: "followUp",
      },
    })
  }

  abort(): void {
    this.sendEnvelope({ rpc: { type: "abort", id: correlationId() } })
  }

  answerUi(response: UiResponse): void {
    this.sendEnvelope({ rpc: response })
  }

  /** un-bien's own plane: session_launch, sessions_list, fork, navigate… */
  sendUb(type: string, params: Record<string, unknown> = {}): void {
    this.sendEnvelope({
      ub: {
        type,
        id: correlationId(),
        ...params,
      } as unknown as EnvelopeMessage["ub"],
    })
  }

  private sendEnvelope(env: EnvelopeMessage): void {
    this.sendInner(stampEnvelope(env))
  }

  private sendStock(inner: unknown): void {
    this.sendInner(inner)
  }

  private sendInner(inner: unknown): void {
    this.relay.send(encodeOuter(inner, this.routingPeer, this.room))
  }

  /** The `peer` of the outer envelope: the machine being addressed. Set by
   *  pairing / attach; never parsed, echoed verbatim. */
  private routingPeer = ""

  setRoutingPeer(epk: string): void {
    this.routingPeer = epk
  }

  // ── inbound ───────────────────────────────────────────────────────────────

  private onLine(line: string): void {
    const inbound = decodeInbound(line)
    if (inbound.kind === "control") {
      this.events.emit("relayControl", inbound.frame)
      if (inbound.frame.ct !== undefined)
        this.events.emit("control", inbound.frame)
      return
    }
    if (inbound.kind === "envelope") {
      this.events.emit("envelope", inbound.frame)
      return
    }
    this.events.emit("control", inbound.frame)
  }

  private setStatus(status: RelayStatus): void {
    if (this.status === status) return
    this.status = status
    this.events.emit("status", status)
  }
}
