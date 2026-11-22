import { describe, expect, it } from "vitest"
import {
  forgetLastRoom,
  hideReasoning,
  lastRoom,
  monoProse,
  rememberLastRoom,
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
