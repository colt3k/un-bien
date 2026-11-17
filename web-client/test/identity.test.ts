import { describe, expect, it } from "vitest"
import {
  contentSignature,
  identify,
  imagesFromContent,
  imagesFromToolResult,
  joinedText,
  stableHash,
} from "../src/content-identity.js"

describe("content identity (the live-row to entry bridge)", () => {
  it("hashes like FNV-1a/64 in base 36 — stable across processes and languages", () => {
    // Independent vectors (the same values a plain FNV-1a/64 implementation
    // produces). The match loop compares these across launches, so a
    // language-native hash would silently break re-sync dedup.
    expect(stableHash("")).toBe("33niihzj4ux45")
    expect(stableHash("a")).toBe("2o0ongoiv4rrg")
    expect(stableHash("user|0|t:hello")).toBe("1unwryswlzrs4")
  })

  it("signatures are order-preserving and kind-tagged", () => {
    expect(
      contentSignature([
        { type: "text", text: "one" },
        { type: "thinking", thinking: "hmm" },
        { type: "toolCall", id: "call_1", name: "read" },
        { type: "image", mimeType: "image/png" },
      ]),
    ).toBe("t:one\nk:hmm\nc:call_1:read\ni:image/png")
    // A bare user string is its own signature.
    expect(contentSignature("just text")).toBe("just text")
  })

  it("a live frame and its later entry replay identify as the same message", () => {
    const live = {
      role: "assistant",
      timestamp: 1787851941480,
      content: [{ type: "text", text: "the answer" }],
    }
    const replayed = {
      role: "assistant",
      timestamp: 1787851941480,
      content: [{ type: "text", text: "the answer" }],
    }
    expect(identify(live)).toBe(identify(replayed))
    expect(identify(live)).toMatch(/^m[0-9a-z]+$/)
  })

  it("ignores vendor fields entirely — providers reuse ids", () => {
    const base = {
      role: "assistant",
      timestamp: 1,
      content: [{ type: "text", text: "one" }],
    }
    // The Swift comment records a real session where 426 of 744 responseIds
    // were shared across DIFFERENT messages. Trusting one collapsed unrelated
    // messages into "the same message", and a row was never born at all.
    expect(identify({ ...base, responseId: "shared-rid" })).toBe(identify(base))
    expect(identify({ ...base, responseId: "other-rid" })).toBe(identify(base))
    expect(identify({ ...base, usage: { output: 9 } })).toBe(identify(base))
    // The message's own fields DO disambiguate.
    expect(identify({ ...base, timestamp: 2 })).not.toBe(identify(base))
    expect(
      identify({ ...base, content: [{ type: "text", text: "two" }] }),
    ).not.toBe(identify(base))
  })

  it("tool-only messages do not collide on empty text", () => {
    const a = {
      role: "assistant",
      timestamp: 5,
      content: [{ type: "toolCall", id: "call_a", name: "bash" }],
    }
    const b = {
      role: "assistant",
      timestamp: 5,
      content: [{ type: "toolCall", id: "call_b", name: "bash" }],
    }
    expect(identify(a)).not.toBe(identify(b))
    // Same content block in a different ORDER is a different message.
    const x = {
      role: "assistant",
      timestamp: 5,
      content: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
    }
    const y = {
      role: "assistant",
      timestamp: 5,
      content: [
        { type: "text", text: "b" },
        { type: "text", text: "a" },
      ],
    }
    expect(identify(x)).not.toBe(identify(y))
  })

  it("joins an entry's text blocks into ONE row body", () => {
    // An assistant entry with several text blocks is one bubble, not one row
    // per block — the `entryId#1` keys the spike was producing are wrong here.
    expect(
      joinedText([
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "first" },
        { type: "toolCall", id: "c", name: "read" },
        { type: "text", text: "second" },
      ]),
    ).toBe("first\nsecond")
    expect(joinedText("bare")).toBe("bare")
  })

  it("pulls images from message content and unwraps a tool result wrapper", () => {
    const content = [
      { type: "text", text: "look" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
      { type: "image", data: "", mimeType: "image/png" },
    ]
    expect(imagesFromContent(content)).toEqual([
      { data: "AAAA", mime: "image/png" },
    ])
    expect(imagesFromToolResult({ content, details: {} })).toHaveLength(1)
    expect(imagesFromToolResult(content)).toHaveLength(1)
    expect(imagesFromToolResult(null)).toEqual([])
  })
})
