import { MARKDOWN_BUDGET } from "./markdown.js"

/** The part of a transcript row that decides how its body is drawn. */
export interface RenderableItem {
  kind: string
  text: string
  streaming: boolean
}

/**
 * Rows whose prose is markdown. Tool and reasoning rows are excluded: a tool
 * body is a face (terminal / file / diff) with its own shaping, and reasoning is
 * verbatim text that must not be re-flowed. Long text stops being parsed at
 * MARKDOWN_BUDGET, the same cap the native app uses.
 */
export function wantsMarkdown(item: RenderableItem): boolean {
  return (
    item.kind !== "tool" &&
    item.kind !== "reasoning" &&
    item.kind !== "compaction" &&
    item.text.length <= MARKDOWN_BUDGET
  )
}

/**
 * Cache key for a rendered body — and the streaming flag is part of it on
 * purpose.
 *
 * A row is drawn as plain text while it streams (re-parsing markdown on every
 * delta is pointless) and as markdown once the turn settles. Keying on the text
 * alone meant the settled pass never ran: the last streaming delta already
 * stored that exact text as "rendered", so the final render was skipped and the
 * row kept its raw `**bold**` and backticks forever — styled in pi's TUI, raw in
 * the browser.
 */
export function bodyRenderKey(
  item: RenderableItem,
  pairingUri?: string,
): string {
  if (pairingUri) return `pair:${pairingUri}|${item.text.length}`
  return `${item.streaming ? "stream" : "final"}:${item.text}`
}

/**
 * Whether a row's body may be clamped behind a "show more" control.
 *
 * The row the reader is waiting for is never clamped: the newest assistant
 * answer, and anything still streaming, is shown in full. Clamping those made the
 * thing you asked for the hardest thing to read — the answer you just asked for sat
 * folded with a button above the composer until you clicked it.
 */
export function mayClamp(opts: {
  kind: string
  atTail: boolean
  streaming: boolean
}): boolean {
  if (opts.kind !== "assistant" && opts.kind !== "notice") return false
  return !opts.atTail && !opts.streaming
}
