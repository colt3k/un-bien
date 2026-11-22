import { describe, expect, it } from "vitest"
import { INITIAL_WINDOW, sliceWindow } from "../src/transcript-window.js"
import { restoredWindow, type SavedView } from "../src/view-state.js"

/**
 * A saved view. The reader was reading `r-140`, which sat 40 rows into the
 * window the list had at the time: `window.start` is 100, so 40 drawn rows were
 * already scrolled off above them. `count` 800 means they had pressed "load
 * earlier rows" several times.
 */
const saved = (over: Partial<SavedView> = {}): SavedView => ({
  epk: "M1",
  roomId: "room-a",
  row: "r-140",
  index: 140,
  dy: 12,
  window: { start: 100, count: 800 },
  savedAt: 1,
  ...over,
})

/** Rows `r-0 … r-(n-1)`, so a slice can be checked for the anchor by name. */
const rows = (n: number) => Array.from({ length: n }, (_, i) => `r-${i}`)

describe("restoredWindow", () => {
  it("follows the anchor when the session grew while the tab was closed", () => {
    // Five rows landed meanwhile, so `r-140` sits at 145 now. The window shifts
    // with it rather than stranding the reader five rows from where they
    // stopped reading.
    expect(restoredWindow(saved(), 145, 905)).toEqual({
      start: 105,
      count: 800,
    })
  })

  it("keeps the history the reader pulled in, not the default screenful", () => {
    // Restoring the window to INITIAL_WINDOW would throw away those "load
    // earlier rows" presses and put them back at the tail.
    const w = restoredWindow(saved(), 140, 900)
    expect(w.count).toBe(800)
    expect(w.count).toBeGreaterThan(INITIAL_WINDOW)
  })

  it("re-seats on wherever the anchor moved, in both directions", () => {
    // A derive reset, a branch switch, or "Hide thinking" flipping between
    // loads can move the list under the anchor.
    expect(restoredWindow(saved(), 138, 900)).toEqual({ start: 98, count: 800 })
    expect(restoredWindow(saved(), 144, 900)).toEqual({
      start: 104,
      count: 800,
    })
  })

  it("draws a short session in full rather than a slice near its end", () => {
    const w = restoredWindow(saved(), 3, 5)
    expect(w.start).toBe(0)
    expect(w.count).toBe(800)
    expect(sliceWindow(rows(5), w).length).toBe(5)
  })

  it("clamps a nonsensical count to at least one row", () => {
    const w = restoredWindow(saved({ window: { start: 0, count: 0 } }), 0, 300)
    expect(w.count).toBe(1)
    expect(w.start).toBe(0)
  })

  it("holds at the top when the shift would run off the start", () => {
    const w = restoredWindow(saved({ window: { start: 4, count: 50 } }), 0, 500)
    expect(w.start).toBe(0)
  })

  /** The invariant every case above is a variation of: whatever the list did
   *  between the save and the restore, the row the reader was standing on has
   *  to be drawn. If it is not, `placeAnchor` fails and the view falls back to
   *  the tail — a jump the reader did not ask for. */
  it.each([
    ["the session grew", 145, 905],
    ["the session shrank", 120, 300],
    ["the list was re-derived from scratch", 2, 300],
    ["the reader was near the tail", 899, 900],
    ["a small window, shifted far", 640, 900],
  ])("keeps the anchor drawn when %s", (_why, index, total) => {
    const w = restoredWindow(
      saved({ index, window: { start: Math.max(0, index - 40), count: 50 } }),
      index,
      total,
    )
    const drawn = sliceWindow(rows(total), w)
    expect(drawn).toContain(`r-${index}`)
    expect(drawn.length).toBeGreaterThan(0)
  })
})
