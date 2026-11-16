/**
 * federated_send.ts — delivery acknowledgements and broadcast addressing for
 * mesh messages sent to sessions on federated machines (via the relay's
 * `pi_envelope` / `pi_envelope_in` frames).
 *
 * The relay forwards a federated envelope verbatim and reports only failures
 * (`transport_error`: not_authorized, unknown_peer). Reaching the target
 * MACHINE says nothing about a session there accepting it: a stale name, or a
 * session that has gone, drops silently. So a sender asks for an ack
 * (`ack: true` in the envelope), and the receiving extension sends one as soon
 * as it accepts the message into its inbox, before its agent sees it. The ack
 * means "arrived and will be delivered", never "read": neither side waits on
 * the other's agent.
 *
 * Compatibility: a receiver that predates acks ignores the flag, so the send
 * settles as unconfirmed (not failed). A sender that predates acks never sets
 * it, so it is never sent an ack it would show its agent as a message.
 *
 * Broadcast: plain `broadcast` stays on this machine's broker. A federated
 * broadcast is explicit: `<relay>:broadcast` reaches every session on that
 * machine, `*:broadcast` every federated machine. Broadcasts are not acked.
 */
import type { AckResult } from "./peer.js"
import { asTransportErrorBody } from "./envelope.js"

/** The all-federated-machines broadcast address. */
export const FEDERATED_BROADCAST_ALL = "*:broadcast"

/** The broadcast address for one federated machine, by its relay label. */
export function federatedBroadcastAddress(relayName: string): string {
  return `${relayName}:broadcast`
}

/** Whether `to` is a federated broadcast address (`*:broadcast` or
 *  `<relay>:broadcast`). A session address always has `<cwd>@<name>` after
 *  the label, so it never has this form. */
export function isFederatedBroadcast(to: string): boolean {
  return to === FEDERATED_BROADCAST_ALL || /^[^:/@\s]+:broadcast$/.test(to)
}

/** Where a federated send goes, from the relay's peer detail
 *  (epk → relay label + room addresses). */
export type FederatedTarget =
  | { kind: "unicast"; epk: string; relayName: string }
  | { kind: "broadcast"; epks: string[]; relayNames: string[] }
  | { kind: "unknown_relay"; relayName: string }

export function resolveFederatedTarget(
  to: string,
  detail: ReadonlyMap<string, { relayName: string; addresses: string[] }>,
): FederatedTarget | null {
  if (isFederatedBroadcast(to)) {
    const label = to.slice(0, to.length - ":broadcast".length)
    const hits = [...detail].filter(([, info]) => label === "*" || info.relayName === label)
    if (hits.length === 0) return label === "*" ? { kind: "broadcast", epks: [], relayNames: [] } : { kind: "unknown_relay", relayName: label }
    return {
      kind: "broadcast",
      epks: hits.map(([epk]) => epk),
      relayNames: hits.map(([, info]) => info.relayName),
    }
  }
  for (const [epk, info] of detail) {
    if (info.addresses.includes(to)) return { kind: "unicast", epk, relayName: info.relayName }
  }
  return null
}

/** An inbound federated envelope, as `pi_envelope_in` carries it. */
export interface FederatedEnvelope {
  id?: string
  from?: string
  to?: string
  re?: string | null
  body?: unknown
  /** Set by a sender that wants a delivery ack. */
  ack?: boolean
}

/** Whether an envelope is a delivery ack (never an agent message). */
export function isAckEnvelope(env: FederatedEnvelope): boolean {
  const body = env.body as { type?: unknown } | null | undefined
  return Boolean(body) && typeof body === "object" && body?.type === "ack"
}

/** The ack a receiver sends back for an accepted envelope. */
export function ackEnvelopeFor(
  env: FederatedEnvelope & { id: string; from: string; to: string },
  fromAddress: string,
  id: string,
): Required<Omit<FederatedEnvelope, "ack">> {
  return {
    id,
    from: fromAddress,
    to: env.from,
    re: env.id,
    body: { type: "ack", status: "received", target: env.to },
  }
}

/** Pending federated sends awaiting an ack, plus the acks this agent sent. */
export class FederatedAcks {
  private readonly pending = new Map<
    string,
    { resolve: (r: AckResult) => void; timer: ReturnType<typeof setTimeout> }
  >()
  /** Ids of acks this agent sent, so the relay's error for one that could
   *  not be returned is not shown to the agent as a message. Bounded. */
  private readonly sentAcks: string[] = []
  private readonly sentAckCap: number

  constructor(sentAckCap = 500) {
    this.sentAckCap = sentAckCap
  }

  /** Wait for the ack (or the relay's refusal) of the send with this id.
   *  Settles `timeout` when neither arrives in time: unconfirmed, not
   *  failed (see the module comment). */
  wait(id: string, timeoutMs: number): Promise<AckResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ status: "timeout", id })
      }, timeoutMs)
      this.pending.set(id, { resolve, timer })
    })
  }

  /** Settle a pending send from an inbound envelope: an ack, or the relay's
   *  transport_error, whose `re` names it. True when it was consumed. */
  settle(env: FederatedEnvelope): boolean {
    const slot = env.re ? this.pending.get(env.re) : undefined
    if (!slot || !env.re) return false
    const err = asTransportErrorBody(env.body)
    if (!err && !isAckEnvelope(env)) return false // a reply, not an ack
    clearTimeout(slot.timer)
    this.pending.delete(env.re)
    if (err) {
      slot.resolve({
        status: err.reason === "unknown_peer" ? "unknown_peer" : err.reason === "offline" ? "timeout" : "denied",
        id: env.re,
        error: `transport_error: ${err.reason}`,
        reason: err.reason,
      })
    } else {
      const target = (env.body as { target?: unknown }).target
      slot.resolve({ status: "received", id: env.re, ...(typeof target === "string" ? { target } : {}) })
    }
    return true
  }

  /** Record an ack this agent sent. */
  noteAckSent(id: string): void {
    this.sentAcks.push(id)
    if (this.sentAcks.length > this.sentAckCap) this.sentAcks.shift()
  }

  /** Whether an envelope is the relay's error for an ack this agent sent. */
  isErrorForOwnAck(env: FederatedEnvelope): boolean {
    return Boolean(env.re) && asTransportErrorBody(env.body) !== null && this.sentAcks.includes(env.re as string)
  }

  /** Drop every pending wait (teardown); each settles as a timeout. */
  clear(): void {
    for (const [id, slot] of this.pending) {
      clearTimeout(slot.timer)
      slot.resolve({ status: "timeout", id })
    }
    this.pending.clear()
    this.sentAcks.length = 0
  }
}
