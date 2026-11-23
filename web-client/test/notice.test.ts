import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  describeError,
  launchFailureHint,
  roomListFailure,
  toastMessage,
} from "../src/notice.js"

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

// Every code the machine can answer a `session_launch` with, read from the
// extension itself: an unmapped code is a refusal the user cannot act on, and
// this client ships separately from the machine, so drift would otherwise show
// up as a bare `launch failed: backend_on_fire` toast on someone's phone.
function machineLaunchCodes(): string[] {
  const source = fileURLToPath(
    new URL("../../extension/src/launch.ts", import.meta.url),
  )
  const after =
    readFileSync(source, "utf8").split("export type LaunchErrorCode =")[1] ?? ""
  const codes: string[] = []
  for (const line of after.split("\n")) {
    if (line.trim() === "") continue // the tail of the declaration line itself
    const member = /^\s*\|?\s*"([a-z_]+)"\s*$/.exec(line)
    if (!member) break
    codes.push(member[1]!)
  }
  return codes
}

const LAUNCH_CODES = [
  "remote_launch_disabled",
  "unknown_peer",
  "permission_denied",
  "cwd_missing",
  "backend_missing",
  "backend_unavailable",
  "spawn_failed",
  "exited_early",
]

describe("launchFailureHint", () => {
  it("covers exactly the codes the machine can refuse with", () => {
    const codes = machineLaunchCodes()
    // A moved or renamed type must not silently disable the guard.
    expect(
      codes.length,
      "could not read LaunchErrorCode from extension/src/launch.ts",
    ).toBeGreaterThan(4)
    expect([...codes].sort()).toEqual([...LAUNCH_CODES].sort())
  })

  it("gives every code a hint that names what to change", () => {
    for (const code of LAUNCH_CODES) {
      const hint = launchFailureHint(code)
      expect(hint, code).not.toBe("")
      expect(hint.length, code).toBeGreaterThan(20)
    }
  })

  it("points at the two different gates the two refusals come from", () => {
    // `permission_denied` is the launch.dirs allow-list; `remote_launch_disabled`
    // is the per-folder allow_remote_launch flag. Both used to be one toast.
    expect(launchFailureHint("permission_denied")).toContain("launch.dirs")
    expect(launchFailureHint("remote_launch_disabled")).toContain(
      "allow_remote_launch",
    )
  })

  it("says what an empty cwd means, since the machine just calls it cwd_missing", () => {
    expect(launchFailureHint("cwd_missing")).toContain("does not exist")
  })

  it("keeps an unknown code instead of inventing a reason", () => {
    expect(launchFailureHint("backend_on_fire")).toContain("backend_on_fire")
    expect(launchFailureHint("")).not.toBe("")
  })
})

describe("roomListFailure", () => {
  it("does not call the relay unreachable while the socket is up", () => {
    // The relay SUPPRESSES a repeat `rooms_check` whose answer is unchanged
    // (relay `last_rooms_resp`), so a timeout on a live socket is what pressing
    // refresh twice does to a healthy machine. Telling that reader to go check
    // the relay sent them to a wire that is carrying the page they are on.
    const text = roomListFailure({ status: "timeout" }, true)
    expect(text).not.toContain("reachable")
    expect(text).toContain("no session list came back for that machine")
    expect(text).toContain("probably offline")
  })

  it("says unreachable only when the socket says so", () => {
    expect(roomListFailure({ status: "timeout" }, false)).toContain(
      "the relay is not reachable",
    )
  })

  it("recommends pairing only for the code that means pairing", () => {
    expect(roomListFailure({ status: "unknown_peer" }, true)).toContain(
      "run /unbien pair again",
    )
    // A quiet relay is not a revoked pairing, and sending someone to fetch a
    // single-use code they do not need is the trap.
    expect(roomListFailure({ status: "timeout" }, true)).not.toContain("pair")
  })

  it("quotes the relay's own refusal", () => {
    expect(
      roomListFailure({ status: "refused", detail: "not_authorized" }, true),
    ).toBe("the relay refused the listing (not_authorized)")
  })
})
