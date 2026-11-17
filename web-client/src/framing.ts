import {
  EVT_KIND,
  RPC_KIND,
  UB_KIND,
  type EnvelopeMessage,
} from "@geohar/un-bien/client"

/**
 * The framing layer, kept separate from the socket so it can be unit-tested
 * without a relay. Both ends of un-bien speak this:
 *
 *   outer (what the relay routes):   { peer, room, ct }
 *   ct = base64(JSON(inner)), opaque to the relay
 *   inner: a stock frame (only `pair_request` before attach), or an envelope
 *          { type: "rpc" | "evt" | "ub", rpc | evt | ub, ts }
 *
 * The plane `type` is not decoration: the extension's pre-attach listener drops
 * any frame whose top-level `type` is not a string, so an unstamped envelope
 * routes, arrives, and silently vanishes.
 */
export interface OuterEnvelope {
  peer: string
  room?: string
  ct: string
}

export type Inbound =
  /** A relay control frame (rooms / presence / errors) — has no `ct`. */
  | { kind: "control"; frame: Record<string, unknown> }
  /** An envelope frame from the pi (rpc spine, evt panels, ub un-bien plane). */
  | { kind: "envelope"; frame: EnvelopeMessage }
  /** A stock (non-envelope) inner frame — in practice pair_ok / pair_error. */
  | { kind: "stock"; frame: Record<string, unknown> }

/** Config stores relay URLs as http(s); the socket needs ws(s). */
export function toWsUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "")
  if (trimmed.startsWith("http://")) return `ws://${trimmed.slice(7)}`
  if (trimmed.startsWith("https://")) return `wss://${trimmed.slice(8)}`
  return trimmed
}

/** Stamp the envelope's REAL plane kind plus a timestamp (see header note). */
export function stampEnvelope(env: EnvelopeMessage): Record<string, unknown> {
  const kind =
    env.rpc !== undefined
      ? RPC_KIND
      : env.evt !== undefined
        ? EVT_KIND
        : UB_KIND
  return { type: kind, ...env, ts: Date.now() }
}

/** The single outbound choke: inner frame → relay line. */
export function encodeOuter(
  inner: unknown,
  peer: string,
  room: string,
): string {
  const outer: OuterEnvelope = {
    peer,
    room,
    ct: Buffer.from(JSON.stringify(inner)).toString("base64"),
  }
  return JSON.stringify(outer)
}

/** One relay line → what it is. Unparseable lines are reported as control
 *  frames with a `_raw` field rather than swallowed, so a protocol mismatch is
 *  visible in the UI instead of looking like silence. */
export function decodeInbound(line: string): Inbound {
  let frame: Record<string, unknown>
  try {
    frame = JSON.parse(line) as Record<string, unknown>
  } catch {
    return {
      kind: "control",
      frame: { type: "_unparseable", _raw: line.slice(0, 200) },
    }
  }

  const ct = frame.ct
  if (typeof ct !== "string") return { kind: "control", frame }

  let inner: unknown
  try {
    inner = JSON.parse(Buffer.from(ct, "base64").toString("utf8"))
  } catch {
    return {
      kind: "control",
      frame: { type: "_undecodable_ct", _raw: ct.slice(0, 200) },
    }
  }

  const record = (inner ?? {}) as Record<string, unknown>
  if ("rpc" in record || "evt" in record || "ub" in record) {
    return { kind: "envelope", frame: record as EnvelopeMessage }
  }
  return { kind: "stock", frame: record }
}

/** Frames carry a correlation id; pi echoes it back in `response`. */
export function correlationId(): string {
  return globalThis.crypto.randomUUID()
}
