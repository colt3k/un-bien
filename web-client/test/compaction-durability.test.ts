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

describe("the anchor is causal, not content-based", () => {
  // Both cases drive `compaction_end` with an `entryId`, which is exactly what
  // `birthEntry` synthesizes for a durable `compaction` entry (reference
  // `SessionState+BirthEntry.swift:18`, mirrored in `reducer.ts`) — the same path a
  // walk takes, without needing a full page.

  const rowsOf = (reducer: TranscriptReducer) =>
    reducer
      .snapshot()
      .items.filter((item) => item.kind === "compaction")
      .map((item) => `${item.row}|${item.text}`)

  it("anchors a live marker to its entry even though NEITHER field matches (023)", () => {
    // The regression 023 caught, driven by that scenario's own real frames: the
    // live plane's watched compaction, then the cold plane's real pages. The live
    // frame reported tokensBefore 127 248; the entry that IS that compaction
    // recorded 127 749; and the PREVIOUS compaction's entry recorded 127 248 with a
    // byte-identical summary. Any content key picks the wrong entry or none, and the
    // viewer sees four "Context compacted" rows for three compactions. Order picks
    // the right one, and the entry's count becomes the caption — what a cold arrival
    // shows. (Entries go in as whole pages: a page of loose entries looks truncated,
    // and the derive defers a truncated page rather than guessing.)
    const live = frames(
      `${scenario("023-live-compaction-pair")}/input.jsonl`,
    ).find(
      (frame) =>
        (frame.rpc as { type?: string } | undefined)?.type === "compaction_end",
    )
    const pages = frames(`${scenario("023-live-compaction-pair")}/replay.jsonl`)
      .map(
        (frame) =>
          frame.rpc as
            | {
                command?: string
                data?: { entries?: unknown[]; leafId?: string }
              }
            | undefined,
      )
      .filter((rpc) => rpc?.command === "get_entries")

    const reducer = new TranscriptReducer()
    reducer.apply(live!)
    expect(rowsOf(reducer)).toEqual(["1|Context compacted (127248 tokens)"])

    for (const page of pages)
      reducer.applyEntries(page!.data?.entries ?? [], page!.data?.leafId)

    expect(rowsOf(reducer)).toEqual([
      "d80b313f|Context compacted (85963 tokens)",
      "4156e442|Context compacted (127248 tokens)",
      "8663f793|Context compacted (127749 tokens)",
    ])
  })

  it("two live compactions then two entries pair up in order, one row each", () => {
    // Compactions are strictly sequential, so FIFO pairing across the planes is the
    // rule. Nothing in the content would tell them apart — pi can and did emit the
    // same summary twice and the same count twice.
    const reducer = new TranscriptReducer()
    const live = (tokens: number) =>
      reducer.apply({
        rpc: {
          type: "compaction_end",
          result: { summary: "the same text", tokensBefore: tokens },
        },
      } as never)
    const entry = (id: string, tokens: number) =>
      reducer.apply({
        rpc: {
          type: "compaction_end",
          result: { summary: "the same text", tokensBefore: tokens },
          entryId: id,
        },
      } as never)
    live(5_000)
    live(9_000)
    entry("e-a", 5_100)
    entry("e-b", 9_100)
    expect(rowsOf(reducer)).toEqual([
      "e-a|Context compacted (5100 tokens)",
      "e-b|Context compacted (9100 tokens)",
    ])
  })

  it("an entry-born compaction with no live marker waiting just appends", () => {
    // The cold plane: nothing was watched, so nothing is anchored — the entry-born
    // rows ride the log position, ahead of any live tail.
    const reducer = new TranscriptReducer()
    reducer.apply({
      rpc: {
        type: "compaction_end",
        result: { summary: "cold fold", tokensBefore: 85_963 },
        entryId: "e-cold",
      },
    } as never)
    expect(rowsOf(reducer)).toEqual(["e-cold|Context compacted (85963 tokens)"])
  })
})

describe("the boundary is the reference's boundary", () => {
  // Where an entry-born compaction goes when the only row on screen is a SETTLED
  // live marker. The folds used to disagree — the reference appended, this fold
  // inserted before — because "not replay-stable" is not the same boundary as
  // "pending live row". Aligned on the reference's rule (`liveTailStartIndex`,
  // `SessionState.swift:245`): the boundary is the first PENDING row or open
  // streaming row, so a settled live row is history and the entry-born row lands
  // after it. vocab.md records the resolution.
  it("an entry-born compaction appends after a settled live marker", () => {
    const reducer = new TranscriptReducer()
    reducer.apply({
      rpc: {
        type: "compaction_end",
        result: { summary: "watched", tokensBefore: 5_000 },
      },
    } as never)
    reducer.apply({
      rpc: {
        type: "compaction_end",
        result: { summary: "watched", tokensBefore: 5_100 },
        entryId: "e-a",
      },
    } as never)
    reducer.apply({
      rpc: {
        type: "compaction_end",
        result: { summary: "another", tokensBefore: 9_000 },
        entryId: "e-b",
      },
    } as never)
    expect(
      reducer
        .snapshot()
        .items.filter((item) => item.kind === "compaction")
        .map((item) => item.row),
    ).toEqual(["e-a", "e-b"])
  })
})
