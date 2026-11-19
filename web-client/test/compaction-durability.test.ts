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
