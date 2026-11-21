import { describe, expect, it } from "vitest"
import {
  isControlRoom,
  isViewableSession,
  mergeRoomLists,
  roomFacts,
  roomTag,
  sortRooms,
  visibleRooms,
  MISSING_GRACE,
  type TrackedRoom,
} from "../src/room-list.js"

// A session room as a machine announces it, and a launcher's control room.
const session: TrackedRoom = {
  room_id: "lij44pP9h-Tw",
  name: "un-bien",
  cwd: "/repo/un-bien",
  sessionId: "01a1e5eb-9683-7211-b94c-87c79fd31bf9",
  caps: ["remote_terminate", "models", "drive"],
  misses: 0,
}

const control: TrackedRoom = {
  room_id: "HI5OxguNw8Nl",
  name: "Gils-MBP.localdomain",
  cwd: "/Users/gfcollin",
  caps: ["remote_launch", "remote_pair", "remote_terminate"],
  misses: 0,
}

describe("mergeRoomLists", () => {
  it("keeps known metadata when a reply states only the room id", () => {
    // The bug this guards: a refresh that sees the registration but not the
    // room_meta used to render the card as a bare id, then as its name again —
    // a name flickering by itself.
    const merged = mergeRoomLists([session], [{ room_id: session.room_id }])
    expect(merged).toHaveLength(1)
    expect(merged[0]!.name).toBe("un-bien")
    expect(merged[0]!.sessionId).toBe(session.sessionId)
    expect(roomTag(merged[0]!)).toBe("session")
  })

  it("takes the newer value when a reply does state a field", () => {
    const merged = mergeRoomLists(
      [session],
      [{ room_id: session.room_id, name: "renamed" }],
    )
    expect(merged[0]!.name).toBe("renamed")
    expect(merged[0]!.cwd).toBe("/repo/un-bien")
  })

  it("survives a gap of up to MISSING_GRACE refreshes, then drops", () => {
    let rooms = mergeRoomLists([session], [])
    expect(rooms).toHaveLength(1)
    for (let i = 1; i < MISSING_GRACE; i++) rooms = mergeRoomLists(rooms, [])
    expect(rooms).toHaveLength(1)
    rooms = mergeRoomLists(rooms, [])
    expect(rooms).toHaveLength(0)
  })

  it("does not resurrect a room the machine re-announced under a new id", () => {
    // Reconnects mint a fresh room id; the old one should age out rather than
    // sit alongside its replacement forever.
    let rooms = mergeRoomLists(
      [session],
      [{ ...session, room_id: "rwQ-Lgirk8-y" }],
    )
    expect(rooms.map((r) => r.room_id).sort()).toEqual([
      "lij44pP9h-Tw",
      "rwQ-Lgirk8-y",
    ])
    for (let i = 0; i <= MISSING_GRACE; i++)
      rooms = mergeRoomLists(rooms, [{ room_id: "rwQ-Lgirk8-y" }])
    expect(rooms.map((r) => r.room_id)).toEqual(["rwQ-Lgirk8-y"])
  })
})

describe("ordering", () => {
  it("is the same however the relay happened to return the rooms", () => {
    // The relay's room list arrives in arbitrary order; rendering it raw made
    // the card in a given slot be a different room on each refresh.
    const a = sortRooms([session, control]).map(roomTag)
    const b = sortRooms([control, session]).map(roomTag)
    expect(a).toEqual(b)
    expect(a).toEqual(["session", "control room"])
  })

  it("breaks name ties by room id, so identical names stay put", () => {
    const one = { ...session, room_id: "aaa", name: "Gils-MBP.localdomain" }
    const two = { ...session, room_id: "bbb", name: "Gils-MBP.localdomain" }
    expect(sortRooms([two, one]).map((r) => r.room_id)).toEqual(["aaa", "bbb"])
  })
})

describe("control rooms", () => {
  it("are recognised by the cap that only a launcher advertises", () => {
    expect(isControlRoom(control)).toBe(true)
    expect(isControlRoom(session)).toBe(false)
  })

  it("are never offered as viewable sessions", () => {
    // Even if a control room grew a session id, its transcript is empty.
    expect(isViewableSession({ ...control, sessionId: "x" })).toBe(false)
    expect(isViewableSession(session)).toBe(true)
  })

  it("are hidden unless asked for", () => {
    const rooms = [session, control]
    expect(visibleRooms(rooms, false).map((r) => r.room_id)).toEqual([
      session.room_id,
    ])
    expect(visibleRooms(rooms, true)).toHaveLength(2)
  })
})

describe("room facts", () => {
  it("always name the room id, the one field that survives a re-announcement", () => {
    const facts = roomFacts({ room_id: "lij44pP9h-Tw", misses: 0 })
    expect(facts).toContain("room lij44pP9")
  })

  it("say what a room is when nothing else is known yet", () => {
    expect(roomTag({ room_id: "lij44pP9h-Tw", misses: 0 })).toBe(
      "awaiting details",
    )
  })
})
