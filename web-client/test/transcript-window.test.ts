import { describe, expect, it } from "vitest"
import {
  INITIAL_WINDOW,
  LOAD_MORE,
  growWindow,
  hasHiddenHistory,
  hiddenAfter,
  hiddenBefore,
  nextWindow,
  sliceWindow,
} from "../src/transcript-window.js"

// A stand-in for TranscriptItem: the window only cares about position.
const rows = (n: number) => Array.from({ length: n }, (_, i) => `row-${i}`)

describe("nextWindow", () => {
  it("draws the tail, not the head, on a big first render", () => {
    const total = 8571 // the real session this was added for
    const w = nextWindow(null, total, true)
    expect(w.count).toBe(INITIAL_WINDOW)
    expect(w.start).toBe(total - INITIAL_WINDOW)
    const drawn = sliceWindow(rows(total), w)
    expect(drawn.length).toBe(INITIAL_WINDOW)
    expect(drawn.at(-1)).toBe(`row-${total - 1}`)
  })

  it("draws everything when the session fits in the window", () => {
    const w = nextWindow(null, 7, true)
    expect(w.start).toBe(0)
    expect(sliceWindow(rows(7), w).length).toBe(7)
    expect(hasHiddenHistory(w, 7)).toBe(false)
  })

  it("keeps the window pinned to the end while following the tail", () => {
    let w = nextWindow(null, 400, true)
    for (let total = 401; total <= 900; total++) w = nextWindow(w, total, true)
    expect(w.count).toBe(INITIAL_WINDOW)
    expect(w.start).toBe(900 - INITIAL_WINDOW)
    // Without this, every streamed row would widen the window by one and the
    // cost of a live turn would grow with the session.
  })

  it("holds position while the reader is up in the history", () => {
    const w = { start: 40, count: 120 }
    expect(nextWindow(w, 500, false)).toEqual({ start: 40, count: 120 })
  })

  it("keeps at least one row drawn when the fold drops rows under it", () => {
    // The reducer can forget a branch. The window must not end up past the last
    // row, which would leave an empty transcript.
    const w = nextWindow({ start: 300, count: 120 }, 95, false)
    const drawn = sliceWindow(rows(95), w)
    expect(w.start).toBeLessThan(95)
    expect(drawn.length).toBeGreaterThan(0)
    expect(drawn.length).toBeLessThanOrEqual(w.count)
  })

  it("never starts before the first row and never asks for zero rows", () => {
    const w = nextWindow({ start: 90, count: 120 }, 95, true)
    expect(w.start).toBeGreaterThanOrEqual(0)
    expect(w.count).toBeGreaterThan(0)
    // A count larger than the list is fine: the slice is simply the whole list.
    expect(sliceWindow(rows(95), w).length).toBe(95)
  })

  it("grows back to a full window as a replay pages in", () => {
    // The regression this caught live: a replay arrives over many frames, the
    // first has a single item, and a count clamped to `total` stuck the whole
    // session at one rendered row.
    let w = nextWindow(null, 1, true)
    for (const total of [2, 5, 40, 400, 8571]) w = nextWindow(w, total, true)
    expect(w.count).toBe(INITIAL_WINDOW)
    expect(sliceWindow(rows(8571), w).length).toBe(INITIAL_WINDOW)
  })
})

describe("growWindow", () => {
  it("adds LOAD_MORE rows of history, keeping the bottom of the view", () => {
    const total = 8571
    const before = nextWindow(null, total, true)
    const after = growWindow(before, total, LOAD_MORE)
    expect(after.count).toBe(INITIAL_WINDOW + LOAD_MORE)
    expect(after.start).toBe(before.start - LOAD_MORE)
  })

  it("stops at the oldest row instead of going negative", () => {
    const total = 300
    let w = nextWindow(null, total, true)
    w = growWindow(w, total, LOAD_MORE)
    w = growWindow(w, total, LOAD_MORE)
    expect(w.start).toBe(0)
    expect(w.count).toBe(total)
    expect(hiddenBefore(w, total)).toBe(0)
  })
})

describe("the hidden-history handle", () => {
  it("reports exactly how much history is not drawn", () => {
    const total = 1000
    const w = nextWindow(null, total, true)
    expect(hiddenBefore(w, total)).toBe(total - INITIAL_WINDOW)
    expect(hasHiddenHistory(w, total)).toBe(true)
    expect(hiddenBefore(growWindow(w, total, LOAD_MORE), total)).toBe(
      total - INITIAL_WINDOW - LOAD_MORE,
    )
  })

  it("has nothing to offer for a short session", () => {
    const w = nextWindow(null, 3, true)
    expect(hasHiddenHistory(w, 3)).toBe(false)
  })
})

describe("what is waiting below the reader", () => {
  it("counts the rows that arrived while the pin was off", () => {
    const total = 1000
    // Reading history: the window holds its start, so every new row lands
    // outside the drawn slice. That is the count the pill shows.
    const w = { start: 500, count: INITIAL_WINDOW }
    expect(hiddenAfter(w, 640)).toBe(20)
    expect(hiddenAfter(w, total)).toBe(total - 620)
  })

  it("is zero when the slice already ends at the newest row", () => {
    const w = nextWindow(null, 300, true)
    expect(hiddenAfter(w, 300)).toBe(0)
    // A session shorter than the request: the slice is naturally shorter and
    // nothing is being withheld.
    expect(hiddenAfter({ start: 0, count: INITIAL_WINDOW }, 3)).toBe(0)
  })
})
