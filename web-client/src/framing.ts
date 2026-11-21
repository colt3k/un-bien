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

/** The port `unbien-relay` listens on unless told otherwise (`:3000` in the
 *  README and the launcher's default). */
export const RELAY_PORT = 3000

/**
 * The relay URL to DEFAULT to, from the page the client was opened on.
 *
 * A phone on the tailnet opens `http://<host>:5173` and needs the relay on the
 * SAME host at `:3000` almost every time — the two are started by the same
 * `start.sh`. Guessing that beats an empty box: the user sees the URL that is
 * about to be used instead of retyping the host off the address bar.
 *
 * Only the port changes. The scheme is kept deliberately: an `https` page
 * cannot open an insecure `ws://` socket at all (mixed content), so defaulting
 * such a page to `http://host:3000` would produce a connection that is
 * guaranteed to fail with a browser error no client code can explain. If the
 * relay really is plain `ws` behind an `https` page, that URL has to be typed.
 *
 * Returns "" for anything that is not an http(s) origin — there is no host to
 * take a relay port from.
 */
export function relayUrlForPage(
  pageUrl: string,
  port: number = RELAY_PORT,
): string {
  let page: URL
  try {
    page = new URL(pageUrl)
  } catch {
    return ""
  }
  if (page.protocol !== "http:" && page.protocol !== "https:") return ""
  if (!page.hostname) return ""
  // `host` keeps the brackets an IPv6 literal needs (`[::1]`), and drops the
  // port, which is the whole point. Path/query/hash are not part of an origin.
  page.port = String(port)
  page.pathname = ""
  page.search = ""
  page.hash = ""
  return page.toString().replace(/\/+$/, "")
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

/**
 * Frames carry a correlation id; pi echoes it back in `response`.
 *
 * `crypto.randomUUID` is a SECURE-CONTEXT API. On the plain-`http` tailnet URL
 * this client is meant to be opened from (`USAGE.md`: open
 * `http://<host>.tail5f1ece.ts.net:5173`), it is `undefined` — measured in
 * Chrome on `http://100.118.102.118:5173`: `isSecureContext false`,
 * `randomUUID undefined`, `getRandomValues` fine.
 *
 * That made this one line the loudest silence in the client. It ran inside the
 * `pairAwaited` Promise constructor, so the TypeError rejected that promise;
 * `pair()` awaited it with no catch, so the async click handler rejected into an
 * unhandled rejection: no toast, no header change, nothing. A phone on the
 * tailnet URL saw a dead pair button, and every `prompt`/`steer`/`abort` was
 * equally dead. `crypto.getRandomValues` is NOT restricted to secure contexts,
 * so the id is built from that when `randomUUID` is missing.
 */
export function correlationId(): string {
  const crypto = globalThis.crypto
  const uuid = crypto?.randomUUID
  if (typeof uuid === "function") return uuid.call(crypto)
  if (typeof crypto?.getRandomValues !== "function") {
    // Say what is missing rather than throwing a bare TypeError from a getter.
    throw new Error(
      "this browser exposes no random source — cannot stamp a request id",
    )
  }
  return uuidFromBytes(crypto.getRandomValues(new Uint8Array(16)))
}

/** 16 random bytes in the v4 layout (version 4, RFC 4122 variant). Split out so
 *  the insecure-context path is testable with fixed bytes. */
export function uuidFromBytes(bytes: Uint8Array): string {
  const withVariant = new Uint8Array(bytes)
  const versionNibble = (withVariant[6] ?? 0) & 0x0f
  const variantNibble = (withVariant[8] ?? 0) & 0x3f
  withVariant[6] = versionNibble | 0x40
  withVariant[8] = variantNibble | 0x80
  const hex = Array.from(withVariant, (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("")
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-")
}
