/**
 * The entry walk: what happens when the machine refuses a page, or stops
 * answering.
 *
 * This is the code that used to conclude "no history" from a machine that had
 * simply not bound the peer yet. `get_entries` on an unbound session is answered
 * with an ERROR on purpose (extension/src/session/rpc_handlers.ts: a silent
 * empty page would read as "no history"), and on a slow connection the reader's
 * frames reach the machine before its attach finishes — so the first page is
 * refused, the walk stopped, and the client showed a blank transcript under a
 * header saying "synced".
 */
import { describe, expect, it } from "vitest"
import { generateEd25519Keypair } from "@geohar/un-bien/client"
import { SessionClient } from "../src/session-client.js"

type Emitter = { emit: (event: string, payload: unknown) => void }

interface Wire {
  client: SessionClient
  /** Outer frames the client put on the wire. */
  sent: { peer?: string; room?: string; ct?: string }[]
  /** The rpc frame behind the last `ct`, correlation id included. */
  lastRequest: () => { id: string; type: string; since?: string }
  /** How many `get_entries` requests have gone out. */
  requests: () => number
  answer: (rpc: Record<string, unknown>) => void
}

function wire(): Wire {
  const client = new SessionClient(
    "ws://relay.invalid",
    generateEd25519Keypair(),
  )
  const sent: Wire["sent"] = []
  // The relay handle and the event bus are private on purpose; a test double
  // needs both, and casting is cheaper than a seam that only tests use.
  const inside = client as unknown as { relay: unknown; events: Emitter }
  inside.relay = {
    connect: async () => {},
    on: () => {},
    send: (line: string) => {
      sent.push(
        JSON.parse(line) as { peer?: string; room?: string; ct?: string },
      )
    },
  }
  const innerOf = (index: number): Record<string, unknown> => {
    const outer = sent[index]
    if (!outer?.ct) throw new Error(`no frame ${index} on the wire`)
    return JSON.parse(Buffer.from(outer.ct, "base64").toString()) as Record<
      string,
      unknown
    >
  }
  return {
    client,
    sent,
    // The inner frame is the stamped envelope (`{type:"rpc", rpc:{…}}`); the
    // verb and its correlation id live on `rpc`.
    lastRequest: () => {
      const env = innerOf(sent.length - 1) as unknown as {
        rpc?: { id: string; type: string; since?: string }
      }
      if (!env.rpc) throw new Error("no rpc in the last frame")
      return env.rpc
    },
    requests: () =>
      sent.filter(
        (_, i) =>
          (innerOf(i) as unknown as { rpc?: { type?: string } }).rpc?.type ===
          "get_entries",
      ).length,
    answer: (rpc) => inside.events.emit("envelope", { rpc }),
  }
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

const entry = (id: string): Record<string, unknown> => ({
  id,
  type: "message",
  parentId: null,
  timestamp: "2026-11-22T12:00:00.000Z",
  message: { role: "user", content: [{ type: "text", text: `m ${id}` }] },
})

describe("the entry walk", () => {
  it("asks again when the machine refuses, and the walk finishes", async () => {
    const w = wire()
    const walk = w.client.getEntries()

    await wait(10)
    // The race itself: the peer is known to the machine, the session is not
    // bound to it yet.
    w.answer({
      type: "response",
      id: w.lastRequest().id,
      command: "get_entries",
      success: false,
      error: "get_entries unavailable (no session bound)",
    })

    // The retry is on a short backoff, not the request timeout: the answer came
    // fast, so the wait is the only cost.
    await wait(600)
    expect(w.requests()).toBe(2)
    w.answer({
      type: "response",
      id: w.lastRequest().id,
      command: "get_entries",
      success: true,
      data: { entries: [entry("e1")], leafId: "e1" },
    })
    await wait(10)
    w.answer({
      type: "response",
      id: w.lastRequest().id,
      command: "get_entries",
      success: true,
      data: { entries: [], leafId: "e1" },
    })

    const read = await walk
    expect(read.complete).toBe(true)
    expect(read.entries).toHaveLength(1)
    expect(read.pages).toBe(2)
    // A hiccup that was recovered from is not reported as the reason.
    expect(read.error).toBeUndefined()
    expect(read.timedOut).toBeUndefined()
  })

  it("gives up after a few refusals, carrying the machine's own words", async () => {
    const w = wire()
    const walk = w.client.getEntries()
    const seen: string[] = []
    for (let attempt = 0; attempt < 3; attempt++) {
      await wait(10 + attempt * 950)
      const request = w.lastRequest()
      seen.push(request.id)
      w.answer({
        type: "response",
        id: request.id,
        command: "get_entries",
        success: false,
        error: "get_entries unavailable (no session bound)",
      })
    }
    const read = await walk
    expect(read.entries).toEqual([])
    expect(read.complete).toBe(false)
    expect(read.pages).toBe(0)
    // Quoted, not paraphrased: "no session bound" points at a machine that is
    // still coming up, which is a different fix from a link that is too slow.
    expect(read.error).toBe("get_entries unavailable (no session bound)")
    expect(new Set(seen).size).toBeGreaterThan(1)
  })

  it("does not ask a machine that never answered, and says it timed out", async () => {
    const w = wire()
    // A short budget stands in for 15 s of silence.
    const read = await w.client.getEntries(undefined, { timeoutMs: 25 })
    expect(read.entries).toEqual([])
    expect(read.complete).toBe(false)
    expect(read.timedOut).toBe(true)
    // Retrying a silence spends another full timeout for nothing; the honest
    // answer is "the machine did not answer", plus a control to try again.
    expect(w.requests()).toBe(1)
    expect(read.error).toMatch(/timed out/)
  })

  it("reports how far it has got, page by page", async () => {
    const w = wire()
    const progress: [number, number][] = []
    const walk = w.client.getEntries(undefined, {
      onPage: (rows, pages) => progress.push([rows, pages]),
    })
    await wait(10)
    w.answer({
      type: "response",
      id: w.lastRequest().id,
      command: "get_entries",
      success: true,
      data: { entries: [entry("e1"), entry("e2")], leafId: "e2" },
    })
    await wait(10)
    w.answer({
      type: "response",
      id: w.lastRequest().id,
      command: "get_entries",
      success: true,
      data: { entries: [entry("e3")], leafId: "e3" },
    })
    await wait(10)
    w.answer({
      type: "response",
      id: w.lastRequest().id,
      command: "get_entries",
      success: true,
      data: { entries: [], leafId: "e3" },
    })
    const read = await walk
    // A climbing number is what a reader on a slow link needs to see: it is the
    // difference between "still walking" and "nothing is coming".
    expect(progress).toEqual([
      [2, 1],
      [3, 2],
    ])
    expect(read.complete).toBe(true)
    expect(read.leafId).toBe("e3")
  })

  it("pages from a cursor when asked to read on from one", async () => {
    const w = wire()
    const walk = w.client.getEntries("e2")
    await wait(10)
    expect(w.lastRequest().since).toBe("e2")
    w.answer({
      type: "response",
      id: w.lastRequest().id,
      command: "get_entries",
      success: true,
      data: { entries: [], leafId: "e2" },
    })
    const read = await walk
    expect(read.complete).toBe(true)
  })
})
