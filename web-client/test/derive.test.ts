import { describe, expect, it } from "vitest"
import { EntryTree, contiguousStart } from "../src/derive.js"

/** Fold pages the way the wire does: a page's `leafId` is a resume cursor
 *  UNLESS the page completes the walk, so the beacon is only trusted on the
 *  terminal (empty) page. Callers pass it accordingly; these tests pass it
 *  explicitly at each fold. */

function entry(
  id: string,
  parentId: string | null,
  type = "message",
): Record<string, unknown> {
  return { type, id, parentId }
}

describe("entry tree + derived path", () => {
  it("renders the whole path on the first derivation, rootward first", () => {
    const tree = new EntryTree()
    const plan = tree.applyEntries(
      [entry("e1", null), entry("e2", "e1"), entry("e3", "e2")],
      "e3",
      true,
    )
    expect(plan.outcome).toBe("render")
    expect(plan.birth).toEqual(["e1", "e2", "e3"])
    expect(tree.path).toEqual(["e1", "e2", "e3"])
    // Idempotent: a repeat fold births nothing.
    expect(tree.applyEntries([], "e3", true).birth).toEqual([])
  })

  it("holds a truncated walk and completes it when the ancestry lands (corpus 009)", () => {
    const tree = new EntryTree()
    // Page 1: the leaf WITHOUT its ancestry. A partial path must not render.
    const first = tree.applyEntries([entry("e4", "e2")], "e4", true)
    expect(first.outcome).toBe("defer-trunc")
    expect(first.birth).toEqual([])
    expect(tree.path).toBeNull()
    // The terminal page repeats the beacon; the walk is still truncated.
    expect(tree.applyEntries([], "e4", true).birth).toEqual([])
    // Ancestry arrives. The HELD beacon re-derives — without the deferral this
    // path would strand empty forever, because the completing page's leafId
    // equals the held leaf and would otherwise be skipped as "unchanged".
    const third = tree.applyEntries(
      [entry("e1", null), entry("e2", "e1")],
      null,
      true,
    )
    expect(third.birth).toEqual(["e1", "e2", "e4"])
    expect(tree.path).toEqual(["e1", "e2", "e4"])
  })

  it("replays the real 009 fixture pages into the expected membership", async () => {
    const { readFileSync } = await import("node:fs")
    const path = new URL(
      "../../contracts/conformance/scenarios/009-derive-path-truncation/input.jsonl",
      import.meta.url,
    ).pathname
    const tree = new EntryTree()
    const plans = []
    for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
      const frame = JSON.parse(line)
      const data = frame?.rpc?.data
      if (!data) continue
      const entries = data.entries ?? []
      // THE COMPLETING-PAGE RULE: a page's `leafId` is a resume cursor unless
      // that page terminated the walk (came back empty). Folding a partial
      // page's cursor as a beacon would hijack the derive onto the sibling
      // `e3`, which expected.json does not contain.
      const completed = entries.length === 0
      plans.push(
        tree.applyEntries(
          entries,
          completed ? (data.leafId ?? null) : null,
          true,
        ),
      )
    }
    // expected.json's items are exactly the derived path: e1, e2, e4.
    const born = plans.flatMap((p) => p.birth)
    expect(born).toEqual(["e1", "e2", "e4"])
    expect(tree.path).toEqual(["e1", "e2", "e4"])
    expect(tree.leaf).toBe("e4")
    expect(plans.some((p) => p.outcome === "defer-trunc")).toBe(true)
    // e3 stays indexed — the abandoned branch is retained data — and is never
    // born. That is the membership gate, asserted against a real fixture.
    expect(tree.entry("e3")).not.toBeUndefined()
  })

  it("gates a walk beacon that would rewind, and honors an authoritative one", () => {
    const tree = new EntryTree()
    tree.applyEntries(
      [entry("e1", null), entry("e2", "e1"), entry("e3", "e2")],
      "e3",
      true,
    )
    // A lagging or sibling beacon from the paging loop: ignored, no reset.
    tree.applyEntries([entry("e9", "e2")], null, true)
    expect(tree.applyEntries([], "e9", false).outcome).toBe("nochange")
    expect(tree.path).toEqual(["e1", "e2", "e3"])
    // The user navigating the tree is authoritative: the reset lands.
    expect(tree.applyEntries([], "e9", true).outcome).toBe("reset")
    expect(tree.path).toEqual(["e1", "e2", "e9"])
  })

  it("extends additively when the path grows rootward, and prepends the births", () => {
    const tree = new EntryTree()
    tree.applyEntries([entry("e2", "e1"), entry("e1", null)], "e2", true)
    // Backfill ABOVE the rendered head, plus a new leaf: the path becomes
    // e0 -> e1 -> e2 -> e3, with the already-rendered [e1,e2] a contiguous run
    // inside it. That is additive — the rendered tail stays and e0 prepends.
    const plan = tree.applyEntries(
      [entry("e0", null, "compaction"), entry("e1", "e0"), entry("e3", "e2")],
      "e3",
      true,
    )
    expect(plan.outcome).toBe("extend")
    expect(plan.prepend).toEqual(["e0"])
    // The new leaf's row is born by the same gate, appended below the tail.
    expect(plan.birth).toEqual(["e3"])
    expect(plan.reset).toBe(false)
    expect(tree.path).toEqual(["e0", "e1", "e2", "e3"])
  })

  it("refuses a beacon that would truncate the transcript unless it is authoritative", () => {
    const tree = new EntryTree()
    tree.applyEntries(
      [entry("e1", null), entry("e2", "e1"), entry("e3", "e2")],
      "e3",
      true,
    )
    // A lagging delta beacon (e2) would TRUNCATE what is on screen. The walk
    // guard stops it upstream (an ancestor is not at-or-ahead of the leaf);
    // the port keeps the in-derive `trunc-keep` outcome as the second line of
    // defence, exactly as the Swift does.
    const plan = tree.applyEntries([], "e2", false)
    expect(plan.outcome).toBe("nochange")
    expect(plan.reset).toBe(false)
    expect(tree.path).toEqual(["e1", "e2", "e3"])
    // The next authoritative beacon is the one that decides.
    const back = tree.applyEntries([], "e2", true)
    expect(back.outcome).toBe("reset")
    expect(back.resetReason).toBe("trunc")
    expect(tree.path).toEqual(["e1", "e2"])
  })

  it("resets on divergence and drops off-path entries from the render", () => {
    const tree = new EntryTree()
    tree.applyEntries(
      [entry("e1", null), entry("e2", "e1"), entry("e3", "e2")],
      "e3",
      true,
    )
    // A sibling branch: e2 -> e9 (e3 abandoned).
    const plan = tree.applyEntries([entry("e9", "e2")], "e9", true)
    expect(plan.outcome).toBe("reset")
    expect(plan.resetReason).toBe("diverge")
    expect(plan.birth).toEqual(["e1", "e2", "e9"])
    // The abandoned branch stays as DATA (retained for the tree browser) and
    // never becomes a row — the membership gate.
    expect(tree.entry("e3")).not.toBeUndefined()
    expect(tree.path).not.toContain("e3")
    expect(plan.birth).not.toContain("e3")
  })

  it("defers a destructive reset while a turn is open, then applies it", () => {
    const tree = new EntryTree()
    tree.applyEntries(
      [entry("e1", null), entry("e2", "e1"), entry("e3", "e2")],
      "e3",
      true,
    )
    const deferred = tree.applyEntries([entry("e9", "e2")], "e9", true, true)
    expect(deferred.outcome).toBe("defer-turn")
    expect(deferred.reset).toBe(false)
    expect(tree.path).toEqual(["e1", "e2", "e3"])
    // Turn settled: the held leaf re-derives and the reset lands.
    const applied = tree.applyEntries([], null, true, false)
    expect(applied.outcome).toBe("reset")
    expect(applied.birth).toEqual(["e1", "e2", "e9"])
  })

  it("gates a backward derive: a sibling or older leaf is not at-or-ahead", () => {
    const tree = new EntryTree()
    tree.applyEntries(
      [
        entry("e1", null),
        entry("e2", "e1"),
        entry("e3", "e2"),
        entry("e4", "e3"),
      ],
      "e4",
      true,
    )
    expect(tree.isLeafAtOrAhead("e4")).toBe(true)
    // Deeper on the same chain is ahead; shallower on it is BEHIND — deriving
    // to an ancestor would rewind what is on screen.
    expect(tree.isLeafAtOrAhead("e3")).toBe(false)
    // An unknown id has no ancestry to walk, so the backwalk ends at the
    // candidate itself and the guard reads it as behind.
    expect(tree.isLeafAtOrAhead("e9")).toBe(false)
    // Once its ancestry is indexed, a sibling chain reads as behind.
    tree.applyEntries([entry("e9", "e2")], null, true)
    expect(tree.isLeafAtOrAhead("e9")).toBe(false)
  })

  it("reports branch points and whether there is a tree to browse at all", () => {
    const tree = new EntryTree()
    tree.applyEntries([entry("e1", null), entry("e2", "e1")], "e2", true)
    expect(tree.hasBranches()).toBe(false)
    expect(tree.branchPointIds()).toEqual(new Set())
    tree.applyEntries([entry("e3", "e1")], null, true)
    expect(tree.hasBranches()).toBe(true)
    expect(tree.branchPointIds()).toEqual(new Set(["e1"]))
  })

  it("finds a path as a contiguous run, which is how extend is detected", () => {
    expect(contiguousStart(["a", "b", "c"], ["x", "a", "b", "c", "y"])).toBe(1)
    expect(contiguousStart(["a", "b"], ["a", "c", "b"])).toBeNull()
    expect(contiguousStart(["a", "b", "c"], ["a", "b"])).toBeNull()
    expect(contiguousStart([], ["a"])).toBeNull()
  })
})
