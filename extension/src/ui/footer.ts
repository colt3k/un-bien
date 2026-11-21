/**
 * Footer renderer for the Pi TUI: three status slots. The terminal title is
 * left to pi (`π - <session> - <folder>`): the relay state it used to carry
 * is already in the relay slot.
 *
 * Slot keys (intentionally namespaced so other extensions don't collide):
 *   - un-bien:session   — current local session + peer count
 *   - un-bien:relay     — relay state (off / on / paired)
 *   - un-bien:peer-active — active mobile device, if paired
 */
export interface FooterContext {
  ui: {
    setStatus(key: string, value: string | undefined): void
  }
}

export interface FooterState {
  session?: string
  peerCount?: number
  relayOn?: boolean
  /** Active device session right now (drives the 📱 slot).
   *  Independent from `hasPairings` — a device may be paired globally
   *  in peers.json without being actively connected to THIS Pi process. */
  devicePaired?: string
  /** At least one device has been paired with this machine before
   *  (peers.json is non-empty). Drives the 🟢/🟡 icon on the relay slot:
   *  🟢 when true (ready — devices can connect), 🟡 when false (first
   *  pairing needed). Pairing is per-machine (global), not per-process. */
  hasPairings?: boolean
}

const K_SESSION = "un-bien:session"
const K_RELAY = "un-bien:relay"
const K_PEER = "un-bien:peer-active"

export function updateFooter(ctx: FooterContext, state: FooterState): void {
  if (state.session) {
    const count = state.peerCount ?? 0
    ctx.ui.setStatus(K_SESSION, `📡 ${state.session} (${count})`)
  } else {
    ctx.ui.setStatus(K_SESSION, undefined)
  }

  if (state.relayOn) {
    ctx.ui.setStatus(
      K_RELAY,
      state.hasPairings ? "🟢 relay" : "🟡 relay waiting for pairing",
    )
  } else {
    ctx.ui.setStatus(K_RELAY, undefined)
  }

  if (state.devicePaired) {
    ctx.ui.setStatus(K_PEER, `📱 ${state.devicePaired}`)
  } else {
    ctx.ui.setStatus(K_PEER, undefined)
  }
}
