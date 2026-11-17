import { afterEach, describe, expect, test } from "vitest"
import { createServer, type Server, type Socket } from "node:net"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { SessionPeer } from "./peer.js"
import { ipcAddress } from "./ipc.js"

function tmpSock(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-reg-"))
  return ipcAddress(`reg-${basename(dir)}`, join(dir, "broker.sock"))
}

/** A broker that answers the election probe's two requests with two
 *  SEPARATE writes (the pong first, the list_peers reply a beat later), then
 *  the register_ack: the timing that made a follower read the list_peers
 *  reply as its first line and fail its join. */
function splitReplyBroker(sockPath: string): Promise<{ server: Server; conns: Socket[] }> {
  const conns: Socket[] = []
  const server = createServer((conn) => {
    conns.push(conn)
    conn.setEncoding("utf8")
    let buf = ""
    let probeReplySent: Promise<void> = Promise.resolve()
    conn.on("data", (chunk: string) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        const msg = JSON.parse(line) as { type?: string; name?: string; cwd?: string }
        const reply = (body: unknown) =>
          conn.write(JSON.stringify({ from: "broker", to: "observer", id: "x", re: null, body }) + "\n")
        if (msg.type === "broker_ping") reply({ type: "broker_pong" })
        else if (msg.type === "list_peers") {
          probeReplySent = new Promise((resolve) =>
            setTimeout(() => {
              reply({ type: "list_peers_reply", peers: ["/a@other"], peers_detailed: [] })
              resolve()
            }, 30),
          )
        } else if (msg.type === "register") {
          const name = msg.name ?? "?"
          void probeReplySent.then(() =>
            conn.write(
              JSON.stringify({
                type: "register_ack",
                name_assigned: name,
                address_assigned: `${msg.cwd ?? ""}@${name}`,
              }) + "\n",
            ),
          )
        }
      }
    })
  })
  return new Promise((resolve) => server.listen(sockPath, () => resolve({ server, conns })))
}

describe("follower register after the election probe", () => {
  let cleanup: (() => Promise<void>) | null = null
  afterEach(async () => {
    await cleanup?.()
    cleanup = null
  })

  test("a probe reply arriving before the register_ack does not fail the join", async () => {
    const sockPath = tmpSock()
    const { server, conns } = await splitReplyBroker(sockPath)
    const peer = new SessionPeer({ sockPath, name: "agent", cwd: "/work/repo", defaultTimeoutMs: 3000 })
    cleanup = async () => {
      await peer.leave().catch(() => undefined)
      for (const c of conns) c.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    await expect(peer.start()).resolves.toBe("agent")
    expect(peer.address()).toBe("/work/repo@agent")
  })
})
