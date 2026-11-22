import { describe, expect, it } from "vitest"
import {
  applyRoomUpdate,
  controlRoomOf,
  isControlRoom,
  isViewableSession,
  launchedRoom,
  mergeRoomLists,
  resumeTarget,
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

// The launcher daemon as it announces itself today: `is_daemon` is the marker
// the extension stamps (launcher.ts DAEMON_CAPS), and it is the ONLY thing that
// separates a daemon room from a live session whose cwd allows remote launch.
const daemon: TrackedRoom = {
  room_id: "_29T25gf-dAop",
  name: "Gils-MacBook-Pro.local",
  cwd: "/Users/gfcollin",
  caps: ["remote_launch", "is_daemon", "session_resume"],
  misses: 0,
}

// A live pi in a folder with allow_remote_launch: it advertises remote_launch
// too, and it has a transcript.
const launchableSession: TrackedRoom = {
  ...session,
  caps: [...session.caps!, "remote_launch"],
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
    // `is_daemon` wins even against a session id: a daemon room has no
    // transcript whatever it grows.
    expect(isViewableSession({ ...daemon, sessionId: "x" })).toBe(false)
    expect(isViewableSession(session)).toBe(true)
  })

  it("treat a room with a pi session id as a session, cap or no cap", () => {
    // A deliberate change from the previous rule, which read any room holding
    // `remote_launch` as a control room and so denied a live session its
    // transcript. The session id is the evidence that there is a transcript.
    expect(isViewableSession({ ...control, sessionId: "x" })).toBe(true)
  })

  it("do not include a live session that happens to allow remote launch", () => {
    // The trap this client fell into: `remote_launch` alone is not the marker.
    // A pi in a folder with allow_remote_launch advertises it, and tagging its
    // room as a control room took away its attach button.
    expect(isControlRoom(launchableSession)).toBe(false)
    expect(isViewableSession(launchableSession)).toBe(true)
    expect(isControlRoom(daemon)).toBe(true)
  })

  it("are hidden unless asked for", () => {
    const rooms = [session, control]
    expect(visibleRooms(rooms, false).map((r) => r.room_id)).toEqual([
      session.room_id,
    ])
    expect(visibleRooms(rooms, true)).toHaveLength(2)
  })
})

describe("launch targeting", () => {
  it("finds the machine's launcher room even while it is hidden from the list", () => {
    // The machine card's launch button depends on this: the control room is
    // hidden by default, but it is still the only thing that answers
    // `session_launch`.
    expect(controlRoomOf([session, control])?.room_id).toBe(control.room_id)
    expect(controlRoomOf([session])).toBeUndefined()
  })

  it("prefers the daemon over a live session that advertises remote_launch", () => {
    // Both answer `session_launch`. Driving the session's room would hide the
    // chat the user is reading, so the daemon wins.
    expect(controlRoomOf([launchableSession, daemon])?.room_id).toBe(
      daemon.room_id,
    )
    // With no daemon registered, the session's room is not grabbed either.
    expect(controlRoomOf([launchableSession])).toBeUndefined()
  })

  it("ages a control room out like any other room", () => {
    // Measured against a live relay, `rooms_check` DOES list the daemon's
    // control room (caps `remote_launch`, `is_daemon`, `session_resume`) — it
    // is not announce-only. So the daemon is aged by MISSING_GRACE like a
    // session: a daemon that dies loses its card, and its launch button, after
    // the machine stops stating it. The exemption this test used to demand was
    // written against a misdiagnosis (a daemon dead from a stale node path in
    // its LaunchAgent, not a client that forgot it).
    let tracked = [daemon]
    for (let i = 0; i < MISSING_GRACE + 1; i++)
      tracked = mergeRoomLists(tracked, [])
    expect(tracked).toHaveLength(0)
  })

  it("keeps a control room across refreshes that state it", () => {
    let tracked = [daemon, launchableSession]
    for (let i = 0; i < MISSING_GRACE + 2; i++)
      tracked = mergeRoomLists(tracked, [
        { room_id: daemon.room_id },
        { room_id: launchableSession.room_id },
      ])
    expect(tracked.map((r) => r.room_id)).toContain(daemon.room_id)
    expect(controlRoomOf(tracked)?.room_id).toBe(daemon.room_id)
  })

  it("picks the same launcher when a restarting daemon leaves two registered", () => {
    const stale = { ...control, room_id: "zzz", name: "A.localdomain" }
    const fresh = { ...control, room_id: "aaa", name: "B.localdomain" }
    const first = controlRoomOf([stale, fresh])?.room_id
    expect(controlRoomOf([fresh, stale])?.room_id).toBe(first)
  })

  it("matches the launched room by the echoed request id", () => {
    // The extension echoes UNBIEN_LAUNCH_REQ into room_meta, so the announce
    // says which request it answers — not just "a room appeared".
    const launchedRoomInfo: TrackedRoom = {
      ...session,
      room_id: "new-room",
      launchReq: "req-42",
      misses: 0,
    }
    expect(
      launchedRoom([session, control, launchedRoomInfo], "req-42")?.room_id,
    ).toBe("new-room")
  })

  it("refuses to guess a launch from a room that does not echo the id", () => {
    // Another device may start a session at the same moment. Without the echo
    // there is no evidence, so the caller must not auto-open a stranger.
    expect(launchedRoom([session, control], "req-42")).toBeUndefined()
    expect(
      launchedRoom(
        [{ ...session, launchReq: "other-req", misses: 0 }, control],
        "req-42",
      ),
    ).toBeUndefined()
    expect(launchedRoom([session], "")).toBeUndefined()
  })
})

describe("single-room updates (room_announced / room_meta_updated)", () => {
  it("do not age out the rooms the frame does not mention", () => {
    // The regression this guards: a live session pushes `room_meta_updated`
    // every time `working` flips — measured at one every couple of seconds —
    // and the daemon's control room is never re-stated. Treating those pushes
    // as listings deleted the control room (and the machine's launch button)
    // MISSING_GRACE frames after load, while `rooms_check` had listed it all along.
    let tracked = [daemon, session]
    for (let i = 0; i < MISSING_GRACE + 3; i++)
      tracked = applyRoomUpdate(tracked, {
        room_id: session.room_id,
        working: i % 2 === 0,
      })
    expect(tracked.map((r) => r.room_id)).toContain(daemon.room_id)
    expect(controlRoomOf(tracked)?.room_id).toBe(daemon.room_id)
    expect(tracked.find((r) => r.room_id === session.room_id)?.misses).toBe(0)
  })

  it("keep fields the frame leaves unstated", () => {
    // A metadata push carries model/name/working only; the caps that mark this
    // room as the launcher must survive it.
    const [updated] = applyRoomUpdate([daemon], {
      room_id: daemon.room_id,
      working: true,
    })
    expect(updated?.working).toBe(true)
    expect(updated?.caps).toEqual(daemon.caps)
    expect(updated && isControlRoom(updated)).toBe(true)
  })

  it("add a room that is announced for the first time", () => {
    const tracked = applyRoomUpdate([session], {
      room_id: "brand-new",
      name: "pi",
      sessionId: "01a2006b-0000-7000-8000-000000000000",
    })
    expect(tracked.map((r) => r.room_id)).toEqual(
      expect.arrayContaining([session.room_id, "brand-new"]),
    )
    expect(tracked.find((r) => r.room_id === "brand-new")?.misses).toBe(0)
  })

  it("still let a listing drop a room that really went away", () => {
    // The update path never removes; removal is `room_ended` or a listing that
    // stays silent about it. Check that the two paths still compose.
    let tracked = applyRoomUpdate([session, daemon], {
      room_id: session.room_id,
      working: true,
    })
    for (let i = 0; i < MISSING_GRACE + 1; i++)
      tracked = mergeRoomLists(tracked, [{ room_id: session.room_id }])
    expect(tracked.map((r) => r.room_id)).toEqual([session.room_id])
  })
})

describe("resume targets (what a reload reopens)", () => {
  it("re-attaches the recorded session while the machine still advertises it", () => {
    const t = resumeTarget({ roomId: session.room_id }, [session, daemon])
    expect(t?.kind).toBe("session")
    expect(t?.room.room_id).toBe(session.room_id)
  })

  it("takes the machine's one live session when the room id rotated", () => {
    const renamed = { ...session, room_id: "NEWroom-aaaa" }
    const t = resumeTarget({ roomId: session.room_id }, [renamed])
    expect(t?.room.room_id).toBe("NEWroom-aaaa")
  })

  it("refuses to guess between two live sessions", () => {
    // Opening a transcript the reader did not leave is worse than a page that
    // says "pick one".
    const other = {
      ...session,
      room_id: "otherRoom",
      sessionId: "9a9a9a9a-0000-4000-8000-000000000000",
    }
    expect(resumeTarget({ roomId: "goneRoom-xx" }, [session, other])).toBeNull()
  })

  it("never reopens a control room as if it were a transcript", () => {
    // The bug this pins: a session record plus a machine whose only room is a
    // launcher used to attach the launcher room, which answers no `get_entries`
    // — the client sat at "machine not answering" forever.
    expect(resumeTarget({ roomId: session.room_id }, [daemon])).toBeNull()
    expect(resumeTarget({ roomId: "goneRoom" }, [daemon])).toBeNull()
  })

  it("puts the launch form back for a control room record", () => {
    const t = resumeTarget({ roomId: daemon.room_id, control: true }, [
      session,
      daemon,
    ])
    expect(t?.kind).toBe("control")
    expect(t?.room.room_id).toBe(daemon.room_id)
  })

  it("follows a rotated control room id to the machine's daemon", () => {
    const t = resumeTarget({ roomId: "OLDcontrol", control: true }, [
      session,
      daemon,
    ])
    expect(t?.kind).toBe("control")
    expect(t?.room.room_id).toBe(daemon.room_id)
  })

  it("says there is nothing to reopen when the launcher stopped", () => {
    expect(
      resumeTarget({ roomId: daemon.room_id, control: true }, [session]),
    ).toBeNull()
  })

  it("still finds an older daemon that never stamps is_daemon", () => {
    const t = resumeTarget({ roomId: "gone", control: true }, [
      session,
      control,
    ])
    expect(t?.room.room_id).toBe(control.room_id)
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
