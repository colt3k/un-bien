/**
 * The image-bearing rpc handoffs — `prompt`/`steer`/`follow_up` with
 * `images`, and which delivery verb each one asks pi for.
 *
 * Colocated and harness-free on purpose: the whole question is which verb
 * reaches `wakeAgent`, and that is answerable with a fake port. The full
 * pi-binding harness (received_images.test.ts) covers the TUI preview and the
 * on-disk side; this file guards the delivery semantics, which is where the
 * queue-vs-interrupt bug lived.
 */
import { describe, expect, it, vi } from "vitest"
import { createRpcHandlers, type RpcHandlersDeps } from "./rpc_handlers.js"
import type { PlainPeerChannel } from "../transport/peer_channel.js"
import type { SubmitContent, SubmitDelivery } from "../core/port.js"

/** Valid base64 of "ABC" — decodable, not a real image. The preview side is not
 *  under test here, and a garbage payload keeps this file off the image codec's
 *  conversion path. */
const IMAGE = { data: "QUJD", mime: "image/png" }

type Submitted = { content: SubmitContent; behavior?: SubmitDelivery }

function harness(opts: { streaming?: boolean; turnId?: string | null } = {}) {
  const submitted: Submitted[] = []
  const state = { turnId: opts.turnId ?? null }
  const wakeAgent = vi.fn(
    (
      content: SubmitContent,
      _label: string,
      steeringBehavior?: SubmitDelivery,
    ) => {
      submitted.push({ content, behavior: steeringBehavior })
      return { ok: true } as const
    },
  )
  // Null ports everywhere they are not read: the image path touches only
  // rootState, myRoomMeta and wakeAgent.
  const deps = {
    agent: null,
    session: { streaming: opts.streaming ?? false },
    sessionControl: null,
    rootState: () => state,
    imageDeps: {
      // Null session: the TUI preview is display-side and best-effort, and this
      // file is about the handoff, not the terminal.
      session: null,
      rootState: () => state,
      myRoomMeta: null,
      wakeAgent,
    },
    wakeAgent,
    abortCurrentTurn: () => true,
  } as unknown as RpcHandlersDeps
  const sender = { send: vi.fn() } as unknown as PlainPeerChannel
  return { handlers: createRpcHandlers(deps, sender), submitted, state, sender }
}

function imageBlocks(content: SubmitContent): unknown[] {
  return Array.isArray(content) ? content : []
}

describe("prompt with images", () => {
  it("QUEUES when the client asked for followUp — it must not interrupt", async () => {
    // The bug this guards: the image path hardcoded deliverAs "steer", so a
    // photo queued with `streamingBehavior:"followUp"` cut into the running
    // turn instead of waiting for it. The text path honoured the verb; the
    // image path now matches it.
    const h = harness({ streaming: true })
    await h.handlers.prompt("look at this", {
      id: "m1",
      images: [IMAGE],
      streamingBehavior: "followUp",
    })
    expect(h.submitted).toHaveLength(1)
    expect(h.submitted[0]?.behavior).toBe("followUp")
  })

  it("STEERS when the client asked for steer", async () => {
    const h = harness({ streaming: true })
    await h.handlers.prompt("look at this", {
      id: "m1",
      images: [IMAGE],
      streamingBehavior: "steer",
    })
    expect(h.submitted[0]?.behavior).toBe("steer")
  })

  it("steers a busy room even when no verb was sent (old client)", async () => {
    // Mechanical safety net, not semantic inference: pi throws if a prompt
    // arrives mid-stream with no verb, so a racing or older client's send
    // defends itself by steering rather than being dropped.
    const h = harness({ streaming: true })
    await h.handlers.prompt("look at this", { id: "m1", images: [IMAGE] })
    expect(h.submitted[0]?.behavior).toBe("steer")
  })

  it("hands off with no verb when the session is idle", async () => {
    const h = harness({ streaming: false })
    await h.handlers.prompt("look at this", { id: "m1", images: [IMAGE] })
    expect(h.submitted[0]?.behavior).toBeUndefined()
  })

  it("submits the image as a content block, with the text alongside it", async () => {
    const h = harness({ streaming: false })
    await h.handlers.prompt("what is wrong here?", {
      id: "m1",
      images: [IMAGE],
    })
    const blocks = imageBlocks(h.submitted[0]?.content)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual({
      type: "image",
      data: "QUJD",
      mimeType: "image/png",
    })
    expect(blocks[1]).toEqual({ type: "text", text: "what is wrong here?" })
  })

  it("leaves a text-only prompt exactly as it was: a bare string", async () => {
    const h = harness({ streaming: false })
    await h.handlers.prompt("no attachment here", { id: "m1" })
    expect(h.submitted[0]?.content).toBe("no attachment here")
  })
})

describe("steer and follow_up with images", () => {
  it("carries the images instead of dropping them", async () => {
    // The dispatcher forwards `frame.images` to these verbs. Ignoring them was
    // a silent loss: the sender got `success:true` and the photo never arrived.
    const h = harness({ streaming: true })
    await h.handlers.steer("and this one", { images: [IMAGE], id: "s1" })
    const blocks = imageBlocks(h.submitted[0]?.content)
    expect(blocks[0]).toMatchObject({ type: "image", mimeType: "image/png" })
    expect(h.submitted[0]?.behavior).toBe("steer")
  })

  it("queues a follow-up image behind the turn", async () => {
    const h = harness({ streaming: true })
    await h.handlers.followUp("after you finish", { images: [IMAGE], id: "f1" })
    expect(h.submitted[0]?.behavior).toBe("followUp")
  })

  it("does not seed the turn id for a follow-up — the turn is pi's", async () => {
    const h = harness({ streaming: true, turnId: "turn-7" })
    await h.handlers.followUp("after you finish", { images: [IMAGE], id: "f1" })
    expect(h.state.turnId).toBe("turn-7")
  })

  it("still takes the plain text path when there are no images", async () => {
    const h = harness({ streaming: true })
    await h.handlers.steer("plain steer", {})
    expect(h.submitted[0]?.content).toBe("plain steer")
    expect(h.submitted[0]?.behavior).toBe("steer")
  })
})

describe("a refused handoff", () => {
  it("answers the sender with an error frame naming the reason", async () => {
    // The message is already off the wire by then, so the only way the app
    // learns its photo was dropped is this frame.
    const state = { turnId: "turn-1" }
    const wakeAgent = vi.fn(() => ({ ok: false, detail: "busy" }) as const)
    const deps = {
      agent: null,
      session: { streaming: true },
      sessionControl: null,
      rootState: () => state,
      imageDeps: {
        session: null,
        rootState: () => state,
        myRoomMeta: null,
        wakeAgent,
      },
      wakeAgent,
      abortCurrentTurn: () => true,
    } as unknown as RpcHandlersDeps
    const sender = { send: vi.fn() } as unknown as PlainPeerChannel
    await createRpcHandlers(deps, sender).prompt("photo", {
      id: "m9",
      images: [IMAGE],
      streamingBehavior: "steer",
    })
    const frame = vi.mocked(sender.send).mock.calls[0]?.[0] as unknown as {
      type?: string
      in_reply_to?: string
      message?: string
    }
    expect(frame.type).toBe("error")
    expect(frame.in_reply_to).toBe("m9")
    expect(frame.message).toContain("busy")
  })
})
