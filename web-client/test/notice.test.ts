import { describe, expect, it } from "vitest"
import { describeError, toastMessage } from "../src/notice.js"

describe("toastMessage", () => {
  it("refuses the empty string that used to render as an empty amber pill", () => {
    expect(toastMessage("")).toBeNull()
    expect(toastMessage("   \n  ")).toBeNull()
  })

  it("keeps a real message and trims the padding around it", () => {
    expect(toastMessage("  relay refused  ")).toBe("relay refused")
  })
})

describe("describeError", () => {
  it("uses the message when there is one", () => {
    expect(describeError(new Error("relay: not connected"))).toBe(
      "relay: not connected",
    )
  })

  it("says something for an Error whose message is empty", () => {
    // The case that produced the visible nothing: `err.message` was "", so the
    // toast rendered a blank box and the failure left no trace.
    const named = new Error("")
    named.name = "RangeError"
    const text = describeError(named)
    expect(text).not.toBe("")
    expect(text).toContain("RangeError")
  })

  it("never returns an empty string for any junk a promise can reject with", () => {
    for (const value of [
      "",
      "   ",
      null,
      undefined,
      {},
      [],
      0,
      new Error(""),
    ]) {
      expect(describeError(value)).not.toBe("")
    }
  })

  it("keeps a non-Error string that has content", () => {
    expect(describeError("room ended")).toBe("room ended")
  })
})
