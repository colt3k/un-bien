import { describe, expect, it } from "vitest"
import {
  canEndSession,
  END_CONFIRM_MS,
  END_LABELS,
  refusalNotice,
  TERMINATE_CAP,
  TERMINATE_QUIET_MS,
} from "../src/session-end.js"

describe("canEndSession", () => {
  it("is offered when the machine advertises the capability", () => {
    expect(
      canEndSession({
        attached: true,
        caps: ["remote_launch", TERMINATE_CAP],
        ended: false,
      }),
    ).toBe(true)
  })

  it("is never offered for a launcher's control room", () => {
    // DAEMON_CAPS exactly as the launcher advertises them
    // (extension/src/launcher/launcher.ts). The capability test alone rules this
    // room out, which is why there is no `isControlRoom` branch to keep in sync.
    const daemonCaps = ["remote_launch", "is_daemon", "session_resume"]
    expect(
      canEndSession({ attached: true, caps: daemonCaps, ended: false }),
    ).toBe(false)
  })

  it("is not offered for a session whose machine has remote terminate off", () => {
    // The extension adds the cap only when its config allows it
    // (session/capabilities.ts), so an absent cap is the machine saying no.
    expect(
      canEndSession({
        attached: true,
        caps: ["remote_launch", "session_resume"],
        ended: false,
      }),
    ).toBe(false)
  })

  it("is not offered while nothing is attached", () => {
    expect(
      canEndSession({ attached: false, caps: [TERMINATE_CAP], ended: false }),
    ).toBe(false)
  })

  it("goes away once the session has ended", () => {
    // The client keeps a room's caps in memory after the relay says the room is
    // gone, so the control needs the ended fact or it would offer to end a
    // session that is already over — and then sit on a refusal it cannot explain.
    expect(
      canEndSession({ attached: true, caps: [TERMINATE_CAP], ended: true }),
    ).toBe(false)
  })
})

describe("the interaction", () => {
  it("arms before it fires, in words the reader can act on", () => {
    expect(END_LABELS.idle).toBe("end")
    expect(END_LABELS.armed).not.toBe(END_LABELS.idle)
    expect(END_LABELS.title).toMatch(/\/quit/)
  })

  it("does not leave the arm sitting live forever", () => {
    // Long enough to move a mouse to a second click; short enough that an
    // abandoned control does not end a session an hour later.
    expect(END_CONFIRM_MS).toBeGreaterThanOrEqual(2000)
    expect(END_CONFIRM_MS).toBeLessThanOrEqual(10_000)
  })

  it("refuses to pretend, and names the setting responsible", () => {
    // A gated machine answers nothing at all, so the client has to say so.
    expect(refusalNotice()).toMatch(/remote terminate/)
    expect(TERMINATE_QUIET_MS).toBeGreaterThanOrEqual(2000)
    expect(TERMINATE_QUIET_MS).toBeLessThanOrEqual(5000)
  })
})
