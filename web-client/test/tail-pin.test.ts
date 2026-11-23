import { describe, expect, it } from "vitest"
import {
  ARRIVE_PX,
  belowTail,
  gestureDisarms,
  keyDisarms,
  pinAfterScroll,
} from "../src/tail-pin.js"

// The report: "when the web-client is streaming text you can't scroll back to
// read the history, because it keeps showing the most recent and takes you back
// to the bottom". The follow was a measurement retaken on every delta —
// `scrollHeight - scrollTop - clientHeight < 220` — so a reader who scrolled
// 100px up was still inside the band and the next delta pinned them back down.
// Reproduced in a live tab before the fix: a 100px wheel up during a stream was
// undone in the same frame, and a 300px one escaped only because it cleared the
// band in a single event. The tests below are that scenario.

describe("the tail pin", () => {
  it("is off the moment the reader scrolls into history, however slightly", () => {
    expect(pinAfterScroll(true, -100, 100)).toBe(false)
    // The old band would have kept following at 100px, and at 219px.
    expect(pinAfterScroll(true, -10, 10)).toBe(false)
    expect(pinAfterScroll(true, -219, 219)).toBe(false)
  })

  it("stays off while the answer piles up below the reader", () => {
    let pinned = pinAfterScroll(true, -400, 400)
    for (const below of [460, 900, 5000, 20000])
      pinned = pinAfterScroll(pinned, 0, below)
    expect(pinned).toBe(false)
  })

  it("is back on when the reader reaches the newest line", () => {
    const off = pinAfterScroll(true, -800, 800)
    expect(off).toBe(false)
    expect(pinAfterScroll(off, 800, 0)).toBe(true)
    expect(pinAfterScroll(off, 0, ARRIVE_PX)).toBe(true)
  })

  it("does not re-arm for a scroll down that stops short of the end", () => {
    // Otherwise a reader who nudges 300px down and stops is yanked the rest of
    // the way, which is the original complaint in a smaller hat.
    let pinned = pinAfterScroll(true, -800, 800)
    pinned = pinAfterScroll(pinned, 300, 500)
    pinned = pinAfterScroll(pinned, 200, 300)
    expect(pinned).toBe(false)
  })

  it("ignores sub-pixel drift and holds the standing decision", () => {
    expect(pinAfterScroll(false, 1, 400)).toBe(false)
    expect(pinAfterScroll(false, -1, 400)).toBe(false)
    expect(pinAfterScroll(true, 0, 400)).toBe(true)
  })

  it("walks the whole round trip: read history, then get the tail back", () => {
    let pinned = true
    // The reader drags up; deltas keep landing and change nothing.
    pinned = pinAfterScroll(pinned, -150, 150)
    pinned = pinAfterScroll(pinned, 0, 420)
    expect(pinned).toBe(false)
    // They scroll back down to the end of what is drawn — the follow resumes.
    pinned = pinAfterScroll(pinned, 200, 220)
    expect(pinned).toBe(false)
    pinned = pinAfterScroll(pinned, 220, 0)
    expect(pinned).toBe(true)
  })
})

describe("gesture intent", () => {
  it("disarms on a wheel up when there is history above", () => {
    expect(gestureDisarms(-120, true)).toBe(true)
  })

  it("does not disarm on a wheel down", () => {
    expect(gestureDisarms(120, true)).toBe(false)
  })

  it("does not disarm when the whole log fits the viewport", () => {
    // Nothing above to move into. Disarming here would strand the next rows
    // below the fold with no gesture left that reaches them.
    expect(gestureDisarms(-120, false)).toBe(false)
  })

  it("reads a finger dragged down as 'show me earlier'", () => {
    // A finger moving DOWN brings earlier rows into view, which in wheel terms
    // is a negative delta — the sign flip app.ts makes explicit.
    const touchY = 100
    const movedTo = 180
    expect(gestureDisarms(touchY - movedTo, true)).toBe(true)
    expect(gestureDisarms(movedTo - touchY, true)).toBe(false)
  })

  it("disarms on the keys that move up the log, not the ones that move down", () => {
    for (const key of ["PageUp", "Home", "ArrowUp"])
      expect(keyDisarms(key)).toBe(true)
    for (const key of ["PageDown", "End", "ArrowDown", " "])
      expect(keyDisarms(key)).toBe(false)
  })
})

describe("belowTail", () => {
  it("is ~0 at the bottom and grows as the reader moves up", () => {
    expect(belowTail(10000, 9437, 563)).toBe(0)
    expect(belowTail(10000, 9000, 563)).toBe(437)
    // Sub-pixel layout can land a hair past the bottom; that is the bottom.
    expect(belowTail(10000, 9437.5, 563)).toBeLessThanOrEqual(ARRIVE_PX)
  })
})
