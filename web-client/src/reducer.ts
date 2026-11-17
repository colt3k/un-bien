/**
 * The transcript fold: wire frames in, ordered transcript out.
 *
 * One fold for both paths — history (`get_entries` pages) and live streaming —
 * because the wire makes them the same thing if you replay entries as the
 * synthetic frames the live stream produces (message_end / tool_execution_*),
 * exactly as `unbien-cli/src/reduce.ts` and the Swift `SessionState.applyEntries`
 * do. Two folds is how a client ends up rendering history differently from live.
 *
 * The item vocabulary follows `contracts/conformance/vocab.md` (kind, row, text,
 * streaming, tool/state, blocks, images; flags, subagents, plan, pendingAsks,
 * leafId) so the corpus under `contracts/conformance/scenarios/` is meaningful
 * here. test/corpus.test.ts asserts that whole projection, in render order,
 * with no scenarios skipped.
 */
import type { EnvelopeMessage } from "@geohar/un-bien/client"
import { EntryTree, type PathPlan } from "./derive.js"
import {
  identify,
  imagesFromContent,
  joinedText,
  stableHash,
} from "./content-identity.js"
import {
  projectionBlocks,
  resolveToolResult,
  type ToolFace,
} from "./tool-faces.js"

export type ItemKind =
  "user" | "assistant" | "reasoning" | "tool" | "notice" | "compaction"

export interface TranscriptItem {
  kind: ItemKind
  /** Stable row key: the pi entry id when replay-stable, else `<kind>#<seq>`. */
  row: string
  /** Set on a `notice` row: the code the notify carried (the corpus keeps only
   *  coded notifies). */
  code?: string
  text: string
  streaming: boolean
  tool?: string
  state?: "running" | "ok" | "failed"
  /** The card's RESULT FACE (`terminal`, `file`, `diff`, `lines`, `markdown`,
   *  `error`, `text`, `pending`, …) plus "hunks" when it carries a diff. This is
   *  the corpus's `blocks` field, and it comes from `tool-faces.ts` — not from
   *  sniffing the text. */
  blocks: string[]
  /** The resolved face, kept so the renderer draws a terminal, a file, a diff or
   *  prose the way the face says instead of guessing from the text. */
  face?: ToolFace
  /** Severity notices the face carries (bash truncation, read continuation,
   *  grep limit), shown apart from the output itself. */
  notices?: string[]
  images: number
  toolCallId?: string
  /** The call's args and canonical `{content, details?}` result, kept so the
   *  face can be re-resolved when either arrives late (a replayed toolCall block
   *  carries args the live frame may not have). */
  args?: unknown
  result?: unknown
  /** True when this row's key IS a pi entry id (born from an entry, or re-keyed
   *  to one). The boundary between replayed history and the live tail is
   *  defined by this, and that boundary is where late entry births insert. */
  replayStable: boolean
  /** Edit-family diff hunks the extension rides in `env.aux` alongside the
   *  byte-faithful rpc frame. Not part of the corpus vocabulary. */
  hunks?: unknown[]
  /** Live tail of a running tool's output; not part of the corpus vocabulary. */
  partial?: string
}

export interface AskRequest {
  id: string
  method: "select" | "confirm" | "input" | "editor" | "notify"
  title?: string
  message?: string
  options?: string[]
  placeholder?: string
  prefill?: string
  notifyType?: "info" | "warning" | "error"
  /** pi-ask's rich flow envelope; present when the machine sent a full
   *  question set rather than a bare dialog. */
  ask?: Record<string, unknown>
}

export interface SubagentRecord {
  id: string
  status: string
  type?: string
  description?: string
  result?: string
  error?: string
}

export interface PlanSnapshot {
  project?: string
  itemCount: number
}

/** A live-only notice: the app toasts it; it never becomes a transcript row. */
export interface Toast {
  id: string
  level: "info" | "warning" | "error"
  text: string
}

export interface ReducerSnapshot {
  items: TranscriptItem[]
  flags: { streaming: boolean; ended: boolean }
  subagents: SubagentRecord[]
  plan: PlanSnapshot | null
  /** Dialogs the app can still answer — a live overlay, not a transcript row. */
  pendingAsks: AskRequest[]
  /** Non-coded `notify`s, drained on read so each is shown once. The corpus's
   *  reference projection keeps these OUT of `items` — scenarios 001, 002 and
   *  007 each carry a rate-limit warning of exactly this kind. */
  toasts: Toast[]
  /** Rows whose key changed this batch (a live placeholder becoming a pi entry
   *  id). The DOM must RENAME the element, not build a new one: a rename keeps
   *  the reader's scroll position and the row's place in the log. Drained on
   *  read, like `toasts`. */
  rekeys: { from: string; to: string }[]
  leafId: string | null
}

type Frame = Record<string, unknown>

function asFrame(value: unknown): Frame | null {
  return typeof value === "object" && value !== null ? (value as Frame) : null
}

interface ContentBlock {
  type?: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  arguments?: unknown
  language?: string
  data?: unknown
  mimeType?: string
}

function blocksOf(message: Frame | null): ContentBlock[] {
  const content = message?.content
  return Array.isArray(content) ? (content as ContentBlock[]) : []
}

/** Concatenated prose of a message's text blocks (the transcript's text). */
function textOf(content: ContentBlock[]): string {
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("")
}

/**
 * Replay `get_entries` history as the SAME synthetic frames the live stream
 * produces. Ported from `unbien-cli/src/reduce.ts`; the entry id rides along as
 * a row hint so replayed rows carry pi's stable ids (the corpus's
 * `replayStable` rule).
 */
export function entriesToEnvelopes(
  entries: readonly unknown[],
): { env: EnvelopeMessage; rowHint?: string }[] {
  const out: { env: EnvelopeMessage; rowHint?: string }[] = []
  for (const raw of entries) {
    const entry = asFrame(raw)
    if (!entry || entry.type !== "message") continue
    const message = asFrame(entry.message)
    if (!message) continue
    // pi's internal system-prompt record (role "system") is STATE, not
    // transcript content — rendering it crashes every transcript renderer.
    if (message.role === "system") continue

    const rowHint = typeof entry.id === "string" ? entry.id : undefined

    if (message.role === "toolResult") {
      out.push({
        env: {
          rpc: {
            type: "tool_execution_end",
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            result: { content: message.content, details: message.details },
            isError: message.isError === true,
          },
        },
        rowHint,
      })
      continue
    }

    out.push({ env: { rpc: { type: "message_end", message } }, rowHint })

    // An assistant turn carries its tool calls inline; the card is born from
    // the start frame, exactly as in the live stream.
    if (message.role !== "assistant" || !Array.isArray(message.content))
      continue
    for (const block of message.content) {
      const call = asFrame(block)
      if (!call || call.type !== "toolCall") continue
      out.push({
        env: {
          rpc: {
            type: "tool_execution_start",
            toolCallId: call.id,
            toolName: call.name,
            args: call.arguments,
          },
        },
        rowHint,
      })
    }
  }
  return out
}

/** Normalize a raw fixture line: bare rpc frames and wrapped envelopes both occur. */
export function toEnvelope(line: unknown): EnvelopeMessage | null {
  const obj = asFrame(line)
  if (!obj) return null
  if ("rpc" in obj || "evt" in obj || "ub" in obj) return obj as EnvelopeMessage
  if (typeof obj.type === "string") return { rpc: obj }
  return null
}

/** Blocking dialogs — the only `extension_ui_request` methods that become a
 *  pending ask. Mirrors the reference reducer's case list. */
const ASK_METHODS = new Set(["select", "confirm", "input", "editor"])
/** Panel statuses the `subagents:*` channels name. */
const SUBAGENT_STATUSES = new Set(["started", "steered", "completed", "failed"])

export class TranscriptReducer {
  private readonly items: TranscriptItem[] = []
  /** row key → item, for live/streaming upserts and tool-result pairing. */
  private readonly byRow = new Map<string, TranscriptItem>()
  private readonly toolsById = new Map<string, TranscriptItem>()
  /** pi's entry tree: every entry retained, the derived path, the membership
   *  gate. Rows are born only for entries on that path. */
  private readonly tree = new EntryTree()
  /** `identify(message)` → the row that message already owns. This is the ONLY
   *  bridge between an id-less live frame and the id-carrying entry that shows
   *  up later; the match loop re-keys the live row to the durable entry id
   *  instead of birthing a twin. */
  private readonly identifyIndex = new Map<string, string>()
  /** Rows still waiting for their entry id (live-built placeholders). */
  private readonly pendingRows = new Set<string>()
  /** The row the current message's text deltas are landing in — ONE per kind
   *  per message, so a message with three text blocks is one bubble, not three
   *  rows. */
  private openAssistant: string | null = null
  private openReasoning: string | null = null
  private subagents: SubagentRecord[] = []
  private plan: PlanSnapshot | null = null
  private readonly asks = new Map<string, AskRequest>()
  private pendingToasts: Toast[] = []
  /** Row renames awaiting the next render — see `ReducerSnapshot.rekeys`. */
  private rekeyLog: { from: string; to: string }[] = []
  private leafId: string | null = null
  private streaming = false
  private ended = false
  private seq: Record<ItemKind, number> = {
    user: 0,
    assistant: 0,
    reasoning: 0,
    tool: 0,
    notice: 0,
    compaction: 0,
  }

  /** Fold a page of pi entries. `leafId` is the ACTIVE-LEAF BEACON, and is only
   *  one when the page COMPLETED the walk (came back empty) — a partial page's
   *  `leafId` is a resume cursor, and deriving from it builds a partial path
   *  that can strand the transcript empty. */
  applyEntries(
    entries: readonly unknown[],
    leafId?: string | null,
    authoritative = true,
  ): void {
    if (typeof leafId === "string" && leafId !== "") this.leafId = leafId
    this.applyPlan(
      this.tree.applyEntries(
        entries,
        leafId ?? null,
        authoritative,
        this.turnOpen(),
      ),
    )
  }

  /** A turn is in flight: a reset would tear a streaming bubble in half, so the
   *  derive defers it and the held leaf re-derives at turn end. */
  private turnOpen(): boolean {
    return (
      this.streaming ||
      this.openAssistant !== null ||
      this.openReasoning !== null
    )
  }

  private applyPlan(plan: PathPlan): void {
    if (plan.reset) this.resetRows()
    if (plan.prepend.length > 0) {
      const born: string[] = []
      for (const id of plan.prepend) {
        const before = this.items.length
        this.birthEntry(this.tree.entry(id))
        for (let i = before; i < this.items.length; i++)
          born.push(this.items[i]!.row)
      }
      this.moveToFront(born)
    }
    for (const id of plan.birth) this.birthEntry(this.tree.entry(id))
  }

  /** Rootward ancestry is the OLDEST content, so it belongs before everything
   *  already on screen — including rows the live stream is still building. */
  private moveToFront(rows: readonly string[]): void {
    if (rows.length === 0) return
    const wanted = new Set(rows)
    const moved = this.items.filter((item) => wanted.has(item.row))
    if (moved.length === 0) return
    const rest = this.items.filter((item) => !wanted.has(item.row))
    this.items.length = 0
    this.items.push(...moved, ...rest)
  }

  /** Drop every rendered row after a derive DIVERGED (the only destructive
   *  outcome). The entry tree keeps everything — the abandoned branch stays as
   *  data — and the new path re-births from it. */
  private resetRows(): void {
    this.items.length = 0
    this.byRow.clear()
    this.toolsById.clear()
    this.identifyIndex.clear()
    this.pendingRows.clear()
    this.openAssistant = null
    this.openReasoning = null
  }

  /** Birth ONE entry's rows. Port of `SessionState+BirthEntry.birthEntry` — the
   *  same funnel the live path uses, so a replayed entry and the frame that
   *  streamed it produce the same row. */
  private birthEntry(raw: unknown): void {
    const entry = asFrame(raw)
    if (!entry) return
    const entryId = typeof entry.id === "string" ? entry.id : undefined
    switch (entry.type) {
      case "compaction":
        this.insertBeforeLiveTail({
          kind: "compaction",
          row: entryId ?? this.row("compaction"),
          text: "",
          streaming: false,
          blocks: [],
          images: 0,
          replayStable: true,
        })
        return
      case "custom_message": {
        // pi's custom-role entry: content + display are TOP-LEVEL here (no
        // `message` object). Extension bookkeeping rides display:false and must
        // stay invisible; mesh agent messages ride display:true.
        if (entry.display === false) return
        this.insertBeforeLiveTail({
          kind: "notice",
          row: `notice@${stableHash(joinedText(entry.content))}`,
          text: joinedText(entry.content),
          streaming: false,
          blocks: [],
          images: 0,
          code: "custom",
          replayStable: true,
        })
        return
      }
      case "message": {
        const message = asFrame(entry.message)
        if (!message) return
        const role = String(message.role ?? "")
        if (role === "toolResult") {
          // A tool result is not a row: it settles the card the toolCall born.
          this.finishTool(String(message.toolCallId ?? ""), message)
          return
        }
        this.applyMessageEnd(message, entryId)
        return
      }
      default:
        // model_change / thinking_level_change / label / ... : state, not rows.
        return
    }
  }

  /** The match loop's other half: rename a live-built row to the durable entry
   *  id, keeping its content and position. Anchors and later replays then key
   *  on the id pi gave it. */
  private rekeyRow(
    row: string,
    entryId: string,
    kind: ItemKind,
  ): string | null {
    const item = this.byRow.get(row)
    if (!item) return null
    const next = entryId
    if (this.byRow.has(next) && next !== row) return null
    this.byRow.delete(row)
    this.pendingRows.delete(row)
    this.rekeyLog.push({ from: row, to: next })
    if (this.openAssistant === row) this.openAssistant = next
    if (this.openReasoning === row) this.openReasoning = next
    item.row = next
    // The row is now anchored to pi's durable id: it counts as history, so a
    // later late birth inserts before it, not after.
    item.replayStable = true
    this.byRow.set(next, item)
    return next
  }

  apply(env: EnvelopeMessage, rowHint?: string): void {
    const evt = env.evt
    if (evt && typeof evt.channel === "string") {
      this.applyEvt(evt.channel, evt.data)
      return
    }
    const rpc = asFrame(env.rpc)
    if (!rpc) return

    switch (rpc.type) {
      case "message_start": {
        // Opens a message; its rows are created by the deltas or by message_end.
        // One open row per kind per message — that is what keeps a message with
        // several text blocks a single bubble.
        this.messageSeq += 1
        this.openAssistant = null
        this.openReasoning = null
        this.streaming = true
        break
      }
      case "message_update": {
        this.applyMessageUpdate(rpc, rowHint)
        break
      }
      case "message_end": {
        this.applyMessageEnd(asFrame(rpc.message), rowHint)
        break
      }
      case "tool_execution_start": {
        this.startTool(
          String(rpc.toolCallId ?? ""),
          String(rpc.toolName ?? "?"),
          asFrame(rpc.args) ?? undefined,
          Array.isArray(env.aux?.hunks)
            ? (env.aux?.hunks as unknown[])
            : undefined,
        )
        break
      }
      case "tool_execution_update": {
        const card = this.toolsById.get(String(rpc.toolCallId ?? ""))
        if (!card) break
        const partial = asFrame(rpc.partialResult)
        const preview = partial ? summarizeResult(partial.content) : ""
        if (preview) card.partial = preview.slice(0, 2_000)
        // The running face comes from the partial output, as in the reference:
        // shell output is already terminal text, anything else (an agent's
        // progress) stays plain text until the call settles.
        this.applyToolView(card, "running", partial ?? undefined)
        break
      }
      case "tool_execution_end": {
        const card = this.toolsById.get(String(rpc.toolCallId ?? ""))
        if (!card) break
        const result = asFrame(rpc.result)
        if (!card.hunks && Array.isArray(env.aux?.hunks))
          card.hunks = env.aux?.hunks as unknown[]
        card.images = countImages(result?.content)
        this.applyToolView(card, rpc.isError === true ? "failed" : "ok", result)
        break
      }
      case "response": {
        // pi's reconstruction pages arrive as `get_entries` RESPONSES. They fold
        // through the entry tree, NOT as live frames: the tree decides which
        // entries are on the derived path at all, and a row is only born for
        // those. Folding a page as frames (what the spike did) renders abandoned
        // branches and duplicates the rows the live stream already built.
        if (rpc.command === "get_entries") {
          const data = asFrame(rpc.data) ?? {}
          const entries = Array.isArray(data.entries)
            ? (data.entries as unknown[])
            : []
          const completed = entries.length === 0
          this.applyEntries(
            entries,
            completed ? String(data.leafId ?? "") || null : null,
          )
          if (typeof data.leafId === "string") this.leafId = data.leafId
        }
        break
      }
      case "extension_ui_request": {
        this.applyUiRequest(rpc)
        break
      }
      case "extension_ui_response": {
        // The machine resolved a dialog it asked us to render.
        this.asks.delete(String(rpc.id ?? ""))
        break
      }
      case "entry_appended": {
        this.applyEntryAppended(asFrame(rpc.entry))
        break
      }
      case "compaction":
      case "session_compact": {
        this.push({
          kind: "compaction",
          row: this.row("compaction", rowHint),
          text: "",
          streaming: false,
          blocks: [],
          replayStable: false,
          images: 0,
        })
        break
      }
      case "turn_start":
      case "agent_start": {
        this.streaming = true
        this.ended = false
        break
      }
      case "turn_end":
      case "agent_end":
      case "agent_settled": {
        // A turn ending is NOT the session ending. `ended` means the machine
        // stopped being drivable, and only `session_shutdown` says that; the
        // corpus asserts `ended == false` after a completed turn for a reason.
        this.streaming = false
        // Any row still marked streaming is stale once the turn settles.
        for (const item of this.items)
          if (item.kind !== "tool") item.streaming = false
        break
      }
      case "session_shutdown": {
        this.ended = true
        this.streaming = false
        for (const item of this.items)
          if (item.kind !== "tool") item.streaming = false
        break
      }
      default:
        break
    }
  }

  private applyMessageUpdate(rpc: Frame, rowHint?: string): void {
    const event = asFrame(rpc.assistantMessageEvent)
    if (!event) return
    // Delta dedup: the wire's delta frames carry NO id, and duplicate delivery
    // (reconnect, doubled subscription paths) would double every chunk — and the
    // doubled pending text then fails the identify match at completion, birthing
    // a twin row. An EXACT immediate repeat is a redelivery; real consecutive
    // deltas are distinct by construction.
    const signature = `${String(event.type)}|${String(event.delta ?? event.content ?? "")}`
    if (signature === this.lastDelta) return
    this.lastDelta = signature

    const kind: ItemKind =
      event.type === "thinking_start" ||
      event.type === "thinking_delta" ||
      event.type === "thinking_end"
        ? "reasoning"
        : "assistant"
    // Only text and thinking allocate a row. A `toolcall_*` delta must NOT open
    // a text bubble, or a tool-only message renders an empty assistant row.
    const isText = /^text_/.test(String(event.type))
    const isThinking = /^thinking_/.test(String(event.type))
    if (!isText && !isThinking) {
      if (event.type === "toolcall_start")
        this.startTool(
          String(event.id ?? ""),
          String(event.toolName ?? "?"),
          undefined,
        )
      return
    }
    const row = this.openRow(kind, rowHint)
    if (!row) return
    const item = this.touch(kind, row)

    switch (event.type) {
      case "text_start":
      case "thinking_start":
        this.streaming = true
        break
      case "text_delta":
      case "thinking_delta":
        item.streaming = true
        item.text += typeof event.delta === "string" ? event.delta : ""
        break
      case "text_end":
      case "thinking_end":
        if (typeof event.content === "string") item.text = event.content
        item.streaming = false
        break
      default:
        break
    }
  }

  /** The row the current message's text (or thinking) deltas are landing in.
   *  Allocated once per message per kind — the placeholder is pi's entry id when
   *  a replay hands one over, else the corpus's `<kind>#<seq>`. */
  private openRow(kind: ItemKind, rowHint?: string): string | null {
    if (kind === "reasoning") {
      if (this.openReasoning === null)
        this.openReasoning = rowHint ?? this.row("reasoning")
      return this.openReasoning
    }
    if (this.openAssistant === null)
      this.openAssistant = rowHint ?? this.row("assistant")
    return this.openAssistant
  }

  /** Fold `message_end` for both planes: a LIVE frame (no `entryId`) builds a
   *  placeholder row that the match loop re-keys when the entry lands; an
   *  ENTRY-born frame (from the tree) matches first and births only on a miss.
   *  Port of `applyRPCMessageEnd` + the match loop in `birthEntry`. */
  private applyMessageEnd(message: Frame | null, entryId?: string): void {
    if (!message) return
    const role = String(message.role ?? "")
    if (role === "toolResult" || role === "system") return
    const key = identify(message)

    if (role === "custom") {
      // un-bien's own bookkeeping (mesh name assignment, relay state) rides
      // custom-role messages flagged display:false precisely so clients don't
      // surface them. The id is content-keyed so a live birth and its later
      // entry replay are the same row.
      if (message.display === false) return
      const text = joinedText(message.content)
      this.push({
        kind: "notice",
        row: `notice@${stableHash(text)}`,
        text,
        streaming: false,
        blocks: [],
        images: 0,
        code: "custom",
        replayStable: false,
      })
      return
    }
    if (role !== "user" && role !== "assistant") return
    const kind: ItemKind = role === "user" ? "user" : "assistant"

    if (message.stopReason === "error") {
      // A failed turn is a notice, not a bubble. Content-keyed, so a live error
      // and its later entry replay dedup into one row.
      const text = String(message.errorMessage ?? "Provider error")
      const item = {
        kind: "notice" as ItemKind,
        row: `notice@err@${stableHash(text)}`,
        text,
        streaming: false,
        blocks: [] as string[],
        images: 0,
        code: "provider_error",
        replayStable: entryId !== undefined,
      }
      // A "now" failure belongs at the tail; a REPLAYED one belongs in the log,
      // where it happened — historical warnings must not float below the newest
      // message on a reconnect.
      if (entryId !== undefined) this.insertBeforeLiveTail(item)
      else this.push(item)
      return
    }

    const content = blocksOf(message)
    const calls = content.filter((block) => block.type === "toolCall")
    const images = imagesFromContent(message.content).length
    const text = joinedText(message.content)

    if (entryId !== undefined) {
      // MATCH FIRST: this entry is a row already on screen (live-built, or born
      // by an earlier page). Re-key it — never append a twin.
      const existing = this.identifyIndex.get(key)
      if (existing !== undefined) {
        const next = this.rekeyRow(existing, entryId, kind)
        if (next !== null) this.identifyIndex.set(key, next)
        this.reconstructCards(calls, true)
        return
      }
      // An assistant entry with no prose and no image births NOTHING: its
      // thinking is not a replay row, and its tool calls are cards.
      if (kind === "assistant" && text === "" && images === 0) {
        this.reconstructCards(calls, true)
        return
      }
      this.insertBeforeLiveTail({
        kind,
        row: entryId,
        text,
        streaming: false,
        blocks: [],
        images,
        replayStable: true,
      })
      this.identifyIndex.set(key, entryId)
      this.reconstructCards(calls, true)
      return
    }

    // LIVE plane. A live frame for a message that already owns a row is a
    // redelivery — the relay does not redeliver, but a reconnect or a replayed
    // subscription buffer can.
    if (this.identifyIndex.has(key)) return
    if (kind === "assistant" && this.openAssistant !== null) {
      // Settle the delta-built bubble and KEEP its placeholder id; the entry id
      // arrives with the next `get_entries` and the match loop re-keys it.
      // pi's stored content wins when it holds MORE than the deltas delivered
      // (a client that joined mid-stream saw a prefix, never more) — content is
      // never lost, and the row keeps the position the viewer watched.
      const item = this.touch(kind, this.openAssistant)
      item.streaming = false
      if (text.length > item.text.length) item.text = text
      if (images > 0) item.images = images
      this.identifyIndex.set(key, this.openAssistant)
      this.pendingRows.add(this.openAssistant)
      this.openAssistant = null
    } else {
      if (kind === "assistant" && text === "" && images === 0) {
        this.reconstructCards(calls, false)
        return
      }
      const row = this.row(kind)
      this.push({
        kind,
        row,
        text,
        streaming: false,
        blocks: [],
        images,
        replayStable: false,
      })
      this.identifyIndex.set(key, row)
      this.pendingRows.add(row)
    }
    this.reconstructCards(calls, false)
  }

  /** Replay reconstructs tool cards from the assistant entry's own `toolCall`
   *  blocks — the live stream opened them with separate `tool_execution_start`
   *  frames. `startTool` dedups by call id, so a live-opened card is untouched. */
  private reconstructCards(
    calls: readonly ContentBlock[],
    fromEntry: boolean,
  ): void {
    for (const call of calls)
      this.startTool(
        String(call.id ?? ""),
        String(call.name ?? "?"),
        asFrame(call.arguments) ?? undefined,
        undefined,
        fromEntry,
      )
  }

  /** A replayed `toolResult` entry settles the card its toolCall opened. */
  private finishTool(toolCallId: string, message: Frame): void {
    const card = this.toolsById.get(toolCallId)
    if (!card) return
    card.images = countImages(message.content)
    // pi's canonical result shape, so replay resolves the SAME face the live
    // `tool_execution_end` produced.
    this.applyToolView(card, message.isError === true ? "failed" : "ok", {
      content: message.content,
      details: message.details,
    })
  }

  /** Resolve and store a card's result view. One place because the face is a
   *  function of (tool name, args, canonical result, state), and the same card
   *  passes through it running → settled, live and replay alike. */
  private applyToolView(
    card: TranscriptItem,
    state: "running" | "ok" | "failed",
    result: unknown,
  ): void {
    card.state = state
    if (result !== undefined) card.result = result
    const view = resolveToolResult({
      tool: card.tool ?? "?",
      args: (card.args ?? {}) as Record<string, unknown>,
      result: card.result,
      state,
    })
    card.face = view.face
    card.blocks = projectionBlocks(view, card.hunks)
    card.notices = view.diagnostics.length > 0 ? view.diagnostics : undefined
    const face = view.face
    card.text =
      face.kind === "pending"
        ? ""
        : face.kind === "diff"
          ? (face.confirmation ?? "")
          : face.kind === "script"
            ? face.output
            : "text" in face
              ? face.text
              : ""
  }

  private startTool(
    toolCallId: string,
    toolName: string,
    args?: Frame,
    hunks?: unknown[],
    fromEntry = false,
  ): void {
    if (!toolCallId) return
    const existing = this.toolsById.get(toolCallId)
    if (existing) {
      // A replayed toolCall block can carry args the live frame did not, and the
      // face resolution needs them. A settled card is never re-opened.
      if (!existing.args && args) existing.args = args
      return
    }
    const item: TranscriptItem = {
      kind: "tool",
      // pi's toolCall ids are identical live and in replay, so they are the
      // stable row key for a card — which is what the corpus asserts.
      row: toolCallId,
      text: "",
      streaming: false,
      tool: toolName,
      state: "running",
      blocks: [],
      images: 0,
      toolCallId,
      replayStable: fromEntry,
      ...(args ? { args } : {}),
      ...(hunks ? { hunks } : {}),
    }
    this.toolsById.set(toolCallId, item)
    this.applyToolView(item, "running", undefined)
    if (fromEntry) this.insertBeforeLiveTail(item)
    else this.push(item)
  }

  private applyUiRequest(rpc: Frame): void {
    const method = String(rpc.method ?? "")
    const id = String(rpc.id ?? "")
    if (method === "notify") {
      // A notify is NOT transcript content by default: the ui bridge emits one
      // when a pi-ask flow RESOLVES, so rendering every notify turns each
      // answered ask into a log row. The corpus keeps only notifies carrying a
      // `code` (the `notice` item's field); the rest are ephemeral, so they
      // surface as toasts instead.
      const message = String(rpc.message ?? "")
      if (!message) return
      const level = String(rpc.notifyType ?? rpc.notify_type ?? "info")
      if (typeof rpc.code !== "string") {
        this.pendingToasts.push({
          id,
          level: level === "error" || level === "warning" ? level : "info",
          text: message,
        })
        return
      }
      this.push({
        kind: "notice",
        row: this.row("notice"),
        text: message,
        streaming: false,
        blocks: [],
        images: 0,
        code: rpc.code,
        replayStable: false,
      })
      return
    }
    if (!id) return
    // Only a BLOCKING dialog is a pending ask. The reference registers exactly
    // `select | confirm | input | editor`; `notify`, `setStatus` and `setWidget`
    // ride the same frame type and are side-state. Folding every ui_request as
    // an ask made the client pop an overlay for a status line — scenario 003
    // holds 8 such frames and expects ZERO pending asks.
    if (!ASK_METHODS.has(method)) return
    this.asks.set(id, {
      id,
      method: method as AskRequest["method"],
      title: typeof rpc.title === "string" ? rpc.title : undefined,
      message: typeof rpc.message === "string" ? rpc.message : undefined,
      options: Array.isArray(rpc.options)
        ? (rpc.options as string[])
        : undefined,
      placeholder:
        typeof rpc.placeholder === "string" ? rpc.placeholder : undefined,
      prefill: typeof rpc.prefill === "string" ? rpc.prefill : undefined,
      ask: asFrame(rpc.ask) ?? undefined,
    })
  }

  private applyEvt(channel: string, data: unknown): void {
    const payload = asFrame(data) ?? {}
    if (channel.startsWith("subagents:")) {
      // The STATUS IS THE CHANNEL NAME: `subagents:started`, `:steered`,
      // `:completed`, `:failed`. A payload-level `status` is the exception, and
      // reading only that (as this fold did) leaves a finished subagent stuck at
      // "started" in the panel forever.
      const status = channel.slice("subagents:".length)
      if (!SUBAGENT_STATUSES.has(status)) return
      const id = typeof payload.id === "string" ? payload.id : null
      if (!id) return
      const previous = this.subagents.find((row) => row.id === id)
      const record: SubagentRecord = {
        id,
        status,
        type: typeof payload.type === "string" ? payload.type : previous?.type,
        description:
          typeof payload.description === "string"
            ? payload.description
            : previous?.description,
        // Everything else comes fresh from the frame: a completion frame carries
        // the result, and keeping a stale one would show an answer the machine
        // never sent for this run.
        result: typeof payload.result === "string" ? payload.result : undefined,
        error: typeof payload.error === "string" ? payload.error : undefined,
      }
      this.subagents = [
        ...this.subagents.filter((row) => row.id !== id),
        record,
      ]
      return
    }
    if (channel === "plan:snapshot" || channel === "plan:update") {
      // The count is the ITEM ARRAY's length, not a `itemCount` field: that is
      // what the reference projects, and a panel that counts a field the
      // machine never sends shows zero forever.
      const items = Array.isArray(payload.items) ? payload.items : []
      this.plan = {
        project:
          typeof payload.project === "string" ? payload.project : undefined,
        itemCount: items.length,
      }
    }
  }

  private applyEntryAppended(entry: Frame | null): void {
    if (!entry) return
    const customType =
      typeof entry.customType === "string" ? entry.customType : ""
    const data = asFrame(entry.data)
    if (customType === "subagents:record" && data) {
      // NOT folded, and deliberately so: the reference reducer folds subagent
      // rows only from the `subagents:{status}` evt channels, and this client
      // has never observed a machine send a `subagents:record` custom message.
      // Handling an unobserved frame is how a client starts rendering itself a
      // private reality. If a real machine does send one, the corpus will say.
      return
    }
    if (customType.startsWith("plan")) this.applyEvt("plan", data ?? {})
    if (typeof entry.id === "string") {
      this.leafId = entry.id
      // INDEX only — no beacon, so nothing is born. Live rows come from the
      // live frames; the durable entry id arrives with the next `get_entries`
      // and the match loop re-keys the row then. Birthing a row from
      // `entry_appended` would (a) duplicate what the stream already built and
      // (b) promote a live placeholder to a replay-stable id early, which is
      // what the conformance golden says must NOT happen.
      this.tree.applyEntries([entry], null, false, this.turnOpen())
    }
  }

  /** Which message is currently being folded (fold bookkeeping; row identity no
   *  longer depends on it — there is one open row per kind per message). */
  private messageSeq = 0
  /** Full-frame dedup for streaming deltas; see `applyMessageUpdate`. */ private lastDelta:
    string | undefined

  /** The `<kind>#<seq>` placeholder the corpus uses when ids are not replay-stable. */
  private row(kind: ItemKind, rowHint?: string): string {
    if (rowHint) return rowHint
    this.seq[kind] += 1
    return `${kind}#${this.seq[kind]}`
  }

  private touch(kind: ItemKind, row: string): TranscriptItem {
    const existing = this.byRow.get(row)
    if (existing) return existing
    const item: TranscriptItem = {
      kind,
      row,
      text: "",
      streaming: true,
      blocks: [],
      images: 0,
      replayStable: false,
    }
    this.push(item)
    return item
  }

  private push(item: TranscriptItem): void {
    // The dedup guard: a row key is either a pi entry id or a toolCall id, and
    // both are identical across the live plane and a replay. If the key is
    // already on screen, this is the same block arriving again.
    if (this.byRow.has(item.row)) return
    this.items.push(item)
    this.byRow.set(item.row, item)
  }

  /** Where a row that belongs to HISTORY goes: before the live tail, not at the
   *  very end. Without this, a reconnect that folds old entries while live rows
   *  are on screen floats historical content below the newest message — the
   *  app's own bug class ("warnings drift to below the normal messages"). */
  private insertBeforeLiveTail(item: TranscriptItem): void {
    if (this.byRow.has(item.row)) return
    let at = this.items.length
    for (let i = 0; i < this.items.length; i++) {
      if (!this.items[i]!.replayStable) {
        at = i
        break
      }
    }
    this.items.splice(at, 0, item)
    this.byRow.set(item.row, item)
  }

  resolveAsk(id: string): void {
    this.asks.delete(id)
  }

  setLeaf(id: string | null): void {
    this.leafId = id
  }

  /** Turn state is pi's to know, not inferable from history: a completed
   *  assistant entry may still contain tool calls, which the live fold reads as
   *  "a turn is in flight". After a replay the app asks pi's own `get_state`
   *  (`isStreaming`) and seeds the flag here; live frames then take over. */
  setTurnStreaming(streaming: boolean): void {
    this.streaming = streaming
    if (!streaming) {
      for (const item of this.items) item.streaming = false
    }
  }

  /** The viewer's session-ended signal. pi says it with `session_shutdown`; a
   *  device learning it from the relay's `room_ended` is the same fact arriving
   *  by a different route. */
  setEnded(ended: boolean): void {
    this.ended = ended
    if (!ended) return
    this.streaming = false
    for (const item of this.items)
      if (item.kind !== "tool") item.streaming = false
  }

  reset(): void {
    this.items.length = 0
    this.byRow.clear()
    this.toolsById.clear()
    this.tree.reset()
    this.identifyIndex.clear()
    this.pendingRows.clear()
    this.openAssistant = null
    this.openReasoning = null
    this.lastDelta = undefined
    this.asks.clear()
    this.subagents = []
    this.plan = null
    this.leafId = null
    this.streaming = false
    this.ended = false
    this.messageSeq = 0
    this.pendingToasts = []
  }

  snapshot(): ReducerSnapshot {
    return {
      items: this.items.slice(),
      flags: { streaming: this.streaming, ended: this.ended },
      subagents: this.subagents.slice(),
      plan: this.plan,
      pendingAsks: [...this.asks.values()],
      toasts: this.drainToasts(),
      rekeys: this.drainRekeys(),
      leafId: this.leafId,
    }
  }

  private drainRekeys(): { from: string; to: string }[] {
    const out = this.rekeyLog
    this.rekeyLog = []
    return out
  }

  private drainToasts(): Toast[] {
    const out = this.pendingToasts
    this.pendingToasts = []
    return out
  }
}

function summarizeResult(content: unknown): string {
  if (!Array.isArray(content)) return ""
  return (content as ContentBlock[])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
}

function blocksFor(result: Frame | null, hunks: unknown): string[] {
  const blocks: string[] = []
  if (Array.isArray(hunks) && hunks.length > 0) blocks.push("diff", "hunks")
  const content = Array.isArray(result?.content)
    ? (result?.content as ContentBlock[])
    : []
  if (content.some((block) => block.type === "code" || Boolean(block.language)))
    blocks.push("code")
  if (content.some((block) => block.type === "image")) blocks.push("image")
  return blocks
}

function countImages(content: unknown): number {
  if (!Array.isArray(content)) return 0
  return (content as ContentBlock[]).filter((block) => block.type === "image")
    .length
}
