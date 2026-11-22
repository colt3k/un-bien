import type { EnvelopeMessage } from "@geohar/un-bien/client"
import {
  SessionClient,
  type PairVerdict,
  type RoomInfo,
} from "./session-client.js"
import {
  applyRoomUpdate,
  controlRoomOf,
  isControlRoom,
  isViewableSession,
  launchedRoom,
  mergeRoomLists,
  roomFacts,
  roomTag,
  roomTitle,
  visibleRooms,
  type TrackedRoom,
} from "./room-list.js"
import {
  canEndSession,
  END_CONFIRM_MS,
  END_LABELS,
  END_REASON,
  refusalNotice,
  TERMINATE_QUIET_MS,
} from "./session-end.js"
import {
  TranscriptReducer,
  type AskRequest,
  type TranscriptItem,
} from "./reducer.js"
import { deviceIdentity, devicePublicKey } from "./identity.js"
import {
  MARKDOWN_BUDGET,
  parseMarkdown,
  type Block,
  type Inline,
} from "./markdown.js"
import { bodyRenderKey, mayClamp, wantsMarkdown } from "./body-render.js"
import {
  LOAD_MORE,
  growWindow,
  hiddenBefore,
  nextWindow,
  sliceWindow,
  type TranscriptWindow,
} from "./transcript-window.js"
import { parseInvite, type PairingInvite } from "./invite.js"
import { RELAY_PORT, relayUrlForPage } from "./framing.js"
import { tokenize } from "./highlight.js"
import {
  dirChoices,
  dirsHint,
  launchNameFor,
  nextAutoName,
  parseLaunchDirs,
  type LaunchDirChild,
  type LaunchDirsAnswer,
} from "./launch-dirs.js"
import { describeError, launchFailureHint, toastMessage } from "./notice.js"
import {
  pairResultMessage,
  pairSectionBadge,
  pairSectionOpens,
} from "./pair-status.js"
import {
  forgetPeer,
  forgetLastRoom,
  forgetRelay,
  hideReasoning,
  lastRoom,
  listPeers,
  listRelays,
  monoProse,
  recordRelayPin,
  rememberPeer,
  rememberLastRoom,
  rememberRelay,
  relayPinFor,
  setHideReasoning,
  setMonoProse,
  type PairedPeer,
} from "./store.js"

/**
 * The controller: relay connection, pairing, discovery, attach, transcript
 * rendering, composer, and pi-ask dialogs. Deliberately framework-free — the
 * hard part of this client is the wire and the fold, not the DOM, and a spike
 * should not add a rendering dependency before the wire is proven.
 */

/**
 * Dev-only fixture capture, off unless the URL says `?capture=1`: tees every
 * inbound envelope to `window.__unbienFrames`, so a conformance scenario can be
 * built from a REAL session (live frames and `get_entries` pages from one
 * attach) instead of hand-written frames. Frames are kept raw and unscrubbed —
 * the scenario's own capture script is what scrubs, and it never sees this
 * window's contents unless a human copies them out. Nothing else in the app
 * reads it; the flag is not sticky across a reload.
 */
const CAPTURE_FRAMES = /(?:\?|&)capture=1(?:&|$)/.test(
  typeof location === "object" ? location.search : "",
)
/**
 * `?fresh=1` opens the viewer without re-attaching to the last room. This is an
 * escape hatch, not a feature: the saved room may be an enormous session (this
 * repo's current pi session is 14 MB / 8571 entries / 244 base64 blocks), and the
 * replay builds the whole transcript in one synchronous pass, so the tab wedges
 * for minutes on load — and a wedged tab cannot load a fix.
 */
const SKIP_RESTORE = /(?:\?|&)fresh=1(?:&|$)/.test(location.search)

const capturedFrames: EnvelopeMessage[] = []
if (CAPTURE_FRAMES) {
  const store = globalThis as Record<string, unknown>
  store.__unbienFrames = capturedFrames
  // `__unbienDump()` downloads the capture as JSONL so a scenario can be built
  // without pasting megabytes through a console. It also returns the count, which
  // is the thing you actually want to see after driving a session: a capture with
  // 3 frames means the client was not attached, not that the turn failed.
  store.__unbienDump = (name = "capture") => {
    const body = capturedFrames.map((f) => JSON.stringify(f)).join("\n") + "\n"
    const a = document.createElement("a")
    a.href = URL.createObjectURL(
      new Blob([body], { type: "application/x-ndjson" }),
    )
    a.download = `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`
    a.click()
    URL.revokeObjectURL(a.href)
    return capturedFrames.length
  }
}

interface ActiveSession {
  epk: string
  roomId: string
  name: string
  caps: string[]
  /** The pi sessionId, from `ub hello`. A new one on a stable room means a
   *  different session reused the room. */
  sessionId?: string
  /** A launcher's control room, not a pi session: routable, but with no
   *  transcript and no composer. A reconnect re-points it without a replay. */
  control?: boolean
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

/** Which rows get markdown. The app renders user, assistant and notice text as
 *  markdown and leaves reasoning and the compaction caption plain
 *  (TranscriptRowViews.swift:67, 112, 138); past the same budget the text is
 *  shown as-is, because parsing a 100 KB paste on every delta of a live stream
 *  is a re-layout per keystroke. */
/** Exported for verification: this is the builder every inline token goes through. */
export function inlineNodes(tokens: Inline[]): Node[] {
  const nodes: Node[] = []
  for (const token of tokens) {
    switch (token.type) {
      case "text":
        // Newlines inside a paragraph keep rendering as line breaks, which is
        // what the plain-text path did before.
        token.text.split("\n").forEach((part, i) => {
          if (i > 0) nodes.push(document.createElement("br"))
          nodes.push(document.createTextNode(part))
        })
        break
      case "code":
        nodes.push(el("code", undefined, token.text))
        break
      case "bold":
        nodes.push(el("strong", undefined, token.text))
        break
      case "em":
        nodes.push(el("em", undefined, token.text))
        break
      case "link": {
        const a = document.createElement("a")
        a.href = token.href
        a.rel = "noopener noreferrer"
        a.textContent = token.text
        nodes.push(a)
        break
      }
    }
  }
  return nodes
}

type PairingDetails = {
  uri: string
  expiresAt?: number
  room?: string
  name?: string
}

/** The structured payload of a `un-bien:pair-code` message, taken from the fold.
 *  Reading it here rather than scraping the display text is what the producer
 *  asks for: `extension/src/commands/pairing.ts:124-136` sends `details` as the
 *  "structured payload for RPC clients: render their own QR from `uri` + show
 *  the expiry, without scraping the display string". */
function pairingDetails(item: TranscriptItem): PairingDetails | null {
  const source = item.details
  if (item.customType !== "un-bien:pair-code" || !source) return null
  const uri = typeof source.uri === "string" ? source.uri : ""
  if (!uri) return null
  return {
    uri,
    expiresAt:
      typeof source.expiresAt === "number" ? source.expiresAt : undefined,
    room: typeof source.roomId === "string" ? source.roomId : undefined,
    name: typeof source.name === "string" ? source.name : undefined,
  }
}

/** The pairing notice as a card: what it is, which room, how long it lasts, and
 *  the code/QR behind a deliberate reveal. Two things this is fixing at once: a
 *  ~30-line QR wall dominating the transcript of every attached client, and a
 *  live credential sitting on screen by default. The ASCII the machine sent
 *  stays reachable — hiding it outright would take away the one thing a second
 *  monitor gives you. */
function pairingCard(
  item: TranscriptItem,
  details: PairingDetails,
): HTMLElement {
  const card = el("div", "pair-card")
  const head = el("div", "pair-head")
  head.append(el("strong", undefined, "Pair a device"))
  const where = [details.name, details.room].filter(Boolean).join(" · ")
  if (where) head.append(el("span", "pair-where", where))
  const expired =
    details.expiresAt !== undefined && details.expiresAt < Date.now()
  head.append(
    el(
      "span",
      expired ? "pair-when expired" : "pair-when",
      details.expiresAt === undefined
        ? "no expiry reported"
        : expired
          ? `expired ${new Date(details.expiresAt).toLocaleTimeString()}`
          : `valid until ${new Date(details.expiresAt).toLocaleTimeString()}`,
    ),
  )
  card.append(head)

  const secret = el("div", "pair-secret collapsed")
  const uri = el("pre", "md-code")
  uri.append(el("code", undefined, details.uri))
  secret.append(uri)

  const copy = el("button", "pill")
  copy.type = "button"
  copy.textContent = "copy pairing code"
  copy.addEventListener("click", () => {
    navigator.clipboard
      ?.writeText(details.uri)
      .then(() => (copy.textContent = "copied"))
      .catch(() => (copy.textContent = "copy failed"))
  })
  secret.append(copy)

  if (item.text.trim() !== "") {
    const qr = el("pre", "md-code pair-qr")
    qr.append(el("code", undefined, item.text))
    secret.append(qr)
  }

  const reveal = el("button", "pill")
  reveal.type = "button"
  reveal.textContent = "show pairing code"
  reveal.addEventListener("click", () => {
    const collapsed = secret.classList.toggle("collapsed")
    reveal.textContent = collapsed ? "show pairing code" : "hide pairing code"
  })
  card.append(reveal, secret)
  return card
}

/** Exported for verification: block-level rendering, including fenced code. */
export function blockNodes(blocks: Block[]): Node[] {
  const nodes: Node[] = []
  for (const block of blocks) {
    switch (block.type) {
      case "code": {
        const pre = el("pre", "md-code")
        const code = document.createElement("code")
        // pi colours a block it recognises token by token, and one it does not
        // as a single colour (`mdCodeBlock` — the green in its transcript).
        // Same split here, so an unknown fence is coloured rather than left flat.
        const tokens = tokenize(block.text, block.lang)
        if (tokens === null) code.classList.add("md-code-plain")
        else
          for (const token of tokens)
            code.append(
              token.role === "plain"
                ? token.text
                : el("span", `tk-${token.role}`, token.text),
            )
        pre.append(code)
        nodes.push(pre)
        break
      }
      case "heading": {
        const level = Math.min(6, Math.max(1, block.level))
        const h = document.createElement(
          `h${level}` as keyof HTMLElementTagNameMap,
        )
        h.className = "md-heading"
        h.append(...inlineNodes(block.inline))
        nodes.push(h)
        break
      }
      case "list": {
        const list = document.createElement(block.ordered ? "ol" : "ul")
        for (const item of block.items) {
          const li = el("li")
          li.append(...inlineNodes(item))
          list.append(li)
        }
        nodes.push(list)
        break
      }
      case "table": {
        // Wrapped in a scroller: a wide table must not widen the transcript, and
        // on a phone it has to scroll sideways inside its own block.
        const wrap = el("div", "md-table-wrap")
        // A wide table has to be scrollable by keyboard, not only by trackpad:
        // a scroll container with no tabindex is invisible to keyboard users.
        wrap.tabIndex = 0
        wrap.setAttribute("role", "region")
        wrap.setAttribute("aria-label", "Table")
        const table = el("table", "md-table")
        const head = document.createElement("thead")
        const headRow = document.createElement("tr")
        block.header.forEach((cell, i) => {
          const th = document.createElement("th")
          th.scope = "col"
          const align = block.align[i]
          if (align) th.className = `align-${align}`
          th.append(...inlineNodes(cell))
          headRow.append(th)
        })
        head.append(headRow)
        const body = document.createElement("tbody")
        for (const row of block.rows) {
          const tr = document.createElement("tr")
          row.forEach((cell, i) => {
            const td = document.createElement("td")
            const align = block.align[i]
            if (align) td.className = `align-${align}`
            td.append(...inlineNodes(cell))
            tr.append(td)
          })
          body.append(tr)
        }
        table.append(head, body)
        wrap.append(table)
        nodes.push(wrap)
        break
      }
      case "quote": {
        const quote = el("blockquote")
        quote.append(...inlineNodes(block.inline))
        nodes.push(quote)
        break
      }
      case "rule":
        nodes.push(el("hr"))
        break
      case "para": {
        const p = el("p", "md-p")
        p.append(...inlineNodes(block.inline))
        nodes.push(p)
        break
      }
    }
  }
  return nodes
}

/** The newest answer row in a window: assistant first, then a notice. */
function findTailRow(shown: TranscriptItem[]): string {
  for (let i = shown.length - 1; i >= 0; i--) {
    const item = shown[i]
    if (item && (item.kind === "assistant" || item.kind === "notice"))
      return item.row
  }
  return ""
}

export class App {
  private readonly transcript = $<HTMLElement>("transcript")
  private readonly drawer = $<HTMLDialogElement>("drawer")
  private readonly statusDot = $<HTMLElement>("statusDot")
  private readonly title = $<HTMLElement>("sessionTitle")
  private readonly sub = $<HTMLElement>("sessionSub")
  private readonly panels = $<HTMLElement>("panels")
  private readonly asks = $<HTMLElement>("asks")
  private readonly toastEl = $<HTMLElement>("toast")
  /** The pair verdict, rendered inside the sheet — see `pair-status.ts`. */
  private readonly pairStatusEl = $<HTMLElement>("pairStatus")
  /**
   * The "Pair a machine" disclosure. `aria-expanded` on the trigger is the
   * state; the form itself hides with `hidden="until-found"`, whose IDL getter
   * reads false, so the boolean is kept here rather than re-read from the DOM.
   */
  private readonly pairToggle = $<HTMLButtonElement>("pairToggle")
  private readonly pairForm = $<HTMLElement>("pairForm")
  private readonly pairState = $<HTMLElement>("pairState")
  private pairFormOpen = true
  /** The notice stack while the sheet is open. See `renderNotices`. */
  private readonly noticeEl = $<HTMLElement>("noticeBar")
  private readonly input = $<HTMLTextAreaElement>("input")
  private readonly stopBtn = $<HTMLButtonElement>("stopBtn")
  private readonly sendBtn = $<HTMLButtonElement>("sendBtn")
  /** End the session (the remote `/quit`). `endSentFor` holds the request id we
   *  put on the wire — the machine answers by ENDING THE ROOM, never with a
   *  result frame, so a request that is not followed by `room_ended` inside the
   *  quiet window was refused by its gate, however the click felt. */
  private readonly endBtn = $<HTMLButtonElement>("endSessionBtn")
  private endArmed = false
  private endSentFor: string | null = null
  /** The open session is over. Its caps outlive the room in this client, so the
   *  control needs the fact itself to go away. */
  private sessionEnded = false
  private endArmTimer: ReturnType<typeof setTimeout> | undefined
  private endWaitTimer: ReturnType<typeof setTimeout> | undefined
  /** Hidden while a control room is open — see `joinControlRoom`. */
  private readonly composer = $<HTMLElement>("composer")
  private readonly launchPanel = $<HTMLElement>("launchPanel")
  private readonly launchHeading = $<HTMLElement>("launchHeading")
  private readonly launchCwd = $<HTMLInputElement>("launchCwd")
  private readonly launchName = $<HTMLInputElement>("launchName")
  private readonly launchNote = $<HTMLElement>("launchNote")
  /** The machine-reported allow-list, offered as the FOLDER FIELD'S OWN dropdown
   *  (`<datalist>`), so picking a path is part of filling the field in rather
   *  than a second control to cross-reference. See `launch-dirs.ts`. */
  private readonly launchDirsHint = $<HTMLElement>("launchDirsHint")
  private readonly launchDirOptions = $<HTMLDataListElement>("launchDirOptions")
  /** Reasoning rows are folded always and hidden here — see `render`. */
  private reasoningHidden = hideReasoning()
  /** One monospace grid for the whole transcript, as pi's terminal sets it. A
   *  preference, not a redesign: it is the closest thing to pi and the least
   *  legible on a narrow screen, so the user decides. */
  private monoProseMode = monoProse()

  private client: SessionClient | null = null
  private relayUrl = ""
  private readonly peers = new Map<string, PairedPeer>()
  private readonly rooms = new Map<string, TrackedRoom[]>()
  private readonly reducer = new TranscriptReducer()
  /** row key → element, so streaming updates patch in place instead of
   *  rebuilding the list on every one of the hundreds of delta frames a turn
   *  produces. */
  private readonly rowEls = new Map<string, HTMLElement>()
  // The newest answer row in the current window, remembered between renders so a
  // node built mid-render can decide whether to clamp itself.
  private tailRowId = ""
  /** Which slice of the transcript is drawn. Null until the first render. */
  private window: TranscriptWindow | null = null
  /** Rows in the last render's item list, for the "load earlier" control. */
  private lastItemCount = 0
  private active: ActiveSession | null = null
  private busy = false
  /** A pair request in flight (up to the 15s verdict timeout). */
  private pairBusy = false
  /** A `session_launch` we asked for and have not seen the room for. The id is
   *  the correlation key: the machine echoes it in `session_launch_result
   *  .in_reply_to` and, once pi starts, in the new room's `launchReq`. */
  private pendingLaunch: { id: string; epk: string; cwd: string } | null = null
  private launchTimer: ReturnType<typeof setTimeout> | undefined
  /** A `session_launch_dirs` request in flight, correlated the same way: the id
   *  is echoed in `session_launch_dirs_result.in_reply_to`, so an answer for a
   *  control room the user has already left is dropped. */
  private pendingDirs: { id: string; epk: string } | null = null
  private dirsTimer: ReturnType<typeof setTimeout> | undefined
  /** The paths the machine offered. Kept so a value that is EXACTLY one of them
   *  counts as a pick while typing (and only then does the name follow). */
  private launchChoices: LaunchDirChild[] = []
  /** The name this client last pre-filled. That is what makes it safe to
   *  replace later: a name the user typed themselves never is. */
  private autoFilledName = ""
  /** Debounce for the post-turn re-read (a turn ends with several frames). */
  private resyncTimer: ReturnType<typeof setTimeout> | undefined

  constructor() {
    for (const peer of listPeers()) this.peers.set(peer.epk, peer)
    this.bindUi()
    this.renderPeerList()
    this.renderRelayList()
    const remembered = listRelays()[0]
    const relayInput = $<HTMLInputElement>("relayUrl")
    // The relay is almost always on the SAME box as the page — `start.sh`
    // brings up both, and a phone reaches them through the same tailnet host.
    // So the URL you connected to, with the relay's port, is the honest
    // default: shown in the box before you type, and used if you don't.
    const guess = relayUrlForPage(location.href, RELAY_PORT)
    if (guess) relayInput.placeholder = guess
    if (remembered) {
      relayInput.value = remembered.url
      void this.connect(remembered.url)
    } else if (guess) {
      relayInput.value = guess
      void this.connect(guess)
    }
    this.sub.textContent = `device key ${devicePublicKey().slice(0, 12)}…`
  }

  // ── wiring ────────────────────────────────────────────────────────────────

  private bindUi(): void {
    // A modal <dialog>: the browser handles Escape, restores focus to this
    // trigger on close, and makes the rest of the page inert while it is open.
    // That inertness is exactly why the ☰ cannot double as the close control —
    // hence the ✕ inside the drawer and a light-dismiss tap on the backdrop.
    $("drawerToggle").addEventListener("click", () => {
      if (!this.drawer.open) this.drawer.showModal()
    })
    // Two close controls (top ✕, sticky bottom bar) — both dismiss the same way.
    for (const btn of this.drawer.querySelectorAll(".drawer-close")) {
      btn.addEventListener("click", () => this.drawer.close())
    }
    // Tap the dimmed area (the dialog box itself, outside its content) to dismiss.
    this.drawer.addEventListener("click", (event: MouseEvent) => {
      if (event.target === this.drawer) this.drawer.close()
    })
    // Keep aria-expanded honest for whatever path closed it (✕, Escape, backdrop).
    this.drawer.addEventListener("toggle", () => {
      $("drawerToggle").setAttribute("aria-expanded", String(this.drawer.open))
      // Deciding the pairing form's state as the sheet opens — rather than the
      // moment a pairing lands — keeps the verdict readable: collapsing the
      // section that holds it would fold it away under the hand that just
      // pressed `pair`. A sheet opened later shows it collapsed and `paired`.
      if (this.drawer.open)
        this.setPairFormOpen(pairSectionOpens(this.peers.size))
      // A notice stack does not get to disappear because the half of the screen
      // it was painted in just closed. Re-render it into whichever is visible.
      if (this.toastLines.length > 0) this.renderNotices()
    })
    this.pairToggle.addEventListener("click", () =>
      this.setPairFormOpen(!this.pairFormOpen),
    )
    $("relayConnect").addEventListener("click", () => {
      const url = $<HTMLInputElement>("relayUrl").value.trim()
      if (url) void this.connect(url)
    })
    $("pairBtn").addEventListener("click", () => void this.pair())
    $("showControlRooms").addEventListener("change", () =>
      this.renderPeerList(),
    )
    $("loadEarlierBtn").addEventListener("click", () => {
      if (!this.window) return
      this.window = growWindow(this.window, this.lastItemCount, LOAD_MORE)
      this.render()
    })
    $("launchClose").addEventListener("click", () => this.closeLaunchPanel())
    $("launchBtn").addEventListener("click", () => this.requestLaunch())
    for (const field of [this.launchCwd, this.launchName]) {
      field.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key === "Enter") {
          event.preventDefault()
          this.requestLaunch()
        }
      })
    }
    // A value that is exactly one of the offered paths — a dropdown pick, a
    // paste, or retyping a whole path — counts as picking it, so the name
    // follows it.
    this.launchCwd.addEventListener("input", () => this.applyNameIfPicked())
    // A TYPED path is a selection too, once the field commits: tabbing out or
    // pressing Enter names the session after the folder they wrote.
    this.launchCwd.addEventListener("change", () => this.applyNameForCwd())
    this.sendBtn.addEventListener("click", () => this.send("auto"))
    $("queueBtn").addEventListener("click", () => this.send("queue"))
    this.stopBtn.addEventListener("click", () => this.client?.abort())
    this.endBtn.addEventListener("click", () => this.onEndSessionClick())
    this.input.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault()
        this.send("auto")
      }
    })
    this.input.addEventListener("input", () => this.autogrow())
    // The browser's version of the app's foreground heal (RootView.swift:78 →
    // `AppModel.refreshBusyState`): a hidden tab is throttled and can miss the
    // frames that bracket a turn while its socket stays healthy — which is
    // precisely the case a reconnect-driven re-ask never covers. Ask pi for its
    // state again when the tab comes back and let the fold reconcile.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.refreshBusyState()
    })
    const hideBox = $<HTMLInputElement>("hideReasoning")
    hideBox.checked = this.reasoningHidden
    hideBox.addEventListener("change", () => {
      this.reasoningHidden = hideBox.checked
      setHideReasoning(this.reasoningHidden)
      // Re-render: hidden rows leave the DOM, shown rows come back with their
      // keys, because the reducer kept folding them the whole time.
      this.render()
    })
    // Typeface is a class on the transcript, not a re-render: the rows and
    // their keys do not move, only the grid they are set on.
    const monoBox = $<HTMLInputElement>("monoProse")
    monoBox.checked = this.monoProseMode
    this.transcript.classList.toggle("mono-prose", this.monoProseMode)
    monoBox.addEventListener("change", () => {
      this.monoProseMode = monoBox.checked
      setMonoProse(this.monoProseMode)
      this.transcript.classList.toggle("mono-prose", this.monoProseMode)
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
      if (this.active?.control) {
        // A control room has no transcript to re-read. Re-point the routing so
        // the launch panel keeps working after the socket came back; a full
        // attach would ask a daemon for `get_entries` and never be answered.
        this.client?.setRoutingPeer(this.active.epk)
        this.client?.setRoom(this.active.roomId)
      } else if (this.active)
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
      if (SKIP_RESTORE)
        this.sub.textContent = "not restoring the last room (?fresh=1)"
      else void this.resumeSession()
    } catch (err) {
      this.statusDot.className = "dot idle"
      this.toast(`connect failed: ${describeError(err)}`)
    }
  }

  async pair(): Promise<void> {
    // One attempt at a time: the button stays pressed for up to 15s, and a
    // second click only re-sends the same request and starts a second listener.
    if (this.pairBusy) return
    const code = $<HTMLTextAreaElement>("pairCode").value.trim()
    const deviceName =
      $<HTMLInputElement>("deviceName").value.trim() || "unbien-web"
    // Every outcome says so in the sheet. Before, the only trace of a refused
    // pairing was a toast under the drawer and a subtitle nobody could see.
    const refuse = (message: string): void => {
      this.setPairStatus(message, "error")
      this.sub.textContent = message
      this.toast(message)
    }
    if (!this.client) {
      refuse("connect to a relay first — a pairing is only valid on one relay")
      return
    }
    let invite: PairingInvite
    try {
      invite = parseInvite(code)
    } catch (err) {
      refuse(describeError(err))
      return
    }
    // Decided before the round trip, from this browser's own records. A machine
    // re-ACKs a device it already trusts without spending a token, so a
    // re-pair changes nothing on screen; `alreadyPaired` is the only thing that
    // can tell the user that the silence meant "yes".
    const alreadyPaired = this.peers.has(invite.epk)

    const pairBtn = $<HTMLButtonElement>("pairBtn")
    this.pairBusy = true
    pairBtn.disabled = true
    this.setPairStatus("pairing…", "pending")
    this.sub.textContent = "pairing…"
    let verdict: PairVerdict
    try {
      verdict = await this.client.pairAwaited(invite, deviceName)
    } catch (err) {
      // The request could not be put on the wire at all (no random source in a
      // browser that treats plain http as unsafe, a socket already gone). This
      // used to land as an unhandled rejection out of an async click handler:
      // no toast, no header, a pair button that looked dead.
      verdict = { ok: false, detail: describeError(err) }
    } finally {
      this.pairBusy = false
      pairBtn.disabled = false
    }
    const message = pairResultMessage(verdict, alreadyPaired)
    this.setPairStatus(message, verdict.ok ? "ok" : "error")
    this.sub.textContent = message
    if (!verdict.ok) {
      this.toast(message)
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
    // Spent. A single-use token left in the box comes back as `token_expired`
    // on the next click, which reads as a broken button rather than an old code.
    $<HTMLTextAreaElement>("pairCode").value = ""
    this.client.subscribeRooms([...this.peers.keys()])
    await this.refreshRooms()
    this.renderPeerList()
  }

  /**
   * The pairing verdict, in the sheet. `role="status"` announces it to a
   * screen reader; the three states are coloured so a green line cannot be
   * mistaken for the amber one.
   */
  /**
   * Open or fold the pairing form. `hidden="until-found"` rather than `hidden`:
   * a collapsed form's fields (and the hint telling you where the code comes
   * from) stay reachable to the browser's own find-in-page, which is what a
   * disclosure is supposed to do instead of making text vanish.
   */
  private setPairFormOpen(open: boolean): void {
    this.pairFormOpen = open
    this.pairToggle.setAttribute("aria-expanded", String(open))
    if (open) this.pairForm.removeAttribute("hidden")
    else this.pairForm.setAttribute("hidden", "until-found")
  }

  /**
   * The trigger's state badge. An open pairing form next to a machine already
   * in the list reads as a step still owed; "paired" is what says it is not.
   */
  private renderPairState(): void {
    const badge = pairSectionBadge(this.peers.size)
    this.pairState.hidden = badge === null
    if (badge) this.pairState.textContent = badge
    // The trigger must not advertise an expanded section that the collapsed
    // state has already hidden, so the fold is decided here too — but only while
    // the sheet is shut, never under a pairing attempt in progress.
    if (!this.drawer.open)
      this.setPairFormOpen(pairSectionOpens(this.peers.size))
  }

  private setPairStatus(text: string, kind: "pending" | "ok" | "error"): void {
    this.pairStatusEl.textContent = text
    this.pairStatusEl.className = `pair-status ${kind}`
    this.pairStatusEl.hidden = text === ""
  }

  // ── discovery ─────────────────────────────────────────────────────────────

  private onRelayControl(frame: Record<string, unknown>): void {
    switch (frame.type) {
      case "room_announced":
      case "room_meta_updated": {
        const epk = String(frame.peer ?? "")
        // Two shapes, one handler: `room_announced` carries the room FLAT, while
        // `room_meta_updated` nests what changed under `meta` (both taken from a
        // captured relay frame log). Casting the whole meta frame — as this did —
        // stated only `room_id` and filed `meta`/`type`/`peer` onto the room.
        const roomId = String(frame.room_id ?? "")
        if (!epk || !roomId) return
        const room: RoomInfo =
          frame.type === "room_announced"
            ? ({ ...frame, room_id: roomId } as unknown as RoomInfo)
            : { ...(frame.meta as RoomInfo | undefined), room_id: roomId }
        // One frame, one room: apply it as an UPDATE, not as a listing. Run
        // through the listing merge, each metadata push of a live session was a
        // miss for every other room the machine owns — which deleted the
        // launcher's control room seconds after load and its launch button with
        // it. See `applyRoomUpdate`.
        this.rooms.set(epk, applyRoomUpdate(this.rooms.get(epk) ?? [], room))
        this.renderPeerList()
        // The room one of OUR launches produced, if this announce carries the
        // request id back: open it, the way the app does. Exact match only — a
        // new room that does not echo the id may be another device's session.
        const pending = this.pendingLaunch
        if (pending && pending.epk === epk && frame.type === "room_announced") {
          const launched = launchedRoom(this.rooms.get(epk) ?? [], pending.id)
          if (launched) {
            this.pendingLaunch = null
            clearTimeout(this.launchTimer)
            this.setLaunchNote("session is live — opening it")
            this.toast("session is live — opening it")
            void this.attach(epk, launched.room_id, roomTitle(launched))
            break
          }
        }
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
        // `room_ended` is an explicit signal, so it drops immediately — the
        // grace period in room-list.ts is only for replies that stay silent.
        this.rooms.set(
          epk,
          (this.rooms.get(epk) ?? []).filter((r) => r.room_id !== roomId),
        )
        this.renderPeerList()
        if (
          this.active &&
          this.active.epk === epk &&
          this.active.roomId === roomId
        ) {
          forgetLastRoom(epk)
          this.clearEndRequest()
          this.toast("that session ended on the machine")
          this.title.textContent = `${this.active.name} (ended)`
          // The relay saying the room is gone IS the session ending for a
          // viewer, even when the machine never got to send `session_shutdown`.
          this.reducer.setEnded(true)
          this.sessionEnded = true
          this.refreshEndSession()
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
      if (result.status === "ok")
        this.rooms.set(
          peer.epk,
          mergeRoomLists(this.rooms.get(peer.epk) ?? [], result.rooms),
        )
      // A failed lookup leaves the last known list standing: an error reply is
      // not evidence that the machine's rooms disappeared.
      // Said only when the machine's card is already empty. A second identical
      // `rooms_check` on the same connection is SUPPRESSED by the relay
      // (relay/src/handlers/peer.rs keeps `last_rooms_resp` and counts a
      // rooms_suppressed metric), so pressing refresh twice reliably "times
      // out" here — a healthy machine, nothing changed. The case worth naming
      // is the one the user can act on: nothing known and nothing answering.
      if (
        result.status !== "ok" &&
        (this.rooms.get(peer.epk) ?? []).length === 0
      )
        this.sub.textContent = explainRooms(result)
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
      // Machine-level launch, on the machine card rather than on the control
      // room's row: that is where the app puts it, and it works without the
      // "control rooms" checkbox (the room is hidden by default but still known).
      const all = this.rooms.get(peer.epk) ?? []
      const control = controlRoomOf(all)
      if (control) {
        const launch = el("button", undefined, "new conversation")
        launch.addEventListener("click", () =>
          this.joinControlRoom(peer.epk, control),
        )
        card.append(launch)
      } else if (all.length > 0) {
        // Rooms but no launcher: the machine is reachable, it just has nothing
        // to start a session with. Naming the fix beats a missing button.
        card.append(
          el(
            "div",
            "meta",
            "no launcher daemon here — run `/unbien install` in Pi",
          ),
        )
      }
      host.append(card)

      const hidden = all.filter(isControlRoom).length
      for (const room of visibleRooms(
        all,
        $<HTMLInputElement>("showControlRooms").checked,
      )) {
        const control = isControlRoom(room)
        const row = el("div", "card room")
        const title = el("div", "name")
        title.append(roomTitle(room))
        // The badge is the point: two cards can legitimately carry the same
        // name (pi names a room after the session, which for a machine's
        // launcher is the hostname), so the name alone cannot say which room
        // this is.
        title.append(
          el("span", control ? "tag tag-control" : "tag", roomTag(room)),
        )
        row.append(title)
        row.append(el("div", "meta", roomFacts(room).join(" · ")))
        if (control) {
          row.append(
            el(
              "div",
              "meta",
              "no transcript — this room starts sessions on the machine",
            ),
          )
        } else {
          const open = el("button", undefined, "attach")
          open.addEventListener(
            "click",
            () =>
              void this.attach(
                peer.epk,
                room.room_id,
                room.name ?? room.room_id,
              ),
          )
          row.append(open)
        }
        host.append(row)
      }
      if (hidden > 0 && !$<HTMLInputElement>("showControlRooms").checked)
        host.append(
          el(
            "div",
            "meta",
            `${hidden} control room${hidden > 1 ? "s" : ""} hidden`,
          ),
        )
    }
    // The heading above the list carries the same fact the list proves.
    this.renderPairState()
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

  /**
   * Point the client at a machine's launcher control room and show the launch
   * form. Routing is exactly an attach; the transcript replay is deliberately
   * skipped — a daemon does not serve `get_entries` (scripts/dump-entries.ts
   * refuses the same room for the same reason), so a normal attach would sit
   * at "machine not answering" forever.
   */
  private joinControlRoom(epk: string, room: TrackedRoom): void {
    const client = this.client
    if (!client) return
    client.setRoutingPeer(epk)
    client.setRoom(room.room_id)
    this.active = {
      epk,
      roomId: room.room_id,
      name: room.name ?? room.room_id,
      caps: room.caps ?? [],
      control: true,
    }
    // Not remembered as the last room: there is nothing to restore into a
    // control room, and `resumeSession` filters to viewable sessions anyway —
    // a reload should come back to the chat, not to a launch form.
    this.reducer.reset()
    this.rowEls.clear()
    this.window = null
    this.lastItemCount = 0
    this.transcript.replaceChildren()
    this.transcript.hidden = true
    this.composer.hidden = true
    $("loadEarlier").hidden = true
    this.launchHeading.textContent = `New conversation on ${room.name ?? "this machine"}`
    // The daemon's own cwd is a hint about where this machine starts, not an
    // answer: it is the launcher process's cwd, almost never the project.
    this.launchCwd.placeholder = room.cwd || "/absolute/path/to/project"
    // Ask what may be launched into — the machine is the only one who knows.
    this.requestLaunchDirs(epk)
    this.setLaunchNote("")
    this.launchPanel.hidden = false
    if (this.drawer.open) this.drawer.close()
    this.title.textContent = room.name ?? "control room"
    this.sub.textContent = `launcher room ${room.room_id.slice(0, 8)} · ${room.caps?.length ?? 0} capabilities`
    this.launchCwd.focus()
  }

  /** Back to a normal viewer: the panel goes away, the composer returns. */
  private closeLaunchPanel(): void {
    this.launchPanel.hidden = true
    this.transcript.hidden = false
    this.composer.hidden = false
    this.active = null
    this.cancelDirsRequest()
    this.clearEndRequest()
    this.title.textContent = "not attached"
    this.sub.textContent = "pick a session from the machines panel"
  }

  private setLaunchNote(text: string): void {
    this.launchNote.textContent = text
    this.launchNote.hidden = text === ""
  }

  private setLaunchDirsHint(text: string): void {
    this.launchDirsHint.textContent = text
    this.launchDirsHint.hidden = text === ""
  }

  private cancelDirsRequest(): void {
    this.pendingDirs = null
    clearTimeout(this.dirsTimer)
  }

  /** Ask the machine which folders may be launched into.
   *
   * The allow-list lives on the machine and is a prefix test against ITS
   * filesystem (`launchDirAllowed`), so the browser cannot derive it — and
   * `~/dev/myai` in the user's config means nothing over here. An older daemon
   * that has never heard of the request simply does not answer, which is why a
   * typed path always stays available.
   */
  private requestLaunchDirs(epk: string): void {
    this.cancelDirsRequest()
    this.launchChoices = []
    this.launchDirOptions.replaceChildren()
    this.setLaunchDirsHint("")
    const client = this.client
    if (!client) return
    const id = client.sendUb("session_launch_dirs")
    this.pendingDirs = { id, epk }
    this.dirsTimer = setTimeout(() => {
      if (this.pendingDirs?.id !== id) return
      this.pendingDirs = null
      // Said only when the user has nothing to work with: someone mid-typing a
      // path does not need a banner about a list they never asked for.
      if (!this.launchCwd.value)
        this.setLaunchDirsHint(
          "the machine did not list its folders — type the path (an older launcher daemon does not answer this)",
        )
    }, 8_000)
  }

  /** Put the answer in the field's own dropdown, ordered by full path.
   *
   * Labels stay the WHOLE path, not the leaf: in a dropdown that pops open under
   * the field, `myai` next to `aichats` says nothing about which root each came
   * from, and a pick has to be readable before it is made. */
  private renderLaunchDirs(answer: LaunchDirsAnswer): void {
    this.launchChoices = dirChoices(answer)
    const options = this.launchDirOptions
    options.replaceChildren()
    for (const choice of this.launchChoices) {
      const option = document.createElement("option")
      option.value = choice.path
      option.label = choice.path
      options.append(option)
    }
    this.setLaunchDirsHint(dirsHint(answer))
  }

  /** Follow the name after the folder. Picking a DIFFERENT folder means picking
   *  a different project, so the name re-follows the choice — but only our own
   *  previous suggestion is ever replaced; a name the user typed stays put. */
  private applyNameForCwd(): void {
    const cwd = this.launchCwd.value.trim()
    if (!cwd) return
    const next = nextAutoName(cwd, this.launchName.value, this.autoFilledName)
    if (next === null) return
    this.launchName.value = next
    this.autoFilledName = next
  }

  /** While TYPING, only a value that is exactly one of the offered paths counts
   *  as a pick — a half-written path must not rename anything. */
  private applyNameIfPicked(): void {
    const cwd = this.launchCwd.value.trim()
    if (this.launchChoices.some((c) => c.path === cwd)) this.applyNameForCwd()
  }

  /** Ask the launcher for a new session, and keep the request id so the
   *  machine's answer and the room it produces can both be matched to it. */
  private requestLaunch(): void {
    const cwd = this.launchCwd.value.trim()
    // `change` has not necessarily fired yet when Enter launches the request
    // straight from the folder field, so the same last-component name applies
    // here — otherwise the same path launched by click and by Enter would name
    // the session differently. An empty field, or one still holding OUR previous
    // suggestion for a different folder, both follow the folder being launched.
    const typed = this.launchName.value.trim()
    const name =
      typed && typed !== this.autoFilledName
        ? typed
        : launchNameFor(cwd) || typed
    if (!this.client || !this.active?.control) {
      this.toast("no control room open — press 'new conversation' on a machine")
      return
    }
    if (!cwd) {
      this.setLaunchNote(
        "a folder is required, and it must already exist on the machine — launch in its parent and let Pi create the project.",
      )
      return
    }
    const id = this.launch(cwd, name || undefined)
    this.pendingLaunch = { id, epk: this.active.epk, cwd }
    clearTimeout(this.launchTimer)
    this.launchTimer = setTimeout(() => {
      this.pendingLaunch = null
    }, 60_000)
    this.setLaunchNote(
      `asked the machine for ${cwd} — waiting for it to answer…`,
    )
  }

  /** The control appears only for a session whose machine advertises the cap —
   *  a control room and a gated session both fail that test on their own. */
  private refreshEndSession(): void {
    this.endBtn.hidden = !canEndSession({
      attached: this.active !== null,
      caps: this.active?.caps ?? [],
      ended: this.sessionEnded,
    })
    this.endBtn.dataset.state = this.endSentFor
      ? "sent"
      : this.endArmed
        ? "armed"
        : "idle"
    this.endBtn.textContent = this.endSentFor
      ? END_LABELS.sent
      : this.endArmed
        ? END_LABELS.armed
        : END_LABELS.idle
    this.endBtn.title = END_LABELS.title
    this.endBtn.disabled = this.endSentFor !== null
  }

  /** Two clicks: arming says `sure?`, and only the second one sends. A session
   *  that has been ended cannot be un-ended. */
  private onEndSessionClick(): void {
    if (!this.active || this.endSentFor) return
    if (!this.endArmed) {
      this.endArmed = true
      clearTimeout(this.endArmTimer)
      this.endArmTimer = setTimeout(() => this.disarmEnd(), END_CONFIRM_MS)
      this.refreshEndSession()
      return
    }
    this.disarmEnd()
    this.endSentFor =
      this.client?.sendUb("terminate", { reason: END_REASON }) ?? null
    clearTimeout(this.endWaitTimer)
    this.endWaitTimer = setTimeout(() => {
      if (!this.endSentFor) return
      this.endSentFor = null
      this.toast(refusalNotice())
      this.refreshEndSession()
    }, TERMINATE_QUIET_MS)
    this.refreshEndSession()
  }

  private disarmEnd(): void {
    this.endArmed = false
    clearTimeout(this.endArmTimer)
    this.refreshEndSession()
  }

  /** Called when the room ends (the machine's only answer) or we leave it. */
  private clearEndRequest(): void {
    this.endSentFor = null
    this.endArmed = false
    clearTimeout(this.endWaitTimer)
    clearTimeout(this.endArmTimer)
    this.refreshEndSession()
  }

  async attach(epk: string, roomId: string, name: string): Promise<void> {
    const client = this.client
    if (!client) return
    client.setRoutingPeer(epk)
    client.setRoom(roomId)
    this.active = { epk, roomId, name, caps: [] }
    // Attaching to a session by hand drops any launch we were waiting on, so a
    // late announce cannot yank the reader into another room mid-read.
    this.pendingLaunch = null
    clearTimeout(this.launchTimer)
    this.cancelDirsRequest()
    this.clearEndRequest()
    // Leaving a control room, if that is where we were: transcript and
    // composer come back.
    this.launchPanel.hidden = true
    this.transcript.hidden = false
    this.composer.hidden = false
    rememberLastRoom({ epk, roomId, name })
    // Attaching means the room is live and drivable again — clear any ended flag
    // the previous room left behind.
    this.reducer.setEnded(false)
    this.sessionEnded = false
    this.title.textContent = name
    this.sub.textContent = "syncing…"
    if (this.drawer.open) this.drawer.close()

    // A full replay on every (re)attach, not an incremental read. Rebuilding
    // from pi's entries gives every row a stable identity (the entry id); an
    // incremental read would add entry-id rows on top of the placeholder rows
    // the live stream created, and this fold has no entry-content-hash dedup
    // (pi's RowBoundsStore) to recognise them as the same block. Cheap and
    // obviously right beats clever and duplicated — see README's gap list.
    this.reducer.reset()
    this.rowEls.clear()
    this.window = null
    this.transcript.replaceChildren()

    // The first frame to a trusted peer is what triggers the extension's
    // attach; session_sync asks for panels + pending dialogs. The transcript
    // itself comes from pi's own paged `get_entries`.
    client.requestSync()
    const { entries, leafId, complete } = await client.getEntries()
    // The beacon (pi's leaf entry id) is what makes the fold render: the entry
    // tree backwalks from it to derive the active path, and rows are born only
    // for entries on that path. Entries without a beacon are indexed and stay
    // invisible — that is the membership gate, not a bug. `complete` says
    // whether the paging walk finished: a walk that timed out mid-way holds a
    // real leaf id and a too-short entry set, and folding that as authoritative
    // would let a divergence reset the transcript to a partial path.
    this.reducer.applyEntries(entries, leafId ?? null, complete)
    // Turn state comes from pi, not from guessing at the history: a completed
    // entry may still contain tool calls. `get_state.isStreaming` is the same
    // signal the iOS app gates its send/steer button on. Skipped when nothing
    // came back — the machine is away, and a second 15s timeout on top of the
    // first is a 30s dead spinner for no information.
    if (entries.length > 0) {
      const piState = await client
        .request<Record<string, unknown>>("get_state")
        .catch(() => undefined)
      this.reducer.reconcileBusy(Boolean(piState?.isStreaming))
    } else {
      this.sub.textContent = `${name} · machine not answering — is it connected?`
    }
    client.requestSync()
    this.render()
    this.sub.textContent = `${name} · ${entries.length} entries`
  }

  /** Re-ask the machine for its authoritative turn state. `reconcileBusy` uses
   *  only an explicit `isStreaming`, so a machine that does not answer (or does
   *  not carry the field) leaves the folded state alone instead of guessing idle. */
  private refreshBusyState(): void {
    const client = this.client
    if (!client) return
    void client
      .request<Record<string, unknown>>("get_state")
      .then((state) => {
        if (state && typeof state.isStreaming === "boolean")
          this.reducer.reconcileBusy(state.isStreaming)
      })
      .catch(() => undefined)
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
    // Only sessions can be restored: a control room has no transcript, and
    // restoring into one used to be possible when it was the machine's only
    // room.
    const rooms = (this.rooms.get(held.epk) ?? []).filter(isViewableSession)
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
      const { entries, leafId, complete } = await client.getEntries()
      if (entries.length > 0) {
        this.reducer.applyEntries(entries, leafId ?? null, complete)
        this.render()
      }
    } catch {
      // Machine away or room gone: the rows on screen stay as they are.
    }
  }

  private onEnvelope(env: EnvelopeMessage): void {
    if (CAPTURE_FRAMES) capturedFrames.push(env)
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
          this.refreshEndSession()
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
      case "session_launch_dirs_result": {
        const answer = parseLaunchDirs(ub)
        const pending = this.pendingDirs
        if (!answer || !pending || ub.in_reply_to !== pending.id) break
        this.cancelDirsRequest()
        this.renderLaunchDirs(answer)
        break
      }
      case "session_launch_result": {
        const code = typeof ub.code === "string" ? ub.code : ""
        const inReplyTo =
          typeof ub.in_reply_to === "string" ? ub.in_reply_to : ""
        if (this.pendingLaunch && inReplyTo === this.pendingLaunch.id) {
          if (ub.ok === true) {
            // pi is starting; its room announce arrives next, echoing our id.
            this.setLaunchNote("launched — waiting for the session to appear…")
          } else {
            // The refusal is the actionable part: a bare `permission_denied`
            // does not say which of the two gates refused.
            this.pendingLaunch = null
            clearTimeout(this.launchTimer)
            this.setLaunchNote(launchFailureHint(code))
          }
        }
        this.toast(
          ub.ok === true
            ? `launched (${String(ub.backend ?? "?")})`
            : `launch failed: ${code || String(ub.message ?? "unknown")}`,
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
    // Only the window is drawn. A replay of a big session has to cost roughly a
    // screenful, not the whole history: this is the difference between a tab
    // that paints and one that freezes for minutes (14 MB / 8571 entries / 244
    // base64 image blocks is a real session here, not a hypothetical).
    this.window = nextWindow(this.window, items.length, followTail)
    this.lastItemCount = items.length
    const shown = sliceWindow(items, this.window)
    this.syncLoadEarlier(items.length)
    const live = new Set(shown.map((item) => item.row))
    // Place rows in window order rather than appending: growing the window
    // toward the top adds rows ABOVE the current first row, and an append would
    // drop them at the bottom of the log.
    let previous: HTMLElement | null = null
    // The newest answer in the window is shown in full; older ones are clamped.
    const tailRow = findTailRow(shown)
    this.tailRowId = tailRow
    for (const item of shown) {
      const atTail = item.row === tailRow
      const existing = this.rowEls.get(item.row)
      let node: HTMLElement
      if (existing) {
        existing.classList.toggle("at-tail", atTail)
        this.patchItem(existing, item)
        node = existing
      } else {
        node = this.buildItem(item)
      }
      const expected: Node | null = previous
        ? previous.nextSibling
        : this.transcript.firstChild
      if (node !== expected) this.transcript.insertBefore(node, expected)
      previous = node
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
    this.busy = snapshot.busy
    this.stopBtn.hidden = !snapshot.busy
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

  /** The control that pulls earlier history into the window. */
  private syncLoadEarlier(total: number): void {
    const bar = $<HTMLElement>("loadEarlier")
    const hidden = this.window ? hiddenBefore(this.window, total) : 0
    bar.hidden = hidden === 0
    if (hidden === 0) return
    const ask = Math.min(LOAD_MORE, hidden)
    $<HTMLButtonElement>("loadEarlierBtn").textContent =
      `load ${ask} earlier rows · ${hidden} above not shown`
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
    node.classList.toggle("at-tail", item.row === this.tailRowId)
    if (item.kind === "tool") {
      // The state rides on the row, not only on the chip, because pi tints the
      // whole tool box by state and a tint that has no attribute behind it
      // cannot be painted from here.
      node.dataset.state = item.state ?? "running"
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
    } else if (item.kind === "compaction") {
      // Just the caption, centred — the app shows no "compaction" header here.
      // The fold carries the wording (it is corpus-compared against the app's),
      // and the summary stays on the item as the stand-in for the folded
      // history rather than becoming a label.
      node.append(el("div", "body", item.text))
    } else {
      node.append(el("div", "who", item.kind))
      node.append(el("div", "body", item.text))
    }
    this.rowEls.set(item.row, node)
    this.patchItem(node, item)
    return node
  }

  /** Body text of a non-tool row. A row that is still streaming is set as plain
   *  text — parsing markdown per delta re-lays the row out mid-stream — and the
   *  app defers the same way (its markdown is budgeted and landed async). Once a
   *  row settles it is parsed, and a body whose text has not changed is left
   *  alone so the scroll position does not jitter. */
  private setBody(node: HTMLElement, item: TranscriptItem): void {
    const body = node.querySelector<HTMLElement>(".body")
    if (!body) return
    const holder = body as HTMLElement & { renderedSource?: string }
    // A pairing notice renders from its payload, not from the text it was told
    // to display.
    const pairing = item.kind === "notice" ? pairingDetails(item) : null
    const key = bodyRenderKey(item, pairing?.uri)
    if (holder.renderedSource === key) return
    if (pairing) {
      holder.renderedSource = key
      body.replaceChildren(pairingCard(item, pairing))
      return
    }
    if (!wantsMarkdown(item) || item.streaming) {
      holder.renderedSource = key
      body.textContent = item.text
      return
    }
    holder.renderedSource = key
    body.replaceChildren(...blockNodes(parseMarkdown(item.text)))
  }

  /** Clamp a body that is taller than it is useful, behind an explicit control.
   *  Two real cases from the live session: `/unbien pair` sends its QR as a custom
   *  message (`extension/src/commands/pairing.ts:124`, `display: true`), which
   *  lands as one notice row ~30 lines tall whose pairing token is then visible to
   *  every attached client; and a model that counts to 2000 fills the scroll area
   *  with digits. The row stays the row — the fold and the corpus are untouched —
   *  it just does not dominate the screen. */
  private syncClamp(kind: string, node: HTMLElement): void {
    const body = node.querySelector<HTMLElement>(".body")
    if (!body) return
    const toggle = node.querySelector<HTMLElement>("button.clamp")
    // A structured body (the pairing card) manages its own disclosure; clamping
    // it would fight the card's own reveal control.
    if (body.querySelector(".pair-card")) {
      node.classList.remove("expanded")
      toggle?.remove()
      return
    }
    if (
      !mayClamp({
        kind,
        atTail: node.classList.contains("at-tail"),
        streaming: node.classList.contains("streaming"),
      })
    ) {
      // Nothing to fold. Drop a stale control — the row may have become the
      // newest answer since it was last drawn — and let the body take its height.
      toggle?.remove()
      node.classList.remove("expanded")
      return
    }
    const needsClamp = body.scrollHeight > body.clientHeight + 24
    if (!needsClamp) {
      node.classList.remove("expanded")
      toggle?.remove()
      return
    }
    if (toggle) return
    const button = el("button", "pill clamp")
    button.type = "button"
    button.textContent = "show more"
    button.addEventListener("click", () => {
      const expanded = node.classList.toggle("expanded")
      button.textContent = expanded ? "show less" : "show more"
    })
    node.append(button)
  }

  private patchItem(node: HTMLElement, item: TranscriptItem): void {
    node.classList.toggle("streaming", item.streaming)
    if (item.kind !== "tool") {
      this.setBody(node, item)
      if (item.kind === "notice" || item.kind === "assistant")
        this.syncClamp(item.kind, node)
      this.syncImages(node, item)
      return
    }
    const state = node.querySelector<HTMLElement>(".state")
    if (state) {
      state.textContent = item.state ?? "running"
      state.className = `state ${item.state ?? "running"}`
      node.dataset.state = item.state ?? "running"
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
    if (snapshot.panels.length > 0) {
      // The transport a real machine sends: one line per source, items drawn
      // from the snapshot's own fields (`title`/`name`/`id`, `status`).
      for (const panel of snapshot.panels) {
        const items = panel.items
          .map((item) => {
            const title = String(item.title ?? item.name ?? item.id ?? "?")
            const status =
              typeof item.status === "string" ? ` (${item.status})` : ""
            return `${title}${status}`
          })
          .join(", ")
        bits.push(`${panel.title ?? panel.key}${items ? `: ${items}` : ""}`)
      }
    } else {
      // Legacy channels only: no shipped producer sends them (scenario 016), so
      // this branch survives for forks that do and for the corpus's 002.
      if (snapshot.plan)
        bits.push(
          `plan: ${snapshot.plan.project ?? "plan"} (${snapshot.plan.itemCount})`,
        )
      for (const row of snapshot.subagents)
        bits.push(
          `subagent ${row.status}${row.type ? ` · ${row.type}` : ""}: ${row.description ?? row.id}`,
        )
    }
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

  /** Remote launch: ask the machine's launcher daemon for a new session.
   *  Returns the request id — the machine echoes it in the result frame and in
   *  the launched room's `launchReq`, which is how the caller correlates them. */
  launch(cwd: string, name?: string): string {
    return (
      this.client?.sendUb("session_launch", {
        mode: "new",
        cwd,
        ...(name ? { name } : {}),
      }) ?? ""
    )
  }

  private toast(message: string): void {
    // A STACK, not one label. One batch can carry several real problems (a
    // refusal, a re-sync, a machine that went away) and the old code showed
    // only the LAST of them for 4 seconds — the most important message lost to
    // a later cosmetic one.
    //
    // An empty message is not a message: it used to render as a small empty
    // amber pill, a visible nothing. Drop it instead.
    const text = toastMessage(message)
    if (text === null) return
    this.toastLines.push(text)
    if (this.toastLines.length > 3) this.toastLines.shift()
    this.renderNotices()
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      this.toastLines.length = 0
      this.renderNotices()
    }, 6_000)
  }

  /**
   * Paint the notice stack where it can actually be seen.
   *
   * While the sheet is open it goes inside the sheet (#noticeBar). The fixed
   * toast cannot be lifted above a modal <dialog>: the dialog and its
   * ::backdrop are in the top layer, where author `z-index` does not reach, and
   * a `popover="auto"` opened after showModal() was measured (Chrome 156) to
   * hit-test BELOW the dialog anyway. At phone width the sheet is 80vw and the
   * toast is centred, which is how "not even an error" happened: every notice
   * a refused pairing produced was painted behind the panel the user was
   * staring at. Two homes, one stack — and the drawer's `toggle` handler
   * re-renders on open/close so a notice is never left stranded in the hidden
   * half.
   */
  private renderNotices(): void {
    const inSheet = this.drawer.open
    const shown = inSheet ? this.noticeEl : this.toastEl
    const other = inSheet ? this.toastEl : this.noticeEl
    other.replaceChildren()
    other.hidden = true
    if (this.toastLines.length === 0) {
      shown.replaceChildren()
      shown.hidden = true
      return
    }
    shown.replaceChildren(
      ...this.toastLines.map((line) => el("div", "toast-line", line)),
    )
    shown.hidden = false
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
