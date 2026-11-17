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
  it("coalesces text deltas into one row, then takes message_end as authoritative", () => {
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
    expect(snapshot.items[0]).toMatchObject({
      kind: "assistant",
      text: "hello there",
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

  it("marks the turn settled so no row stays streaming", () => {
    const snapshot = fold([
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
    ]).snapshot()
    expect(snapshot.flags.streaming).toBe(false)
    expect(snapshot.flags.ended).toBe(true)
    expect(snapshot.items.every((item) => !item.streaming)).toBe(true)
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
    const snapshot = fold([
      {
        rpc: {
          type: "tool_execution_start",
          toolCallId: "e1",
          toolName: "edit",
          args: {},
        },
        aux: { hunks: [{ lines: [{ kind: "add", text: "+hi" }] }] },
      },
    ]).snapshot()
    expect(snapshot.items[0]?.blocks).toEqual(["diff", "hunks"])
    expect(snapshot.items[0]?.hunks).toHaveLength(1)
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
