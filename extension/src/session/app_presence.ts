/**
 * app_presence.ts — stop streaming to an app that has gone away.
 *
 * An app's PlainPeerChannel stays attached after the app disconnects (phones
 * drop and come back constantly, and a returning app re-attaches on its first
 * frame through the auto-listener's reconnect path), so every frame this pi
 * sends kept going to every app it had ever attached. The relay dropped each
 * one at the missing (peer, room).
 *
 * This watch asks the relay which attached apps are online (`presence_check`,
 * answered on this connection; it keeps no subscription, so sessions sharing
 * this machine's key cannot overwrite each other). An app the relay has
 * reported offline for the whole grace period (minutes, so a brief drop never
 * costs anything) is detached; when it comes back, its first frame re-attaches
 * it and it resyncs as it does after any reconnect.
 *
 * The relay omits a `presence` reply identical to the previous one on this
 * connection, so no reply means unchanged. An offline mark belongs to the
 * channel it was observed for: a channel re-created on reconnect starts clean.
 */

/** How long an app must be reported offline before it is detached. */
export const APP_OFFLINE_GRACE_MS = 5 * 60_000

/** How often attached apps' presence is checked. */
export const APP_PRESENCE_POLL_MS = 60_000

export interface AppPresenceWatchOptions<C> {
  /** The attached apps: relay peer id → its channel. */
  activePeers(): ReadonlyMap<string, C>
  /** Send a control frame on the relay connection. */
  send(line: string): void
  /** Detach an app that has been offline for the grace period. */
  detach(appPeerId: string): void
  graceMs?: number
  pollMs?: number
  now?: () => number
}

export class AppPresenceWatch<C extends object> {
  private readonly offlineSince = new WeakMap<C, number>()
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly graceMs: number
  private readonly pollMs: number
  private readonly now: () => number

  constructor(private readonly opts: AppPresenceWatchOptions<C>) {
    this.graceMs = opts.graceMs ?? APP_OFFLINE_GRACE_MS
    this.pollMs = opts.pollMs ?? APP_PRESENCE_POLL_MS
    this.now = opts.now ?? Date.now
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), this.pollMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** One poll: detach apps offline past the grace period, then ask again. */
  tick(): void {
    const peers = this.opts.activePeers()
    if (peers.size === 0) return
    const now = this.now()
    for (const [peer, channel] of [...peers]) {
      const since = this.offlineSince.get(channel)
      if (since !== undefined && now - since >= this.graceMs) {
        this.offlineSince.delete(channel)
        this.opts.detach(peer)
      }
    }
    const remaining = [...this.opts.activePeers().keys()]
    if (remaining.length === 0) return
    try {
      this.opts.send(
        JSON.stringify({ type: "presence_check", peers: remaining }),
      )
    } catch {
      /* relay going down: the next tick asks again */
    }
  }

  /** Read a relay line; a `presence` reply updates the offline marks. */
  onLine(line: string): void {
    let parsed: { type?: unknown; states?: unknown }
    try {
      parsed = JSON.parse(line) as { type?: unknown; states?: unknown }
    } catch {
      return
    }
    if (parsed?.type !== "presence" || !Array.isArray(parsed.states)) return
    const peers = this.opts.activePeers()
    const now = this.now()
    for (const s of parsed.states as Array<{
      peer?: unknown
      online?: unknown
    }>) {
      if (typeof s?.peer !== "string" || typeof s.online !== "boolean") continue
      const channel = peers.get(s.peer)
      if (!channel) continue
      if (s.online) this.offlineSince.delete(channel)
      else if (!this.offlineSince.has(channel))
        this.offlineSince.set(channel, now)
    }
  }
}
