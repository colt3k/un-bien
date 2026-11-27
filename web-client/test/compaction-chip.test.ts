import { describe, expect, it } from "vitest"
import {
  CHIP_TTL_MS,
  chipClock,
  witnessedCompaction,
} from "../src/compaction-chip.js"
import type { TranscriptItem } from "../src/reducer.js"

const compaction = (
  row: string,
  text = "Context compacted",
): TranscriptItem => ({
  kind: "compaction",
  row,
  text,
  streaming: false,
  blocks: [],
  images: 0,
  replayStable: false,
})

const assistant = (row: string): TranscriptItem => ({
  kind: "assistant",
  row,
  text: "hi",
  streaming: false,
  blocks: [],
  images: 0,
  replayStable: true,
})

describe("witnessedCompaction", () => {
  it("ignores compactions that were already in the log when the page opened", () => {
    // The reported bug. The chip used to take the newest compaction in the
    // transcript, whatever its age, and hide only when that row was on screen.
    // In a long session the newest compaction is always scrolled above the
    // viewport, so the header showed "↑ Context compacted (213,325 tokens)"
    // from the first frame — for an event from hours ago, explaining nothing
    // the reader had watched. It could be cleared only by hunting the row down.
    const items = [compaction("e1"), assistant("e2"), assistant("e3")]
    const baseline = new Set(items.map((i) => i.row))
    expect(witnessedCompaction(items, baseline)).toBeNull()
  })

  it("points at a compaction that landed while the reader was watching", () => {
    const items = [compaction("e1"), assistant("e2"), compaction("c7")]
    const baseline = new Set(["e1"])
    expect(witnessedCompaction(items, baseline)?.row).toBe("c7")
  })

  it("takes the newest witnessed one", () => {
    const items = [compaction("c1"), compaction("c2"), compaction("c3")]
    expect(witnessedCompaction(items, new Set())?.row).toBe("c3")
  })

  it("survives the row being re-keyed to a pi entry id", () => {
    // A live compaction is born with a synthetic id and is re-keyed once the
    // entry walk anchors it. The new id is not in the baseline, so the chip
    // keeps pointing at it — which is why the baseline keys on row id and the
    // `replayStable` flag cannot stand in for it (rekeyRow flips that flag a
    // second or two after birth, hiding the chip before it was ever seen).
    const items = [compaction("e9")]
    expect(witnessedCompaction(items, new Set(["compaction#4"]))?.row).toBe(
      "e9",
    )
  })

  it("returns null when nothing compacted", () => {
    expect(
      witnessedCompaction([assistant("e1"), assistant("e2")], new Set()),
    ).toBeNull()
  })
})

describe("chipClock", () => {
  const T0 = 1_000_000

  it("starts when the chip first appears for a row", () => {
    const c = chipClock("c7", null, null, T0)
    expect(c.since).toBe(T0)
    expect(c.expired).toBe(false)
  })

  it("keeps running for the same row instead of restarting on every render", () => {
    // Renders are event-driven and frequent; a clock that reset on each one
    // would never expire.
    const c = chipClock("c7", "c7", T0, T0 + CHIP_TTL_MS - 1)
    expect(c.since).toBe(T0)
    expect(c.expired).toBe(false)
  })

  it("expires after twenty seconds", () => {
    expect(CHIP_TTL_MS).toBe(20_000)
    const c = chipClock("c7", "c7", T0, T0 + CHIP_TTL_MS)
    expect(c.expired).toBe(true)
  })

  it("does not restart when the row scrolls back out of view", () => {
    // Hiding the chip is not an acknowledgement. The window runs from the
    // chip's first appearance, so scrolling off and back cannot keep it alive.
    const c = chipClock("c7", "c7", T0, T0 + CHIP_TTL_MS + 5_000)
    expect(c.since).toBe(T0)
    expect(c.expired).toBe(true)
  })

  it("starts a fresh window for a different compaction", () => {
    const c = chipClock("c8", "c7", T0, T0 + CHIP_TTL_MS + 5_000)
    expect(c.since).toBe(T0 + CHIP_TTL_MS + 5_000)
    expect(c.expired).toBe(false)
  })
})
