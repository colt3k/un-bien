import type { EnvelopeMessage } from "@geohar/un-bien/client"
import { SessionClient, type RoomInfo } from "./session-client.js"
import {
  TranscriptReducer,
  type AskRequest,
  type TranscriptItem,
} from "./reducer.js"
import { deviceIdentity, devicePublicKey } from "./identity.js"
import { parseInvite } from "./invite.js"
import {
  forgetPeer,
  forgetLastRoom,
  forgetRelay,
  hideReasoning,
  lastRoom,
  listPeers,
  listRelays,
  recordRelayPin,
  rememberPeer,
  rememberLastRoom,
  rememberRelay,
  relayPinFor,
  setHideReasoning,
  type PairedPeer,
} from "./store.js"

/**
 * The controller: relay connection, pairing, discovery, attach, transcript
 * rendering, composer, and pi-ask dialogs. Deliberately framework-free — the
 * hard part of this client is the wire and the fold, not the DOM, and a spike
 * should not add a rendering dependency before the wire is proven.
 */

interface ActiveSession {
  epk: string
  roomId: string
  name: string
  caps: string[]
  /** The pi sessionId, from `ub hello`. A new one on a stable room means a
   *  different session reused the room. */
  sessionId?: string
}

let toastTimer: ReturnType<typeof setTimeout> | undefined

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id)
  if (!node) throw new Error(`missing #${id}`)
  return node as T
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

export class App {
  private readonly transcript = $<HTMLElement>("transcript")
  private readonly drawer = $<HTMLElement>("drawer")
  private readonly statusDot = $<HTMLElement>("statusDot")
  private readonly title = $<HTMLElement>("sessionTitle")
  private readonly sub = $<HTMLElement>("sessionSub")
  private readonly panels = $<HTMLElement>("panels")
  private readonly asks = $<HTMLElement>("asks")
  private readonly toastEl = $<HTMLElement>("toast")
  private readonly input = $<HTMLTextAreaElement>("input")
  private readonly stopBtn = $<HTMLButtonElement>("stopBtn")
  private readonly sendBtn = $<HTMLButtonElement>("sendBtn")
  /** Reasoning rows are folded always and hidden here — see `render`. */
  private reasoningHidden = hideReasoning()

  private client: SessionClient | null = null
  private relayUrl = ""
  private readonly peers = new Map<string, PairedPeer>()
  private readonly rooms = new Map<string, RoomInfo[]>()
  private readonly reducer = new TranscriptReducer()
  /** row key → element, so streaming updates patch in place instead of
   *  rebuilding the list on every one of the hundreds of delta frames a turn
   *  produces. */
  private readonly rowEls = new Map<string, HTMLElement>()
  private active: ActiveSession | null = null
  private busy = false
  /** Debounce for the post-turn re-read (a turn ends with several frames). */
  private resyncTimer: ReturnType<typeof setTimeout> | undefined

  constructor() {
    for (const peer of listPeers()) this.peers.set(peer.epk, peer)
    this.bindUi()
    this.renderPeerList()
    this.renderRelayList()
    const remembered = listRelays()[0]
    if (remembered) {
      $<HTMLInputElement>("relayUrl").value = remembered.url
      void this.connect(remembered.url)
    }
    this.sub.textContent = `device key ${devicePublicKey().slice(0, 12)}…`
  }

  // ── wiring ────────────────────────────────────────────────────────────────

  private bindUi(): void {
    $("drawerToggle").addEventListener("click", () => {
      this.drawer.hidden = !this.drawer.hidden
    })
    $("relayConnect").addEventListener("click", () => {
      const url = $<HTMLInputElement>("relayUrl").value.trim()
      if (url) void this.connect(url)
    })
    $("pairBtn").addEventListener("click", () => void this.pair())
    this.sendBtn.addEventListener("click", () => this.send("auto"))
    $("queueBtn").addEventListener("click", () => this.send("queue"))
    this.stopBtn.addEventListener("click", () => this.client?.abort())
    this.input.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault()
        this.send("auto")
      }
    })
    this.input.addEventListener("input", () => this.autogrow())
    const hideBox = $<HTMLInputElement>("hideReasoning")
    hideBox.checked = this.reasoningHidden
    hideBox.addEventListener("change", () => {
      this.reasoningHidden = hideBox.checked
      setHideReasoning(this.reasoningHidden)
      // Re-render: hidden rows leave the DOM, shown rows come back with their
      // keys, because the reducer kept folding them the whole time.
      this.render()
    })
  }

  private autogrow(): void {
    this.input.style.height = "auto"
    this.input.style.height = `${Math.min(this.input.scrollHeight, 160)}px`
  }

  // ── connection ────────────────────────────────────────────────────────────

  async connect(url: string): Promise<void> {
    this.client?.close()
    this.relayUrl = url
    const pin = relayPinFor(url)
    const client = new SessionClient(url, deviceIdentity(), {
      expectRelayPubkey: pin,
      onRelayIdentity: (pubkey) => recordRelayPin(url, pubkey),
    })
    this.client = client

    client.on("status", (status) => {
      this.statusDot.className = `dot ${status}`
      if (status === "identity_mismatch") {
        this.toast(
          "relay identity mismatch — this URL is serving a different relay than the one you paired with",
        )
      }
    })
    client.on("relayControl", (frame) => this.onRelayControl(frame))
    client.on("envelope", (env) => this.onEnvelope(env))
    client.on("control", (frame) => {
      if (frame.type === "pair_ok" || frame.type === "pair_error") return // pair flow awaits its own verdict
      if (typeof frame.type === "string" && frame.type.startsWith("_")) {
        this.toast(
          `relay sent an unreadable frame: ${String(frame._raw ?? frame.type)}`,
        )
      }
    })
    client.on("reconnected", () => {
      // The socket died (idle watchdog, tailnet drop, phone backgrounded).
      // Re-subscribe, refresh discovery, and re-read from the leaf we hold —
      // the protocol's incremental path, not a full re-dump.
      client.subscribeRooms([...this.peers.keys()])
      void this.refreshRooms()
      if (this.active)
        void this.attach(this.active.epk, this.active.roomId, this.active.name)
    })

    try {
      await client.connect()
      rememberRelay(url, pin)
      this.renderRelayList()
      client.subscribeRooms([...this.peers.keys()])
      await this.refreshRooms()
      // Resume what the user was last driving. A reload, a recycled phone tab or
      // a sleep should bring the transcript back, not an empty screen at the
      // top of an empty column.
      void this.resumeSession()
    } catch (err) {
      this.statusDot.className = "dot idle"
      this.toast(
        `connect failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  async pair(): Promise<void> {
    const code = $<HTMLTextAreaElement>("pairCode").value.trim()
    const deviceName =
      $<HTMLInputElement>("deviceName").value.trim() || "unbien-web"
    if (!this.client) {
      this.toast(
        "connect to a relay first — a pairing is only valid on one relay",
      )
      return
    }
    let invite
    try {
      invite = parseInvite(code)
    } catch (err) {
      this.toast(err instanceof Error ? err.message : String(err))
      return
    }

    this.sub.textContent = "pairing…"
    const verdict = await this.client.pairAwaited(invite, deviceName)
    if (!verdict.ok) {
      this.sub.textContent = `pairing refused: ${verdict.detail}`
      this.toast(`pairing refused: ${verdict.detail}`)
      return
    }
    const paired: PairedPeer = {
      epk: invite.epk,
      deviceName,
      // pair_ok's own fields win over the invite's `n`: a machine is a machine,
      // and the invite string is the SESSION it happened to be pairing from.
      machineName: verdict.sessionName ?? invite.sessionName,
      hostname: verdict.hostname,
      harness: verdict.harness,
      ...(verdict.capabilities ? { caps: verdict.capabilities } : {}),
      relayUrl: this.relayUrl,
      roomHint: verdict.roomId ?? invite.roomId,
      pairedAt: Date.now(),
    }
    rememberPeer(paired)
    this.peers.set(paired.epk, paired)
    if (verdict.relayPubkey) recordRelayPin(this.relayUrl, verdict.relayPubkey)
    this.sub.textContent = "paired"
    this.client.subscribeRooms([...this.peers.keys()])
    await this.refreshRooms()
    this.renderPeerList()
  }

  // ── discovery ─────────────────────────────────────────────────────────────

  private onRelayControl(frame: Record<string, unknown>): void {
    switch (frame.type) {
      case "room_announced":
      case "room_meta_updated": {
        const epk = String(frame.peer ?? "")
        const room = frame as unknown as RoomInfo
        if (!epk || !room.room_id) return
        const list = this.rooms.get(epk) ?? []
        const next = [...list.filter((r) => r.room_id !== room.room_id), room]
        this.rooms.set(epk, next)
        this.renderPeerList()
        // A re-announcement of the room being driven means the machine came
        // back on the same room id — pi restarted, so the history we hold is
        // stale (new session, entries possibly replaced). The relay does not
        // tell the device the machine dropped, so this is the signal we get.
        // `room_meta_updated` is excluded: that fires on renames and would
        // rebuild the transcript under the user's fingers.
        if (
          frame.type === "room_announced" &&
          this.active &&
          this.active.epk === epk &&
          this.active.roomId === room.room_id
        ) {
          this.toast("machine re-announced this session — re-syncing")
          void this.attach(epk, room.room_id, room.name ?? this.active.name)
        }
        break
      }
      case "room_ended": {
        const epk = String(frame.peer ?? "")
        const roomId = String(frame.room_id ?? "")
        const list = this.rooms.get(epk) ?? []
        this.rooms.set(
          epk,
          list.filter((r) => r.room_id !== roomId),
        )
        this.renderPeerList()
        if (
          this.active &&
          this.active.epk === epk &&
          this.active.roomId === roomId
        ) {
          forgetLastRoom(epk)
          this.toast("that session ended on the machine")
          this.title.textContent = `${this.active.name} (ended)`
          // The relay saying the room is gone IS the session ending for a
          // viewer, even when the machine never got to send `session_shutdown`.
          this.reducer.setEnded(true)
          this.render()
        }
        break
      }
      case "error": {
        const code = String(frame.code ?? "error")
        if (code === "unknown_peer") {
          this.toast(
            "this device is not paired on that machine — run /unbien pair again",
          )
        }
        break
      }
      default:
        break
    }
  }

  async refreshRooms(): Promise<void> {
    if (!this.client) return
    for (const peer of this.peers.values()) {
      const result = await this.client.listRooms(peer.epk)
      if (result.status === "ok") this.rooms.set(peer.epk, result.rooms)
      else this.rooms.set(peer.epk, [])
      if (result.status !== "ok") this.sub.textContent = explainRooms(result)
    }
    this.renderPeerList()
  }

  private renderPeerList(): void {
    const host = $("peerList")
    host.replaceChildren()
    for (const peer of this.peers.values()) {
      const card = el("div", "card")
      // The machine's name, not the session's: one pairing reaches every room a
      // machine owns, and `pair_ok.session_name` is identical to the room's own
      // name — labelling the machine with it makes the list read like a
      // duplicate of the rooms below it.
      card.append(
        el("div", "name", peer.hostname ?? peer.machineName ?? "machine"),
      )
      const facts = [peer.epk.slice(0, 10) + "…", peer.relayUrl]
      if (peer.harness) facts.push(peer.harness)
      card.append(el("div", "meta", facts.join(" · ")))
      if (peer.caps?.length)
        card.append(el("div", "meta", `${peer.caps.length} capabilities`))
      const forget = el("button", undefined, "unpair")
      forget.addEventListener("click", () => {
        forgetPeer(peer.epk)
        forgetLastRoom(peer.epk)
        this.peers.delete(peer.epk)
        this.rooms.delete(peer.epk)
        this.renderPeerList()
        this.toast(
          "unpaired locally — also revoke it on the machine with `/unbien revoke`",
        )
      })
      card.append(forget)
      const refresh = el("button", undefined, "refresh")
      refresh.addEventListener("click", () => void this.refreshRooms())
      card.append(refresh)
      host.append(card)

      for (const room of this.rooms.get(peer.epk) ?? []) {
        const row = el("div", "card room")
        row.append(el("div", "name", room.name ?? room.room_id))
        const roomFacts = [room.cwd ?? "?"]
        // Only say "N capabilities" here: the caps themselves are the same list
        // the machine card already summarizes, and dumping eleven strings in a
        // phone-width card is unreadable noise.
        if (room.caps?.length)
          roomFacts.push(`${room.caps.length} capabilities`)
        if (room.sessionId) roomFacts.push(room.sessionId.slice(0, 8))
        row.append(el("div", "meta", roomFacts.join(" · ")))
        const open = el("button", undefined, "attach")
        open.addEventListener(
          "click",
          () =>
            void this.attach(peer.epk, room.room_id, room.name ?? room.room_id),
        )
        row.append(open)
        host.append(row)
      }
    }
  }

  private renderRelayList(): void {
    const host = $("relayList")
    host.replaceChildren()
    for (const relay of listRelays()) {
      const card = el("div", "card")
      card.append(el("div", "name", relay.url))
      card.append(
        el(
          "div",
          "meta",
          relay.pubkey
            ? `pinned ${relay.pubkey.slice(0, 12)}…`
            : "no pin recorded",
        ),
      )
      const forget = el("button", undefined, "forget")
      forget.addEventListener("click", () => {
        forgetRelay(relay.url)
        this.renderRelayList()
      })
      card.append(forget)
      host.append(card)
    }
  }

  // ── attach + transcript ───────────────────────────────────────────────────

  async attach(epk: string, roomId: string, name: string): Promise<void> {
    const client = this.client
    if (!client) return
    client.setRoutingPeer(epk)
    client.setRoom(roomId)
    this.active = { epk, roomId, name, caps: [] }
    rememberLastRoom({ epk, roomId, name })
    // Attaching means the room is live and drivable again — clear any ended flag
    // the previous room left behind.
    this.reducer.setEnded(false)
    this.title.textContent = name
    this.sub.textContent = "syncing…"
    this.drawer.hidden = true

    // A full replay on every (re)attach, not an incremental read. Rebuilding
    // from pi's entries gives every row a stable identity (the entry id); an
    // incremental read would add entry-id rows on top of the placeholder rows
    // the live stream created, and this fold has no entry-content-hash dedup
    // (pi's RowBoundsStore) to recognise them as the same block. Cheap and
    // obviously right beats clever and duplicated — see README's gap list.
    this.reducer.reset()
    this.rowEls.clear()
    this.transcript.replaceChildren()

    // The first frame to a trusted peer is what triggers the extension's
    // attach; session_sync asks for panels + pending dialogs. The transcript
    // itself comes from pi's own paged `get_entries`.
    client.requestSync()
    const { entries, leafId } = await client.getEntries()
    // The beacon (pi's leaf entry id) is what makes the fold render: the entry
    // tree backwalks from it to derive the active path, and rows are born only
    // for entries on that path. Entries without a beacon are indexed and stay
    // invisible — that is the membership gate, not a bug.
    this.reducer.applyEntries(entries, leafId ?? null)
    // Turn state comes from pi, not from guessing at the history: a completed
    // entry may still contain tool calls. `get_state.isStreaming` is the same
    // signal the iOS app gates its send/steer button on. Skipped when nothing
    // came back — the machine is away, and a second 15s timeout on top of the
    // first is a 30s dead spinner for no information.
    if (entries.length > 0) {
      const piState = await client
        .request<Record<string, unknown>>("get_state")
        .catch(() => undefined)
      this.reducer.setTurnStreaming(Boolean(piState?.isStreaming))
    } else {
      this.sub.textContent = `${name} · machine not answering — is it connected?`
    }
    client.requestSync()
    this.render()
    this.sub.textContent = `${name} · ${entries.length} entries`
  }

  /** Re-attach the session this client was last driving. The room id is only a
   *  hint — pi's room rotates per session — so the recorded room is honoured
   *  when the machine is still advertising it, and otherwise the machine's
   *  single live room is taken. Attaching nothing on purpose is right when the
   *  machine has no live room: there is nothing to read. */
  private async resumeSession(): Promise<void> {
    if (this.active || !this.client) return
    const held = lastRoom()
    if (!held) return
    const peer = this.peers.get(held.epk)
    if (!peer) {
      forgetLastRoom(held.epk)
      return
    }
    const rooms = this.rooms.get(held.epk) ?? []
    if (rooms.length === 0) return
    const target =
      rooms.find((room) => room.room_id === held.roomId) ??
      (rooms.length === 1 ? rooms[0]! : undefined)
    if (!target) {
      this.sub.textContent = `${rooms.length} sessions on ${peer.hostname ?? peer.machineName ?? "machine"} — pick one`
      return
    }
    await this.attach(
      held.epk,
      target.room_id,
      target.name ?? held.name ?? target.room_id,
    )
  }

  /** After a turn settles, pi has new entries for what just streamed. Re-read
   *  them so the live placeholder rows are RE-KEYED to their durable entry ids
   *  (the match loop) instead of staying `assistant#7` forever — that is what
   *  makes the next reconnect's replay land on the rows already on screen. */
  private scheduleResync(): void {
    if (!this.active || !this.client) return
    clearTimeout(this.resyncTimer)
    this.resyncTimer = setTimeout(() => void this.resyncEntries(), 400)
  }

  private async resyncEntries(): Promise<void> {
    const client = this.client
    if (!client || !this.active) return
    try {
      const { entries, leafId } = await client.getEntries()
      if (entries.length > 0) {
        this.reducer.applyEntries(entries, leafId ?? null)
        this.render()
      }
    } catch {
      // Machine away or room gone: the rows on screen stay as they are.
    }
  }

  private onEnvelope(env: EnvelopeMessage): void {
    const ub = env.ub as unknown as Record<string, unknown> | undefined
    if (ub && typeof ub.type === "string") {
      // `ub` frames are protocol (handshake, sync terminator, launch result),
      // not transcript content.
      this.onUb(ub)
      if (env.rpc === undefined && env.evt === undefined) return
    }
    this.reducer.apply(env)
    const rpc = env.rpc as unknown as Record<string, unknown> | undefined
    if (rpc && (rpc.type === "turn_end" || rpc.type === "agent_settled"))
      this.scheduleResync()
    this.render()
  }

  private onUb(ub: Record<string, unknown>): void {
    switch (ub.type) {
      case "hello": {
        const caps = Array.isArray(ub.caps) ? (ub.caps as string[]) : []
        if (this.active) {
          // A NEW sessionId on a stable room means a different session reused
          // the room — the transcript must not carry the old one over.
          if (this.active.caps.length === 0) {
            this.active.caps = caps
          } else if (ub.sessionId && this.active.sessionId !== ub.sessionId) {
            this.reducer.reset()
            this.rowEls.clear()
            this.transcript.replaceChildren()
          }
          this.active.caps = caps
          this.active.sessionId =
            typeof ub.sessionId === "string" ? ub.sessionId : undefined
        }
        break
      }
      case "session_sync_end": {
        const name =
          typeof ub.session_name === "string" ? ub.session_name : undefined
        if (name && this.active) {
          this.active.name = name
          this.title.textContent = name
        }
        this.sub.textContent = `${this.active?.name ?? "session"} · synced`
        break
      }
      case "session_launch_result": {
        this.toast(
          ub.ok === true
            ? `launched (${String(ub.backend ?? "?")})`
            : `launch failed: ${String(ub.code ?? ub.message ?? "unknown")}`,
        )
        break
      }
      default:
        break
    }
  }

  /** Patch rows in place; append the ones that are new. Order never changes,
   *  because rows are appended in fold order. */
  private render(): void {
    const snapshot = this.reducer.snapshot()
    for (const toast of snapshot.toasts) this.toast(toast.text)
    // "Hide thinking" is a VIEW preference: the reducer still folds every
    // thinking delta, so flipping it back mid-session shows what already
    // arrived. Hiding also stops reasoning pinning the reader to the tail.
    const items = this.reasoningHidden
      ? snapshot.items.filter((item) => item.kind !== "reasoning")
      : snapshot.items
    // Where the reader was, BEFORE the DOM moves. Rows born by a rootward
    // extension insert ABOVE the viewport, and a naive follow would yank the
    // reader to the bottom (or to the top when the column empties).
    const followTail =
      this.transcript.scrollHeight -
        this.transcript.scrollTop -
        this.transcript.clientHeight <
      220
    const anchor = this.anchorRow()
    const anchorTop = anchor?.getBoundingClientRect().top
    // Renames first: a row that became a pi entry id keeps ITS element (and the
    // reader's scroll position). Rebuilding it would leave the old element
    // behind as a ghost row and jump the log. A re-key that only ever appeared
    // as a remove+append is the exact bug the Swift tests call `twin rows`.
    for (const { from, to } of snapshot.rekeys) {
      const node = this.rowEls.get(from)
      if (!node) continue
      this.rowEls.delete(from)
      this.rowEls.set(to, node)
      node.dataset.row = to
    }
    const live = new Set(items.map((item) => item.row))
    for (const item of items) {
      const existing = this.rowEls.get(item.row)
      if (existing) this.patchItem(existing, item)
      else this.transcript.append(this.buildItem(item))
    }
    // Rows that left the transcript (a derive reset, a truncation that dropped
    // a branch): remove the element, or it sits there as a ghost the reducer
    // has already forgotten.
    for (const [row, node] of [...this.rowEls]) {
      if (live.has(row)) continue
      this.rowEls.delete(row)
      node.remove()
    }
    this.renderPanels(snapshot)
    this.renderAsks(snapshot.pendingAsks)
    this.busy = snapshot.flags.streaming
    this.stopBtn.hidden = !snapshot.flags.streaming
    // An ended session is not drivable: say so where the user will hit it rather
    // than letting `prompt` fail with `unknown_peer`/`room_ended` toasts.
    this.sendBtn.disabled = snapshot.flags.ended
    this.input.disabled = snapshot.flags.ended
    if (snapshot.flags.ended)
      this.sub.textContent = `${this.active?.name ?? "session"} · ended`
    if (followTail || !anchor || !anchor.isConnected) {
      this.transcript.scrollTop = this.transcript.scrollHeight
      return
    }
    // Not following the tail: hold the anchor row visually still, whatever grew
    // or moved above it.
    this.transcript.scrollTop += anchor.getBoundingClientRect().top - anchorTop!
  }

  /** The row at the top edge of the scroll area — the thing the reader is
   *  looking at, and therefore what a scroll correction must preserve. */
  private anchorRow(): HTMLElement | null {
    const top = this.transcript.getBoundingClientRect().top
    for (const child of this.transcript.children) {
      const node = child as HTMLElement
      if (node.getBoundingClientRect().bottom > top + 1) return node
    }
    return null
  }

  private buildItem(item: TranscriptItem): HTMLElement {
    const node = el("div", `item ${item.kind}`)
    node.dataset.row = item.row
    if (item.kind === "tool") {
      const details = el("details", "tool-inner")
      const summary = el("summary")
      summary.append(el("span", "who", `tool · ${item.tool ?? "?"}`))
      // The face is shown because it is the honest label: "bash · terminal" or
      // "read · file" says what the card will contain, and "text" says the
      // result did not match a declared spec.
      if (item.face) summary.append(el("span", "face", item.face.kind))
      summary.append(el("span", "state", item.state ?? "running"))
      details.append(summary)
      const body = el("div", "collapsed")
      details.append(body)
      node.append(details)
    } else {
      node.append(el("div", "who", item.kind))
      node.append(el("div", "body", item.text))
    }
    this.rowEls.set(item.row, node)
    this.patchItem(node, item)
    return node
  }

  private patchItem(node: HTMLElement, item: TranscriptItem): void {
    node.classList.toggle("streaming", item.streaming)
    if (item.kind !== "tool") {
      const body = node.querySelector(".body")
      if (body && body.textContent !== item.text) body.textContent = item.text
      this.syncImages(node, item)
      return
    }
    const state = node.querySelector<HTMLElement>(".state")
    if (state) {
      state.textContent = item.state ?? "running"
      state.className = `state ${item.state ?? "running"}`
    }
    // The face label must follow the card: it goes pending → terminal / file /
    // diff as the result settles. Written once at build time it would freeze at
    // "pending" for the card's whole life.
    let faceChip = node.querySelector<HTMLElement>(".face")
    if (item.face) {
      if (!faceChip && state?.parentElement) {
        faceChip = el("span", "face", item.face.kind)
        state.parentElement.insertBefore(faceChip, state)
      } else if (faceChip) faceChip.textContent = item.face.kind
    } else {
      faceChip?.remove()
    }
    const body = node.querySelector<HTMLElement>(".collapsed")
    if (!body) return
    const want = renderToolBody(item)
    if (body.dataset.sig !== want.sig) {
      body.dataset.sig = want.sig
      body.replaceChildren(...want.nodes)
      this.syncImages(body, item)
    }
  }

  /** Draw the image blocks pi rides inline (base64 in the content array). Added
   *  incrementally so a live row gaining an attachment does not rebuild the row,
   *  and never re-added: the fold caps how many a row carries. */
  private syncImages(host: HTMLElement, item: TranscriptItem): void {
    const parts = item.imageParts ?? []
    const drawn = host.querySelectorAll("img.attachment").length
    for (let i = drawn; i < parts.length; i++) {
      const part = parts[i]!
      const img = el("img", "attachment")
      img.src = `data:${part.mime};base64,${part.data}`
      img.loading = "lazy"
      img.alt = `image from ${item.tool ?? item.kind}`
      host.append(img)
    }
  }

  private renderPanels(
    snapshot: ReturnType<TranscriptReducer["snapshot"]>,
  ): void {
    const bits: string[] = []
    if (snapshot.plan)
      bits.push(
        `plan: ${snapshot.plan.project ?? "plan"} (${snapshot.plan.itemCount})`,
      )
    for (const row of snapshot.subagents)
      bits.push(
        `subagent ${row.status}${row.type ? ` · ${row.type}` : ""}: ${row.description ?? row.id}`,
      )
    if (bits.length === 0) {
      this.panels.hidden = true
      return
    }
    this.panels.hidden = false
    this.panels.replaceChildren(...bits.map((bit) => el("div", undefined, bit)))
  }

  private renderAsks(asks: AskRequest[]): void {
    const seen = new Set(asks.map((ask) => ask.id))
    for (const node of [...this.asks.children]) {
      if (!seen.has(node.getAttribute("data-ask") ?? "")) node.remove()
    }
    for (const ask of asks) {
      if (this.asks.querySelector(`[data-ask=\"${ask.id}\"]`)) continue
      this.asks.append(this.buildAsk(ask))
    }
  }

  private buildAsk(ask: AskRequest): HTMLElement {
    const box = el("div", "ask")
    box.setAttribute("data-ask", ask.id)
    box.append(
      el("h3", undefined, ask.title ?? ask.message ?? "the session is asking"),
    )
    const opts = el("div", "opts")
    const respond = (build: () => void): void => {
      build()
      this.reducer.resolveAsk(ask.id)
      box.remove()
    }
    if (ask.method === "confirm") {
      const yes = el("button", undefined, "yes")
      yes.addEventListener("click", () =>
        respond(() =>
          this.client?.answerUi({
            type: "extension_ui_response",
            id: ask.id,
            confirmed: true,
          }),
        ),
      )
      const no = el("button", undefined, "no")
      no.addEventListener("click", () =>
        respond(() =>
          this.client?.answerUi({
            type: "extension_ui_response",
            id: ask.id,
            confirmed: false,
          }),
        ),
      )
      opts.append(yes, no)
    } else if (ask.method === "input" || ask.method === "editor") {
      const field = el(
        ask.method === "editor" ? "textarea" : "input",
      ) as HTMLInputElement
      field.placeholder = ask.placeholder ?? ""
      const submit = el("button", undefined, "submit")
      submit.addEventListener("click", () =>
        respond(() =>
          this.client?.answerUi({
            type: "extension_ui_response",
            id: ask.id,
            value: field.value,
          }),
        ),
      )
      opts.append(field, submit)
    } else {
      for (const option of ask.options ?? []) {
        const button = el("button", undefined, option)
        button.addEventListener("click", () =>
          respond(() =>
            this.client?.answerUi({
              type: "extension_ui_response",
              id: ask.id,
              value: option,
            }),
          ),
        )
        opts.append(button)
      }
    }
    const cancel = el("button", undefined, "cancel")
    cancel.addEventListener("click", () =>
      respond(() =>
        this.client?.answerUi({
          type: "extension_ui_response",
          id: ask.id,
          cancelled: true,
        }),
      ),
    )
    opts.append(cancel)
    box.append(opts)
    return box
  }

  // ── composer ──────────────────────────────────────────────────────────────

  private send(mode: "auto" | "queue"): void {
    const text = this.input.value.trim()
    if (!text || !this.client || !this.active) {
      if (!this.active)
        this.toast("no session attached — pick one from the machines panel")
      return
    }
    // `auto` mirrors the app's two-button rule: a message while the agent is
    // working STEERS it; otherwise it is a fresh prompt. Slash text is sent as
    // an ordinary prompt — pi expands it on the machine (the iOS app's richer
    // command registry + refusal toasts are not implemented here yet).
    if (mode === "queue") this.client.queue(text)
    else if (this.busy) this.client.steer(text)
    else this.client.prompt(text)
    this.input.value = ""
    this.autogrow()
  }

  /** Remote launch: ask the machine's launcher daemon for a new session. */
  launch(cwd: string, name?: string): void {
    this.client?.sendUb("session_launch", {
      mode: "new",
      cwd,
      ...(name ? { name } : {}),
    })
  }

  private toast(message: string): void {
    // A STACK, not one label. One batch can carry several real problems (a
    // refusal, a re-sync, a machine that went away) and the old code showed
    // only the LAST of them for 4 seconds — the most important message lost to
    // a later cosmetic one.
    this.toastLines.push(message)
    if (this.toastLines.length > 3) this.toastLines.shift()
    this.toastEl.replaceChildren(
      ...this.toastLines.map((line) => el("div", "toast-line", line)),
    )
    this.toastEl.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      this.toastLines.length = 0
      this.toastEl.replaceChildren()
      this.toastEl.hidden = true
    }, 6_000)
  }
  private readonly toastLines: string[] = []
}

function explainRooms(result: {
  status: string
  detail?: string
  peer?: string
}): string {
  switch (result.status) {
    case "unknown_peer":
      return "not paired on that machine — run /unbien pair again"
    case "refused":
      return `relay refused the listing (${result.detail ?? "?"})`
    case "timeout":
      return "relay did not answer the session listing — is it reachable?"
    default:
      return ""
  }
}

/** Draw a tool card the way its RESOLVED FACE says — a terminal as terminal
 *  output, a read as a file, an edit as a diff, a search as lines, an agent's
 *  report as prose — rather than dumping whatever text came back. The face came
 *  from the tool's declared result spec (src/tool-faces.ts), so "it is a diff"
 *  is a fact about the result, not a guess from its shape. */
function renderToolBody(item: TranscriptItem): { sig: string; nodes: Node[] } {
  const face = item.face
  const nodes: Node[] = []
  const sig = [
    item.state ?? "",
    face?.kind ?? "none",
    item.text.length,
    item.partial?.length ?? 0,
    item.hunks?.length ?? 0,
    item.notices?.length ?? 0,
    item.imageParts?.length ?? 0,
  ].join("|")

  // Notices (bash truncation, read continuation, a search hitting its limit)
  // belong apart from the output: they are about the output, not part of it.
  const notices =
    face && "notices" in face
      ? ((face as { notices?: string[] }).notices ?? [])
      : []
  for (const notice of notices) nodes.push(el("div", "face-notice", notice))

  switch (face?.kind) {
    case "pending":
      if (item.partial) nodes.push(el("pre", "partial", item.partial))
      break
    case "terminal":
      if (face.diff) nodes.push(...renderHunks(face.diff.hunks))
      else nodes.push(el("pre", "face-term", face.text))
      break
    case "file": {
      const pre = el("pre", "face-file", face.text)
      if (face.lang) pre.dataset.lang = face.lang
      nodes.push(pre)
      break
    }
    case "lines": {
      const list = el("ul", "face-lines")
      for (const line of face.text.split("\n"))
        list.append(el("li", undefined, line))
      nodes.push(list)
      break
    }
    case "diff": {
      // pi's own patch hunks first; a running card may only have the extension's
      // pre-rendered sidecar hunks.
      nodes.push(
        ...renderHunks(
          face.hunks ?? (item.hunks as unknown[] | undefined) ?? [],
        ),
      )
      if (face.confirmation)
        nodes.push(el("div", "face-confirm", face.confirmation))
      break
    }
    case "confirmation":
      nodes.push(el("div", "face-confirm", face.text))
      break
    case "script":
      if (face.calls.length > 0) {
        const list = el("ul", "face-calls")
        for (const call of face.calls)
          list.append(
            el(
              "li",
              undefined,
              `${call.name}(${call.args}) · ${call.status}${call.durationMs !== undefined ? ` ${call.durationMs}ms` : ""}${call.error ? ` — ${call.error}` : ""}`,
            ),
          )
        nodes.push(list)
      }
      nodes.push(el("pre", "face-term", face.output))
      break
    case "error":
      nodes.push(el("pre", "face-error", face.text))
      break
    case "markdown":
      nodes.push(el("div", "face-prose", face.text))
      break
    case "text":
    default:
      if (item.partial) nodes.push(el("pre", "partial", item.partial))
      if (item.text)
        nodes.push(el("pre", undefined, item.text.slice(0, 20_000)))
      for (const hunk of (item.hunks as unknown[] | undefined) ?? [])
        nodes.push(...renderHunks([hunk]))
      break
  }
  return { sig, nodes }
}

type DiffLineView = {
  kind: "add" | "remove" | "context"
  text: string
  oldLine?: number
  newLine?: number
}

/** Render diff hunks. Two shapes arrive: this client's parsed patch
 *  (`{kind, text, oldLine, newLine}`) and the extension's pre-rendered sidecar
 *  hunks (`{type: "+" | "-" | " ", text}`), so both are normalized here. */
function renderHunks(hunks: unknown[]): Node[] {
  const nodes: Node[] = []
  for (const raw of hunks) {
    const lines = (raw as { lines?: unknown[] })?.lines ?? []
    const box = el("div", "hunk")
    for (const rawLine of lines) {
      const line = normalizeDiffLine(rawLine)
      if (!line) continue
      const row = el("div", `diff-line ${line.kind}`, line.text)
      const number =
        line.kind === "remove" ? line.oldLine : (line.newLine ?? line.oldLine)
      if (number !== undefined) row.dataset.line = String(number)
      box.append(row)
    }
    nodes.push(box)
  }
  return nodes
}

function normalizeDiffLine(raw: unknown): DiffLineView | undefined {
  const value = raw as Record<string, unknown>
  if (!value) return undefined
  const text = typeof value.text === "string" ? value.text : ""
  const oldLine = typeof value.oldLine === "number" ? value.oldLine : undefined
  const newLine = typeof value.newLine === "number" ? value.newLine : undefined
  if (
    value.kind === "add" ||
    value.kind === "remove" ||
    value.kind === "context"
  )
    return { kind: value.kind, text, oldLine, newLine }
  const marker = value.type ?? value.marker
  if (marker === "+") return { kind: "add", text, newLine }
  if (marker === "-") return { kind: "remove", text, oldLine }
  if (marker === " " || marker === "context")
    return { kind: "context", text, oldLine, newLine }
  return undefined
}
