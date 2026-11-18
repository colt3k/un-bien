import { describe, expect, it } from "vitest"
import {
  TranscriptReducer,
  entriesToEnvelopes,
  toEnvelope,
} from "../src/reducer.js"
import type { EnvelopeMessage } from "@geohar/un-bien/client"

function fold(frames: EnvelopeMessage[]): TranscriptReducer {
  const reducer = new TranscriptReducer()
  for (const frame of frames) reducer.apply(frame)
  return reducer
}

function text(frame: Record<string, unknown>): EnvelopeMessage {
  return { rpc: frame }
}

describe("streaming fold", () => {
  it("keeps what streamed: message_end settles the row, it does not re-write it", () => {
    const snapshot = fold([
      text({
        type: "message_start",
        message: { role: "assistant", content: [] },
      }),
      text({
        type: "message_update",
        assistantMessageEvent: { type: "text_start", contentIndex: 0 },
      }),
      text({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "he",
        },
      }),
      text({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "llo",
        },
      }),
      text({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello there" }],
        },
      }),
    ]).snapshot()

    expect(snapshot.items).toHaveLength(1)
    // The deltas are the record of what the viewer watched. The settled frame
    // carries MORE text here, and the reference deliberately does not swap it
    // in — same rule as the `text_end` event, which is ignored outright.
    expect(snapshot.items[0]).toMatchObject({
      kind: "assistant",
      text: "hello",
      streaming: false,
    })
    expect(snapshot.items[0]?.row).toBe("assistant#1")
  })

  it("splits a thinking block into its own reasoning row", () => {
    const snapshot = fold([
      text({
        type: "message_start",
        message: { role: "assistant", content: [] },
      }),
      text({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
      }),
      text({
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: "hmm",
        },
      }),
      text({
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_end",
          contentIndex: 0,
          content: "hmm",
        },
      }),
      text({
        type: "message_update",
        assistantMessageEvent: { type: "text_start", contentIndex: 1 },
      }),
      text({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 1,
          delta: "answer",
        },
      }),
    ]).snapshot()

    expect(snapshot.items.map((item) => item.kind)).toEqual([
      "reasoning",
      "assistant",
    ])
    expect(snapshot.items[1]).toMatchObject({ text: "answer", streaming: true })
  })

  it("keeps the turn open until agent_settled, and settles the rows there", () => {
    const reducer = fold([
      text({ type: "turn_start" }),
      text({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "x",
        },
      }),
      text({ type: "turn_end" }),
    ])
    const afterTurnEnd = reducer.snapshot()
    // `turn_end` closes the bubble but does NOT end the turn: the reference's
    // streaming flag is `activeTurnID != nil`, cleared only by agent_settled —
    // an agent chaining turns stays streaming in between.
    expect(afterTurnEnd.flags.streaming).toBe(true)
    expect(afterTurnEnd.items.every((item) => !item.streaming)).toBe(true)
    reducer.apply(text({ type: "agent_end" }))
    expect(reducer.snapshot().flags.streaming).toBe(true)
    reducer.apply(text({ type: "agent_settled" }))
    const snapshot = reducer.snapshot()
    // A turn settling is NOT the session ending. `ended` means the machine
    // stopped being drivable, and getting that wrong dims the transcript and
    // kills the composer after every reply.
    expect(snapshot.flags.ended).toBe(false)
    expect(snapshot.items.every((item) => !item.streaming)).toBe(true)
  })

  it("marks the session ended only on session_shutdown", () => {
    const snapshot = fold([
      text({ type: "turn_start" }),
      text({ type: "agent_end" }),
      text({ type: "agent_settled" }),
      text({ type: "session_shutdown" }),
    ]).snapshot()
    expect(snapshot.flags.ended).toBe(true)
    expect(snapshot.flags.streaming).toBe(false)
  })
})

describe("tool cards", () => {
  it("runs one card per toolCallId, even when the delta opens it first", () => {
    const snapshot = fold([
      text({
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_start",
          contentIndex: 2,
          id: "t1",
          toolName: "bash",
        },
      }),
      text({
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "bash",
        args: { command: "ls" },
      }),
      text({
        type: "tool_execution_update",
        toolCallId: "t1",
        partialResult: { content: [{ type: "text", text: "working…" }] },
      }),
      text({
        type: "tool_execution_end",
        toolCallId: "t1",
        result: { content: [{ type: "text", text: "a b c" }] },
        isError: false,
      }),
    ]).snapshot()

    expect(snapshot.items.filter((item) => item.kind === "tool")).toHaveLength(
      1,
    )
    expect(snapshot.items[0]).toMatchObject({
      state: "ok",
      text: "a b c",
      tool: "bash",
    })
  })

  it("picks up the edit-family diff hunks riding in env.aux", () => {
    const reducer = new TranscriptReducer()
    reducer.apply({
      rpc: {
        type: "tool_execution_start",
        toolCallId: "e1",
        toolName: "edit",
        args: { path: "a.ts", old_string: "x", new_string: "y" },
      },
      aux: { hunks: [{ lines: [{ kind: "add", text: "+hi" }] }] },
    } as never)
    // `blocks` names the card's RESULT face. While the call runs there is no
    // result, so the face is `pending` — and the diff still renders, from the
    // sidecar hunks, which is exactly why the projection lists "hunks" next to
    // it. The old expectation ("diff" while running) was the spike inventing a
    // rule the reference does not have.
    expect(reducer.snapshot().items[0]?.blocks).toEqual(["pending", "hunks"])
    expect(reducer.snapshot().items[0]?.hunks).toHaveLength(1)

    reducer.apply({
      rpc: {
        type: "tool_execution_end",
        toolCallId: "e1",
        result: {
          content: [{ type: "text", text: "Edited a.ts: 1 line added" }],
        },
      },
    } as never)
    expect(reducer.snapshot().items[0]?.blocks).toEqual(["diff", "hunks"])
    expect(reducer.snapshot().items[0]?.text).toBe("Edited a.ts: 1 line added")
  })

  it("marks a failed tool failed", () => {
    const snapshot = fold([
      text({
        type: "tool_execution_start",
        toolCallId: "b1",
        toolName: "bash",
        args: {},
      }),
      text({
        type: "tool_execution_end",
        toolCallId: "b1",
        result: { content: [{ type: "text", text: "boom" }] },
        isError: true,
      }),
    ]).snapshot()
    expect(snapshot.items[0]?.state).toBe("failed")
  })
})

describe("dialogs and notices", () => {
  it("holds an actionable dialog until it is answered", () => {
    const reducer = fold([
      text({
        type: "extension_ui_request",
        id: "a1",
        method: "select",
        title: "pick",
        options: ["x", "y"],
      }),
    ])
    expect(reducer.snapshot().pendingAsks).toHaveLength(1)
    reducer.apply(text({ type: "extension_ui_response", id: "a1", value: "x" }))
    expect(reducer.snapshot().pendingAsks).toHaveLength(0)
  })

  it("surfaces only coded notifies as rows; the rest are toasts", () => {
    // The corpus's reference projection drops the uncoded rate-limit warning in
    // scenarios 001/002/007 from `items`; only a notify with a `code` (the
    // `notice` item's field) is transcript content.
    const snapshot = fold([
      text({
        type: "extension_ui_request",
        id: "n1",
        method: "notify",
        message: "resolved",
        notifyType: "info",
      }),
      text({
        type: "extension_ui_request",
        id: "n2",
        method: "notify",
        message: "rate limit",
        notifyType: "warning",
      }),
      text({
        type: "extension_ui_request",
        id: "n3",
        method: "notify",
        message: "careful",
        code: "policy",
        notifyType: "warning",
      }),
    ]).snapshot()
    expect(snapshot.items).toHaveLength(1)
    expect(snapshot.items[0]).toMatchObject({
      kind: "notice",
      text: "careful",
      code: "policy",
    })
    expect(snapshot.toasts).toHaveLength(2)
  })
})

describe("panels", () => {
  it("folds subagent lifecycle frames from the evt plane", () => {
    const snapshot = fold([
      {
        evt: {
          channel: "subagents:started",
          data: { id: "s1", description: "explore", status: "started" },
        },
      },
      {
        evt: {
          channel: "subagents:completed",
          data: { id: "s1", status: "completed", result: "done" },
        },
      },
    ]).snapshot()
    expect(snapshot.subagents).toHaveLength(1)
    expect(snapshot.subagents[0]).toMatchObject({
      status: "completed",
      result: "done",
    })
  })
})

describe("replay through the same fold", () => {
  it("renders history as the same rows as live", () => {
    const entries = [
      {
        id: "e1",
        parentId: null,
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
      {
        id: "e2",
        parentId: "e1",
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "running ls" },
            {
              type: "toolCall",
              id: "t1",
              name: "bash",
              arguments: { command: "ls" },
            },
          ],
        },
      },
      {
        id: "e3",
        parentId: "e2",
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "t1",
          toolName: "bash",
          content: [{ type: "text", text: "a b c" }],
          isError: false,
        },
      },
    ]

    const reducer = new TranscriptReducer()
    // The beacon is the leaf entry: the tree derives e1 -> e2 -> e3 from the
    // parent links and births a row for each. Without it, entries are indexed
    // and stay invisible.
    reducer.applyEntries(entries, "e3")
    const replayed = reducer.snapshot()
    // Replay rows carry pi's stable entry ids (the corpus's replayStable rule);
    // a tool card is keyed by its toolCall id, exactly as the corpus expects.
    expect(replayed.items.map((item) => item.kind)).toEqual([
      "user",
      "assistant",
      "tool",
    ])
    expect(replayed.items.map((item) => item.row)).toEqual(["e1", "e2", "t1"])
    expect(replayed.items[2]).toMatchObject({ state: "ok", text: "a b c" })
  })

  it("does not infer a running turn from replayed history", () => {
    // An entry whose content contains tool calls reads as "turn in flight" to
    // the live fold. Replay must not leave the app stuck in steer-mode, so the
    // app seeds the flag from pi's get_state instead.
    const reducer = new TranscriptReducer()
    reducer.applyEntries(
      [
        {
          id: "e9",
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "hi" },
              { type: "toolCall", id: "t9", name: "bash" },
            ],
          },
        },
      ],
      "e9",
    )
    // Replaying history does NOT claim a turn is in flight — that was the spike
    // inferring "streaming" from tool calls sitting in a completed entry. The
    // app still seeds the flag from pi's own get_state, which is the only
    // authority on it.
    expect(reducer.snapshot().flags.streaming).toBe(false)
    reducer.setTurnStreaming(true)
    expect(reducer.snapshot().flags.streaming).toBe(true)
    reducer.setTurnStreaming(false)
    expect(reducer.snapshot().flags.streaming).toBe(false)
    expect(reducer.snapshot().items.every((item) => !item.streaming)).toBe(true)
  })

  it("normalizes bare rpc fixtures into envelopes", () => {
    expect(toEnvelope({ type: "turn_start" })).toEqual({
      rpc: { type: "turn_start" },
    })
    expect(toEnvelope({ rpc: { type: "turn_start" } })).toEqual({
      rpc: { type: "turn_start" },
    })
    expect(toEnvelope({ nonsense: true })).toBeNull()
  })
})

describe("history vs the live tail", () => {
  const liveAssistant = (text: string) => [
    { rpc: { type: "message_start" } },
    {
      rpc: {
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: text,
        },
      },
    },
    {
      rpc: {
        type: "message_end",
        message: {
          role: "assistant",
          timestamp: 1000,
          content: [{ type: "text", text }],
        },
      },
    },
  ]

  it("inserts a late entry birth ABOVE the live tail", () => {
    const reducer = new TranscriptReducer()
    for (const frame of liveAssistant("answer I watched stream"))
      reducer.apply(frame)
    expect(reducer.snapshot().items.map((i) => i.row)).toEqual(["assistant#1"])

    // A reconnect folds older history while the live rows are still on screen.
    // Historical rows must land in the log, not float below the newest message.
    reducer.applyEntries(
      [
        {
          id: "e1",
          parentId: null,
          type: "message",
          message: {
            role: "user",
            timestamp: 900,
            content: [{ type: "text", text: "old prompt" }],
          },
        },
        {
          id: "e2",
          parentId: "e1",
          type: "message",
          message: {
            role: "assistant",
            timestamp: 901,
            content: [{ type: "text", text: "old answer" }],
          },
        },
      ],
      "e2",
    )
    expect(reducer.snapshot().items.map((i) => i.row)).toEqual([
      "e1",
      "e2",
      "assistant#1",
    ])
  })

  it("re-keys a live row to its entry id and keeps its position", () => {
    const reducer = new TranscriptReducer()
    for (const frame of liveAssistant("answer I watched streamed"))
      reducer.apply(frame)

    // The post-turn re-read: pi now has an ENTRY for what just streamed. Same
    // content identity, different plane — the match loop renames the row.
    reducer.applyEntries(
      [
        {
          id: "e1",
          parentId: null,
          type: "message",
          message: {
            role: "assistant",
            timestamp: 1000,
            content: [{ type: "text", text: "answer I watched streamed" }],
          },
        },
      ],
      "e1",
    )
    const items = reducer.snapshot().items
    expect(items.map((i) => i.row)).toEqual(["e1"])
    expect(items[0]!.text).toBe("answer I watched streamed")
    expect(items[0]!.replayStable).toBe(true)
  })

  it("a re-keyed row counts as history for the NEXT late birth", () => {
    const reducer = new TranscriptReducer()
    for (const frame of liveAssistant("streamed")) reducer.apply(frame)
    reducer.applyEntries(
      [
        {
          id: "e5",
          parentId: null,
          type: "message",
          message: {
            role: "assistant",
            timestamp: 1000,
            content: [{ type: "text", text: "streamed" }],
          },
        },
      ],
      "e5",
    )
    // A genuinely new live row is now the tail again.
    for (const frame of liveAssistant("brand new")) reducer.apply(frame)
    const before = reducer.snapshot().items.map((i) => i.row)
    expect(before).toEqual(["e5", "assistant#2"])
    // And history arriving later still goes above it.
    reducer.applyEntries(
      [
        {
          id: "e6",
          parentId: "e5",
          type: "message",
          message: {
            role: "assistant",
            timestamp: 1100,
            content: [{ type: "text", text: "backfilled middle" }],
          },
        },
      ],
      "e6",
    )
    // Backfilled ancestry extends the path and is born as HISTORY — above the
    // live row, even though it arrived last on the wire.
    expect(reducer.snapshot().items.map((i) => i.row)).toEqual([
      "e5",
      "e6",
      "assistant#2",
    ])
  })
})

describe("image blocks", () => {
  it("counts them for the projection and keeps the payload for the view", () => {
    const reducer = new TranscriptReducer()
    reducer.applyEntries(
      [
        {
          id: "e1",
          parentId: null,
          type: "message",
          message: {
            role: "assistant",
            timestamp: 10,
            content: [
              { type: "text", text: "screenshot" },
              { type: "image", mimeType: "image/png", data: "AAAA" },
            ],
          },
        },
      ],
      "e1",
    )
    const item = reducer.snapshot().items[0]!
    // `images` is the corpus's COUNT; the bytes are kept separately so the view
    // can actually draw what pi sent inline.
    expect(item.images).toBe(1)
    expect(item.imageParts).toEqual([{ data: "AAAA", mime: "image/png" }])
  })

  it("caps how many a row holds without lying about the count", () => {
    const content = Array.from({ length: 12 }, (_, i) => ({
      type: "image",
      mimeType: "image/png",
      data: `img${i}`,
    }))
    const reducer = new TranscriptReducer()
    reducer.applyEntries(
      [
        {
          id: "e1",
          parentId: null,
          type: "message",
          message: { role: "user", timestamp: 10, content },
        },
      ],
      "e1",
    )
    const item = reducer.snapshot().items[0]!
    expect(item.images).toBe(12)
    expect(item.imageParts).toHaveLength(8)
  })
})

describe("compaction", () => {
  // pi's own compaction entry shape, as it rides `get_entries` (captured in
  // corpus scenario 013; a real one carries a 4 KB summary).
  const entry = (id: string, tokensBefore: number) => ({
    type: "compaction",
    id,
    parentId: null,
    timestamp: "2026-11-16T19:53:04.388Z",
    summary: "the stand-in text that replaces the folded history",
    firstKeptEntryId: "e1",
    tokensBefore,
    fromHook: false,
  })

  it("marks the live plane from `compaction_end`, keeping the token count", () => {
    const reducer = new TranscriptReducer()
    // The extension remaps pi's `session_compact` EVENT into this rpc frame
    // (extension/src/session/rpc_envelope.ts:338). It is the only compaction
    // shape that arrives live, and the marker's whole visible content is the
    // count the caption renders.
    reducer.apply({
      rpc: {
        type: "compaction_end",
        reason: "manual",
        result: { summary: "…", tokensBefore: 213920 },
        aborted: false,
        willRetry: false,
      },
    })
    const item = reducer.snapshot().items.find((i) => i.kind === "compaction")
    expect(item?.row).toBe("compaction#1")
    expect(item?.tokensBefore).toBe(213920)
    expect(item?.replayStable).toBe(false)
  })

  it("pi's EVENT name is not a wire frame: `session_compact` marks nothing", () => {
    // Not a tolerance test — a record of the trap. Folding on the event name
    // (or on pi's subscribe-only `compaction`) silently drops the marker,
    // because the client is only ever sent `compaction_end`.
    const reducer = new TranscriptReducer()
    reducer.apply({
      rpc: { type: "session_compact", compactionEntry: { tokensBefore: 1 } },
    })
    reducer.apply({ rpc: { type: "compaction", tokensBefore: 1 } })
    expect(reducer.snapshot().items.some((i) => i.kind === "compaction")).toBe(
      false,
    )
  })

  it("a replayed entry keys on the entry id, lands in the history, and redelivers once", () => {
    const reducer = new TranscriptReducer()
    // A live row is already on screen (this is what a reconnect looks like).
    reducer.apply({
      rpc: {
        type: "message_end",
        message: {
          role: "assistant",
          timestamp: 2000,
          content: [{ type: "text", text: "watched this stream" }],
        },
      },
    })

    reducer.applyEntries([entry("c1", 900)], "c1")
    const rows = reducer.snapshot().items.map((i) => `${i.kind}@${i.row}`)
    // In the log, not below the newest live row: history keeps its position.
    expect(rows).toEqual(["compaction@c1", "assistant@assistant#1"])

    // Redelivery — a second page carrying the same entry — must not duplicate
    // the caption. Entry-born markers key on the entry id for exactly this.
    reducer.applyEntries([entry("c1", 900)], "c1")
    expect(
      reducer.snapshot().items.filter((i) => i.kind === "compaction"),
    ).toHaveLength(1)
    const marker = reducer
      .snapshot()
      .items.find((i) => i.kind === "compaction")!
    expect(marker.replayStable).toBe(true)
    expect(marker.tokensBefore).toBe(900)
  })
})

describe("a tool result's live shape", () => {
  // Captured from a live room (corpus scenario 015): pi's `tool_execution_end`
  // carries the image in `content` AND repeats the same base64 in
  // `structuredContent`, along with fields the stored record never has.
  const IMAGE =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
  const liveResult = {
    content: [
      { type: "text", text: "Read image file [image/jpeg]" },
      { type: "image", mimeType: "image/jpeg", data: IMAGE },
    ],
    structuredContent: { type: "image", data: IMAGE },
    usage: { input: 0, output: 0 },
    isError: false,
  }

  it("keeps only the canonical {content, details?} on the card", () => {
    const reducer = new TranscriptReducer()
    reducer.apply({
      rpc: {
        type: "tool_execution_start",
        toolCallId: "c1",
        toolName: "read",
        args: { path: "docs/images/01-welcome.png" },
      },
    })
    reducer.apply({
      rpc: {
        type: "tool_execution_end",
        toolCallId: "c1",
        toolName: "read",
        result: liveResult,
        isError: false,
        durationMs: 423,
      },
    })
    const card = reducer.snapshot().items.find((i) => i.kind === "tool")!
    // One image, counted once — not once per copy on the wire.
    expect(card.images).toBe(1)
    expect(card.imageParts).toHaveLength(1)
    expect(card.blocks).toEqual(["file"])
    // The live extras are gone: a card must not hold a field its own replay
    // cannot produce (and must not hold the same 142 KB string twice).
    expect(card.result).toEqual({ content: liveResult.content })
  })

  it("live then replay leaves one card with one image", () => {
    const reducer = new TranscriptReducer()
    reducer.apply({
      rpc: {
        type: "tool_execution_start",
        toolCallId: "c1",
        toolName: "read",
        args: { path: "x.png" },
      },
    })
    reducer.apply({
      rpc: {
        type: "tool_execution_end",
        toolCallId: "c1",
        toolName: "read",
        result: liveResult,
        isError: false,
      },
    })
    reducer.apply({
      rpc: {
        type: "message_end",
        message: {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "read",
          timestamp: 10,
          content: liveResult.content,
        },
      },
    })
    const cards = reducer.snapshot().items.filter((i) => i.kind === "tool")
    expect(cards).toHaveLength(1)
    expect(cards[0]!.images).toBe(1)
    expect(cards[0]!.state).toBe("ok")
  })
})
