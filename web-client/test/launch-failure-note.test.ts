import { describe, expect, it } from "vitest"
import { launchFailureHint, launchFailureNote } from "../src/notice.js"

describe("launch failure notes", () => {
  it("is just the hint when the machine said nothing", () => {
    expect(launchFailureNote("permission_denied", "")).toBe(
      launchFailureHint("permission_denied"),
    )
    expect(launchFailureNote("permission_denied")).toBe(
      launchFailureHint("permission_denied"),
    )
  })

  it("carries the machine's reason, which the code cannot express", () => {
    // The live case: eight launches refused, and `spawn_failed` on the phone
    // while the answer sat in launcher.log.
    const note = launchFailureNote(
      "spawn_failed",
      "create window failed: index 2 in use",
    )
    expect(note).toContain("the machine could not start pi in that folder")
    expect(note).toContain("create window failed: index 2 in use")
  })

  it("folds the machine's newlines into the one line the note is", () => {
    const note = launchFailureNote("spawn_failed", "tmux:\n  index 2\n  in use")
    expect(note).toContain("tmux: index 2 in use")
    expect(note).not.toContain("\n")
  })

  it("clips a long machine message instead of wrapping the panel", () => {
    const note = launchFailureNote("spawn_failed", "x".repeat(500))
    expect(note).toContain(`${"x".repeat(180)}`)
    expect(note).not.toContain(`${"x".repeat(181)}`)
  })

  it("does not print the same words twice", () => {
    const hint = launchFailureHint("remote_launch_disabled")
    expect(launchFailureNote("remote_launch_disabled", hint)).toBe(hint)
  })

  it("still names an unrecognised code, so a new one is not silent", () => {
    expect(launchFailureNote("cwd_missing", "")).toContain(
      "that folder does not exist on the machine",
    )
    expect(launchFailureNote("brand_new_code", "")).toContain(
      "the machine refused the launch (code brand_new_code)",
    )
  })
})
