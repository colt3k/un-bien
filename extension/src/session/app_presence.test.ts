import { describe, expect, test } from "vitest"
import { AppPresenceWatch } from "./app_presence.js"

type Ch = { id: string }

function setup(grace = 300_000) {
  let now = 1_000_000
  const peers = new Map<string, Ch>([
    ["app-a", { id: "a1" }],
    ["app-b", { id: "b1" }],
  ])
  const sent: string[] = []
  const detached: string[] = []
  const watch = new AppPresenceWatch<Ch>({
    activePeers: () => peers,
    send: (line) => sent.push(line),
    detach: (peer) => {
      detached.push(peer)
      peers.delete(peer)
    },
    graceMs: grace,
    now: () => now,
  })
  const presence = (states: Array<{ peer: string; online: boolean }>) =>
    watch.onLine(JSON.stringify({ type: "presence", states }))
  return {
    watch,
    peers,
    sent,
    detached,
    presence,
    advance: (ms: number) => (now += ms),
  }
}

describe("AppPresenceWatch", () => {
  test("asks the relay about the attached apps", () => {
    const { watch, sent } = setup()
    watch.tick()
    expect(JSON.parse(sent[0]!)).toEqual({
      type: "presence_check",
      peers: ["app-a", "app-b"],
    })
  })

  test("an app offline for the whole grace period is detached; one that came back is not", () => {
    const { watch, detached, presence, advance } = setup()
    presence([
      { peer: "app-a", online: false },
      { peer: "app-b", online: false },
    ])
    advance(120_000)
    presence([{ peer: "app-b", online: true }]) // b reconnected
    advance(180_000) // a: 5 min offline
    watch.tick()
    expect(detached).toEqual(["app-a"])
  })

  test("a brief drop inside the grace period changes nothing", () => {
    const { watch, detached, presence, advance } = setup()
    presence([{ peer: "app-a", online: false }])
    advance(299_000)
    watch.tick()
    expect(detached).toEqual([])
  })

  test("no reply means unchanged: a skipped duplicate reply keeps the offline mark running", () => {
    const { watch, detached, presence, advance } = setup()
    presence([{ peer: "app-a", online: false }])
    advance(100_000)
    watch.tick() // the relay sends no reply (identical to the last)
    advance(200_000)
    watch.tick()
    expect(detached).toEqual(["app-a"])
  })

  test("a channel re-created on reconnect does not inherit the old offline mark", () => {
    const { watch, peers, detached, presence, advance } = setup()
    presence([{ peer: "app-a", online: false }])
    advance(200_000)
    peers.set("app-a", { id: "a2" }) // re-attached through the reconnect path
    advance(200_000)
    watch.tick()
    expect(detached).toEqual([])
  })

  test("ignores other lines and unknown peers, and sends nothing with no apps attached", () => {
    const { watch, peers, sent, detached, advance } = setup()
    watch.onLine("not json")
    watch.onLine(JSON.stringify({ type: "peer_online", peer: "app-a" }))
    watch.onLine(
      JSON.stringify({
        type: "presence",
        states: [{ peer: "stranger", online: false }],
      }),
    )
    advance(1_000_000)
    peers.clear()
    watch.tick()
    expect(sent).toEqual([])
    expect(detached).toEqual([])
  })
})
