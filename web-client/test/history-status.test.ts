/**
 * What a history read says about itself.
 *
 * The state that motivated this: a phone refreshes on a slow link, the machine
 * has not bound the session yet so `get_entries` is refused, the walk gives up,
 * and the page shows a blank transcript under a header that says "synced". Both
 * halves were true and the reader could not tell which one they were looking at.
 */
import { describe, expect, it } from "vitest"
import {
  type HistoryRead,
  historyDetail,
  historyLabel,
  historyOutcome,
  historyRetryable,
} from "../src/history-status.js"

const read = (over: Partial<HistoryRead>): HistoryRead => ({
  rows: 40,
  pages: 1,
  complete: true,
  ...over,
})

describe("historyOutcome", () => {
  it("is content when the whole history arrived", () => {
    expect(historyOutcome(read({}))).toBe("full")
  })

  it("is partial when rows arrived and then the walk stopped", () => {
    expect(historyOutcome(read({ complete: false }))).toBe("partial")
    expect(
      historyOutcome(read({ rows: 12, error: "get_entries: timed out" })),
    ).toBe("partial")
  })

  it("is failed when nothing arrived and something is to blame", () => {
    expect(historyOutcome(read({ rows: 0, complete: false }))).toBe("failed")
    expect(
      historyOutcome(read({ rows: 0, error: "no session bound", pages: 0 })),
    ).toBe("failed")
    expect(historyOutcome(read({ rows: 0, timedOut: true }))).toBe("failed")
  })

  it("is an empty session when the walk finished cleanly with nothing to show", () => {
    // A session that has just been launched really has no entries. Saying "the
    // machine did not answer" here sends the reader hunting for a fault that
    // does not exist, so the two cases are kept apart.
    expect(historyOutcome(read({ rows: 0 }))).toBe("empty-session")
  })
})

describe("historyLabel", () => {
  it("leaves the header alone when there is nothing to report", () => {
    expect(historyLabel(read({}))).toBeNull()
    expect(historyLabel(read({ rows: 0 }))).toBeNull()
  })

  it("replaces 'synced' with what actually happened", () => {
    // "synced" is only the truth about the protocol half; a header that says it
    // over a blank transcript is the lie this exists to stop.
    expect(historyLabel(read({ rows: 0, complete: false }))).toBe(
      "no history loaded",
    )
    expect(historyLabel(read({ rows: 7, complete: false }))).toBe(
      "history incomplete",
    )
  })
})

describe("historyDetail", () => {
  it("quotes the machine rather than guessing at the reason", () => {
    const text = historyDetail(
      read({
        rows: 0,
        pages: 0,
        complete: false,
        error: "get_entries unavailable (no session bound)",
      }),
    )
    expect(text).toContain("No history loaded.")
    expect(text).toContain(
      "The machine said: get_entries unavailable (no session bound).",
    )
    // The machine's sentence and ours stay separate: a run-on quote is how a
    // message stops being readable.
    expect(text).toBe(
      "No history loaded. The machine said: get_entries unavailable " +
        "(no session bound). The conversation is still there on the machine.",
    )
    // The conversation is on the machine. A blank screen here reads as lost
    // history, and it is not.
    expect(text).toContain("still there on the machine")
  })

  it("names a timeout as a timeout", () => {
    const text = historyDetail(
      read({ rows: 0, complete: false, timedOut: true }),
    )
    expect(text).toContain("did not answer in time")
  })

  it("counts what survived a partial walk", () => {
    const text = historyDetail(
      read({ rows: 1_240, pages: 25, complete: false, timedOut: true }),
    )
    expect(text).toContain("1240 rows")
    expect(text).toContain("25 pages")
    expect(text).toContain("then the read stopped")
  })

  it("says so plainly when a session really is empty", () => {
    expect(historyDetail(read({ rows: 0 }))).toBe(
      "This session has no entries yet.",
    )
  })

  it("stays out of the way when the read was complete", () => {
    expect(historyDetail(read({}))).toBeNull()
  })
})

describe("historyRetryable", () => {
  it("offers the retry exactly where a second attempt can help", () => {
    expect(historyRetryable(read({ rows: 0, complete: false }))).toBe(true)
    expect(historyRetryable(read({ rows: 7, complete: false }))).toBe(true)
    expect(historyRetryable(read({}))).toBe(false)
    // Nothing was refused: a session with no entries has nothing to re-read.
    expect(historyRetryable(read({ rows: 0 }))).toBe(false)
  })
})
