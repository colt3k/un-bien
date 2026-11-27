import type { TranscriptItem } from "./reducer.js"

/**
 * The header chip that points at a compaction the reader cannot see.
 *
 * The marker row is a centred caption about 37px tall, and the turn it enables
 * lands rows underneath it immediately — so by the time a reader looks up, the
 * event that explains the pause is screens above the tail. The chip says where
 * it went. It used to have no notion of *when* the compaction happened, which
 * made it permanent furniture in any long session: the newest compaction is
 * always scrolled above the viewport, so the header carried
 * "↑ Context compacted (213,325 tokens)" from the moment the page opened, for
 * a compaction from hours ago that explained nothing the reader had seen.
 *
 * Two rules fix that, and both live here rather than in the view so they can
 * be tested: the chip only ever points at a compaction the reader watched
 * happen, and it fades twenty seconds after first appearing.
 */

/** How long the chip stays up for a compaction you watched happen. Twenty
 *  seconds is long enough to notice the pause and go looking for it, short
 *  enough that it never becomes a permanent fixture of the header. */
export const CHIP_TTL_MS = 20_000

/** The newest compaction the reader SAW happen.
 *
 *  `baseline` holds the compaction row ids already in the transcript at the
 *  first render — history the reader did not witness, which must never raise
 *  the chip.
 *
 *  Keyed on row id, deliberately NOT on `replayStable`: `rekeyRow` flips a
 *  live row to `replayStable` the moment the entry walk anchors it, a second or
 *  two after it was born. That would hide the chip before the reader ever saw
 *  it — the flag answers "is this durable?", not "did anyone watch it?". */
export function witnessedCompaction(
  items: TranscriptItem[],
  baseline: Set<string>,
): TranscriptItem | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item && item.kind === "compaction" && !baseline.has(item.row)) {
      return item
    }
  }
  return null
}

/** The chip's clock: it starts the first time the chip appears for THAT row,
 *  and a different row starts a new one. Hiding the chip because the row
 *  scrolled into view does NOT restart it — the twenty seconds are absolute
 *  from first appearance, so scrolling away and back cannot keep the chip
 *  alive. */
export function chipClock(
  row: string,
  chipRowId: string | null,
  since: number | null,
  now: number,
): { since: number; expired: boolean } {
  const start = chipRowId === row && since !== null ? since : now
  return { since: start, expired: now - start >= CHIP_TTL_MS }
}
