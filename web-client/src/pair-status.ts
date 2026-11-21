import type { PairVerdict } from "./session-client.js"

/**
 * The one line the drawer shows about a pairing attempt.
 *
 * The pair flow used to report itself in exactly two places: the header
 * subtitle, and the bottom-centred toast. Both are covered by the drawer you
 * have to hold open to press `pair` — a modal `<dialog>` and its `::backdrop`
 * live in the top layer, where no `z-index` on a page element can beat them,
 * and at phone width the sheet is `min(80vw, 360px)` while the toast sits dead
 * centre (measured on an iPhone 15 viewport: 100% of the toast area behind the
 * sheet). So the verdict was rendered and never seen, and a working button
 * looked broken. The text therefore has to be painted inside the sheet, which
 * makes its wording the whole feature — so it lives here, apart from the DOM,
 * where the case users actually hit can be tested.
 *
 * The case users hit: the browser is ALREADY paired with that machine. The
 * machine ACKs a known owner without consuming a token
 * (`extension/src/session/relay_lifecycle.ts:1052`), so the re-pair succeeds
 * and stores what was already stored — no list changes, no new card. Only the
 * wording can tell the user that the silence meant "yes".
 */

/** The MACHINE's name, not the session the code happened to be printed from. */
function machineLabel(verdict: Extract<PairVerdict, { ok: true }>): string {
  return verdict.hostname ?? verdict.sessionName ?? "the machine"
}

/**
 * One honest sentence about a finished attempt, and what to do next.
 *
 * `alreadyPaired` comes from this browser's own peer records, decided before
 * the round trip: it is what distinguishes "you are now paired" from "you were
 * already paired and nothing changed", and it is knowable without asking.
 */
export function pairResultMessage(
  verdict: PairVerdict,
  alreadyPaired: boolean,
): string {
  if (verdict.ok) {
    const machine = machineLabel(verdict)
    return alreadyPaired
      ? `${machine} is already paired with this browser — re-confirmed. Pick a session below.`
      : `paired with ${machine}. Pick a session below.`
  }
  const detail =
    verdict.detail.trim() || "the machine refused without saying why"
  if (!alreadyPaired) return detail
  // The token only bootstraps trust for a NEW device, so a refusal for a device
  // that is already in the machine's allow-list means this CODE failed, not the
  // pairing. Sending that user back to `/unbien pair` for a code they never
  // needed is the trap this sentence exists to avoid.
  return (
    `${detail}. This browser is already paired with that machine, so pick a ` +
    "session below — a fresh code is only needed for a device that has never paired."
  )
}
