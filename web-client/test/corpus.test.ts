import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { TranscriptReducer, toEnvelope } from "../src/reducer.js"

/**
 * Corpus-driven check against `contracts/conformance/` — the fixtures BOTH the
 * Swift `SessionState` and the extension's TS runner assert against.
 *
 * WHAT THIS ASSERTS: each live-mode scenario's recorded frames are folded
 * without throwing, and the resulting sequence of (kind, row) items matches the
 * normalized `expected.json`. Rows are compared on purpose: `row` is where pi's
 * entry identity shows up, so a fold that invents or loses rows fails here.
 *
 * ALL TEN SCENARIOS RUN. They did not always: four were skipped for two missing
 * subsystems — row identity across live and replay, and entry-tree derivation
 * with its membership gate. Both are ported now (src/derive.ts,
 * src/content-identity.ts, and the match loop in the reducer). SKIP_REASONS
 * below is the mechanism for skipping one honestly; it is deliberately empty.
 *
 * STILL NOT COMPARED — do not read 10/10 as conformance:
 *   - ORDER is compared (see `projections`), but `blocks`, `flags`,
 *     `pendingAsks`, `leafId` and the panel projections are NOT.
 *   - `replay` mode: every scenario declares `modes: ["live"]` except none —
 *     the corpus has no recorded paging fixture, so the paging contract is
 *     only covered by test/derive.test.ts, not here.
 *   - 003/006/008 expect NO items, so for them this asserts "produces no
 *     spurious rows", which is weaker than it looks.
 */
const SCENARIO_DIR = join(
  __dirname,
  "..",
  "..",
  "contracts",
  "conformance",
  "scenarios",
)

/** Scenario → why it is out of this fold's reach, so a skip stays auditable.
 *  Keep this empty: an unexplained skip is how a client drifts. */
const SKIP_REASONS: Record<string, string> = {}

interface ScenarioMeta {
  modes?: string[]
}

interface Expected {
  version: number
  items: { kind: string; row: string }[]
}

/** `kind@row`, in RENDER ORDER. The vocab says items are in render order, so
 *  sorting here would hide a fold that births the rootward ancestry below the
 *  rows it should precede. */
function projections(items: { kind: string; row: string }[]): string[] {
  return items.map((item) => `${item.kind}@${item.row}`)
}

describe("conformance corpus (kind + row)", () => {
  const scenarios = readdirSync(SCENARIO_DIR).sort()
  expect(scenarios.length).toBeGreaterThanOrEqual(10)

  for (const name of scenarios) {
    const dir = join(SCENARIO_DIR, name)
    const meta = JSON.parse(
      readFileSync(join(dir, "meta.json"), "utf8"),
    ) as ScenarioMeta
    const expected = JSON.parse(
      readFileSync(join(dir, "expected.json"), "utf8"),
    ) as Expected
    const lines = readFileSync(join(dir, "input.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)

    const skipReason = SKIP_REASONS[name]
      ? SKIP_REASONS[name]
      : meta.modes?.includes("live")
        ? undefined
        : "replay-mode paging is not exercised by this client's fold test"

    const run = skipReason ? it.skip : it
    run(
      `${name}${skipReason ? ` — SKIP: ${skipReason}` : ": matches expected (kind,row)"}`,
      () => {
        const reducer = new TranscriptReducer()
        let unrecognised = 0
        for (const line of lines) {
          const env = toEnvelope(JSON.parse(line))
          if (env) reducer.apply(env)
          else unrecognised += 1
        }
        // A frame this client cannot even shape is worth knowing about — it
        // means the corpus grew a plane this fold has not read.
        expect(unrecognised).toBe(0)
        expect(projections(reducer.snapshot().items)).toEqual(
          projections(expected.items),
        )
      },
    )
  }
})
