import { existsSync, readFileSync, readdirSync } from "node:fs"
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
/** How many `thinking` blocks the durable pages carry. Not folded into rows by
 *  either implementation — the count is the size of the reasoning gap. */
function thinkingBlocksIn(frames: Record<string, unknown>[]): number {
  let count = 0
  for (const frame of frames) {
    const rpc = frame.rpc as Record<string, unknown> | undefined
    const data = rpc?.data as Record<string, unknown> | undefined
    const entries = data?.entries as Record<string, unknown>[] | undefined
    if (!entries) continue
    for (const entry of entries) {
      if (entry.type !== "message") continue
      const message = entry.message as Record<string, unknown> | undefined
      const content = message?.content as Record<string, unknown>[] | undefined
      if (!content) continue
      count += content.filter((block) => block.type === "thinking").length
    }
  }
  return count
}

/** The build every captured scenario was recorded through. Pinned in
 *  `contracts/conformance/capture-build.json` (with the npm dist integrity) because
 *  the repo's own extension source is OLDER than the build that wrote the goldens —
 *  0.25.11 against 0.25.15, with 0.25.13/14/15 published and untagged here. A new
 *  scenario captured against another build has to say so in its meta.json, and fails
 *  here until the pin is changed on purpose. */
const PINNED_CAPTURE_BUILD = (() => {
  const file = new URL(
    "../../contracts/conformance/capture-build.json",
    import.meta.url,
  )
  return JSON.parse(readFileSync(file, "utf8")) as {
    version: string
    "dist.integrity": string
  }
})()

function assertCaptureBuild(name: string, meta: ScenarioMeta): void {
  const declared = meta.extensionVersion
  // The older reference-authored fixtures (001-018) declare no build; they were not
  // captured through a client, so there is nothing to agree with.
  if (!declared) return
  expect(
    declared.includes(`0.25.`) &&
      declared.includes(PINNED_CAPTURE_BUILD.version),
    `${name}: meta.json declares an extension build other than the pinned capture build ${PINNED_CAPTURE_BUILD.version} (${declared.slice(0, 60)}…) — either the fixture came from a new build (update capture-build.json deliberately) or the declaration is stale`,
  ).toBe(true)
}

const SKIP_REASONS: Record<string, string> = {}

/** The conformance vocabulary this runner implements. The reference projects it
 *  (`ConformanceProjection`) and vocab.md documents it; version 2 added the
 *  live `panels` plane. */
const VOCAB_VERSION = 3

interface ScenarioMeta {
  modes?: string[]
  /** Which published extension build recorded this scenario, when it was a client
   *  capture rather than a reference-authored fixture. Checked against
   *  `capture-build.json` by `assertCaptureBuild`. */
  extensionVersion?: string
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
    // A scenario directory can be committed before its fixture exists (021 ships
    // its capture recipe first, so the capture is reviewable). Only allowed when
    // the directory says so — a `meta.json` that went missing must fail loudly.
    if (!existsSync(join(dir, "meta.json"))) {
      if (!existsSync(join(dir, "capture-steps.md")))
        throw new Error(
          `${name}: no meta.json and no capture-steps.md — a fixture that went missing, not one under construction`,
        )
      continue
    }
    const meta = JSON.parse(
      readFileSync(join(dir, "meta.json"), "utf8"),
    ) as ScenarioMeta
    assertCaptureBuild(name, meta)
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
        // Row ids are compared as the VOCABULARY defines them, not as this fold
        // allocates them internally — see `conformanceItems()`. The reference
        // projects `<kind>#<seq>` by order of appearance; allocating eagerly here
        // leaves gaps once a walk re-keys live-born rows to entry ids.
        const gotItems = reducer.conformanceItems()
        expect(projections(gotItems)).toEqual(projections(expected.items))

        const problems: string[] = []
        gotItems.forEach((item, index) => {
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

        // A PAIRED scenario (020): the same session reached the other way — a
        // client that arrives cold and only ever sees `get_entries` pages. It must
        // fold to the same transcript, so it is held to the SAME golden with the
        // same vocabulary rules (not to the connected run: the golden is the
        // contract, and its scrub semantics are what make the two planes
        // comparable at all). Three things in the projection are legitimately
        // plane-specific and are dropped here, each with its reason:
        //   * panels / subagents / pendingAsks — pi does not persist them, so a
        //     cold arrival has none by construction;
        //   * reasoning rows — pi persists `thinking` blocks ON the message entry
        //     (25 in this session) and NEITHER fold turns a persisted block into a
        //     row: thinking rows exist only where the deltas were watched. 020
        //     records that as a gap, not as a pass (the reference's projection
        //     cannot express the equality either — it keys reasoning rows synthetic
        //     unconditionally, `ConformanceProjection.swift:95`);
        //   * the `hunks` block on a card — the diff sidecar rides the live
        //     `tool_execution_start` frame and nothing else.
        const replayFile = join(dir, "replay.jsonl")
        if (existsSync(replayFile)) {
          const cold = new TranscriptReducer()
          // The replay frames are kept, not just folded: the reasoning gap below
          // counts the `thinking` blocks sitting in the durable log.
          const replayFrames = readFileSync(replayFile, "utf8")
            .split("\n")
            .filter((line) => line.trim().length > 0)
            .map((line) => JSON.parse(line) as Record<string, unknown>)
          for (const frame of replayFrames) {
            const env = toEnvelope(frame)
            if (env) cold.apply(env)
          }
          const coldSnap = cold.snapshot()
          const dropPlaneOnly = <T extends { kind?: unknown }>(rows: T[]) =>
            rows.filter((row) => row.kind !== "reasoning")
          const coldItems = dropPlaneOnly(
            cold.conformanceItems() as never as Record<string, unknown>[],
          )
          const wantItems = dropPlaneOnly(expected.items)
          const noSidecar = (row: Record<string, unknown>) => ({
            ...row,
            blocks: (Array.isArray(row.blocks) ? row.blocks : []).filter(
              (block) => block !== "hunks",
            ),
          })
          // CONTAINMENT, not equality, and 021 is the reason. That session
          // BRANCHED: the watcher saw a stretch of turns, the tree then moved the
          // leaf onto a different branch, and `get_entries` only ever serves the
          // active path. A client arriving afterwards therefore cannot show those
          // rows — that is the tree working, not the two folds disagreeing. What
          // must hold is the other direction: every row a cold viewer sees exists
          // in the watched transcript with the same fields.
          const wantByKey = new Map(
            wantItems.map((want) => [`${want.kind}@${want.row}`, want]),
          )
          for (const row of coldItems) {
            const key = `${row.kind}@${row.row}`
            const want = wantByKey.get(key)
            if (!want) {
              problems.push(`cold row ${key}: not present in the golden`)
              continue
            }
            problems.push(
              ...itemProblems(
                noSidecar(want),
                noSidecar(row) as unknown as TranscriptItem,
              ).map((problem) => `cold ${key}: ${problem}`),
            )
          }
          const offPath = wantItems.filter(
            (want) =>
              !coldItems.some(
                (row) =>
                  `${row.kind}@${row.row}` === `${want.kind}@${want.row}`,
              ),
          )
          // Pinned numerically, because it is a behaviour, not an accident: 021
          // branched, and the branch moved 37 comparable rows off the active path —
          // visible to the client that watched them, invisible to one that arrives
          // after. (92 rows watched, 41 cold; the extra 14 of the difference are
          // reasoning rows, which the comparison drops on both sides.) If a fold
          // ever renders off-path entries, or the derivation changes, this number
          // moves and the change has to be argued about here.
          const EXPECTED_OFF_PATH_ROWS: Record<string, number> = {
            "021-durable-vocabulary-pair": 37,
          }
          const expectedOffPath = EXPECTED_OFF_PATH_ROWS[name]
          if (expectedOffPath !== undefined)
            expect(
              offPath.length,
              `${name}: rows a watcher sees but a cold arrival cannot`,
            ).toBe(expectedOffPath)

          // The thinking split, pinned in BOTH directions because it is a DECISION
          // (DESIGN.md §2): pi does not replay `thinking` blocks when a session is
          // reloaded, so a viewer that arrives cold shows none either — even though
          // the blocks are persisted on the message entry (020's log holds 25,
          // 021's 50). So the watcher's reasoning rows must exist, and the cold
          // arrival must render none. A fold that starts rendering persisted
          // thinking fails here until this assertion, the runner comparison rule in
          // vocab.md, and DESIGN.md §2 are changed together.
          const persistedThinking = thinkingBlocksIn(replayFrames)
          if (persistedThinking > 0) {
            const liveReasoning = gotItems.filter(
              (item) => item.kind === "reasoning",
            ).length
            const coldReasoning = coldItems.filter(
              (row) => row.kind === "reasoning",
            ).length
            expect(
              liveReasoning,
              `${name}: a watcher should see reasoning rows (${persistedThinking} thinking blocks in the log, ${liveReasoning} rows on screen)`,
            ).toBeGreaterThan(0)
            expect(
              coldReasoning,
              `${name}: a cold arrival rendered ${coldReasoning} reasoning rows from ${persistedThinking} persisted thinking blocks — pi replays neither, so if this is now wanted, change DESIGN.md §2, vocab.md's exemption and this assertion together`,
            ).toBe(0)
          }
          if (
            "leafId" in expected &&
            coldSnap.leafId !== (expected.leafId ?? null)
          )
            problems.push(
              `cold leafId ${coldSnap.leafId} != ${expected.leafId ?? null}`,
            )
          if (expected.flags) {
            if (coldSnap.flags.streaming !== expected.flags.streaming)
              problems.push(
                `cold flags.streaming ${coldSnap.flags.streaming} != ${expected.flags.streaming}`,
              )
            if (coldSnap.flags.ended !== expected.flags.ended)
              problems.push(
                `cold flags.ended ${coldSnap.flags.ended} != ${expected.flags.ended}`,
              )
          }
        }

        expect(problems).toEqual([])
      },
    )
  }
})
