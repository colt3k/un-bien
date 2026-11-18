import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { TranscriptReducer, toEnvelope } from "../src/reducer.js"
import type { TranscriptItem } from "../src/reducer.js"

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
 *   - No scenario's expected item declares `images` non-zero, so image counting
 *     is only weakly covered here.
 *   - The face FIELDS beyond their name (a terminal face's notices, a diff's
 *     hunks, a script's calls) — `blocks` names the face; the corpus does not
 *     project what is inside it, so `test/tool-faces.test.ts` carries that.
 *   - Mode INDEPENDENCE per session: 019 is a replay-mode fixture (durable
 *     `get_entries` pages of a real session) and runs here like any other, but
 *     no scenario yet feeds the SAME session through both planes, so "the live
 *     fold and the replay fold agree on one history" is still not asserted —
 *     only that each matches its own golden. Paging edges beyond 019's remain
 *     covered by test/derive.test.ts.
 *   - 003/006/008 expect NO items, so for them this asserts "produces no
 *     spurious rows", which is weaker than it looks.
 *
 * Everything else the reference projects — `text` (prefix, because the corpus
 * scrubs long strings and escapes their newlines), `streaming`, `images`,
 * `state`, `tool`, `flags`, `leafId`, `subagents`, `pendingAsks`, `panels` — is
 * compared,
 * `blocks` is compared against the resolved result face (tool-faces.ts).
 *
 * Widening the comparison is what caught the phantom-dialog bug (8 `setStatus`/`notify` frames
 * folded as 8 blocking asks), the "session ended after every turn" bug
 * (`turn_end` setting `ended`), a subagent panel stuck at "started" (the status
 * is the CHANNEL name, not a payload field), and inferring "a turn is in
 * flight" from a completed tool result.
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

/** The conformance vocabulary this runner implements. The reference projects it
 *  (`ConformanceProjection`) and vocab.md documents it; version 2 added the
 *  live `panels` plane. */
const VOCAB_VERSION = 3

interface ScenarioMeta {
  modes?: string[]
}

interface Expected {
  version: number
  items: Record<string, unknown>[]
  flags?: { streaming: boolean; ended: boolean }
  leafId?: string | null
  subagents?: Record<string, unknown>[]
  pendingAsks?: Record<string, unknown>[]
  plan?: Record<string, unknown> | null
  panels?: Record<string, unknown>[]
}

/** `kind@row`, in RENDER ORDER. The vocab says items are in render order, so
 *  sorting here would hide a fold that births the rootward ancestry below the
 *  rows it should precede. */
function projections(items: { kind?: unknown; row?: unknown }[]): string[] {
  return items.map((item) => `${item.kind}@${item.row}`)
}

/** The corpus scrubs long strings and ends them with an ellipsis, so a scrubbed
 *  expectation is a PREFIX requirement, not an equality one. The reference also
 *  escapes newlines when it scrubs (so `expected.json` stays line-wise
 *  diffable) — a projection that reads the wire literally must undo that escape
 *  before comparing, or every multi-line reply "mismatches" on a formatting
 *  artifact. */
function textMatches(actual: string, expected: string): boolean {
  // The reference's scrub (Conformance.scrub) turns real newlines into a literal
  // `\n` PAIR of characters and truncates long text with `…`. Undo the escaping
  // on the expected side, otherwise every multi-line row fails on a difference
  // the scrub itself introduced.
  const want = expected.replace(/\\n/g, "\n")
  if (!want.endsWith("…")) return actual === want
  return actual.startsWith(want.slice(0, -1))
}

/** Compare a panel item exactly as the projection emits it: pi's own wire
 *  shape, strings scrubbed, STRUCTURE required. The reference deliberately does
 *  not reshape these items, so the comparison must not reshape them either —
 *  that is the whole value of comparing panels: both clients read the machine's
 *  schema rather than a guess at it. */
function panelItemProblems(
  want: Record<string, unknown>,
  got: unknown,
  at: string,
): string[] {
  if (typeof got !== "object" || got === null)
    return [`${at} is ${JSON.stringify(got)}, not an object`]
  const mine = got as Record<string, unknown>
  const problems: string[] = []
  for (const key of Object.keys(want)) {
    const expected = want[key]
    const actual = mine[key]
    if (typeof expected === "string") {
      if (typeof actual !== "string" || !textMatches(actual, expected))
        problems.push(
          `${at}.${key} ${JSON.stringify(actual)} !~ ${JSON.stringify(expected)}`,
        )
    } else if (Array.isArray(expected)) {
      if (!Array.isArray(actual) || actual.length !== expected.length)
        problems.push(
          `${at}.${key} ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
        )
      else
        expected.forEach((entry, i) => {
          if (typeof entry === "string") {
            const value = actual[i]
            if (typeof value !== "string" || !textMatches(value, entry))
              problems.push(
                `${at}.${key}[${i}] ${JSON.stringify(value)} !~ ${JSON.stringify(entry)}`,
              )
          } else if (JSON.stringify(actual[i]) !== JSON.stringify(entry))
            problems.push(
              `${at}.${key}[${i}] ${JSON.stringify(actual[i])} != ${JSON.stringify(entry)}`,
            )
        })
    } else if (expected && typeof expected === "object") {
      problems.push(
        ...panelItemProblems(
          expected as Record<string, unknown>,
          actual,
          `${at}.${key}`,
        ),
      )
    } else if (actual !== expected)
      problems.push(
        `${at}.${key} ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
      )
  }
  return problems
}

/** Compare every field the expected item declares. `blocks` is the one gap:
 *  it is the tool card's RESULT FACE (`ToolFaceResolver.resolve` in the app —
 *  terminal / file / diff / lines / script / markdown / …), which this client
 *  does not resolve yet. Everything else is held to the same bar as (kind,row). */
function itemProblems(
  want: Record<string, unknown>,
  got: TranscriptItem,
): string[] {
  const problems: string[] = []
  for (const key of Object.keys(want)) {
    const expected = want[key]
    switch (key) {
      case "kind":
      case "row":
        break // compared as the sequence
      case "text":
        if (!textMatches(got.text, String(expected ?? "")))
          problems.push(
            `text ${JSON.stringify(got.text.slice(0, 60))} !~ ${JSON.stringify(expected)}`,
          )
        break
      case "streaming":
        if (got.streaming !== Boolean(expected))
          problems.push(`streaming ${got.streaming} != ${Boolean(expected)}`)
        break
      case "images":
        if (got.images !== Number(expected))
          problems.push(`images ${got.images} != ${Number(expected)}`)
        break
      case "state":
        if (got.state !== expected)
          problems.push(`state ${got.state} != ${expected}`)
        break
      case "tool":
        if (got.tool !== expected)
          problems.push(`tool ${got.tool} != ${expected}`)
        break
      case "blocks": {
        // The card's result face, resolved by tool-faces.ts. Compared as a set
        // in declared order — the projection's own shape.
        const wantBlocks = Array.isArray(expected) ? expected : []
        if (JSON.stringify(got.blocks) !== JSON.stringify(wantBlocks))
          problems.push(
            `blocks ${JSON.stringify(got.blocks)} != ${JSON.stringify(wantBlocks)}`,
          )
        break
      }
      case "code":
        // A notice's class — `provider_error`, `custom`, `branch`. The
        // reference projects it (ConformanceProjection.swift:113) because the
        // class decides the styling (info vs warning), so it is a compared
        // field, not a rendering detail.
        if (got.code !== expected)
          problems.push(
            `code ${JSON.stringify(got.code)} != ${JSON.stringify(expected)}`,
          )
        break
      case "customType":
        // What the machine sent (vocabulary v3): `un-bien:pair-code`,
        // `un-bien:mesh-message`. A client that drops it has to pattern-match
        // the display text the producer told it to show instead.
        if (!textMatches(String(got.customType ?? ""), String(expected)))
          problems.push(
            `customType ${JSON.stringify(got.customType)} !~ ${JSON.stringify(expected)}`,
          )
        break
      case "details": {
        // The message's structured payload, compared as structure with
        // scrubbed strings — never reshaped on either side.
        problems.push(
          ...panelItemProblems(
            expected as Record<string, unknown>,
            got.details,
            "details",
          ),
        )
        break
      }
      default:
        problems.push(`expected key this client does not project: ${key}`)
    }
  }
  return problems
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

    // The fold is one loop for both planes: a `get_entries` response page enters
    // through the same `apply` as a live frame and is routed to the entry tree by
    // the fold itself (as in the reference). So a replay-mode scenario needs no
    // separate runner here — and skipping one would hide exactly the entry
    // folding that 019 was added to pin.
    const skipReason = SKIP_REASONS[name]

    const run = skipReason ? it.skip : it
    run(
      `${name}${skipReason ? ` — SKIP: ${skipReason}` : ": matches expected (kind,row + fields, flags, leafId, subagents, asks)"}`,
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
        const got = reducer.snapshot()
        expect(projections(got.items)).toEqual(projections(expected.items))

        const problems: string[] = []
        got.items.forEach((item, index) => {
          const want = expected.items[index] as Record<string, unknown>
          for (const problem of itemProblems(want, item))
            problems.push(`item[${index}] ${item.kind}@${item.row}: ${problem}`)
        })

        // The vocabulary this runner implements (contracts/conformance/vocab.md).
        // A golden from another version is not this test's contract.
        if (expected.version !== VOCAB_VERSION)
          problems.push(
            `vocab version ${expected.version} != this runner's ${VOCAB_VERSION}`,
          )

        // Flags: the fold must not claim a turn is running (or ended) when the
        // reference does not, and vice versa — that flag drives the composer's
        // steer/follow affordance.
        if (expected.flags) {
          if (got.flags.streaming !== expected.flags.streaming)
            problems.push(
              `flags.streaming ${got.flags.streaming} != ${expected.flags.streaming}`,
            )
          if (got.flags.ended !== expected.flags.ended)
            problems.push(
              `flags.ended ${got.flags.ended} != ${expected.flags.ended}`,
            )
        }

        // The leaf beacon: what the client would resume from.
        if ("leafId" in expected && got.leafId !== (expected.leafId ?? null))
          problems.push(`leafId ${got.leafId} != ${expected.leafId ?? null}`)

        // Subagent rows: the panel's content, not just its presence.
        const wantAgents = (expected.subagents ?? []) as Record<
          string,
          unknown
        >[]
        if (got.subagents.length !== wantAgents.length) {
          problems.push(
            `subagents ${got.subagents.length} != ${wantAgents.length}`,
          )
        } else {
          wantAgents.forEach((want, i) => {
            const mine = got.subagents[i] as unknown as Record<string, unknown>
            for (const key of Object.keys(want)) {
              const expectedValue = want[key]
              if (typeof expectedValue === "string") {
                if (!textMatches(String(mine[key] ?? ""), expectedValue))
                  problems.push(
                    `subagent[${i}].${key} ${JSON.stringify(mine[key])} !~ ${JSON.stringify(expectedValue)}`,
                  )
              } else if (mine[key] !== expectedValue) {
                problems.push(
                  `subagent[${i}].${key} ${mine[key]} != ${expectedValue}`,
                )
              }
            }
          })
        }

        // Asks the machine is still waiting on — the overlay's whole reason to exist.
        const wantAsks = (expected.pendingAsks ?? []) as Record<
          string,
          unknown
        >[]
        if (got.pendingAsks.length !== wantAsks.length) {
          problems.push(
            `pendingAsks ${got.pendingAsks.length} != ${wantAsks.length}`,
          )
        } else {
          wantAsks.forEach((want, i) => {
            const mine = got.pendingAsks[i] as unknown as Record<
              string,
              unknown
            >
            for (const key of Object.keys(want)) {
              const expectedValue = want[key]
              if (Array.isArray(expectedValue)) {
                if (
                  JSON.stringify(mine[key] ?? []) !==
                  JSON.stringify(expectedValue)
                )
                  problems.push(
                    `ask[${i}].${key} ${JSON.stringify(mine[key])} != ${JSON.stringify(expectedValue)}`,
                  )
              } else if (typeof expectedValue === "string") {
                if (!textMatches(String(mine[key] ?? ""), expectedValue))
                  problems.push(
                    `ask[${i}].${key} ${JSON.stringify(mine[key])} !~ ${JSON.stringify(expectedValue)}`,
                  )
              } else if (mine[key] !== expectedValue) {
                problems.push(
                  `ask[${i}].${key} ${mine[key]} != ${expectedValue}`,
                )
              }
            }
          })
        }

        // The plan panel: which project's plan, and how many items. Compared
        // field-wise, not by serialized JSON — key order in a fixture is not
        // part of the contract.
        if ("plan" in expected) {
          const wantPlan = expected.plan as Record<string, unknown> | null
          if (wantPlan === null) {
            if (got.plan !== null)
              problems.push(`plan ${JSON.stringify(got.plan)} != null`)
          } else if (got.plan === null) {
            problems.push(`plan null != ${JSON.stringify(wantPlan)}`)
          } else {
            const mine = got.plan as unknown as Record<string, unknown>
            for (const key of Object.keys(wantPlan))
              if (mine[key] !== wantPlan[key])
                problems.push(`plan.${key} ${mine[key]} != ${wantPlan[key]}`)
          }
        }

        // The LIVE panel plane: what the machine says its agents and plan are.
        // Compared ALWAYS (the projection always emits the field, empty when
        // there are none) — an optional field cannot tell "this machine sent no
        // panels" apart from "this client dropped the frames". The legacy
        // `subagents`/`plan` fields above stay compared separately: they are the
        // older transport, and 002 pins it.
        const wantPanels = (expected.panels ?? []) as Record<string, unknown>[]
        if (got.panels.length !== wantPanels.length) {
          problems.push(`panels ${got.panels.length} != ${wantPanels.length}`)
        } else {
          wantPanels.forEach((want, i) => {
            const mine = got.panels[i] as unknown as Record<string, unknown>
            for (const field of ["key", "title", "icon"]) {
              const expectedValue = want[field]
              if (expectedValue === undefined) continue
              if (
                !textMatches(String(mine[field] ?? ""), String(expectedValue))
              )
                problems.push(
                  `panel[${i}].${field} ${JSON.stringify(mine[field])} !~ ${JSON.stringify(expectedValue)}`,
                )
            }
            const wantItems = (want.items ?? []) as Record<string, unknown>[]
            const mineItems = (mine.items ?? []) as unknown[]
            if (mineItems.length !== wantItems.length)
              problems.push(
                `panel[${i}] (${want.key}).items ${mineItems.length} != ${wantItems.length}`,
              )
            else
              wantItems.forEach((item, j) =>
                problems.push(
                  ...panelItemProblems(
                    item,
                    mineItems[j],
                    `panel[${i}](${want.key}).items[${j}]`,
                  ),
                ),
              )
          })
        }

        expect(problems).toEqual([])
      },
    )
  }
})
