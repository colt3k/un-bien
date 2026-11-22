import type { TranscriptWindow } from "./transcript-window.js"

/**
 * Where the reader was standing, so a reload can put them back there.
 *
 * `lastRoom` (store.ts) says WHICH session to re-open; it says nothing about
 * where in it the reader was. Without this, every refresh replays the session
 * and drops them at the tail: the half-read answer they had scrolled up to is
 * gone, the "load earlier rows" they had pressed is forgotten, and a reload of
 * a 8000-row session costs the whole scroll back.
 *
 * The position is stored as a ROW, not as a pixel offset. A pixel offset is
 * meaningless across a reload: row heights depend on images that have not
 * loaded yet and on rows the window has not drawn yet. The row at the top edge
 * of the scroll box is stable — entry-born row ids are the same on the next
 * replay — and its small offset within the viewport is all that is left over.
 */
export interface SavedView {
  /** The machine this view belongs to. The gate for applying it. */
  epk: string
  /** The room it was saved against. A hint, not a gate: pi mints a new room id
   *  when the machine re-announces, and the session — and its entries — is the
   *  same one. Whether the anchor row still exists is the real gate. */
  roomId: string
  /** The row at the top edge of the scroll box. */
  row: string
  /** Its index in the drawn list when saved, so the window can be re-seated on
   *  wherever that row landed this time. */
  index: number
  /** Pixels from the top of the scroll box to the top of that row: how far the
   *  reader had pushed past the start of the row. */
  dy: number
  /** How much of the history the reader had asked to draw. Not re-derived from
   *  the tail: they may have pressed "load earlier rows" three times. */
  window: TranscriptWindow
  savedAt: number
}

/**
 * The window to draw for a restored view.
 *
 * Rows are appended for one session, so the anchor's index barely moves — but
 * a branch switch, a derive reset, or "Hide thinking" flipping in between can
 * shift the list under it. So the saved window is shifted by however far the
 * anchor actually moved, which keeps the reader's place whether the session
 * grew (the normal case: a turn finished while the tab was closed) or was
 * re-derived.
 *
 * `count` carries over as the reader's request rather than the tail position:
 * that is the whole point of restoring — their `load earlier rows` presses
 * survive the reload.
 */
export function restoredWindow(
  saved: SavedView,
  anchorIndex: number,
  total: number,
): TranscriptWindow {
  const count = Math.max(1, saved.window.count)
  const start = saved.window.start + (anchorIndex - saved.index)
  // The invariant the whole restore depends on: the anchor row must be INSIDE
  // the slice. The scroll that follows puts it back at the height it was at,
  // and a row that was never drawn cannot be scrolled to — so the clamps are
  // measured against the anchor, not against the ends of the list. A slice
  // that starts past the last row would paint an empty log; one that starts
  // past the anchor would paint a log the reader is not in.
  const lowest = Math.max(0, anchorIndex - count + 1)
  const highest = Math.min(anchorIndex, Math.max(0, total - 1))
  return { start: Math.min(Math.max(start, lowest), highest), count }
}
