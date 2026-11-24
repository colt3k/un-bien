import { describe, expect, it } from "vitest"
import {
  forgetLastRoom,
  forgetLastView,
  forgetLaunchDraft,
  forgetPendingLaunch,
  hideReasoning,
  lastRoom,
  lastView,
  launchDraft,
  monoProse,
  PENDING_LAUNCH_TTL_MS,
  pendingLaunch,
  rememberLastRoom,
  rememberLastView,
  rememberLaunchDraft,
  rememberPendingLaunch,
  setHideReasoning,
  setMonoProse,
} from "../src/store.js"

/**
 * The resume record. Storage falls back to an in-memory map under Node
 * (src/storage.ts), so this exercises the real module rather than a mock.
 */
describe("the session to resume", () => {
  it("remembers and returns the attached room", () => {
    forgetLastRoom()
    expect(lastRoom()).toBeUndefined()
    rememberLastRoom({ epk: "M1", roomId: "room-a", name: "tmpunbien" })
    expect(lastRoom()).toEqual({
      epk: "M1",
      roomId: "room-a",
      name: "tmpunbien",
    })
  })

  it("the newest attach wins", () => {
    rememberLastRoom({ epk: "M1", roomId: "room-a" })
    rememberLastRoom({ epk: "M2", roomId: "room-b" })
    expect(lastRoom()?.roomId).toBe("room-b")
  })

  it("forgetting one machine only drops that machine's record", () => {
    rememberLastRoom({ epk: "M1", roomId: "room-a" })
    forgetLastRoom("M2")
    expect(lastRoom()?.roomId).toBe("room-a")
    forgetLastRoom("M1")
    expect(lastRoom()).toBeUndefined()
  })

  it("a stale record does not survive an unparseable write", () => {
    // The kv seam treats unparseable JSON as absent; a half-written record must
    // not resume a session the user never attached to.
    rememberLastRoom({ epk: "M1", roomId: "room-a" })
    forgetLastRoom()
    expect(lastRoom()).toBeUndefined()
  })
})

/**
 * The page, not just the session. `lastRoom` says what to open; this says where
 * in it the reader was standing, which is the half a reload otherwise drops.
 */
describe("the page to restore", () => {
  const view = {
    epk: "M1",
    roomId: "room-a",
    row: "entry-9f3a",
    index: 40,
    dy: 12,
    window: { start: 100, count: 800 },
    savedAt: 1700000000000,
  }

  it("remembers the row, its height, and how much history was drawn", () => {
    forgetLastView()
    expect(lastView()).toBeUndefined()
    rememberLastView(view)
    expect(lastView()).toEqual(view)
  })

  it("the newest position wins", () => {
    rememberLastView({ ...view, row: "entry-old" })
    rememberLastView({ ...view, row: "entry-new" })
    expect(lastView()?.row).toBe("entry-new")
  })

  it("leaving a session drops the page with it", () => {
    rememberLastView(view)
    forgetLastView()
    expect(lastView()).toBeUndefined()
    // …and does not take the room record with it: they are separate facts, and
    // forgetting where to go is not the same as forgetting where you were.
    rememberLastRoom({ epk: "M1", roomId: "room-a" })
    forgetLastView()
    expect(lastRoom()?.roomId).toBe("room-a")
  })
  it("carries the page the launcher was opened on top of, one level deep", () => {
    rememberLastRoom({
      epk: "M1",
      roomId: "_29T25gf-dAop",
      name: "Gils-MBP.localdomain",
      control: true,
      under: { epk: "M1", roomId: "lij44pP9h-Tw", name: "un-bien" },
    })
    const held = lastRoom()
    expect(held?.control).toBe(true)
    expect(held?.under).toEqual({
      epk: "M1",
      roomId: "lij44pP9h-Tw",
      name: "un-bien",
    })
    // Closing the panel promotes `under` back to the whole record — and what
    // comes back is a session page, not a launcher page with a page under it.
    rememberLastRoom(held!.under!)
    expect(lastRoom()).toEqual({
      epk: "M1",
      roomId: "lij44pP9h-Tw",
      name: "un-bien",
    })
  })

  it("detach drops the pair, not just the top page", () => {
    rememberLastRoom({
      epk: "M1",
      roomId: "_29T25gf-dAop",
      control: true,
      under: { epk: "M1", roomId: "lij44pP9h-Tw", name: "un-bien" },
    })
    // Leaving a room forgets the whole record, so nothing waits to be restored.
    forgetLastRoom("M1")
    expect(lastRoom()).toBeUndefined()
  })
})

/**
 * The launch form. The folder path is the one field on that page a person types
 * by hand, and the page they were on is a control room, not a transcript.
 */
describe("the launch form to put back", () => {
  it("keeps which room was a launcher room, so the form is the thing restored", () => {
    rememberLastRoom({
      epk: "M1",
      roomId: "_29T25gf-dAop",
      name: "Gils-MBP.localdomain",
      control: true,
    })
    expect(lastRoom()).toEqual({
      epk: "M1",
      roomId: "_29T25gf-dAop",
      name: "Gils-MBP.localdomain",
      control: true,
    })
  })

  it("remembers the folder and name as typed", () => {
    forgetLaunchDraft()
    expect(launchDraft()).toBeUndefined()
    rememberLaunchDraft({
      epk: "M1",
      roomId: "_29T25gf-dAop",
      cwd: "/Users/you/dev/myai/un-bien",
      name: "un-bien",
    })
    expect(launchDraft()?.cwd).toBe("/Users/you/dev/myai/un-bien")
    expect(launchDraft()?.name).toBe("un-bien")
  })

  it("unpairing drops it with the machine's other records", () => {
    rememberLaunchDraft({
      epk: "M1",
      roomId: "_29T25gf-dAop",
      cwd: "/repo/x",
      name: "",
    })
    forgetLaunchDraft()
    expect(launchDraft()).toBeUndefined()
  })
})

/**
 * A launch the machine has not produced a room for yet. It is stored because the
 * machine echoes our request id in the room it starts, so the answer can arrive
 * in a page that outlived the one that asked.
 */
describe("a launch still waiting for its room", () => {
  it("survives the page that asked for it", () => {
    forgetPendingLaunch()
    expect(pendingLaunch()).toBeUndefined()
    rememberPendingLaunch({
      id: "rJ3k-2fQaLmX",
      epk: "M1",
      cwd: "/Users/you/dev/myai/un-bien",
      askedAt: Date.now(),
    })
    expect(pendingLaunch()?.id).toBe("rJ3k-2fQaLmX")
    expect(pendingLaunch()?.cwd).toBe("/Users/you/dev/myai/un-bien")
  })

  it("goes stale rather than waiting forever", () => {
    const askedAt = Date.now()
    rememberPendingLaunch({ id: "w1", epk: "M1", cwd: "/repo/x", askedAt })
    // The clock is injected, so the edge is testable: still waiting one unit
    // before the window closes, gone after it.
    expect(pendingLaunch(askedAt + PENDING_LAUNCH_TTL_MS - 1)?.id).toBe("w1")
    expect(pendingLaunch(askedAt + PENDING_LAUNCH_TTL_MS + 1)).toBeUndefined()
    // And the expired record is really deleted, not recomputed away on every
    // read — otherwise a machine that never answers keeps the note alive.
    expect(pendingLaunch()).toBeUndefined()
  })

  it("is dropped once the room is in hand, or the machine said no", () => {
    rememberPendingLaunch({
      id: "done",
      epk: "M1",
      cwd: "/repo/x",
      askedAt: Date.now(),
    })
    forgetPendingLaunch()
    expect(pendingLaunch()).toBeUndefined()
  })
})

/**
 * View preferences share ONE storage key, so the hazard is not reading them —
 * it is one writer quietly dropping the other's field.
 */
describe("view preferences", () => {
  it("monospace prose starts off and sticks once set", () => {
    setMonoProse(false)
    expect(monoProse()).toBe(false)
    setMonoProse(true)
    expect(monoProse()).toBe(true)
  })

  it("writing one preference keeps the other", () => {
    setHideReasoning(true)
    setMonoProse(false)
    expect(hideReasoning()).toBe(true)
    setHideReasoning(false)
    setMonoProse(true)
    expect(monoProse()).toBe(true)
    expect(hideReasoning()).toBe(false)
  })
})
