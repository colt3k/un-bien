/**
 * The entry tree, the derived active path, and the membership gate.
 *
 * Port of the `applyEntries` / `derivePath` / `renderPendingPathEntries` /
 * `isLeafAtOrAhead` / `contiguousStart` cluster in
 * `app/Sources/UnBienCore/Session/SessionState.swift`.
 *
 * The model, in the order it runs:
 *
 *  1. Every entry from a `get_entries` page is INDEXED and RETAINED — including
 *     entries on abandoned branches. They stay as data (the tree browser needs
 *     them) and produce no row.
 *  2. A leaf beacon (the page's `leafId`, once the walk completes) derives the
 *     ACTIVE PATH: backwalk `parentId` links rootward, reverse the chain.
 *  3. Rows are born only for path entries not yet rendered — that single rule
 *     IS the membership gate.
 *
 * Deriving can only do four things to a rendered transcript: render (first
 * time), EXTEND (the old path is a contiguous run inside the new one, so the
 * new ancestry prepends), keep (a non-authoritative beacon fell back to an
 * ancestor — undecidable by shape, so hold the superset), defer (ancestry is
 * not backfilled yet, or a turn is mid-flight and a reset would tear a live
 * bubble in half), or RESET (divergence — the only destructive outcome).
 */

type Frame = Record<string, unknown>

function asFrame(value: unknown): Frame | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Frame)
    : null
}

function str(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/** Why the derived path replaced the rendered one. */
export type ResetReason = "trunc" | "shape" | "diverge"

/** What a derive decided, named as the Swift names it. */
export type DeriveOutcome =
  | "render"
  | "extend"
  | "nochange"
  | "trunc-keep"
  | "defer-trunc"
  | "defer-turn"
  | "reset"

/** What the caller must do to the rendered rows after one `applyEntries`. */
export interface PathPlan {
  outcome: DeriveOutcome
  /** Entry ids whose rows must be born now, in path order (appended below what
   *  is already rendered). The membership gate: an entry absent from the derived
   *  path never appears here. */
  birth: string[]
  /** A rootward extension: these births are the path's PREFIX and belong at the
   *  FRONT, keeping the already-rendered tail intact. */
  prepend: string[]
  /** Divergence: drop the rendered rows and rebuild from `path`. */
  reset: boolean
  resetReason?: ResetReason
  /** The active path after this fold, or null while nothing is derived. */
  path: string[] | null
}

export class EntryTree {
  private readonly byId = new Map<string, unknown>()
  /** entry id -> parent entry id ("" = a root). */
  private readonly parent = new Map<string, string>()

  private pathOrder: string[] | null = null
  private pathIds = new Set<string>()
  /** How much of `pathOrder` has had rows born — the gate's cursor. */
  private renderedPathCount = 0
  private activeLeafId: string | null = null

  /** A derive that could not complete: a truncated walk (ancestry not
   *  backfilled) or a deferred reset (turn in flight). Held, not dropped — the
   *  next page re-derives it. Corpus 009 is exactly this: the completing page's
   *  beacon EQUALS the held leaf, so only the deferred repath would ever render
   *  the path, and a client that forgot it strands the transcript empty. */
  private pendingRepathLeaf: string | null = null
  private pendingRepathAuthoritative = false

  get leaf(): string | null {
    return this.activeLeafId
  }

  get path(): string[] | null {
    return this.pathOrder ? [...this.pathOrder] : null
  }

  get size(): number {
    return this.byId.size
  }

  entry(id: string): unknown {
    return this.byId.get(id)
  }

  parentOf(id: string): string | undefined {
    return this.parent.get(id)
  }

  /** True when the tree diverges anywhere (some entry has >1 child, or there is
   *  more than one root) — a linear session has no tree to browse. */
  hasBranches(): boolean {
    const counts = new Map<string, number>()
    for (const parentId of this.parent.values())
      counts.set(parentId, (counts.get(parentId) ?? 0) + 1)
    for (const n of counts.values()) if (n > 1) return true
    return this.parent.size > 1 && countRoots(this.parent) > 1
  }

  /** Entry ids that have more than one child — the fork points. */
  branchPointIds(): Set<string> {
    const counts = new Map<string, number>()
    for (const parentId of this.parent.values())
      counts.set(parentId, (counts.get(parentId) ?? 0) + 1)
    const out = new Set<string>()
    for (const [parentId, n] of counts)
      if (n > 1 && parentId !== "") out.add(parentId)
    return out
  }

  /**
   * Is `candidate` at-or-ahead of the currently rendered leaf: nothing derived
   * yet, the candidate IS the current leaf, or the current leaf is in the
   * candidate's ancestry (deriving moves strictly FORWARD). A candidate on a
   * sibling or older chain is BEHIND — deriving to it would rewind the visible
   * transcript, which is how a paging loop stuck in an old region spins.
   */
  isLeafAtOrAhead(candidate: string): boolean {
    const current = this.activeLeafId
    if (current === null || current === candidate) return true
    let cursor = candidate
    const seen = new Set<string>()
    while (cursor !== "" && !seen.has(cursor) && this.parent.has(cursor)) {
      seen.add(cursor)
      if (cursor === current) return true
      cursor = this.parent.get(cursor) ?? ""
    }
    return cursor === current
  }

  /** Fold one page of raw pi entries. `leafId` is the ACTIVE-LEAF BEACON only
   *  when trusted: a partial page's `leafId` is just a resume cursor, and
   *  deriving from it builds a partial path. `turnOpen` = a turn is in flight
   *  (a live bubble is open), which defers a destructive reset.
   *
   *  `authoritative` has NO default on purpose (audit, 2026-11-18): the choice
   *  is the difference between a destructive `reset` and keep-truncated, so a
   *  default is behaviour, not convenience. The wrapper on the reducer side
   *  defaults it to true because a `get_entries` page that came back without a
   *  leaf finished the walk; callers that have not thought about it should go
   *  through that wrapper rather than guess. */
  applyEntries(
    entries: readonly unknown[],
    leafId: string | null | undefined,
    authoritative: boolean,
    turnOpen = false,
  ): PathPlan {
    for (const raw of entries) {
      const entry = asFrame(raw)
      const id = entry ? str(entry.id) : ""
      if (!id) continue
      this.byId.set(id, raw)
      this.parent.set(id, entry ? str(entry.parentId) : "")
    }

    const plan: PathPlan = {
      outcome: "nochange",
      birth: [],
      prepend: [],
      reset: false,
      path: this.pathOrder ? [...this.pathOrder] : null,
    }

    // The deferred repath fires AFTER the page merged, so the fuller ancestry is
    // visible.
    if (this.pendingRepathLeaf !== null) {
      const leaf = this.pendingRepathLeaf
      const auth = this.pendingRepathAuthoritative
      this.pendingRepathLeaf = null
      const outcome = this.derivePath(leaf, auth, turnOpen, plan)
      plan.outcome = outcome
      if (this.pathOrder) plan.path = [...this.pathOrder]
      this.collectBirths(plan)
    }

    if (
      typeof leafId === "string" &&
      leafId !== this.activeLeafId &&
      this.byId.has(leafId) &&
      // The walk guard: a delta/paging beacon that sits on a sibling or an
      // older chain would REWIND the visible transcript, so it is ignored
      // until an authoritative beacon (a cache load, or the user navigating
      // the tree) says otherwise. A paging loop stuck spinning in an old
      // region is exactly what this stops.
      (authoritative || this.isLeafAtOrAhead(leafId))
    ) {
      plan.outcome = this.derivePath(leafId, authoritative, turnOpen, plan)
      if (this.pathOrder) plan.path = [...this.pathOrder]
    }

    this.collectBirths(plan)
    return plan
  }

  /** Backwalk from `leaf` to a root; the reversed chain is the render order.
   *  Returns the outcome and fills `plan` with what the caller must do. */
  private derivePath(
    leaf: string,
    authoritative: boolean,
    turnOpen: boolean,
    plan: PathPlan,
  ): DeriveOutcome {
    const chain: string[] = []
    const seen = new Set<string>()
    let cursor = leaf
    let reachedRoot = false
    while (cursor !== "" && !seen.has(cursor) && this.parent.has(cursor)) {
      seen.add(cursor)
      chain.push(cursor)
      const parentId = this.parent.get(cursor) ?? ""
      if (parentId === "") {
        reachedRoot = true
        break
      }
      cursor = parentId
    }

    // Truncated walk: the entry exists but its ancestry is not backfilled yet.
    // Do NOT render a partial path — a first page that cuts the chain mid-way
    // would otherwise render rows it can never complete.
    if (!reachedRoot) {
      this.pendingRepathLeaf = leaf
      this.pendingRepathAuthoritative = authoritative
      return "defer-trunc"
    }

    const newOrder = chain.reverse()
    if (setEquals(newOrder, this.pathIds)) {
      this.activeLeafId = leaf
      return "nochange"
    }

    const firstDerivation = this.pathOrder === null
    const oldOrder = this.pathOrder ?? []

    if (firstDerivation) {
      this.activeLeafId = leaf
      this.pathOrder = newOrder
      this.pathIds = new Set(newOrder)
      this.renderedPathCount = 0
      return "render"
    }

    // EXTENSION: the old path is a contiguous run inside the new one, so this
    // is additive — safe mid-turn, because an in-flight message has no log
    // entry until streaming ends, so a beacon extend only adds settled
    // ancestry, never the live tail.
    const frontCount = contiguousStart(oldOrder, newOrder)
    if (frontCount !== null) {
      this.activeLeafId = leaf
      this.pathOrder = newOrder
      this.pathIds = new Set(newOrder)
      if (frontCount > 0) plan.prepend.push(...newOrder.slice(0, frontCount))
      this.renderedPathCount = frontCount + oldOrder.length
      return "extend"
    }

    // REGRESSION: the beacon fell back to an ancestor (new ⊆ old). Undecidable
    // by shape — a non-authoritative delta simply lags the live leaf — so keep
    // the superset and let the next authoritative beacon re-derive.
    if (!authoritative && contiguousStart(newOrder, oldOrder) !== null) {
      return "trunc-keep"
    }

    // RESET — the only destructive outcome. It would fragment a live bubble, so
    // defer it while a turn is open; the held leaf re-derives at turn end.
    if (turnOpen) {
      this.pendingRepathLeaf = leaf
      this.pendingRepathAuthoritative = authoritative
      this.activeLeafId = leaf
      return "defer-turn"
    }

    this.activeLeafId = leaf
    this.pathOrder = newOrder
    this.pathIds = new Set(newOrder)
    const priorLeaf = oldOrder[oldOrder.length - 1]
    const sameLine =
      (priorLeaf !== undefined && newOrder.includes(priorLeaf)) ||
      oldOrder.includes(leaf)
    const truncated = contiguousStart(newOrder, oldOrder) !== null
    plan.reset = true
    plan.resetReason = truncated ? "trunc" : sameLine ? "shape" : "diverge"
    // A reset tore the rows down, so the whole new path re-births — via the
    // gate, not by hand, so the gate stays the single source of births.
    this.renderedPathCount = 0
    return "reset"
  }

  /** Birth rows for path entries not yet rendered, in path order. */
  private collectBirths(plan: PathPlan): void {
    const order = this.pathOrder
    if (!order || this.renderedPathCount >= order.length) return
    for (let i = this.renderedPathCount; i < order.length; i++) {
      const id = order[i]
      if (id === undefined) continue
      this.renderedPathCount = i + 1
      if (this.byId.has(id)) plan.birth.push(id)
    }
  }

  reset(): void {
    this.byId.clear()
    this.parent.clear()
    this.pathOrder = null
    this.pathIds = new Set()
    this.renderedPathCount = 0
    this.activeLeafId = null
    this.pendingRepathLeaf = null
    this.pendingRepathAuthoritative = false
  }
}

function countRoots(parent: Map<string, string>): number {
  let roots = 0
  for (const parentId of parent.values()) if (parentId === "") roots += 1
  return roots
}

function setEquals(order: readonly string[], set: Set<string>): boolean {
  if (order.length !== set.size) return false
  for (const id of order) if (!set.has(id)) return false
  return true
}

/** The start index where `sub` occurs as a CONTIGUOUS run in `seq`, else null.
 *  Paths are ancestor chains with unique ids, so this is O(n). */
export function contiguousStart(
  sub: readonly string[],
  seq: readonly string[],
): number | null {
  const first = sub[0]
  if (first === undefined || sub.length > seq.length) return null
  let from = 0
  for (;;) {
    const idx = seq.indexOf(first, from)
    if (idx === -1) return null
    if (idx + sub.length <= seq.length) {
      let same = true
      for (let i = 0; i < sub.length; i++)
        if (seq[idx + i] !== sub[i]) {
          same = false
          break
        }
      if (same) return idx
    }
    from = idx + 1
  }
}
