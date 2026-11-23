/**
 * The transcript window: how much of a session is allowed to exist as DOM.
 *
 * Attaching does a full replay, and a real session can be enormous — the pi
 * session this viewer was attached to was 14 MB / 8571 entries / 244 base64
 * image blocks. Building a row per entry in one pass blocks the main thread for
 * minutes: the tab stops painting, the debugger cannot attach, and no fix can
 * land. Building only the tail, and letting the reader ask for more, keeps the
 * cost proportional to the viewport instead of the history.
 *
 * The fold is not involved here. Every entry is still folded and every row
 * still has its identity; this chooses which rows are drawn.
 */

/** Rows built on first render — a generous screenful and a fraction of a frame. */
export const INITIAL_WINDOW = 120

/** Rows added each time the reader asks for earlier history. */
export const LOAD_MORE = 200

export interface TranscriptWindow {
  /** Index of the first drawn row in the full item list. */
  start: number
  /** How many rows the reader has asked for, ceiling aside. */
  count: number
}

/**
 * Decide the window for a render.
 *
 * - No window yet (a fresh attach or first paint): the last INITIAL_WINDOW rows.
 * - Following the tail: keep the requested count pinned to the end, so new rows
 *   arrive without the window drifting wider.
 * - Reading history (not following): hold the start. Growing it toward the tail
 *   would move what the reader is looking at.
 */
export function nextWindow(
  prev: TranscriptWindow | null,
  total: number,
  followTail: boolean,
): TranscriptWindow {
  if (!prev) {
    // The request is INITIAL_WINDOW rows even when fewer exist — a replay pages
    // in from one row upward, and a count seeded at the first frame's size would
    // stick there for the whole session.
    return { start: Math.max(0, total - INITIAL_WINDOW), count: INITIAL_WINDOW }
  }
  // `count` is what the reader asked for, not what exists: near the top of the
  // history the slice is naturally shorter. Clamping it to `total` instead was a
  // real bug — the first frame of a replay has one item, so the count stuck at
  // one and the whole session rendered as a single row.
  const count = Math.max(1, prev.count)
  if (followTail) return { start: Math.max(0, total - count), count }
  // Reading history: hold the start, but keep at least one row on screen if the
  // fold dropped rows out from under us.
  const start = Math.min(prev.start, Math.max(0, total - 1))
  return { start, count }
}

/** Ask for `extra` more rows of history, keeping the tail end of the window. */
export function growWindow(
  prev: TranscriptWindow,
  total: number,
  extra: number,
): TranscriptWindow {
  const count = Math.min(total, prev.count + Math.max(1, extra))
  return { start: Math.max(0, total - count), count }
}

export function sliceWindow<T>(
  items: readonly T[],
  window: TranscriptWindow,
): T[] {
  return items.slice(window.start, window.start + window.count)
}

/** Rows that exist but are not drawn — for the "load earlier" label. */
export function hiddenBefore(window: TranscriptWindow, total: number): number {
  return Math.max(0, window.start)
}

/** Rows that exist below the drawn slice. Reading history holds the slice's
 *  `start` (`nextWindow`), so everything that arrives while the reader is up
 *  there stays undrawn — this is how many rows are waiting below them, and what
 *  the "jump to end" pill counts. */
export function hiddenAfter(window: TranscriptWindow, total: number): number {
  return Math.max(0, total - (window.start + window.count))
}

/** Is there history we are not drawing? */
export function hasHiddenHistory(
  window: TranscriptWindow,
  total: number,
): boolean {
  return hiddenBefore(window, total) > 0
}
