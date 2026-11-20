import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { TranscriptReducer } from "../src/reducer.js"

/**
 * One compaction, one row.
 *
 * A compaction reaches a viewer twice: as a live `compaction_end` frame while it
 * watches, and later as the durable `compaction` ENTRY a walk brings back. The two
 * key differently — the live marker on the bare sequence number, the entry on pi's
 * entry id — and nothing linked them, so the watched transcript grew a SECOND
 * "Context compacted" row the moment a walk brought the entry. Found by probing the
 * 022 capture (021 could not show it: its branch put the compaction entry off the
 * active path).
 *
 * Both frames below are 021's, read from the committed fixture rather than
 * reconstructed: the live frame and the entry for the SAME compaction (both report
 * 103 812 tokens before). Their `summary` strings deliberately do NOT match — the
 * live frame's is scrubbed to a `«2122»` marker and the entry's to length-preserving
 * filler — which is why the match is on the token count, the one thing both forms
 * report identically.
 */

const scenario = (name: string) =>
  fileURLToPath(
    new URL(`../../contracts/conformance/scenarios/${name}/`, import.meta.url),
  )

const frames = (file: string) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, never>)

/** 022's cold arrival at an already-compacted log — the real pages, real leaf. */
const cold = frames(`${scenario("022-cold-compacted-log")}/replay.jsonl`)
const compactionEntry = cold
  .flatMap(
    (frame) =>
      (
        frame.rpc as
          { data?: { entries?: Record<string, never>[] } } | undefined
      )?.data?.entries ?? [],
  )
  .find((row) => (row as { type?: string }).type === "compaction") as
  { id: string; tokensBefore?: number; summary?: string } | undefined

describe("compaction marker durability", () => {
  it("carries the fixture it depends on", () => {
    expect(compactionEntry?.id).toBeTruthy()
    expect(compactionEntry?.tokensBefore).toBe(85_963)
  })

  it("anchors the live marker to the entry instead of adding a second row", () => {
    // The live frame is 021's `compaction_end` SHAPE carrying 022's numbers: no
    // capture yet shows a compaction that was BOTH watched live and later walked
    // on-path (021's got branched off; 022's arrived cold), so the pair is
    // assembled here from two real shapes. The assertion is about the fold, not
    // about the numbers.
    const reducer = new TranscriptReducer()
    reducer.apply({
      rpc: {
        type: "compaction_end",
        result: {
          summary: compactionEntry?.summary ?? "",
          tokensBefore: compactionEntry?.tokensBefore,
        },
      },
    } as never)
    const rows = () =>
      reducer
        .snapshot()
        .items.filter((item) => item.kind === "compaction")
        .map((item) => item.row)

    // Live birth: the bare sequence number, as `SyntheticID.compaction(seq:)` keys it.
    expect(rows()).toEqual(["1"])

    // …then a walk brings the entry that IS this compaction, on the active path.
    for (const frame of cold) {
      const rpc = frame.rpc as
        | { command?: string; data?: { entries?: unknown[]; leafId?: string } }
        | undefined
      if (rpc?.command === "get_entries")
        reducer.applyEntries(rpc.data?.entries ?? [], rpc.data?.leafId)
    }

    // One row — anchored to pi's entry id, so a client that arrives cold (which
    // only ever sees the entry) lands on the same row. One `snapshot()` because
    // draining the re-key log is part of what a snapshot does.
    const settled = reducer.snapshot()
    expect(
      settled.items
        .filter((item) => item.kind === "compaction")
        .map((item) => item.row),
    ).toEqual([compactionEntry!.id])
    expect(settled.rekeys).toEqual([{ from: "1", to: compactionEntry!.id }])
  })

  it("a cold arrival, twice over, still shows one row", () => {
    const reducer = new TranscriptReducer()
    const walk = () => {
      for (const frame of cold) {
        const rpc = frame.rpc as
          | {
              command?: string
              data?: { entries?: unknown[]; leafId?: string }
            }
          | undefined
        if (rpc?.command === "get_entries")
          reducer.applyEntries(rpc.data?.entries ?? [], rpc.data?.leafId)
      }
    }
    walk()
    walk()
    expect(
      reducer.snapshot().items.filter((item) => item.kind === "compaction"),
    ).toHaveLength(1)
  })
})

describe("the match key's two edges", () => {
  // Both cases drive `compaction_end` with an `entryId`, which is exactly what
  // `birthEntry` synthesizes for a durable `compaction` entry (reference
  // `SessionState+BirthEntry.swift:18`, mirrored in `reducer.ts`) — so the fold is
  // exercised on the same path a walk takes, without needing a full page.

  const compactedRows = (reducer: TranscriptReducer) =>
    reducer
      .snapshot()
      .items.filter((item) => item.kind === "compaction")
      .map((item) => `${item.row}|${item.text}`)

  it("two compactions that report no token count stay two rows", () => {
    // Older pi frames may carry no `tokensBefore`. The caption says just "Context
    // compacted", and an unguarded identity match (in Swift, `Int? == Int?` is true
    // when both are nil) would fold them into ONE row and silently drop a
    // compaction the viewer should see. The match requires a count on both sides.
    const reducer = new TranscriptReducer()
    reducer.apply({
      rpc: { type: "compaction_end", result: { summary: "the first fold" } },
    } as never)
    reducer.apply({
      rpc: {
        type: "compaction_end",
        result: { summary: "the second fold" },
        entryId: "e-countless",
      },
    } as never)
    // Two rows — and the entry-born one BEFORE the live marker, which is where this
    // fold puts it. The reference puts it AFTER: its boundary (`liveTailStartIndex`,
    // `SessionState.swift:245`) is defined by PENDING live rows and open streaming
    // rows, and a live compaction marker is neither, so its boundary is the end of
    // the list. Unresolved and recorded in vocab.md; unreachable from real logs,
    // because every compaction entry in the session logs carries `tokensBefore`, so
    // the two counts differ and the anchored case collapses to one row either way.
    // Pinned per implementation on purpose: changing either order has to be a
    // decision about the boundary rule, not a silent edit of a test.
    expect(compactedRows(reducer)).toEqual([
      "e-countless|Context compacted",
      "1|Context compacted",
    ])
  })

  it("two compactions reporting the SAME count read as one row — the known limit", () => {
    // Stated, not hidden: `tokensBefore` is the only field both forms report
    // identically, so it is also the only field that can collide. In a real session
    // the second count includes what the first compacted away, so they differ; if pi
    // ever changes that, this test is the thing that has to change — in both folds.
    const reducer = new TranscriptReducer()
    reducer.apply({
      rpc: {
        type: "compaction_end",
        result: { summary: "first fold", tokensBefore: 5_000 },
      },
    } as never)
    reducer.apply({
      rpc: {
        type: "compaction_end",
        result: {
          summary: "a DIFFERENT fold, same count",
          tokensBefore: 5_000,
        },
        entryId: "e-second",
      },
    } as never)
    expect(compactedRows(reducer)).toEqual([
      "e-second|Context compacted (5000 tokens)",
    ])
  })
})
