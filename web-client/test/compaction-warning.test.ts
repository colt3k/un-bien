import { describe, expect, it } from "vitest"
import { TranscriptReducer } from "../src/reducer.js"
import type { EnvelopeMessage } from "@geohar/un-bien/client"

// The extension's pre-fold notice: pi folds the transcript at
// `tokens > contextWindow - reserveTokens`
// (pi dist/core/compaction/compaction.js:173), and the extension announces it
// while the margin is still inside 1% of the window, because the hook that could
// have announced an IN-PROGRESS compaction reaches extensions only ~2 ms before
// it completes (measured 2026-11-21). So this evt channel is the only advance
// warning a reader gets.
function notices(reducer: TranscriptReducer) {
  return reducer.snapshot().items.filter((item) => item.kind === "notice")
}

function warn(data: unknown): EnvelopeMessage {
  return { evt: { channel: "compaction_warning", data } }
}

const inBand = {
  tokens: 16307,
  contextWindow: 262144,
  threshold: 17144,
  marginTokens: 837,
  reserveTokens: 245000,
}

describe("compaction_warning notice", () => {
  it("renders one notice row carrying pi's own numbers", () => {
    const reducer = new TranscriptReducer()
    reducer.apply(warn(inBand))
    const rows = notices(reducer)
    expect(rows).toHaveLength(1)
    const text = rows[0]?.text ?? ""
    expect(text).toContain("Compaction coming")
    expect(text).toContain("837")
    expect(text).toContain("17,144")
    expect(text).toContain("16,307")
  })

  it("warns once per crossing — the numbers move every turn, the row does not", () => {
    const reducer = new TranscriptReducer()
    reducer.apply(warn(inBand))
    reducer.apply(warn({ ...inBand, tokens: 16600, marginTokens: 544 }))
    reducer.apply(warn({ ...inBand, tokens: 16900, marginTokens: 244 }))
    expect(notices(reducer)).toHaveLength(1)
  })

  it("drops a frame with no usage rather than claiming zero margin", () => {
    // Right after a fold pi reports `tokens: null` until the next response. A
    // notice saying "0 tokens of margin left" would be a lie, and a lie about an
    // imminent compaction is worse than silence.
    const reducer = new TranscriptReducer()
    reducer.apply(warn({ ...inBand, tokens: null, marginTokens: null }))
    reducer.apply(warn({ contextWindow: 0 }))
    expect(notices(reducer)).toHaveLength(0)
  })
})
