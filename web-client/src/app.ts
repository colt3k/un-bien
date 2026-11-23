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
  resumeTarget,
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
  INITIAL_WINDOW,
  LOAD_MORE,
  growWindow,
  hiddenAfter,
  hiddenBefore,
  nextWindow,
  sliceWindow,
  type TranscriptWindow,
} from "./transcript-window.js"
import {
  ARRIVE_PX,
  belowTail,
  gestureDisarms,
  keyDisarms,
  pinAfterScroll,
} from "./tail-pin.js"
import {
  type HistoryRead,
  historyDetail,
  historyLabel,
  historyRetryable,
} from "./history-status.js"
import { parseInvite, type PairingInvite } from "./invite.js"
import {
  browserLabel,
  insetForLimitPx,
  isAndroidUserAgent,
  keyboardInsetPx,
  keyboardProbeLines,
  keyboardSlackPx,
  keyboardTopFromRectPx,
  liftForPokePx,
  type VirtualKeyboardLike,
} from "./keyboard-inset.js"
import { RELAY_PORT, relayUrlForPage } from "./framing.js"
import { tokenize } from "./highlight.js"
import {
  dirChoices,
  dirRows,
  dirsHint,
  launchNameFor,
  nextAutoName,
  parseLaunchDirs,
  rootsCovering,
  type LaunchDirChild,
  type LaunchDirRow,
  type LaunchDirsAnswer,
} from "./launch-dirs.js"
import {
  describeError,
  launchFailureHint,
  roomListFailure,
  toastMessage,
} from "./notice.js"
import {
  pairResultMessage,
  pairSectionBadge,
  pairSectionOpens,
} from "./pair-status.js"
import {
  forgetPeer,
  forgetLastRoom,
  forgetLastView,
  forgetLaunchDraft,
  forgetPendingLaunch,
  forgetRelay,
  hideReasoning,
  launchDraft,
  lastRoom,
  lastView,
  listPeers,
  listRelays,
  monoProse,
  PENDING_LAUNCH_TTL_MS,
  pendingLaunch as storedPendingLaunch,
  recordRelayPin,
  rememberPeer,
  rememberLastRoom,
  rememberLastView,
  rememberLaunchDraft,
  rememberPendingLaunch,
  rememberRelay,
  relayPinFor,
  setHideReasoning,
  setMonoProse,
  type PairedPeer,
} from "./store.js"
import { restoredWindow, type SavedView } from "./view-state.js"

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
 * reads it; the flag stays in the address bar until you take it out, which is
 * what a capture driver wants — it re-drives the same page after a reload.
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
if (SKIP_RESTORE && typeof history?.replaceState === "function") {
  // One use, so the hatch does not become the setting. A reload keeps the query
  // string, so after someone escapes a wedged tab once, every later refresh of
  // that page silently skipped the resume and looked like a different bug: "I
  // refreshed and lost my place". The flag has been read; take it back out.
  const url = new URL(location.href)
  url.searchParams.delete("fresh")
  history.replaceState(history.state, "", url)
}

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
  /** The "↑ <what the compaction said>" pointer in the header. It exists only
   *  because the marker row itself gets buried. See `syncCompactionChip`. */
  private readonly compactionJump = $<HTMLButtonElement>("compactionJump")
  /** The "↓ N below" pill. It exists only because the pin can be off, and a
   *  reader who is not following needs to know the stream did not stop. */
  private readonly jumpToEnd = $<HTMLButtonElement>("jumpToEnd")
  private readonly sendBtn = $<HTMLButtonElement>("sendBtn")
  /** Queue a message for after the running turn. A field rather than a `$()` at
   *  each use, because the ended view hides it alongside the other controls. */
  private readonly queueBtn = $<HTMLButtonElement>("queueBtn")
  /** End the session (the remote `/quit`). `endSentFor` holds the request id we
   *  put on the wire — the machine answers by ENDING THE ROOM, never with a
   *  result frame, so a request that is not followed by `room_ended` inside the
   *  quiet window was refused by its gate, however the click felt. */
  private readonly endBtn = $<HTMLButtonElement>("endSessionBtn")
  /** The finished-conversation bar that takes the composer's place. */
  private readonly endedNote = $<HTMLDivElement>("endedNote")
  private readonly closeEndedBtn = $<HTMLButtonElement>("closeEndedBtn")
  /** Re-read the attached session's history. The reader's escape hatch when a
   *  read came back short or empty — and the nudge a machine that has not bound
   *  the session yet needs, since `session_sync` is the frame that triggers the
   *  extension's attach. */
  private readonly refreshBtn = $<HTMLButtonElement>("refreshBtn")
  /** What the last history read produced, and the notice that says so. A blank
   *  transcript with a "synced" header reads as a broken app; the sentence and
   *  the retry are the difference between a slow machine and a dead one. */
  private readonly historyNotice = $<HTMLElement>("historyNotice")
  private readonly historyNoticeText = $<HTMLElement>("historyNoticeText")
  private readonly historyRetryBtn = $<HTMLButtonElement>("historyRetryBtn")
  private history: HistoryRead | null = null
  private readingHistory = false
  private endArmed = false
  private endSentFor: string | null = null
  /** The open session is over. Its caps outlive the room in this client, so the
   *  control needs the fact itself to go away. */
  private sessionEnded = false
  /** Whether the composer is currently painted as finished (the fold's ended
   *  flag). Tracked so the switch runs once per change rather than on every
   *  frame, and so the header controls can ask the same question the composer
   *  answers. */
  private endedInView = false
  private endArmTimer: ReturnType<typeof setTimeout> | undefined
  private endWaitTimer: ReturnType<typeof setTimeout> | undefined
  /** Hidden while a control room is open — see `joinControlRoom`. */
  private readonly composer = $<HTMLElement>("composer")
  private readonly launchPanel = $<HTMLElement>("launchPanel")
  private readonly launchHeading = $<HTMLElement>("launchHeading")
  private readonly launchCwd = $<HTMLInputElement>("launchCwd")
  private readonly launchName = $<HTMLInputElement>("launchName")
  private readonly launchNote = $<HTMLElement>("launchNote")
  /** The one-line explanation of what the machine's answer is NOT (wildcard,
   *  locked, remote launch off, folders that are gone). It has to be a sentence
   *  because a short list is otherwise indistinguishable from a broken one. */
  private readonly launchDirsHint = $<HTMLElement>("launchDirsHint")
  /** The machine's folders, and the ONLY way to pick one. The field above it is
   *  a plain text input: rows fill it, it never pops a second list of the same
   *  paths over the list that is already on screen. */
  private readonly launchDirList = $<HTMLElement>("launchDirList")
  /** Reasoning rows are folded always and hidden here — see `render`. */
  private reasoningHidden = hideReasoning()
  /** One monospace grid for the whole transcript, as pi's terminal sets it. A
   *  preference, not a redesign: it is the closest thing to pi and the least
   *  legible on a narrow screen, so the user decides. */
  private monoProseMode = monoProse()

  private client: SessionClient | null = null
  private relayUrl = ""
  private readonly peers = new Map<string, PairedPeer>()
  /** Is the relay socket up RIGHT NOW. A `rooms_check` that goes unanswered on a
   *  live socket is the relay staying quiet about an unchanged listing
   *  (relay/src/handlers/peer.rs `last_rooms_resp`), not a dead wire — and the
   *  sentence the reader gets has to know which. */
  private relayConnected = false
  /** Remembered machines the RELAY says do not know this device
   *  (`rooms_check` → `unknown_peer`). The local record can outlive the pairing:
   *  revoked, or the relay rebuilt. Kept separate from `peers` because the
   *  machine is still worth listing — with the doubt said. */
  private readonly pairingDoubt = new Set<string>()
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
  /** The newest compaction row that is NOT on screen, and the one-shot window
   *  and row the reader asked to jump to. See `syncCompactionChip`. */
  private chipRowId: string | null = null
  private jumpWindow: TranscriptWindow | null = null
  private pendingJump: string | null = null
  /** What the last render drew, so a bare scroll can re-aim the chip without
   *  asking the fold for another snapshot. */
  private lastItems: TranscriptItem[] = []
  private viewQueued = false
  /** The standing decision to keep the reader at the newest line — the tail
   *  pin (src/tail-pin.ts). `true` until the reader scrolls into history; the
   *  follow then stays off until they get back to the bottom. Deliberately NOT
   *  re-derived from the scroll position each render: that is what made
   *  scrolling up during a turn impossible, because every delta undid a little
   *  bit of the reader's scroll and they never got clear of the band. */
  private shouldPin = true
  /** What the scroll box was last told to be by SCRIPT (the follow, the anchor
   *  correction, a jump). A `scroll` event that reads this value is the echo of
   *  the app's own write, not the reader moving — only an echo-free scroll
   *  counts as intent, and only intent may move the pin. */
  private appScrollTop = 0
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
  /** The machine's answer, kept so the visible list can be repainted when a
   *  group is opened without asking the machine again. */
  private dirsAnswer: LaunchDirsAnswer | null = null
  /** Which allow-listed roots have their folders revealed. */
  private readonly expandedDirs = new Set<string>()
  /** The name this client last pre-filled. That is what makes it safe to
   *  replace later: a name the user typed themselves never is. */
  private autoFilledName = ""
  /** Debounce for the post-turn re-read (a turn ends with several frames). */
  private resyncTimer: ReturnType<typeof setTimeout> | undefined
  /** The view to put back after the next attach's replay, and the one-shot
   *  scroll that lands it. Set only for a resume/reconnect — an attach the
   *  reader asked for by name goes to the tail, which is what "open this
   *  conversation" means. */
  private pendingRestore: SavedView | null = null
  private pendingAnchor: { row: string; dy: number } | null = null
  /** Debounce for writing the reader's position: a flick writes on every wheel
   *  tick, and localStorage is synchronous. */
  private viewTimer: ReturnType<typeof setTimeout> | undefined
  /** The same, for the launch form's folder field (typed, unlike everything
   *  else on that page). */
  private draftTimer: ReturnType<typeof setTimeout> | undefined

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

  /**
   * Paint the keyboard's claim on the screen into `--keyboard-inset`, which CSS
   * subtracts from the boxes that end at the bottom edge (`#app`, `#drawer`, the
   * toast). Without it the keyboard is painted over the message box: see
   * `src/keyboard-inset.ts` for why the two viewports diverge, and for why the
   * viewport-meta alternative is not used. `scroll` is listened to as well as
   * `resize` because a browser that pans the layout viewport to reveal a field
   * moves the claim without changing its size, and `focusin` because a keyboard
   * can appear without either viewport being resized at all.
   */
  private trackKeyboardInset(): void {
    const vv = window.visualViewport
    if (!vv) return
    this.mountKeyboardProbe()
    // Chromium will say where its keyboard is — but only if we take
    // responsibility for staying out of it. With `overlaysContent` on, the browser
    // stops resizing the viewport and reports the keyboard's rectangle instead,
    // and that rectangle is the only number that knows Android handed the keys the
    // navigation bar's strip for free. See src/keyboard-inset.ts for the numbers.
    const vk = this.virtualKeyboard()
    if (vk) {
      try {
        vk.overlaysContent = true
      } catch {
        // No support, or an insecure context: the viewport path still works.
      }
      vk.addEventListener("geometrychange", () => this.paintKeyboardInset())
    }
    for (const event of ["resize", "scroll"])
      vv.addEventListener(event, () => this.paintKeyboardInset())
    document.addEventListener("focusin", () => this.paintKeyboardInset())
    this.paintKeyboardInset()
  }

  private virtualKeyboard(): VirtualKeyboardLike | null {
    const nav = navigator as Navigator & {
      virtualKeyboard?: VirtualKeyboardLike
    }
    return nav.virtualKeyboard ?? null
  }

  /**
   * `?kbdebug`: a panel of viewport facts, for the keyboard cases that only
   * happen on a phone. A phone disagrees with itself about where its keyboard
   * starts — the reported visible bottom can sit BELOW the keys — and which of
   * its numbers lied is only answerable on the device. One screenshot of this
   * panel answers it. Dev-only: it exists only when the URL asks for it, and
   * nothing else reads it.
   */
  private mountKeyboardProbe(): void {
    if (!location.search.toLowerCase().includes("kbdebug")) return
    const ruler = document.createElement("div")
    ruler.style.cssText =
      "position:fixed;top:0;left:0;width:0;height:100dvh;visibility:hidden;pointer-events:none"
    const insetProbe = document.createElement("div")
    insetProbe.style.cssText =
      "position:fixed;height:0;padding-bottom:env(safe-area-inset-bottom);visibility:hidden;pointer-events:none"
    const panel = document.createElement("div")
    panel.className = "kb-debug"
    document.body.append(ruler, insetProbe, panel)
    this.keyboardProbe = { panel, ruler, insetProbe }
  }

  private paintKeyboardProbe(facts: {
    inset: number
    bottomLimit: number
    slack: number
    vk: VirtualKeyboardLike | null
  }): void {
    const probe = this.keyboardProbe
    const vv = window.visualViewport
    if (!probe || !vv) return
    const box = this.composer.getBoundingClientRect()
    const focused = document.activeElement
    probe.panel.textContent = keyboardProbeLines({
      innerHeight: window.innerHeight,
      visualHeight: vv.height,
      visualOffsetTop: vv.offsetTop,
      visualScale: vv.scale,
      dynamicViewportHeight: probe.ruler.getBoundingClientRect().height,
      safeAreaBottom:
        Number.parseFloat(getComputedStyle(probe.insetProbe).paddingBottom) ||
        0,
      keyboardRect: facts.vk ? facts.vk.boundingRect : null,
      overlaysContent: facts.vk ? facts.vk.overlaysContent : null,
      secureContext: window.isSecureContext,
      browser: browserLabel(navigator.userAgent),
      slack: facts.slack,
      bottomLimit: facts.bottomLimit,
      inset: facts.inset,
      composerBottom: box.bottom,
      composerHeight: box.height,
      focused: focused?.id || focused?.tagName || "(none)",
    }).join("\n")
  }

  /**
   * Put the bottom of the app on the line the keyboard cannot cross, then measure
   * what that missed and pay for it too.
   *
   * The line is the keyboard's top when the browser admits where that is
   * (`virtualKeyboard.boundingRect` — the only source that counts the strip of
   * navigation bar the keys sit on), and the bottom of the visible viewport
   * otherwise. The inset starts at whichever source asks for more, then each pass
   * moves the box by the last pass's debt: two passes converge, three is the guard.
   *
   * The measuring pass runs only while a keyboard is in play. With none, `100dvh`
   * is the honest height and the bottom edge should not move.
   */
  private paintKeyboardInset(): void {
    const vv = window.visualViewport
    if (!vv) return
    const vk = this.virtualKeyboard()
    const keyboardTop = keyboardTopFromRectPx(vk?.boundingRect, vv.offsetTop)
    const claim = keyboardInsetPx({
      layoutHeight: window.innerHeight,
      visualHeight: vv.height,
      visualOffsetTop: vv.offsetTop,
    })
    const slack = keyboardSlackPx({
      isAndroid: isAndroidUserAgent(navigator.userAgent),
      limitFromViewport: keyboardTop === null,
      keyboardReported: claim > 0,
    })
    const bottomLimit = Math.min(
      keyboardTop ?? Number.POSITIVE_INFINITY,
      vv.height + vv.offsetTop - slack,
    )
    let inset = Math.max(
      claim,
      insetForLimitPx({
        layoutHeight: window.innerHeight,
        bottomLimit,
      }),
    )
    try {
      this.setKeyboardInset(inset)
      if (inset === 0 && !this.someoneIsTyping()) return
      for (let pass = 0; pass < 3; pass++) {
        const box = this.composer.getBoundingClientRect()
        // A control room hides the composer, so there is nothing to keep clear.
        if (box.height === 0) break
        const paid = liftForPokePx({
          inset,
          boxBottom: box.bottom,
          bottomLimit,
        })
        if (paid === inset) break
        inset = paid
        this.setKeyboardInset(inset)
      }
      this.revealFocusedAbove(bottomLimit)
    } finally {
      this.paintKeyboardProbe({ inset, bottomLimit, slack, vk })
    }
  }

  /**
   * With `overlaysContent` on, Chromium no longer pans the page to reveal a
   * focused field, so the fields that live in a scroller — the drawer's relay URL
   * and pairing code — need that courtesy from us: if the focused box hangs below
   * the line, scroll its nearest scrollable ancestor by the difference. The
   * composer needs nothing; the inset already moved it.
   */
  private revealFocusedAbove(bottomLimit: number): void {
    const el = document.activeElement
    if (!(el instanceof Element)) return
    const box = el.getBoundingClientRect()
    if (box.height === 0 || box.bottom <= bottomLimit) return
    for (let node = el.parentElement; node; node = node.parentElement) {
      if (node.scrollHeight <= node.clientHeight + 1) continue
      node.scrollTop += box.bottom - bottomLimit
      return
    }
  }

  private setKeyboardInset(px: number): void {
    document.documentElement.style.setProperty("--keyboard-inset", `${px}px`)
  }

  /** The `?kbdebug` panel and its two measuring sticks, when that is asked for. */
  private keyboardProbe: {
    panel: HTMLElement
    ruler: HTMLElement
    insetProbe: HTMLElement
  } | null = null

  /** A text field holds focus, so a keyboard is wanted even if no viewport
   *  reports having shrunk — an overlaying keyboard leaves both untouched. */
  private someoneIsTyping(): boolean {
    const el = document.activeElement
    if (
      !(el instanceof HTMLTextAreaElement) &&
      !(el instanceof HTMLInputElement)
    )
      return false
    return ![
      "checkbox",
      "radio",
      "button",
      "submit",
      "image",
      "range",
      "color",
      "file",
    ].includes(el.type)
  }

  private bindUi(): void {
    this.trackKeyboardInset()
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
        this.setPairFormOpen(
          pairSectionOpens(this.peers.size, this.doubtedPeers()),
        )
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
    this.closeEndedBtn.addEventListener("click", () => this.closeEnded())
    $("showControlRooms").addEventListener("change", () =>
      this.renderPeerList(),
    )
    $("loadEarlierBtn").addEventListener("click", () => {
      if (!this.window) return
      this.window = growWindow(this.window, this.lastItemCount, LOAD_MORE)
      this.render()
    })
    this.compactionJump.addEventListener("click", () => this.jumpToCompaction())
    this.jumpToEnd.addEventListener("click", () => {
      // Reading the newest line. The next render re-pins the window to the tail
      // (so the rows that arrived while the pin was off get drawn) and scrolls
      // to its bottom.
      this.shouldPin = true
      this.render()
    })
    // Scrolling changes what is on screen and who is following without a single
    // frame arriving. Measured once per animation frame, not once per wheel
    // tick — except the pin, which is decided from the event itself: waiting a
    // frame for it lets a delta land first and yank the reader back.
    this.transcript.addEventListener("scroll", () => {
      const top = this.transcript.scrollTop
      if (top !== this.appScrollTop) {
        this.shouldPin = pinAfterScroll(
          this.shouldPin,
          top - this.appScrollTop,
          this.tailDistance(),
        )
        this.appScrollTop = top
      }
      this.scheduleViewSave()
      if (this.viewQueued) return
      this.viewQueued = true
      requestAnimationFrame(() => {
        this.viewQueued = false
        this.syncCompactionChip(this.lastItems)
        this.syncJumpToEnd(this.lastItems)
      })
    })
    // The gestures come BEFORE the scroll they cause, and that is the whole
    // point: the follow has to be off before the next delta lands, or that
    // delta scrolls under the reader's finger and the two fight for the rest of
    // the turn. (Verified against the old rule on purpose: a 100px wheel up
    // during a stream was undone inside the same frame.)
    this.transcript.addEventListener(
      "wheel",
      (event) => {
        if (gestureDisarms(event.deltaY, this.canScrollUp()))
          this.shouldPin = false
      },
      { passive: true },
    )
    // A finger dragged DOWN brings earlier rows into view, which in wheel terms
    // is a negative delta. Kept relative to the previous move so one long drag
    // keeps its meaning.
    let touchY: number | null = null
    this.transcript.addEventListener(
      "touchstart",
      (event) => {
        touchY = event.touches[0]?.clientY ?? null
      },
      { passive: true },
    )
    this.transcript.addEventListener(
      "touchmove",
      (event) => {
        const y = event.touches[0]?.clientY
        if (touchY === null || y === undefined) return
        if (gestureDisarms(touchY - y, this.canScrollUp()))
          this.shouldPin = false
        touchY = y
      },
      { passive: true },
    )
    this.transcript.addEventListener("touchend", () => {
      touchY = null
    })
    document.addEventListener("keydown", (event) => {
      // While the sheet is open the keys belong to the sheet.
      if (this.drawer.open) return
      const target = event.target as HTMLElement | null
      // Typing in the composer, the drawer, or the launch form is not a request
      // to move the log.
      if (target?.isContentEditable) return
      if (["TEXTAREA", "INPUT", "SELECT"].includes(target?.tagName ?? ""))
        return
      if (keyDisarms(event.key) && this.canScrollUp()) this.shouldPin = false
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
    // The field is a free text box: a value that is exactly one of the offered
    // paths counts as picking it (so the name follows and the list opens to
    // it), and anything else TYPES — which filters the list rather than
    // replacing it with a dropdown of the same paths.
    this.launchCwd.addEventListener("input", () => {
      const typed = this.launchCwd.value.trim()
      if (this.launchChoices.some((c) => c.path === typed)) {
        this.applyNameIfPicked()
        this.expandForCwd()
      }
      this.renderLaunchDirList()
      this.scheduleDraftSave()
    })
    // A TYPED path is a selection too, once the field commits: tabbing out or
    // pressing Enter names the session after the folder they wrote.
    this.launchCwd.addEventListener("change", () => {
      this.applyNameForCwd()
      this.scheduleDraftSave()
    })
    this.launchName.addEventListener("input", () => this.scheduleDraftSave())
    this.sendBtn.addEventListener("click", () => this.send("auto"))
    this.queueBtn.addEventListener("click", () => this.send("queue"))
    this.stopBtn.addEventListener("click", () => this.client?.abort())
    this.endBtn.addEventListener("click", () => this.onEndSessionClick())
    this.refreshBtn.addEventListener("click", () => void this.refreshHistory())
    this.historyRetryBtn.addEventListener(
      "click",
      () => void this.refreshHistory(),
    )
    this.input.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault()
        this.send("auto")
      }
    })
    this.input.addEventListener("input", () => this.autogrow())
    if (CAPTURE_FRAMES) this.installDebugHooks()
    // The browser's version of the app's foreground heal (RootView.swift:78 →
    // `AppModel.refreshBusyState`): a hidden tab is throttled and can miss the
    // frames that bracket a turn while its socket stays healthy — which is
    // precisely the case a reconnect-driven re-ask never covers. Ask pi for its
    // state again when the tab comes back and let the fold reconcile.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.refreshBusyState()
      // A phone backgrounding the tab is the other way this page dies: iOS
      // recycles the tab without ever firing a load event, so the position has
      // to be written on the way out rather than assumed from the last scroll.
      else this.savePage()
    })
    // Refresh and navigate-away. `pagehide`, not `beforeunload`: it is the one
    // that also fires on the bfcache path and on iOS. See view-state.ts.
    window.addEventListener("pagehide", () => this.savePage())
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
      this.relayConnected = status === "connected"
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
        void this.attach(
          this.active.epk,
          this.active.roomId,
          this.active.name,
          {
            resume: true,
          },
        )
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
      else if (!this.recoverPendingLaunch()) void this.resumeSession()
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
    // A fresh grant from the machine ends any doubt the relay had about it.
    this.pairingDoubt.delete(paired.epk)
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
  /** How many machines this browser remembers the RELAY disputes. Counted over
   *  the machines still listed, so an unpaired one cannot leave a doubt behind
   *  that keeps the badge red forever. */
  private doubtedPeers(): number {
    let doubted = 0
    for (const epk of this.peers.keys())
      if (this.pairingDoubt.has(epk)) doubted++
    return doubted
  }

  private renderPairState(): void {
    const doubted = this.doubtedPeers()
    const badge = pairSectionBadge(this.peers.size, doubted)
    this.pairState.hidden = badge === null
    if (badge) {
      this.pairState.textContent = badge
      // Green is a claim about this browser's state; it must not be shown for a
      // machine the relay will not list. Dashed like `control room`, because the
      // state is genuinely uncertain rather than merely different.
      this.pairState.className =
        doubted >= this.peers.size && this.peers.size > 0
          ? "tag tag-doubt"
          : "tag tag-paired"
    }
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
        this.syncActiveCaps()
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
            forgetPendingLaunch()
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
          void this.attach(epk, room.room_id, room.name ?? this.active.name, {
            resume: true,
          })
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
          forgetLastView()
          this.clearEndRequest()
          this.toast("that session ended on the machine")
          this.title.textContent = `${this.active.name} (ended)`
          // The relay saying the room is gone IS the session ending for a
          // viewer, even when the machine never got to send `session_shutdown`.
          this.reducer.setEnded(true)
          this.sessionEnded = true
          this.refreshSessionControls()
          this.render()
        }
        break
      }
      case "error": {
        const code = String(frame.code ?? "error")
        if (code === "unknown_peer") {
          // One sentence for one condition: the room listing already says this,
          // and a drawer that words the same fault two ways makes a reader
          // wonder which one they are in.
          this.toast(roomListFailure({ status: code }, this.relayConnected))
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
      // The relay's answer is the authority on the pairing; `peers` is this
      // browser's memory of it. `timeout` is evidence of neither, so it leaves
      // the record alone.
      if (result.status === "unknown_peer") this.pairingDoubt.add(peer.epk)
      else if (result.status === "ok") this.pairingDoubt.delete(peer.epk)
      if (result.status === "ok")
        this.rooms.set(
          peer.epk,
          mergeRoomLists(this.rooms.get(peer.epk) ?? [], result.rooms),
        )
      if (result.status === "ok") this.syncActiveCaps()
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
        this.sub.textContent = roomListFailure(result, this.relayConnected)
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
        forgetLastView()
        forgetLaunchDraft()
        forgetPendingLaunch()
        this.peers.delete(peer.epk)
        this.rooms.delete(peer.epk)
        this.pairingDoubt.delete(peer.epk)
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
        // Say which room this device is IN, because the control on it is
        // "detach" and that only reads as "leave" once the card says you are
        // here. Room ids rotate, so this is matched on the live pair
        // (epk + room id), not on a remembered one.
        const watching = this.watchingRoom(peer.epk, room.room_id)
        if (watching) {
          title.append(el("span", "tag tag-open", "open"))
          row.classList.add("room-active")
        }
        row.append(title)
        row.append(el("div", "meta", roomFacts(room).join(" · ")))
        if (control)
          row.append(
            el(
              "div",
              "meta",
              "no transcript — this room starts sessions on the machine",
            ),
          )
        // The control that matches the state. Before, "attach" was the only one,
        // so the only way OUT of a session was into another one: a device that
        // had finished reading a machine stayed pointed at it (and back at it on
        // every reload), with no way to say "stop following this".
        if (watching) {
          const leave = el("button", "detach", "detach")
          leave.title =
            "stop following this session on this device — it keeps running on the machine"
          leave.addEventListener("click", () => this.detach())
          row.append(leave)
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
  private joinControlRoom(
    epk: string,
    room: TrackedRoom,
    opts: { resume?: boolean } = {},
  ): void {
    const client = this.client
    if (!client) return
    // The page this panel is being opened ON TOP OF, read BEFORE this room
    // becomes the active one: after the assignment below there is no previous
    // page left to find, and the one carried would always be the launcher itself
    // (measured — the first version wrote `under: undefined` every time).
    const previous = this.active
    client.setRoutingPeer(epk)
    client.setRoom(room.room_id)
    this.active = {
      epk,
      roomId: room.room_id,
      name: room.name ?? room.room_id,
      caps: room.caps ?? [],
      control: true,
    }
    // Remembered, with `control: true` to say what kind of page it was. This is
    // the page the reader was on, so a reload has to come back to the launch
    // form — not to a transcript they had left, and not to an empty one. It is
    // replaced by a session record the moment a session is attached (including
    // the one this form starts).
    //
    // `under` is the page the panel was opened ON TOP of. Going to the launcher
    // and coming back is not abandoning the session you were reading, so that
    // page is carried — one level deep — and `closeLaunchPanel` puts it back.
    // On a resume `this.active` is null (nothing is attached yet), so the page
    // being carried comes from the record being resumed.
    const under = previous
      ? previous.control
        ? undefined
        : {
            epk: previous.epk,
            roomId: previous.roomId,
            name: previous.name,
          }
      : lastRoom()?.under
    rememberLastRoom({
      epk,
      roomId: room.room_id,
      name: room.name ?? room.room_id,
      control: true,
      under,
    })
    this.reducer.reset()
    this.rowEls.clear()
    this.window = null
    // A half-applied restore from the room we are leaving must not fire on the
    // next render into an empty transcript.
    this.pendingRestore = null
    this.pendingAnchor = null
    this.lastItemCount = 0
    this.shouldPin = true
    this.transcript.replaceChildren()
    this.transcript.hidden = true
    this.historyNotice.hidden = true
    this.composer.hidden = true
    $("loadEarlier").hidden = true
    this.launchHeading.textContent = `New conversation on ${room.name ?? "this machine"}`
    // The daemon's own cwd is a hint about where this machine starts, not an
    // answer: it is the launcher process's cwd, almost never the project.
    this.launchCwd.placeholder = room.cwd || "/absolute/path/to/project"
    // Put back what had been typed. Of everything on this page the folder is the
    // one field a person had to type by hand — it names the MACHINE's
    // filesystem, so the device cannot derive it — and losing it to a refresh
    // costs a re-typed absolute path on a phone keyboard. Matched on the machine
    // rather than the room id: a control room's id can rotate while the machine,
    // and the path being aimed at, are the same.
    const draft = launchDraft()
    if (draft && draft.epk === epk) {
      this.launchCwd.value = draft.cwd
      this.launchName.value = draft.name
      this.autoFilledName = draft.name
    } else {
      this.launchCwd.value = ""
      this.launchName.value = ""
      this.autoFilledName = ""
    }
    // Ask what may be launched into — the machine is the only one who knows.
    // The answer repaints the list against the field as it now stands, so a
    // restored path arrives already filtered and with its group open.
    this.requestLaunchDirs(epk)
    this.setLaunchNote("")
    this.launchPanel.hidden = false
    if (this.drawer.open) this.drawer.close()
    this.title.textContent = room.name ?? "control room"
    this.sub.textContent = `launcher room ${room.room_id.slice(0, 8)} · ${room.caps?.length ?? 0} capabilities`
    // A resume must not steal the keyboard. Clicking "new conversation" means
    // "let me type", so focusing the field is right; a page load doing it
    // unprompted covers half the screen with the keyboard on a phone.
    // preventScroll: even on a deliberate open, letting the browser scroll to
    // the field can push the folder list (and the launch button) under it.
    if (!opts.resume) this.launchCwd.focus({ preventScroll: true })
  }

  /** Back to a normal viewer: the panel goes away, the composer returns.
   *
   *  The page the panel was opened on top of, if there was one, becomes the page
   *  a reload comes back to. Closing a panel is not walking away from the session
   *  you were reading — that is what **detach** says — and without this the
   *  reader who glanced at the launcher, closed it, and refreshed got a blank
   *  page instead of the transcript they had left. The saved position goes back
   *  with it, or the reload would drop them at the tail of a transcript they had
   *  scrolled up in. */
  private closeLaunchPanel(): void {
    const under = lastRoom()?.under
    const view = lastView()
    // A launch already sent is not part of the panel. Pressing launch put the
    // request with the MACHINE; closing the form does not take it back, so the
    // wait survives the close — in memory (the room still opens itself when it
    // lands) and in storage (a reload after the close still recognises it).
    // `clearRoomView` puts the whole view down, so the wait is re-armed against
    // the record's remaining life rather than the panel's 60s note.
    const remaining = this.remainingLaunchWaitMs()
    this.clearRoomView()
    if (remaining > 0) {
      const stored = storedPendingLaunch()!
      this.armLaunchWait(
        { id: stored.id, epk: stored.epk, cwd: stored.cwd },
        remaining,
      )
    }
    if (!under || !this.peers.has(under.epk)) return
    rememberLastRoom(under)
    if (view && view.epk === under.epk && view.roomId === under.roomId) {
      rememberLastView(view)
    }
    // Say it, because the alternative is a page that quietly knows something
    // the reader cannot see.
    this.sub.textContent = `not attached — a reload goes back to ${under.name ?? under.roomId}`
  }

  /** Is this the room this device is pointed at right now? Matched on the live
   *  pair (machine + room id), not on a remembered one — pi mints a new room id
   *  when the machine re-announces, so the remembered id is only ever a hint. */
  private watchingRoom(epk: string, roomId: string): boolean {
    const active = this.active
    return !!active && active.epk === epk && active.roomId === roomId
  }

  /** Stop following the room this client is pointed at — the way out of a
   *  session that is the mirror of `attach`. Nothing changes on the machine: the
   *  session keeps running, its other viewers keep their view, and the room
   *  stays in the list to be opened again. What stops here is this device's
   *  reading of it, and its habit of going back to it on the next load. */
  private detach(): void {
    const was = this.active
    if (!was) return
    // A launch still outstanding goes with it: leaving the room is the reader
    // saying stop, which closing a form does not say.
    forgetPendingLaunch()
    this.clearRoomView()
    this.toast(`detached from ${was.name} — it keeps running on the machine`)
  }

  /** Put the room down: routing, transcript, and the records that would bring
   *  it back on the next load.
   *
   *  Clearing the routing is the part that matters. `session-client.ts` drops
   *  inbound envelopes that are not for the room this view holds, so leaving the
   *  old room id in place would keep folding a room the UI no longer claims to
   *  be showing into a transcript the reader cannot explain (ONE VIEW, ONE
   *  ROOM). Emptying it makes that the same rule that already protects a switch
   *  between two rooms. */
  private clearRoomView(): void {
    this.client?.setRoutingPeer("")
    this.client?.setRoom("")
    this.active = null
    this.sessionEnded = false
    // The reader asked to leave, so a reload must not walk them back in.
    forgetLastRoom()
    forgetLastView()
    this.pendingRestore = null
    this.pendingAnchor = null
    // The in-memory watch goes with the view; whether the RECORD of the ask
    // survives is the caller's call — `detach` drops it, `closeLaunchPanel`
    // re-arms it, because closing a form does not take the request back from the
    // machine.
    this.pendingLaunch = null
    clearTimeout(this.launchTimer)
    this.cancelDirsRequest()
    this.clearLaunchDirs()
    this.clearEndRequest()
    this.launchPanel.hidden = true
    this.transcript.hidden = false
    // No room in view, no input. An empty "message the session…" box on a page
    // that says `not attached` is the same trap the ended bar above replaced: it
    // looks drivable, and the send has nowhere to go. `attach` puts it back.
    this.composer.hidden = true
    this.syncHistoryNotice()
    $("loadEarlier").hidden = true
    this.compactionJump.hidden = true
    this.chipRowId = null
    // `reset()` clears the ended flag too, so the NEXT room's composer is not
    // still painted as the finished state of the room that just went away.
    this.reducer.reset()
    this.rowEls.clear()
    this.window = null
    this.jumpWindow = null
    this.lastItems = []
    this.lastItemCount = 0
    this.shouldPin = true
    this.setEndedView(false)
    this.transcript.replaceChildren()
    this.render()
    this.renderPeerList()
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

  /** Drop the answer and everything painted from it — a panel that is closed,
   *  or asking again, must not keep showing the previous machine's folders. */
  private clearLaunchDirs(): void {
    this.dirsAnswer = null
    this.expandedDirs.clear()
    this.launchDirList.replaceChildren()
    this.launchDirList.hidden = true
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
    this.clearLaunchDirs()
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

  /** Put the answer in the list under the folder field, ordered by full path.
   *
   * Labels stay the WHOLE path, not the leaf: `myai` next to `aichats` says
   * nothing about which root each came from, and a pick has to be readable
   * before it is made. */
  private renderLaunchDirs(answer: LaunchDirsAnswer): void {
    this.launchChoices = dirChoices(answer)
    this.dirsAnswer = answer
    this.expandForCwd()
    this.renderLaunchDirList()
    this.setLaunchDirsHint(dirsHint(answer))
  }

  /** Paint the machine's folders as rows. Repainted on every keystroke, pick
   *  and group toggle — the list is at most a few hundred small buttons and the
   *  alternative (patching one row's classes) is more code than the redraw. */
  private renderLaunchDirList(): void {
    const answer = this.dirsAnswer
    if (!answer) return
    const typed = this.launchCwd.value.trim()
    // An EXACT path is a choice, not a search: browsing stays browsing. Only
    // half-typed text filters, so tapping a folder does not collapse the list
    // down to the row you just tapped.
    const exact = this.launchChoices.some((c) => c.path === typed)
    const filter = exact ? "" : typed
    const rows = dirRows(answer, this.expandedDirs, filter)
    const list = this.launchDirList
    list.replaceChildren()
    for (const row of rows) {
      const btn = el("button", "dir-row")
      btn.type = "button"
      if (row.depth === 1) btn.classList.add("dir-child")
      if (!row.pickable) btn.classList.add("dir-missing")
      if (row.path === typed) btn.classList.add("dir-chosen")
      // A root's marker is its state, not a second control: one tap both
      // chooses the folder and opens what is inside it.
      const caret = el(
        "span",
        "dir-caret",
        row.expandable ? (row.expanded ? "\u25be" : "\u25b8") : "",
      )
      const path = el("span", "dir-path", row.label)
      const meta = el(
        "span",
        "dir-meta",
        row.note ?? (row.childCount ? `${row.childCount} inside` : ""),
      )
      btn.append(caret, path, meta)
      btn.disabled = !row.pickable
      btn.addEventListener("click", () => this.chooseDir(row))
      list.append(btn)
    }
    // A filter that matches nothing has to SAY so: silence looks like the
    // machine stopped answering, and the typed path is still perfectly
    // launchable — the list is a convenience, not a whitelist of what the field
    // accepts. No echo of the text: it is in the field one line above. An EMPTY
    // answer (wildcard, locked, roots that are all gone) stays silent here: the
    // hint under the list names that case in its own words, and saying it twice
    // reads as two different problems.
    //
    // Written about the STATE of the field, not about typing into it. The same
    // line now fires for a path the client put there on a resume, where nobody
    // typed anything a second ago — "what you typed" blamed an action the reader
    // did not just take, which reads like a complaint about the restore.
    if (rows.length === 0 && filter) {
      list.append(
        el(
          "p",
          "dir-empty",
          "no folder listed by this machine matches what is in the field — it still launches if the folder exists there",
        ),
      )
      list.hidden = false
      return
    }
    list.hidden = rows.length === 0
  }

  /** Open the group(s) a folder in the field came from, so the marked row is a
   *  row the user can see. Only for a value that is one of the offered paths —
   *  half-typed text filters the list instead of opening groups in it. */
  private expandForCwd(): void {
    const answer = this.dirsAnswer
    if (!answer) return
    for (const root of rootsCovering(answer, this.launchCwd.value))
      this.expandedDirs.add(root)
  }

  /** A folder from the list: it goes in the field, the name follows it (see
   *  `nextAutoName`), and a root with folders inside it opens or closes them. A
   *  row is one control doing both — the caret is its state, not a second
   *  button to aim at with a thumb. Programmatic assignment fires no
   *  `input`/`change`, so the naming happens here. */
  private chooseDir(row: LaunchDirRow): void {
    if (row.expandable) {
      if (this.expandedDirs.has(row.path)) this.expandedDirs.delete(row.path)
      else this.expandedDirs.add(row.path)
    }
    // A child pick also opens its root: after the tap the field holds the full
    // path, the filter clears, and the chosen row must still be on screen
    // rather than folded away behind a closed group.
    if (row.depth === 1 && this.dirsAnswer)
      for (const root of rootsCovering(this.dirsAnswer, row.path))
        this.expandedDirs.add(root)
    this.launchCwd.value = row.path
    this.applyNameForCwd()
    this.renderLaunchDirList()
    this.setLaunchNote("")
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
    // The note on the form lasts 60s; the RECORD of the ask lasts as long as an
    // exact `launchReq` match is believable (see store.ts). They are different
    // clocks answering different questions: "is this answer late?" versus "is
    // this room still mine?".
    this.armLaunchWait({ id, epk: this.active.epk, cwd }, 60_000)
    rememberPendingLaunch({
      id,
      epk: this.active.epk,
      cwd,
      askedAt: Date.now(),
    })
    this.setLaunchNote(
      `asked the machine for ${cwd} — waiting for it to answer…`,
    )
  }

  /** Watch, in memory, for the room a launch produced, for `remainingMs`.
   *
   *  One helper because three places need the same thing — the form that asked,
   *  a page that resumed mid-launch, and a panel that was closed while the
   *  machine still had the request. */
  private armLaunchWait(
    pending: { id: string; epk: string; cwd: string },
    remainingMs: number,
  ): void {
    this.pendingLaunch = pending
    clearTimeout(this.launchTimer)
    this.launchTimer = setTimeout(
      () => {
        this.pendingLaunch = null
      },
      Math.max(0, remainingMs),
    )
  }

  /** How long a launch asked for in THIS page is still worth waiting for, after
   *  this page stopped showing the form. */
  private remainingLaunchWaitMs(): number {
    const stored = storedPendingLaunch()
    if (!stored) return 0
    return PENDING_LAUNCH_TTL_MS - (Date.now() - stored.askedAt)
  }

  /** The header's session controls. `end` appears only for a session whose
   *  machine advertises the cap — a control room and a gated session both fail
   *  that test on their own. `refresh` needs no cap: re-reading the history is
   *  read-only, and any live session (not a control room) can come back short. */
  private refreshSessionControls(): void {
    this.refreshBtn.hidden =
      this.active === null ||
      this.active.control === true ||
      // Re-reading a transcript needs the ROOM. A session the relay has dropped
      // has nothing left to answer `get_entries`, so offering refresh there is a
      // button that can only fail.
      this.endedInView
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
      this.refreshSessionControls()
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
      this.refreshSessionControls()
    }, TERMINATE_QUIET_MS)
    this.refreshSessionControls()
  }

  private disarmEnd(): void {
    this.endArmed = false
    clearTimeout(this.endArmTimer)
    this.refreshSessionControls()
  }

  /** Called when the room ends (the machine's only answer) or we leave it. */
  private clearEndRequest(): void {
    this.endSentFor = null
    this.endArmed = false
    clearTimeout(this.endWaitTimer)
    clearTimeout(this.endArmTimer)
    this.refreshSessionControls()
  }

  async attach(
    epk: string,
    roomId: string,
    name: string,
    opts: { resume?: boolean } = {},
  ): Promise<void> {
    const client = this.client
    if (!client) return
    client.setRoutingPeer(epk)
    client.setRoom(roomId)
    // Seeded from the room's own record when the listing already has it. Only a
    // machine `hello` used to fill this, and a resume — a reload, a recycled
    // phone tab, a reconnect — never gets one, so every cap-gated control (the
    // session's **end** above all) sat hidden on a live, drivable session.
    this.active = { epk, roomId, name, caps: this.roomCaps(epk, roomId) }
    // Where the reader was, or where they asked to be. A resume (a reload, a
    // recycled phone tab, a socket reconnect, a machine re-announce) puts them
    // back on the row they were reading; an attach they asked for by name
    // starts at the newest rows, because that is what "open this conversation"
    // means.
    this.pendingRestore = null
    this.pendingAnchor = null
    const resumeView = opts.resume ? lastView() : undefined
    // Attaching to a session by hand drops any launch we were waiting on, so a
    // late announce cannot yank the reader into another room mid-read.
    this.pendingLaunch = null
    clearTimeout(this.launchTimer)
    forgetPendingLaunch()
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
    this.setEndedView(false)
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
    // Opening a session means looking at where it is now. A resumed view that
    // lands mid-transcript re-decides the pin from the position it restored to
    // (render, `pinFromPosition`).
    this.shouldPin = true
    this.transcript.replaceChildren()

    // The first frame to a trusted peer is what triggers the extension's
    // attach; session_sync asks for panels + pending dialogs. The transcript
    // itself comes from pi's own paged `get_entries`.
    client.requestSync()
    const read = await this.walkHistory(client, () => {
      // Arm the restore HERE, not at the top of attach: the replay is what puts
      // the reader's anchor row back on the list. Arming it early lost it on any
      // session that is streaming — a live frame renders while the transcript is
      // still empty, does not find the row, and gives up. A row that is really
      // gone is the right reason to fall back to the tail; "not loaded yet" is
      // not. Only the same machine's view is trusted, and it only lands if its
      // anchor row survived the replay — see render().
      if (resumeView && resumeView.epk === epk) this.pendingRestore = resumeView
    })
    // A second sync after the walk: frames the machine sent while the pages were
    // arriving (panels, pending dialogs) are re-asked for rather than missed.
    client.requestSync()
    this.render()
    // The machine list carries the attach/detach control, so it needs to know
    // which room is the live one now.
    this.renderPeerList()
    // LAST, on purpose. This is the only thing that decides what the header
    // says about the transcript, and it has to see the rendered row count. The
    // line that used to live here — `${name} · ${entries.length} entries` —
    // overwrote the careful "machine not answering" message two statements
    // after it wrote it, so a failed read ended with a number that looked
    // deliberate and a blank column underneath.
    this.reportHistory(read)
  }

  /** Walk pi's paged `get_entries` and fold what arrives. `afterFold` runs once
   *  the entries are in the reducer but before anything renders — attach uses it
   *  to arm the view restore, which must be armed against the replayed rows,
   *  not against the empty transcript the attach just cleared. */
  private async walkHistory(
    client: SessionClient,
    afterFold?: () => void,
  ): Promise<{
    entries: unknown[]
    pages: number
    complete: boolean
    error?: string
    timedOut?: boolean
  }> {
    const read = await client.getEntries(undefined, {
      onPage: (rows) => {
        // A climbing number is the difference between "loading" and "broken" on a
        // slow link: a long session takes a while to walk, page by page.
        if (this.active) this.sub.textContent = `reading history · ${rows} rows`
      },
    })
    // The beacon (pi's leaf entry id) is what makes the fold render: the entry
    // tree backwalks from it to derive the active path, and rows are born only
    // for entries on that path. Entries without a beacon are indexed and stay
    // invisible — that is the membership gate, not a bug. `complete` says
    // whether the paging walk finished: a walk that timed out mid-way holds a
    // real leaf id and a too-short entry set, and folding that as authoritative
    // would let a divergence reset the transcript to a partial path.
    this.reducer.applyEntries(read.entries, read.leafId ?? null, read.complete)
    afterFold?.()
    // Turn state comes from pi, not from guessing at the history: a completed
    // entry may still contain tool calls. `get_state.isStreaming` is the same
    // signal the iOS app gates its send/steer button on. Skipped when nothing
    // came back — the machine is away, and a second 15s timeout on top of the
    // first is a 30s dead spinner for no information.
    if (read.entries.length > 0) {
      const piState = await client
        .request<Record<string, unknown>>("get_state")
        .catch(() => undefined)
      this.reducer.reconcileBusy(Boolean(piState?.isStreaming))
    }
    return {
      entries: read.entries,
      pages: read.pages,
      complete: read.complete,
      error: read.error,
      timedOut: read.timedOut,
    }
  }

  /** Re-read the history of the session that is open. The reader's way out of a
   *  short or empty read, and worth having anyway: a machine that restarted, a
   *  link that dropped mid-walk, or a transcript that simply looks stale. It
   *  sends `session_sync` first because that frame is what makes the extension
   *  attach this peer — asking for entries before the machine knows who is
   *  asking is exactly the race that produced the blank transcript. */
  private async refreshHistory(): Promise<void> {
    const client = this.client
    if (!client || !this.active || this.readingHistory) return
    this.readingHistory = true
    this.refreshBtn.disabled = true
    this.sub.textContent = "reading history…"
    try {
      client.requestSync()
      const read = await this.walkHistory(client)
      this.render()
      this.reportHistory(read)
    } catch (err) {
      // No history AND no explanation is the state this control exists to
      // avoid, so a throw in the walk gets the same sentence as a refused page.
      this.reportHistory({
        pages: 0,
        complete: false,
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      this.readingHistory = false
      this.refreshBtn.disabled = false
    }
  }

  /** Record what the last read produced and say so, in the header and in the
   *  transcript area. Call it AFTER the render: the honest row count is the one
   *  on screen, not the one off the wire. */
  private reportHistory(read: {
    pages: number
    complete: boolean
    error?: string
    timedOut?: boolean
  }): void {
    this.history = {
      rows: this.lastItemCount,
      pages: read.pages,
      complete: read.complete,
      ...(read.error === undefined ? {} : { error: read.error }),
      ...(read.timedOut === undefined ? {} : { timedOut: read.timedOut }),
    }
    this.applyHistoryNotice()
  }

  private applyHistoryNotice(): void {
    this.syncHistoryNotice()
    if (this.active) {
      const label = this.history ? historyLabel(this.history) : null
      this.sub.textContent = `${this.active.name} · ${label ?? "synced"}`
    }
  }

  /** The notice sits beside the transcript, so a hidden transcript (the launch
   *  panel open on top of the page) hides it too: a complaint about a history
   *  the reader cannot currently see is noise. */
  private syncHistoryNotice(): void {
    const read = this.history
    const detail = read ? historyDetail(read) : null
    const show = detail !== null && !this.transcript.hidden
    this.historyNotice.hidden = !show
    if (show && read && detail !== null) {
      this.historyNoticeText.textContent = detail
      this.historyRetryBtn.hidden = !historyRetryable(read)
    }
  }

  /** Re-ask the machine for its authoritative turn state. `reconcileBusy` uses
   *  only an explicit `isStreaming`, so a machine that does not answer (or does
   *  not carry the field) leaves the folded state alone instead of guessing idle. */
  private refreshBusyState(): void {
    const client = this.client
    if (!client || !this.active) return
    void client
      .request<Record<string, unknown>>("get_state")
      .then((state) => {
        if (state && typeof state.isStreaming === "boolean")
          this.reducer.reconcileBusy(state.isStreaming)
      })
      .catch(() => undefined)
  }

  /** Finish a launch this page asked for and never saw the result of.
   *
   *  `session_launch` carries a request id that the machine echoes twice: in its
   *  direct answer, and in the `launchReq` of the room it produces. The second
   *  echo is what makes a launch survive a reload — the announce is out there
   *  whether or not the tab that asked still is. So: if the room has landed,
   *  open it; if it has not, keep matching for it and say so.
   *
   *  Without this, refreshing during a launch loses the question. The session
   *  usually starts anyway and appears in the machines list, but the page can no
   *  longer tell "still starting" from "refused" from "never asked" — and the
   *  room it is waiting for looks like somebody else's conversation.
   *
   *  Returns whether it took over the page, so the caller skips the ordinary
   *  resume rather than restoring a different room on top of a launch that just
   *  landed. */
  private recoverPendingLaunch(): boolean {
    const stored = storedPendingLaunch()
    if (!stored) return false
    if (!this.peers.has(stored.epk)) {
      forgetPendingLaunch()
      return false
    }
    const launched = launchedRoom(this.rooms.get(stored.epk) ?? [], stored.id)
    // Re-arm the in-memory match either way: the announce may still be coming.
    this.armLaunchWait(
      { id: stored.id, epk: stored.epk, cwd: stored.cwd },
      PENDING_LAUNCH_TTL_MS - (Date.now() - stored.askedAt),
    )
    const peer = this.peers.get(stored.epk)
    const label = peer?.hostname ?? peer?.machineName ?? "the machine"
    if (!launched) {
      // Said out loud, because the alternative is silence about a request the
      // reader made in a page that no longer exists.
      this.toast(`still waiting for ${label} to start ${stored.cwd}`)
      return false
    }
    forgetPendingLaunch()
    this.pendingLaunch = null
    clearTimeout(this.launchTimer)
    this.toast("that launch finished while the page was closed — opening it")
    void this.attach(stored.epk, launched.room_id, roomTitle(launched))
    return true
  }

  /** Re-open the page this client was last on: the session it was driving, or
   *  the launcher's form. The room id is only a hint — pi's room rotates per
   *  session — so the recorded room is honoured when the machine is still
   *  advertising it, and otherwise the machine's single live room is taken.
   *  Reopening nothing on purpose is right when the machine has no live room:
   *  there is nothing to read. */
  private async resumeSession(): Promise<void> {
    if (this.active || !this.client) return
    const held = lastRoom()
    if (!held) return
    const peer = this.peers.get(held.epk)
    if (!peer) {
      forgetLastRoom(held.epk)
      forgetLastView()
      forgetLaunchDraft()
      return
    }
    const all = this.rooms.get(held.epk) ?? []
    const label = peer.hostname ?? peer.machineName ?? "machine"
    const target = resumeTarget(held, all)
    if (!target) {
      // Nothing to reopen. Say which kind of nothing, because both cases look
      // identical on screen: an empty page and a subtitle nobody reads.
      const sessions = all.filter(isViewableSession)
      if (held.control)
        this.sub.textContent = `no launcher room on ${label} right now — start it in Pi with /unbien install`
      else if (sessions.length > 1)
        this.sub.textContent = `${sessions.length} sessions on ${label} — pick one`
      return
    }
    // A control room has no transcript to replay, so restoring it means opening
    // the form again — the same machine, the same folder already typed, and no
    // keyboard popped up over the page on someone who did not ask for one.
    if (target.kind === "control") {
      this.joinControlRoom(held.epk, target.room, { resume: true })
      return
    }
    await this.attach(
      held.epk,
      target.room.room_id,
      target.room.name ?? held.name ?? target.room.room_id,
      { resume: true },
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
          this.refreshSessionControls()
        }
        break
      }
      case "session_sync_end": {
        const name =
          typeof ub.session_name === "string" ? ub.session_name : undefined
        // Detached: a late protocol frame must not write a session name into a
        // page that is no longer showing one.
        if (!this.active) break
        if (name) {
          this.active.name = name
          this.title.textContent = name
        }
        // "synced" is only the truth about the protocol half. If the transcript
        // came back empty or short the header says so instead — that mismatch
        // (a blank column under a confident header) is what this notice exists
        // to end, and `session_sync_end` is the frame that used to re-create it
        // after the read had already said otherwise.
        const label = this.history ? historyLabel(this.history) : null
        this.sub.textContent = `${this.active.name} · ${label ?? "synced"}`
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
            forgetPendingLaunch()
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
    // Who is following the output: the reader's standing decision, not a
    // measurement of where the scroll happens to be (src/tail-pin.ts). It is
    // read once, at the top, so a `scroll` event cannot change it halfway
    // through a render.
    const followTail = this.shouldPin
    // Where the reader was, BEFORE the DOM moves. Rows born by a rootward
    // extension insert ABOVE the viewport, and a naive follow would yank the
    // reader to the bottom (or to the top when the column empties).
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
    // A jump the reader asked for outranks the scroll rules for one render —
    // `followTail` is computed from where they were standing, which is the
    // bottom, which would snap the window straight back to the tail.
    this.window =
      this.jumpWindow ?? nextWindow(this.window, items.length, followTail)
    this.jumpWindow = null
    this.lastItems = items
    this.lastItemCount = items.length
    // A resume puts the reader back where they were, not at the tail.
    // `followTail` above was measured against the transcript this attach had
    // just emptied — it is always true here — so the saved window has to
    // outrank it, exactly as an explicit jump does. The anchor row is the gate:
    // if the replay did not produce that row (different session in the same
    // room, a branch switch, "Hide thinking" flipped in between), the view is
    // stale and the tail is the honest answer.
    if (this.pendingRestore) {
      const saved = this.pendingRestore
      this.pendingRestore = null
      const index = items.findIndex((item) => item.row === saved.row)
      if (index >= 0) {
        this.window = restoredWindow(saved, index, items.length)
        this.pendingAnchor = { row: saved.row, dy: saved.dy }
      }
    }
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
    // than letting `prompt` fail with `unknown_peer`/`room_ended` toasts. Say it
    // by taking the input AWAY, not by greying it out — a disabled text field
    // still reads as "a chat, paused", and the reader has nowhere to go: the
    // room's card, which carries `detach`, left with the room.
    this.setEndedView(snapshot.flags.ended)
    if (snapshot.flags.ended)
      this.sub.textContent = `${
        this.active?.name ?? "session"
      } · ended on the machine — close to put it down`
    // A jump wins over both scroll rules: the row asked for gets centred, and
    // the chip re-aims at whatever is now off screen.
    if (this.pendingJump !== null) {
      const row = this.pendingJump
      this.pendingJump = null
      this.centerRow(this.rowEls.get(row) ?? null)
      // A jump is the reader naming a row, which may be in the middle of the
      // log. Whatever that position is, that is where they are now.
      this.pinFromPosition()
      this.syncCompactionChip(items)
      this.syncJumpToEnd(items)
      return
    }
    // The resumed position: the saved row at the saved height. It outranks
    // follow-tail for the same render, and only for it.
    if (this.pendingAnchor !== null) {
      const { row, dy } = this.pendingAnchor
      this.pendingAnchor = null
      if (!this.placeAnchor(row, dy))
        this.setScrollTop(this.transcript.scrollHeight)
      this.pinFromPosition()
      this.syncCompactionChip(items)
      this.syncJumpToEnd(items)
      return
    }
    if (followTail || !anchor || !anchor.isConnected) {
      this.setScrollTop(this.transcript.scrollHeight)
    } else {
      // Not following the tail: hold the anchor row visually still, whatever
      // grew or moved above it. This is the other half of the fix — a reader
      // who has stopped the follow needs the rows arriving BELOW them to leave
      // their place alone, and one arriving ABOVE them to be paid back.
      this.setScrollTop(
        this.transcript.scrollTop +
          (anchor.getBoundingClientRect().top - anchorTop!),
      )
    }
    this.syncCompactionChip(items)
    this.syncJumpToEnd(items)
  }

  /** Put a finished conversation down.
   *
   *  **close**, not **detach**: there is nothing left running to stop following,
   *  and the card that carries `detach` went away when the room was dropped from
   *  the listing. What ends here is this device's page — the transcript, the
   *  records that would bring it back on the next load, and the routing. The
   *  machine keeps the session's log; nothing is deleted anywhere. */
  private closeEnded(): void {
    const was = this.active?.name ?? "session"
    this.clearRoomView()
    this.toast(`closed ${was} here — its log stays on the machine`)
  }

  /** Paint the composer as drivable, or as finished.
   *
   *  Hidden rather than disabled: a control that cannot be used should not hold
   *  the space of one, and `hidden` takes it out of the tab order and the a11y
   *  tree in the same move. The queue button goes with them — queueing a message
   *  for a turn that can never arrive is not a thing to offer. */
  private setEndedView(ended: boolean): void {
    if (this.endedInView === ended) return
    this.endedInView = ended
    this.input.hidden = ended
    this.sendBtn.hidden = ended
    this.queueBtn.hidden = ended
    this.stopBtn.hidden = ended || !this.busy
    this.endedNote.hidden = !ended
    this.refreshSessionControls()
  }

  /** The caps the machine's own listing advertises for a room, if that room is
   *  known. Copied, never invented: the machine stays the authority on what a
   *  session allows. */
  private roomCaps(epk: string, roomId: string): string[] {
    return this.rooms.get(epk)?.find((r) => r.room_id === roomId)?.caps ?? []
  }

  /** Move a room's advertised caps onto the room this view is holding, when
   *  nothing has filled them yet, and re-decide the controls gated on them.
   *  Called wherever a listing or an announce lands, because on boot the resume
   *  attaches BEFORE the listing arrives. */
  private syncActiveCaps(): void {
    const active = this.active
    if (!active || active.caps.length > 0) return
    const caps = this.roomCaps(active.epk, active.roomId)
    if (caps.length === 0) return
    active.caps = caps
    this.refreshSessionControls()
  }

  /** Dev-only (`?capture=1`): drive the fold from the console or a driver
   *  script. `__unbienFeed(frame|frames)` pushes envelopes through the SAME
   *  `onEnvelope` the wire uses, so a conformance scenario — or one hand-written
   *  `compaction_start` — replays into a live tab. `__unbienRows()` is what the
   *  FOLD holds, `__unbienDrawn()` what the DOM has, `__unbienWindow()` the slice
   *  between them, and `__unbienScroll()` where the reader sits relative to the
   *  tail. Those four disagreeing is how "the frame arrived but nothing painted"
   *  gets answered in one look rather than a guessing game. */
  private installDebugHooks(): void {
    const store = globalThis as Record<string, unknown>
    store.__unbienFeed = (frames: unknown) => {
      const list = Array.isArray(frames) ? frames : [frames]
      for (const frame of list) this.onEnvelope(frame as EnvelopeMessage)
      return this.reducer.snapshot().items.length
    }
    store.__unbienRows = () =>
      this.reducer.snapshot().items.map((item) => ({
        kind: item.kind,
        row: item.row,
        text: item.text,
        streaming: item.streaming,
        state: item.state,
      }))
    store.__unbienDrawn = () =>
      [...this.transcript.children].map(
        (node) => (node as HTMLElement).dataset.row,
      )
    store.__unbienWindow = () => this.window
    store.__unbienScroll = () => ({
      belowTail:
        this.transcript.scrollHeight -
        this.transcript.scrollTop -
        this.transcript.clientHeight,
      pinned: this.shouldPin,
      window: this.window,
      rows: this.transcript.children.length,
    })
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

  /** The compaction marker is a centred caption about 37px tall, and the turn
   *  it just enabled lands rows underneath it immediately — by the time a
   *  reader looks up, the event that explains the pause is screens above the
   *  tail. Two reports of "it didn't show" were really that: the row was in the
   *  DOM the whole time, 23 rows below the fold. So the header says where it
   *  went: the newest compaction that is NOT on screen gets a chip carrying its
   *  own text, and clicking it walks the window back to the row. */
  private syncCompactionChip(items: TranscriptItem[]): void {
    const chip = this.compactionJump
    let target: TranscriptItem | null = null
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]
      if (item && item.kind === "compaction") {
        target = item
        break
      }
    }
    if (target === null || this.onScreen(target.row)) {
      chip.hidden = true
      this.chipRowId = null
      return
    }
    this.chipRowId = target.row
    chip.textContent = `↑ ${target.text}`
    chip.title = "jump to the compaction"
    chip.hidden = false
  }

  /** Drawn at all (it may be outside the window), and inside the scroll box. */
  private onScreen(row: string): boolean {
    const node = this.rowEls.get(row)
    if (!node || !node.isConnected) return false
    const box = this.transcript.getBoundingClientRect()
    const rect = node.getBoundingClientRect()
    return rect.bottom > box.top && rect.top < box.bottom
  }

  /** Widen the window to cover the row, then centre it. `this.window` is set as
   *  well as `jumpWindow` so a scroll that arrives before the next frame does
   *  not measure against the old slice. */
  private jumpToCompaction(): void {
    const row = this.chipRowId
    if (row === null) return
    const items = this.lastItems
    const index = items.findIndex((item) => item.row === row)
    if (index < 0) return
    const count = Math.max(INITIAL_WINDOW, this.window?.count ?? INITIAL_WINDOW)
    const start = Math.max(
      0,
      Math.min(
        index - Math.floor(count / 2),
        Math.max(0, items.length - count),
      ),
    )
    this.window = { start, count }
    this.jumpWindow = { start, count }
    this.pendingJump = row
    this.render()
  }

  /** Centre a row inside the transcript's own scroll box. `scrollIntoView` is
   *  the obvious call and the wrong one: it scrolls every scrollable ANCESTOR
   *  too, which can move the page and the drawer under the reader. */
  private centerRow(node: HTMLElement | null): void {
    if (!node) return
    const box = this.transcript.getBoundingClientRect()
    const rect = node.getBoundingClientRect()
    this.setScrollTop(
      this.transcript.scrollTop +
        rect.top -
        box.top -
        (box.height - rect.height) / 2,
    )
  }

  /** Put a row back at the height it was at, for a resumed view. False when the
   *  row is not drawn, so the caller can fall back to the tail. */
  private placeAnchor(row: string, dy: number): boolean {
    const node = this.rowEls.get(row)
    if (!node || !node.isConnected) return false
    const box = this.transcript.getBoundingClientRect()
    this.setScrollTop(
      this.transcript.scrollTop +
        node.getBoundingClientRect().top -
        box.top -
        dy,
    )
    return true
  }

  /** Every SCRIPT-side scroll goes through here, so the `scroll` listener can
   *  recognise its own echo (`appScrollTop`) instead of reading the app's
   *  follow as the reader's intent. Read back rather than assumed: a value
   *  beyond the bottom is clamped by the browser, and an assumed one would
   *  never match the echo. */
  private setScrollTop(top: number): void {
    this.transcript.scrollTop = top
    this.appScrollTop = this.transcript.scrollTop
  }

  /** Pixels from the bottom edge of the scroll box to the bottom of its
   *  content; ~0 means the newest drawn row is on the fold. */
  private tailDistance(): number {
    const box = this.transcript
    return belowTail(box.scrollHeight, box.scrollTop, box.clientHeight)
  }

  /** Is there earlier content above to move into? Without it a scroll up is not
   *  "leave the tail": with the whole log inside the viewport, disarming would
   *  strand the next rows below the fold with no gesture left to reach them. */
  private canScrollUp(): boolean {
    const box = this.transcript
    return box.scrollTop > 0 && box.scrollHeight > box.clientHeight + ARRIVE_PX
  }

  /** A position the app put the reader at (a jump, a resumed view) decides the
   *  pin by itself: mid-log means the follow is off, on the bottom means it is
   *  on. Not `pinAfterScroll` — there is no movement to read, and keeping the
   *  previous value would let the next delta undo the jump. */
  private pinFromPosition(): void {
    this.shouldPin = this.tailDistance() <= ARRIVE_PX
  }

  /** The pill for a reader who stopped following the tail: rows keep arriving
   *  below them, unseen, and a transcript that has stopped moving needs to say
   *  WHY. Same job as the compaction chip (which says where a row went); this
   *  one says how much has gone by. The app has the same control
   *  (`jumpToEndButton`, TranscriptView.swift). */
  private syncJumpToEnd(items: TranscriptItem[]): void {
    const pill = this.jumpToEnd
    // A full replay, a detach, and a session swap all empty the transcript with
    // `replaceChildren()`, which takes the pill with them. Re-hanging it here
    // (the end of every render) means no clear site has to remember it.
    if (!pill.isConnected) this.transcript.append(pill)
    // No pill for a reader who is already looking at the bottom, however the
    // pin got there: the pill promises content they cannot see, and there is
    // none.
    if (
      this.shouldPin ||
      this.tailDistance() <= ARRIVE_PX ||
      items.length === 0
    ) {
      pill.hidden = true
      return
    }
    const below = this.window ? hiddenAfter(this.window, items.length) : 0
    pill.textContent = below > 0 ? `↓ ${below} below` : "↓ newest"
    pill.title = "show the newest lines"
    pill.hidden = false
  }

  /** Write where the reader is standing, for the next load. Debounced on scroll
   *  (a flick is dozens of events and localStorage is synchronous), and called
   *  directly on the way out — see the `pagehide`/visibilitychange hooks. */
  private scheduleViewSave(): void {
    clearTimeout(this.viewTimer)
    this.viewTimer = setTimeout(() => this.saveViewState(), 250)
  }

  private saveViewState(): void {
    clearTimeout(this.viewTimer)
    this.viewTimer = undefined
    const active = this.active
    const drawn = this.window
    // A transcript position only exists for a session. A control room has no
    // rows to stand on; the page it goes back to is the launch form, and that is
    // carried by the launch draft instead.
    if (!active || active.control || !drawn) return
    const anchor = this.anchorRow()
    const row = anchor?.dataset.row
    if (!anchor || !row) return
    const index = this.lastItems.findIndex((item) => item.row === row)
    if (index < 0) return
    const box = this.transcript.getBoundingClientRect()
    rememberLastView({
      epk: active.epk,
      roomId: active.roomId,
      row,
      index,
      dy: Math.round(anchor.getBoundingClientRect().top - box.top),
      window: drawn,
      savedAt: Date.now(),
    })
  }

  /** Both halves of "the page I was on": where the reader stood in a
   *  transcript, and what they had typed into a launch form. One call at the two
   *  hooks that fire when the page is going away. */
  private savePage(): void {
    this.saveViewState()
    this.saveLaunchDraft()
  }

  private scheduleDraftSave(): void {
    clearTimeout(this.draftTimer)
    this.draftTimer = setTimeout(() => this.saveLaunchDraft(), 250)
  }

  /** The launch form, kept while it is open. An empty form is not stored: there
   *  is nothing to put back, and a stale empty record would overwrite the fields
   *  of someone who has since typed something. */
  private saveLaunchDraft(): void {
    clearTimeout(this.draftTimer)
    this.draftTimer = undefined
    const active = this.active
    if (!active?.control) return
    const cwd = this.launchCwd.value.trim()
    const name = this.launchName.value.trim()
    if (!cwd && !name) {
      // An empty form has nothing to put back, so the record goes rather than
      // being skipped: erasing the field by hand has to erase the memory too, or
      // a path the reader deleted comes back on the next open.
      forgetLaunchDraft()
      return
    }
    rememberLaunchDraft({ epk: active.epk, roomId: active.roomId, cwd, name })
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
      // `state` is set only when the compaction did NOT happen (refused or
      // cancelled): the row then has to read as a refusal, not as a fold.
      if (item.state) node.dataset.state = item.state
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
      // Collapsing a long row is a layout change the app caused, not the reader
      // leaving the tail — but it moves the scroll box (the browser's own
      // anchoring adjusts it on Safari, which cannot be told otherwise), and a
      // `scroll` event for it reads like intent. So re-take the echo value once
      // the frame has laid out, and put the pin back if it was on. The rendering
      // steps dispatch scroll events before running animation-frame callbacks,
      // so the disarming lands first and is undone here, inside one frame.
      const wasPinned = this.shouldPin
      requestAnimationFrame(() => {
        this.appScrollTop = this.transcript.scrollTop
        if (wasPinned) this.shouldPin = true
      })
    })
    node.append(button)
  }

  private patchItem(node: HTMLElement, item: TranscriptItem): void {
    node.classList.toggle("streaming", item.streaming)
    if (item.kind === "compaction") {
      // A compaction row changes state without changing kind: it opens as
      // "Auto-compacting..." and settles either folded (no state) or refused
      // (failed). The caption is re-set below from the changed text; the state
      // attribute has to follow it or the row keeps the colour of the attempt
      // that already ended.
      if (item.state) node.dataset.state = item.state
      else delete node.dataset.state
    }
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
    // Sending is the clearest possible "show me the newest": a reader who had
    // scrolled up to read history does not want their own message — and the
    // answer to it — happening below the fold. The iOS app arms its pin on
    // submit for the same reason.
    this.shouldPin = true
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
