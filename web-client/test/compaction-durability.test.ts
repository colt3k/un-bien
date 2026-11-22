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

describe("the compaction row opens when the summary call starts", () => {
  // A compaction's summary is a full model call — tens of seconds in which no
  // other frame arrives. A viewer that only learns of the compaction at its end
  // watches the transcript stop moving with nothing to read, which is what this
  // is for. The extension sources `compaction_start` from the
  // `session_before_compact` hook (extension/src/session/rpc_envelope.ts); pi's
  // own frame of that name is subscribe-only and never reaches an extension.
  const rowsOf = (reducer: TranscriptReducer) =>
    reducer
      .snapshot()
      .items.filter((item) => item.kind === "compaction")
      .map(
        (item) =>
          `${item.row}|${item.text}|${item.streaming ? "running" : "settled"}${
            item.state ? `|${item.state}` : ""
          }`,
      )

  const start = (reason: string) =>
    ({ rpc: { type: "compaction_start", reason } }) as never
  const end = (tokens: number) =>
    ({
      rpc: {
        type: "compaction_end",
        reason: "threshold",
        result: { summary: "the fold", tokensBefore: tokens },
      },
    }) as never
  const failed = (fields: Record<string, unknown>) =>
    ({ rpc: { type: "compaction_end", reason: "manual", ...fields } }) as never

  it("says what pi's own screen says, per reason", () => {
    const reducer = new TranscriptReducer()
    reducer.apply(start("threshold"))
    reducer.apply(start("manual"))
    reducer.apply(start("overflow"))
    expect(rowsOf(reducer)).toEqual([
      "1|Auto-compacting...|running",
      "2|Compacting context...|running",
      "3|Context overflow detected, auto-compacting...|running",
    ])
  })

  it("its end settles that row in place — one row, and the count appears", () => {
    const reducer = new TranscriptReducer()
    reducer.apply(start("threshold"))
    expect(rowsOf(reducer)).toEqual(["1|Auto-compacting...|running"])
    reducer.apply(end(85_963))
    // Same id, same position, no second row: the projection a compaction
    // produces is unchanged, so the conformance vocabulary does not move.
    expect(rowsOf(reducer)).toEqual([
      "1|Context compacted (85963 tokens)|settled",
    ])
  })

  it("start → end → entry is still ONE row, anchored to the entry id", () => {
    // The three planes of one compaction. The row opens at the hook, settles on
    // the live frame, and is re-keyed to pi's durable id when a walk brings the
    // entry — with the LOG's count, which is what a cold arrival shows.
    const reducer = new TranscriptReducer()
    reducer.apply(start("threshold"))
    reducer.apply(end(127_248))
    reducer.apply({
      rpc: {
        type: "compaction_end",
        result: { summary: "the fold", tokensBefore: 127_749 },
        entryId: "e-live",
      },
    } as never)
    expect(rowsOf(reducer)).toEqual([
      "e-live|Context compacted (127749 tokens)|settled",
    ])
  })

  it("a lost live frame still settles at the entry, not at 'Auto-compacting…'", () => {
    // The reconnect case: the hook's frame arrived, the outcome's did not. The
    // walk heals it — and the row must not be stolen by a YOUNGER live frame.
    const reducer = new TranscriptReducer()
    reducer.apply(start("threshold"))
    reducer.apply({
      rpc: {
        type: "compaction_end",
        result: { summary: "the fold", tokensBefore: 9_000 },
        entryId: "e-healed",
      },
    } as never)
    expect(rowsOf(reducer)).toEqual([
      "e-healed|Context compacted (9000 tokens)|settled",
    ])
  })

  it("a refused compaction ends the row as a refusal, not as a fold", () => {
    // pi appends NO entry when compaction fails, so `session_compact` never
    // fires. Without this the row would read "Auto-compacting..." forever.
    const reducer = new TranscriptReducer()
    reducer.apply(start("manual"))
    reducer.apply({
      rpc: {
        type: "compaction_end",
        reason: "manual",
        aborted: false,
        errorMessage:
          "Compaction failed: Nothing to compact (session too small)",
      },
    } as never)
    expect(rowsOf(reducer)).toEqual([
      "1|Compaction failed: Nothing to compact (session too small)|settled|failed",
    ])
  })

  it("an Esc in the TUI says so", () => {
    const reducer = new TranscriptReducer()
    reducer.apply(start("threshold"))
    reducer.apply(failed({ aborted: true }))
    expect(rowsOf(reducer)).toEqual(["1|Compaction cancelled|settled|failed"])
  })

  it("a failure with no row open adds nothing", () => {
    // `/compact` on a session too small fails BEFORE the hook, so no row was
    // ever opened. A failure row for a compaction nobody saw start is a phantom.
    const reducer = new TranscriptReducer()
    reducer.apply(
      failed({ errorMessage: "Compaction failed: Already compacted" }),
    )
    expect(rowsOf(reducer)).toEqual([])
  })

  it("keeps the session busy across the compaction, even a manual one", () => {
    // pi fires NO turn for a compaction, so a manual `/compact` on an idle
    // session looked idle: no stop button, no working affordance, a minute of
    // silence. `flags.streaming` stays what it was — that is what the corpus
    // compares — and the view's `busy` picks the open row up instead.
    const reducer = new TranscriptReducer()
    expect(reducer.snapshot().busy).toBe(false)
    reducer.apply(start("manual"))
    expect(reducer.snapshot().busy).toBe(true)
    expect(reducer.snapshot().flags.streaming).toBe(false)
    reducer.apply(failed({ aborted: true }))
    expect(reducer.snapshot().busy).toBe(false)
  })

  it("a machine that never sends compaction_start still behaves as before", () => {
    // Extension builds older than this frame, and durable hosts (which have no
    // hook to source it from): the end frame still births the marker.
    const reducer = new TranscriptReducer()
    reducer.apply(end(5_000))
    expect(rowsOf(reducer)).toEqual([
      "1|Context compacted (5000 tokens)|settled",
    ])
  })

  it("two running compactions settle in the order they opened", () => {
    // Compactions do not overlap, so FIFO is the rule here too. The first one's
    // end frame being lost must not mislabel the second.
    const reducer = new TranscriptReducer()
    reducer.apply(start("threshold"))
    reducer.apply(start("threshold"))
    reducer.apply(end(7_000))
    expect(rowsOf(reducer)).toEqual([
      "1|Context compacted (7000 tokens)|settled",
      "2|Auto-compacting...|running",
    ])
    reducer.apply(failed({ aborted: true }))
    expect(rowsOf(reducer)).toEqual([
      "1|Context compacted (7000 tokens)|settled",
      "2|Compaction cancelled|settled|failed",
    ])
  })
})
