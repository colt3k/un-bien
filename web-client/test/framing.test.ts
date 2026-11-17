import { describe, expect, it } from "vitest"
import {
  decodeInbound,
  encodeOuter,
  stampEnvelope,
  toWsUrl,
} from "../src/framing.js"
import { parseInvite } from "../src/invite.js"
import { generateEd25519Keypair } from "@geohar/un-bien/client"

describe("relay URL", () => {
  it("turns a configured http(s) relay into a socket URL", () => {
    expect(toWsUrl("http://m5max.tail5f1ece.ts.net:3000")).toBe(
      "ws://m5max.tail5f1ece.ts.net:3000",
    )
    expect(toWsUrl("https://relay.example.com/")).toBe(
      "wss://relay.example.com",
    )
    expect(toWsUrl("ws://localhost:3000")).toBe("ws://localhost:3000")
  })
})

describe("envelope stamping", () => {
  it("stamps the plane's REAL kind — an unstamped frame is silently dropped", () => {
    const rpc = stampEnvelope({ rpc: { type: "prompt" } })
    expect(rpc.type).toBe("rpc")
    expect(typeof rpc.ts).toBe("number")

    expect(stampEnvelope({ ub: { type: "session_sync" } }).type).toBe("ub")
    expect(stampEnvelope({ evt: { channel: "plan", data: {} } }).type).toBe(
      "evt",
    )
  })
})

describe("outer framing", () => {
  it("round-trips an envelope through the relay's opaque ct", () => {
    const inner = stampEnvelope({
      rpc: { type: "message_end", message: { role: "user" } },
    })
    const line = encodeOuter(inner, "MACHINEPK", "aB12CD34eF56")
    const parsed = JSON.parse(line) as {
      peer: string
      room: string
      ct: string
    }
    expect(parsed).toMatchObject({ peer: "MACHINEPK", room: "aB12CD34eF56" })

    const inbound = decodeInbound(line)
    expect(inbound.kind).toBe("envelope")
    if (inbound.kind === "envelope") {
      expect(inbound.frame.rpc).toMatchObject({ type: "message_end" })
    }
  })

  it("classifies a relay control frame (no ct) as control, not session traffic", () => {
    const inbound = decodeInbound(
      JSON.stringify({ type: "rooms", peer: "X", rooms: [] }),
    )
    expect(inbound.kind).toBe("control")
  })

  it("classifies a pre-attach stock frame (pair_ok) as control-plane, not envelope", () => {
    const line = encodeOuter(
      { type: "pair_ok", room_id: "r1" },
      "MACHINEPK",
      "main",
    )
    const inbound = decodeInbound(line)
    expect(inbound.kind === "stock" && inbound.frame.type).toBe("pair_ok")
  })

  it("surfaces unreadable frames instead of swallowing them", () => {
    expect(decodeInbound("{not json").kind).toBe("control")
    if (decodeInbound("{not json").kind === "control") {
      const frame = (
        decodeInbound("{not json") as { frame: Record<string, unknown> }
      ).frame
      expect(frame.type).toBe("_unparseable")
    }
  })
})

describe("pairing invites", () => {
  it("parses the /unbien pair code", () => {
    const keypair = generateEd25519Keypair()
    // The QR carries base64url (`-`/`_`, unpadded) — that is exactly what makes
    // it safe to drop into a query string. Standard base64 is NOT: a `+` in a
    // query decodes as a space, and the key is silently mangled.
    const urlSafe = Buffer.from(keypair.publicKey).toString("base64url")
    const standard = Buffer.from(keypair.publicKey).toString("base64")
    const invite = parseInvite(
      `unbien://pair?t=tok123&epk=${urlSafe}&n=un-bien %C2%B7 main&rm=aB12CD34eF56`,
    )
    expect(invite.token).toBe("tok123")
    expect(invite.epk).toBe(standard)
    expect(invite.sessionName).toBe("un-bien · main")
    expect(invite.roomId).toBe("aB12CD34eF56")
  })

  it("canonicalizes the QR's base64url key into the relay's padded standard base64", () => {
    // The self-revocation trap (DESIGN.md §10.1): the QR carries base64url,
    // the relay routes by standard padded base64. Same bytes, unequal strings.
    const keypair = generateEd25519Keypair()
    const urlSafe = Buffer.from(keypair.publicKey).toString("base64url")
    const standard = Buffer.from(keypair.publicKey).toString("base64")
    const invite = parseInvite(`unbien://pair?t=t&epk=${urlSafe}`)
    expect(invite.epk).toBe(standard)
    expect(invite.roomId).toBe("main")
  })

  it("refuses anything that is not a pairing URI", () => {
    expect(() => parseInvite("http://example.com")).toThrow(/not a pairing URI/)
    expect(() => parseInvite("unbien://pair?epk=AAAA")).toThrow(/no token/)
    expect(() => parseInvite("unbien://pair?t=abc")).toThrow(/no peer key/)
  })

  it("says so when a code was half-copied", () => {
    // The core throws MeshPublicKeyError on a wrong-length key; the person at
    // the phone screen needs "the key is wrong", not a stack type.
    expect(() => parseInvite("unbien://pair?t=abc&epk=QUJDRA")).toThrow(
      /unusable machine key/,
    )
  })
})
