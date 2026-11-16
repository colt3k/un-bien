import { describe, expect, test, vi } from "vitest"
import {
  FederatedAcks,
  ackEnvelopeFor,
  isAckEnvelope,
  isFederatedBroadcast,
  resolveFederatedTarget,
} from "./federated_send.js"

const detail = new Map([
  ["epk-a", { relayName: "cascade", addresses: ["cascade:/repo@alpha", "cascade:/repo@beta"] }],
  ["epk-b", { relayName: "droplet", addresses: ["droplet:/home@gamma"] }],
])

describe("federated addressing", () => {
  test("broadcast forms are explicit; session addresses and plain broadcast are not", () => {
    expect(isFederatedBroadcast("*:broadcast")).toBe(true)
    expect(isFederatedBroadcast("cascade:broadcast")).toBe(true)
    expect(isFederatedBroadcast("broadcast")).toBe(false)
    expect(isFederatedBroadcast("cascade:/repo@broadcast")).toBe(false)
    expect(isFederatedBroadcast("/repo@broadcast")).toBe(false)
  })

  test("resolves a listed room address to its machine", () => {
    expect(resolveFederatedTarget("cascade:/repo@beta", detail)).toEqual({ kind: "unicast", epk: "epk-a", relayName: "cascade" })
    expect(resolveFederatedTarget("/repo@beta", detail)).toBeNull()
  })

  test("resolves broadcasts to one or every machine, and names an unknown label", () => {
    expect(resolveFederatedTarget("droplet:broadcast", detail)).toEqual({ kind: "broadcast", epks: ["epk-b"], relayNames: ["droplet"] })
    expect(resolveFederatedTarget("*:broadcast", detail)).toEqual({
      kind: "broadcast",
      epks: ["epk-a", "epk-b"],
      relayNames: ["cascade", "droplet"],
    })
    expect(resolveFederatedTarget("nowhere:broadcast", detail)).toEqual({ kind: "unknown_relay", relayName: "nowhere" })
    expect(resolveFederatedTarget("*:broadcast", new Map())).toEqual({ kind: "broadcast", epks: [], relayNames: [] })
  })
})

describe("FederatedAcks", () => {
  test("an ack naming the send settles it as received", async () => {
    const acks = new FederatedAcks()
    const p = acks.wait("send-1", 5_000)
    const consumed = acks.settle({ id: "a-1", from: "x", to: "y", re: "send-1", body: { type: "ack", status: "received", target: "t" } })
    expect(consumed).toBe(true)
    await expect(p).resolves.toEqual({ status: "received", id: "send-1", target: "t" })
  })

  test("the relay's refusal settles it with the transport reason", async () => {
    const acks = new FederatedAcks()
    const p = acks.wait("send-2", 5_000)
    acks.settle({ id: "e-1", from: "_relay", to: "y", re: "send-2", body: { type: "transport_error", reason: "unknown_peer" } })
    await expect(p).resolves.toMatchObject({ status: "unknown_peer", reason: "unknown_peer" })
  })

  test("a reply to the send is not an ack and is left for the inbox", () => {
    const acks = new FederatedAcks()
    void acks.wait("send-3", 5_000)
    expect(acks.settle({ id: "r-1", from: "x", to: "y", re: "send-3", body: "the answer" })).toBe(false)
    acks.clear()
  })

  test("no ack in time settles as an unconfirmed timeout (no reason)", async () => {
    vi.useFakeTimers()
    try {
      const acks = new FederatedAcks()
      const p = acks.wait("send-4", 5_000)
      vi.advanceTimersByTime(5_000)
      await expect(p).resolves.toEqual({ status: "timeout", id: "send-4" })
      // a late ack is no longer consumed as a settlement
      expect(acks.settle({ id: "a-2", re: "send-4", body: { type: "ack" } })).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  test("recognises the relay's error for an ack this agent sent", () => {
    const acks = new FederatedAcks()
    acks.noteAckSent("ack-9")
    expect(acks.isErrorForOwnAck({ id: "e", from: "_relay", re: "ack-9", body: { type: "transport_error", reason: "unknown_peer" } })).toBe(true)
    expect(acks.isErrorForOwnAck({ id: "e", from: "_relay", re: "other", body: { type: "transport_error", reason: "unknown_peer" } })).toBe(false)
  })

  test("the ack goes back to the sender, correlated to its envelope", () => {
    const env = { id: "m-1", from: "/remote@asker", to: "cascade:/repo@alpha", body: "hi", ack: true }
    const ack = ackEnvelopeFor(env, "/repo@alpha", "ack-1")
    expect(ack).toEqual({
      id: "ack-1",
      from: "/repo@alpha",
      to: "/remote@asker",
      re: "m-1",
      body: { type: "ack", status: "received", target: "cascade:/repo@alpha" },
    })
    expect(isAckEnvelope(ack)).toBe(true)
  })
})
