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
 * WHAT THIS CLIENT DOES NOT IMPLEMENT YET — the four skipped scenarios are not
 * incidental bugs, they are two named subsystems this fold does not have:
 *
 *   1. Row identity across live and replay. The reference (pi's
 *      RowBoundsStore) derives row identity from pi's ENTRY ids, parent links
 *      and content hashes, so a block seen live and again in a `get_entries`
 *      page is ONE row. This fold keys live rows `<kind>#<seq>` and replay rows
 *      by entry id, so redelivery would duplicate them.
 *      → 001-message-turn, 007-redelivery-dedup
 *   2. Entry-tree derivation and the membership gate. Rows only exist for
 *      blocks on the derived path from pi's leaf; a block that was abandoned
 *      (branch switched, path truncated) is retained data with NO row. This
 *      fold is linear — it renders every entry it is given.
 *      → 002-subagent-run, 009-derive-path-truncation
 *
 * Also not compared anywhere: `blocks`, `flags`, `pendingAsks`, `leafId`, the
 * panel projections, and the replay-mode paging contract. 003/006/008 pass at
 * (kind, row) level, which for scenarios whose expected items are empty means
 * "produces no spurious rows" — weaker than it looks.
 */
const SCENARIO_DIR = join(
  __dirname,
  "..",
  "..",
  "contracts",
  "conformance",
  "scenarios",
)

/** Scenario → why it is out of this fold's reach, so the skip is auditable. */
const SKIP_REASONS: Record<string, string> = {
  "001-message-turn": "needs entry-content row identity (redelivery dedup)",
  "002-subagent-run":
    "needs derived-path membership gate + entry-content row identity",
  "007-redelivery-dedup": "needs entry-content row identity (redelivery dedup)",
  "009-derive-path-truncation": "needs derived-path membership gate + paging",
}

interface ScenarioMeta {
  modes?: string[]
}

interface Expected {
  version: number
  items: { kind: string; row: string }[]
}

function projections(items: { kind: string; row: string }[]): string[] {
  return items.map((item) => `${item.kind}@${item.row}`).sort()
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
