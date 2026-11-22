import { describe, expect, it } from "vitest"
import {
  pairResultMessage,
  pairSectionBadge,
  pairSectionOpens,
} from "../src/pair-status.js"
import type { PairVerdict } from "../src/session-client.js"

// A real pair_ok shape: `hostname` is the MACHINE, `sessionName` the session
// the code happened to be printed from. They are different things and the line
// must name the machine.
const fresh: PairVerdict = {
  ok: true,
  machine: { type: "pair_ok", room_id: "1iVugrrsyGRP" },
  hostname: "Gils-MBP.localdomain",
  sessionName: "tmpunbien",
  roomId: "1iVugrrsyGRP",
}
const expired: PairVerdict = { ok: false, detail: "pairing token expired" }
const timedOut: PairVerdict = {
  ok: false,
  detail: "timed out — run `/unbien pair` again for a fresh code",
}

describe("pairResultMessage", () => {
  it("names the machine, not the session, for a first pairing", () => {
    expect(pairResultMessage(fresh, false)).toContain("Gils-MBP.localdomain")
    expect(pairResultMessage(fresh, false)).not.toContain("tmpunbien")
  })

  it("says what to do next, because the drawer is where the machine list is", () => {
    expect(pairResultMessage(fresh, false)).toMatch(/session below/)
  })

  it("says 'already paired' when the machine only re-confirmed a known device", () => {
    // The case that looked like a dead button: this browser held the pairing,
    // the machine ACKed without spending the token, and the list did not change.
    const line = pairResultMessage(fresh, true)
    expect(line).toMatch(/already paired/)
    expect(line).toMatch(/re-confirmed/)
    expect(line).toMatch(/Gils-MBP.localdomain/)
  })

  it("keeps the machine's refusal as the first thing said", () => {
    expect(pairResultMessage(expired, false)).toBe("pairing token expired")
  })

  it("does not send an already-paired device off to find another code", () => {
    const line = pairResultMessage(timedOut, true)
    expect(line).toMatch(/already paired with that machine/)
    expect(line).toMatch(/only.*never paired|never paired/)
    // The reason is still there — a swallowed reason is how this became
    // "nothing happens, not even an error".
    expect(line).toMatch(/timed out/)
  })

  it("still says something when the machine sent no reason", () => {
    expect(pairResultMessage({ ok: false, detail: "   " }, false)).not.toBe("")
  })

  it("falls back to the session name, then to a generic noun", () => {
    expect(
      pairResultMessage({ ok: true, machine: {}, sessionName: "test" }, false),
    ).toContain("test")
    expect(pairResultMessage({ ok: true, machine: {} }, false)).toContain(
      "the machine",
    )
  })
})

describe("pairSectionOpens / pairSectionBadge", () => {
  it("stays open and unbadged with nothing paired", () => {
    expect(pairSectionOpens(0)).toBe(true)
    expect(pairSectionBadge(0)).toBeNull()
  })

  it("folds and says so from the first machine on", () => {
    expect(pairSectionOpens(1)).toBe(false)
    expect(pairSectionBadge(1)).toBe("paired")
    expect(pairSectionBadge(3)).toBe("3 paired")
  })

  it("never claims paired for a negative count", () => {
    // Defensive only: `peers.size` cannot go below zero, but the badge is a
    // claim about the user's state and a false one is worse than silence.
    expect(pairSectionBadge(-1)).toBeNull()
    expect(pairSectionOpens(-1)).toBe(false)
  })
})
