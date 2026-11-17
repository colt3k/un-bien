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
 * here. See test/corpus.test.ts for what is currently asserted: item KINDS and
 * counts, not yet the full normalized projection (blocks/rows/leafId).
 */
import type { EnvelopeMessage } from "@geohar/un-bien/client"
import { EntryTree, type PathPlan } from "./derive.js"
import {
  identify,
  imagesFromContent,
  joinedText,
  stableHash,
} from "./content-identity.js"

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
  /** Derived render blocks ("diff", "hunks", "code", "image"). */
  blocks: string[]
  images: number
  toolCallId?: string
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
        this.push({
          kind: "compaction",
          row: entryId ?? this.row("compaction"),
          text: "",
          streaming: false,
          blocks: [],
          images: 0,
        })
        return
      case "custom_message": {
        // pi's custom-role entry: content + display are TOP-LEVEL here (no
        // `message` object). Extension bookkeeping rides display:false and must
        // stay invisible; mesh agent messages ride display:true.
        if (entry.display === false) return
        this.push({
          kind: "notice",
          row: this.row("notice"),
          text: joinedText(entry.content),
          streaming: false,
          blocks: [],
          images: 0,
          code: "custom",
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
    if (this.openAssistant === row) this.openAssistant = next
    if (this.openReasoning === row) this.openReasoning = next
    item.row = next
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
        break
      }
      case "tool_execution_end": {
        const card = this.toolsById.get(String(rpc.toolCallId ?? ""))
        if (!card) break
        const result = asFrame(rpc.result)
        card.state = rpc.isError === true ? "failed" : "ok"
        card.text = result ? summarizeResult(result.content) : ""
        card.blocks = blocksFor(result, env.aux?.hunks)
        if (!card.hunks && Array.isArray(env.aux?.hunks))
          card.hunks = env.aux?.hunks as unknown[]
        card.images = countImages(result?.content)
        this.streaming = true // a running turn is still in flight
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
        this.streaming = false
        this.ended = true
        // Any row still marked streaming is stale once the turn settles.
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
      })
      return
    }
    if (role !== "user" && role !== "assistant") return
    const kind: ItemKind = role === "user" ? "user" : "assistant"

    if (message.stopReason === "error") {
      // A failed turn is a notice, not a bubble. Content-keyed, so a live error
      // and its later entry replay dedup into one row.
      const text = String(message.errorMessage ?? "Provider error")
      this.push({
        kind: "notice",
        row: `notice@err@${stableHash(text)}`,
        text,
        streaming: false,
        blocks: [],
        images: 0,
        code: "provider_error",
      })
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
        this.reconstructCards(calls)
        return
      }
      // An assistant entry with no prose and no image births NOTHING: its
      // thinking is not a replay row, and its tool calls are cards.
      if (kind === "assistant" && text === "" && images === 0) {
        this.reconstructCards(calls)
        return
      }
      this.push({
        kind,
        row: entryId,
        text,
        streaming: false,
        blocks: [],
        images,
      })
      this.identifyIndex.set(key, entryId)
      this.reconstructCards(calls)
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
        this.reconstructCards(calls)
        return
      }
      const row = this.row(kind)
      this.push({ kind, row, text, streaming: false, blocks: [], images })
      this.identifyIndex.set(key, row)
      this.pendingRows.add(row)
    }
    this.reconstructCards(calls)
  }

  /** Replay reconstructs tool cards from the assistant entry's own `toolCall`
   *  blocks — the live stream opened them with separate `tool_execution_start`
   *  frames. `startTool` dedups by call id, so a live-opened card is untouched. */
  private reconstructCards(calls: readonly ContentBlock[]): void {
    for (const call of calls)
      this.startTool(String(call.id ?? ""), String(call.name ?? "?"), undefined)
  }

  /** A replayed `toolResult` entry settles the card its toolCall opened. */
  private finishTool(toolCallId: string, message: Frame): void {
    const card = this.toolsById.get(toolCallId)
    if (!card) return
    card.state = message.isError === true ? "failed" : "ok"
    card.text = summarizeResult(message.content)
    card.blocks = blocksFor({ content: message.content }, message.details)
    card.images = countImages(message.content)
  }

  private startTool(
    toolCallId: string,
    toolName: string,
    hunks: unknown[] | undefined,
  ): void {
    if (!toolCallId) return
    const existing = this.toolsById.get(toolCallId)
    if (existing) return
    const item: TranscriptItem = {
      kind: "tool",
      // pi's toolCall ids are identical live and in replay, so they are the
      // stable row key for a card — which is what the corpus asserts.
      row: toolCallId,
      text: "",
      streaming: false,
      tool: toolName,
      state: "running",
      blocks: hunks && hunks.length > 0 ? ["diff", "hunks"] : [],
      images: 0,
      toolCallId,
      ...(hunks ? { hunks } : {}),
    }
    this.toolsById.set(toolCallId, item)
    this.push(item)
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
      })
      return
    }
    if (!id) return
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
    if (channel.startsWith("subagents")) {
      const id = typeof payload.id === "string" ? payload.id : null
      if (!id) return
      const previous = this.subagents.find((row) => row.id === id)
      const record: SubagentRecord = {
        id,
        status:
          typeof payload.status === "string"
            ? payload.status
            : (previous?.status ?? "started"),
        description:
          typeof payload.description === "string"
            ? payload.description
            : previous?.description,
        result:
          typeof payload.result === "string"
            ? payload.result
            : previous?.result,
        error:
          typeof payload.error === "string" ? payload.error : previous?.error,
      }
      this.subagents = [
        ...this.subagents.filter((row) => row.id !== id),
        record,
      ]
      return
    }
    if (channel.startsWith("plan")) {
      const items = Array.isArray(payload.items) ? payload.items : []
      this.plan = {
        project:
          typeof payload.project === "string" ? payload.project : undefined,
        itemCount:
          typeof payload.itemCount === "number"
            ? payload.itemCount
            : items.length,
      }
    }
  }

  private applyEntryAppended(entry: Frame | null): void {
    if (!entry) return
    const customType =
      typeof entry.customType === "string" ? entry.customType : ""
    const data = asFrame(entry.data)
    if (customType === "subagents:record" && data)
      this.applyEvt("subagents", data)
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
  /** Full-frame dedup for streaming deltas; see `applyMessageUpdate`. */
  private lastDelta: string | undefined

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
      leafId: this.leafId,
    }
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
