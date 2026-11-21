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
