import { canonicalizeEd25519PublicKey } from "@geohar/un-bien/client"

/**
 * A parsed `unbien://pair?t=…&epk=…&n=…&rm=…` invite, as printed by
 * `/unbien pair` (QR, and the "camera-less devices" copy-paste code —
 * extension/src/commands/pairing.ts).
 *
 * This mirrors `unbien-cli/src/invite.ts`. Both clients restate it because the
 * core does not export it; when a second real client exists, the right fix is to
 * move it into `@geohar/un-bien/client` rather than let a third copy appear.
 */
export interface PairingInvite {
  /** Single-use pairing token — opaque, echoed verbatim in `pair_request`. */
  token: string
  /** Destination pi's Ed25519 public key; the outer envelope's routing `peer`. */
  epk: string
  sessionName?: string
  roomId: string
}

export function parseInvite(raw: string): PairingInvite {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error(`not a pairing URI: ${raw}`)
  }
  if (url.protocol !== "unbien:" || url.host !== "pair") {
    throw new Error(`not a pairing URI: ${raw}`)
  }
  const token = url.searchParams.get("t")
  const epk = url.searchParams.get("epk")
  if (!token) throw new Error("pairing URI has no token (t)")
  if (!epk) throw new Error("pairing URI has no peer key (epk)")

  let key: string
  try {
    // The QR carries base64url; the relay routes by standard padded base64.
    // Skipping this makes every (peer, room) lookup miss — the self-revocation
    // class of bug from DESIGN.md §10.1.
    key = canonicalizeEd25519PublicKey(epk) ?? epk
  } catch (err) {
    // The core throws on a wrong-length key. Say it in terms of what the user
    // is holding: a half-copied pairing code off a phone screen.
    throw new Error(
      `pairing URI carries an unusable machine key (epk): ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  return {
    token,
    epk: key,
    sessionName: url.searchParams.get("n") ?? undefined,
    roomId: url.searchParams.get("rm") ?? "main",
  }
}
