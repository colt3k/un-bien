import { describe, expect, it } from "vitest"
import { MeshInbox, _addressMatches, type MeshMessage } from "./mesh_inbox.js"

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
  const me = "/Users/g/Development/pi/un-bien@worker"
  it("matches this agent's address, bare or behind a relay label", () => {
    expect(_addressMatches(me, me)).toBe(true)
    expect(_addressMatches(`cascade:${me}`, me)).toBe(true)
  })
  it("rejects another agent on the same machine", () => {
    expect(_addressMatches("/Users/g/Development/pi/un-bien@reviewer", me)).toBe(false)
    expect(_addressMatches("cascade:/Users/g/Development/other@worker", me)).toBe(false)
    expect(_addressMatches(`${me}x`, me)).toBe(false)
  })
  it("matches nothing before the mesh node exists", () => {
    expect(_addressMatches(me, undefined)).toBe(false)
  })
})
