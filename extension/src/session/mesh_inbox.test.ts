import { describe, expect, it } from "vitest"
import { MeshInbox, _addressMatches, _federatedAddress, _roomAddress, type MeshMessage } from "./mesh_inbox.js"

const msg = (id: string): MeshMessage => ({
  id, from: "/a@x", to: "/b@y", body: "hi", re: null, sentAt: 1, deliveredAt: null,
})

describe("MeshInbox", () => {
  it("stores a message once and reports a redelivery", () => {
    const inbox = new MeshInbox()
    expect(inbox.add(msg("m1"))).toBe(true)
    expect(inbox.add(msg("m1"))).toBe(false)
    expect(inbox.add(msg("m2"))).toBe(true)
  })
})

describe("_addressMatches", () => {
  // A session's mesh address uses its agent name and resolved cwd; other
  // machines address it from its room metadata: display name, raw cwd.
  const mesh = "/Users/g/Development/pi/un-bien@unbien-highligher"
  const room = "/Users/g/dev/un-bien@un-bien"   // symlinked cwd, display name
  const names = [mesh, room]

  it("matches the mesh address and the room-metadata form, bare or behind a relay label", () => {
    expect(_addressMatches(mesh, names)).toBe(true)
    expect(_addressMatches(`cascade:${mesh}`, names)).toBe(true)
    expect(_addressMatches(`cascade:${room}`, names)).toBe(true)
  })

  it("rejects another agent on the same machine", () => {
    expect(_addressMatches("cascade:/Users/g/dev/un-bien@reviewer", names)).toBe(false)
    expect(_addressMatches("cascade:/Users/g/Development/other@unbien-highligher", names)).toBe(false)
    expect(_addressMatches(`${mesh}x`, names)).toBe(false)
  })

  it("matches nothing when this agent has no names yet", () => {
    expect(_addressMatches(mesh, [undefined, null])).toBe(false)
  })
})

describe("federated addressing round trip", () => {
  it("the address a sender builds from the room list is one the receiver accepts", () => {
    // The receiver's room as the relay lists it (display name, raw cwd), and
    // its mesh address (agent name, resolved cwd).
    const room = { cwd: "/Users/g/dev/un-bien", name: "un-bien", room_id: "r-1" }
    const mesh = "/Users/g/Development/pi/un-bien@unbien-highligher"
    const sent = _federatedAddress("cascade", _roomAddress(room))
    expect(sent).toBe("cascade:/Users/g/dev/un-bien@un-bien")
    expect(_addressMatches(sent, [mesh, _roomAddress({ cwd: room.cwd, name: room.name })])).toBe(true)
    // An unnamed room is addressed by its id.
    const unnamed = _federatedAddress("cascade", _roomAddress({ cwd: room.cwd, room_id: "r-1" }))
    expect(_addressMatches(unnamed, [mesh, _roomAddress({ cwd: room.cwd, room_id: "r-1" })])).toBe(true)
    // Another session on the same machine is not this one.
    const other = _federatedAddress("cascade", _roomAddress({ cwd: room.cwd, name: "reviewer" }))
    expect(_addressMatches(other, [mesh, _roomAddress({ cwd: room.cwd, name: room.name })])).toBe(false)
  })
})
