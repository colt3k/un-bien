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

  applyEntries(entries: readonly unknown[]): void {
    for (const { env, rowHint } of entriesToEnvelopes(entries))
      this.apply(env, rowHint)
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
        // Opens a message; its content rows are created by the deltas below or
        // by message_end, so nothing is emitted here. Rows are keyed per content
        // index, so the live deltas and the authoritative message_end land on
        // the same row.
        this.messageSeq += 1
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
        // through the same path as live frames — that is the point of the fold.
        // Rows are keyed by entry id, so a page repeating what the live stream
        // already showed updates in place instead of duplicating. (Deduping
        // against rows that only have a PLACEHOLDER id needs pi's entry content
        // hashes — listed as an open gap in the README.)
        if (rpc.command === "get_entries") {
          const data = asFrame(rpc.data) ?? {}
          if (Array.isArray(data.entries))
            this.applyEntries(data.entries as unknown[])
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
    const index =
      typeof event.contentIndex === "number" ? event.contentIndex : 0
    const kind: ItemKind =
      event.type === "thinking_start" ||
      event.type === "thinking_delta" ||
      event.type === "thinking_end"
        ? "reasoning"
        : "assistant"
    const row = this.segmentRow(kind, rowHint, index)

    switch (event.type) {
      case "text_start":
      case "thinking_start": {
        this.touch(kind, row)
        this.streaming = true
        break
      }
      case "text_delta":
      case "thinking_delta": {
        const item = this.touch(kind, row)
        item.streaming = true
        item.text += typeof event.delta === "string" ? event.delta : ""
        break
      }
      case "text_end":
      case "thinking_end": {
        const item = this.touch(kind, row)
        if (typeof event.content === "string") item.text = event.content
        item.streaming = false
        break
      }
      case "toolcall_start": {
        // The card itself is born on tool_execution_start (with args); when the
        // delta arrives first, open the card so the stream has somewhere to go.
        this.startTool(
          String(event.id ?? ""),
          String(event.toolName ?? "?"),
          undefined,
        )
        break
      }
      default:
        break
    }
  }

  private applyMessageEnd(message: Frame | null, rowHint?: string): void {
    if (!message) return
    const role = String(message.role ?? "")
    // A toolResult message duplicates the tool card's own result frame.
    if (role === "toolResult" || role === "system") return

    const content = blocksOf(message)
    let toolIndex = 0
    for (const [index, block] of content.entries()) {
      if (block.type === "text") {
        const row = this.segmentRow(
          role === "user" ? "user" : "assistant",
          rowHint,
          index,
        )
        const item = this.touch(role === "user" ? "user" : "assistant", row)
        item.text = typeof block.text === "string" ? block.text : ""
        item.streaming = false
      } else if (block.type === "thinking") {
        const row = this.segmentRow("reasoning", rowHint, index)
        const item = this.touch("reasoning", row)
        item.text = typeof block.thinking === "string" ? block.thinking : ""
        item.streaming = false
      } else if (block.type === "toolCall") {
        this.startTool(
          String(block.id ?? `call-${index}`),
          String(block.name ?? "?"),
          undefined,
        )
        toolIndex += 1
      } else if (block.type === "image") {
        const row = this.segmentRow(
          role === "user" ? "user" : "assistant",
          rowHint,
          index,
        )
        const item = this.touch(role === "user" ? "user" : "assistant", row)
        item.images += 1
      }
    }
    if (toolIndex > 0) this.streaming = true
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
    if (typeof entry.id === "string") this.leafId = entry.id
  }

  /** Row key for a segment of a streamed message: one row per content block, so
   *  live deltas and the authoritative message_end land on the same row.
   *  Memoized: a placeholder row id is allocated ONCE per segment, otherwise
   *  every delta would invent a new row and the transcript would shatter. */
  private readonly segmentRows = new Map<string, string>()
  /** Which message is currently being folded: every message numbers its content
   *  blocks from 0, so without this the per-segment row keys would collide
   *  across messages. */
  private messageSeq = 0

  private segmentRow(
    kind: ItemKind,
    rowHint: string | undefined,
    index: number,
  ): string {
    const key = `${kind}:${rowHint ?? `msg${this.messageSeq}`}:${index}`
    const existing = this.segmentRows.get(key)
    if (existing) return existing
    // Replay-stable rows ARE pi's entry ids (the corpus's `replayStable` rule);
    // live rows are the `<kind>#<seq>` placeholder. Only a message with more
    // than one block of the same kind needs the index suffix.
    const row =
      rowHint === undefined
        ? this.row(kind)
        : index === 0
          ? rowHint
          : `${rowHint}#${index}`
    this.segmentRows.set(key, row)
    return row
  }

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
    this.asks.clear()
    this.segmentRows.clear()
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
