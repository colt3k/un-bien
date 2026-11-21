import { describe, expect, it } from "vitest"
import {
  RELAY_PORT,
  correlationId,
  decodeInbound,
  encodeOuter,
  relayUrlForPage,
  stampEnvelope,
  toWsUrl,
  uuidFromBytes,
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

describe("request ids", () => {
  const uuidShape =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

  it("stamps a v4 uuid where the browser has one", () => {
    expect(correlationId()).toMatch(uuidShape)
  })

  it("still stamps one when crypto.randomUUID is missing", () => {
    // `crypto.randomUUID` is a SECURE-CONTEXT API: it is `undefined` on the
    // plain-http tailnet URL this client is opened from, while
    // `getRandomValues` is present. The id must not depend on the restricted
    // one, or every request (pair, prompt, steer, abort) dies silently.
    const real = globalThis.crypto
    const stub = {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(0)
        for (let i = 0; i < bytes.length; i++) bytes[i] = i
        return bytes
      },
    }
    // `globalThis.crypto` is a getter-only accessor: a plain assignment is
    // silently ignored, so replace the property itself.
    Object.defineProperty(globalThis, "crypto", {
      value: stub,
      configurable: true,
    })
    try {
      expect(correlationId()).toMatch(uuidShape)
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        value: real,
        configurable: true,
      })
    }
  })

  it("lays the version and variant nibbles in the v4 slots", () => {
    // byte 6 -> the first nibble of the third group, byte 8 -> the first of the
    // fourth. All-zero and all-one inputs show both slots being overwritten.
    expect(uuidFromBytes(new Uint8Array(16))).toBe(
      "00000000-0000-4000-8000-000000000000",
    )
    expect(uuidFromBytes(new Uint8Array(16).fill(0xff))).toBe(
      "ffffffff-ffff-4fff-bfff-ffffffffffff",
    )
  })
})

describe("default relay URL, from the page the client was opened on", () => {
  it("keeps the host and swaps in the relay port", () => {
    // The phone case: the page and the relay are the same tailnet host,
    // started by the same start.sh, differing only by port.
    expect(
      relayUrlForPage("http://m5max.tail5f1ece.ts.net:5173/?fresh=1"),
    ).toBe("http://m5max.tail5f1ece.ts.net:3000")
    expect(relayUrlForPage("http://localhost:5173/")).toBe(
      "http://localhost:3000",
    )
    expect(relayUrlForPage("http://192.168.1.86:5173/x")).toBe(
      "http://192.168.1.86:3000",
    )
  })

  it("adds the port when the page has none", () => {
    expect(relayUrlForPage("http://relay.example.com")).toBe(
      "http://relay.example.com:3000",
    )
  })

  it("keeps the scheme — an https page cannot open an insecure ws:// socket", () => {
    const https = relayUrlForPage("https://host.example:8443/p?q=1#h")
    expect(https).toBe("https://host.example:3000")
    expect(toWsUrl(https)).toBe("wss://host.example:3000")
  })

  it("keeps an IPv6 literal bracketed", () => {
    expect(relayUrlForPage("http://[::1]:5173")).toBe("http://[::1]:3000")
  })

  it("defaults to the relay's own port, and takes another when told", () => {
    expect(RELAY_PORT).toBe(3000)
    expect(relayUrlForPage("http://host:5173", 3100)).toBe("http://host:3100")
  })

  it("guesses nothing when there is no http host to take", () => {
    expect(relayUrlForPage("file:///tmp/index.html")).toBe("")
    expect(relayUrlForPage("about:blank")).toBe("")
    expect(relayUrlForPage("not a url")).toBe("")
  })
})
