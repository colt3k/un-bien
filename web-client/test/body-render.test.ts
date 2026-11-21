import { describe, expect, it } from "vitest"
import { MARKDOWN_BUDGET } from "../src/markdown.js"
import { bodyRenderKey, wantsMarkdown } from "../src/body-render.js"

const settled = {
  kind: "assistant",
  text: "the **hidden** attribute",
  streaming: false,
}
const streaming = { ...settled, streaming: true }

describe("bodyRenderKey", () => {
  it("changes when a row stops streaming, so markdown gets its turn", () => {
    // The bug: a streaming row is drawn as plain text, and once the text was
    // cached as rendered the settled markdown pass never ran. Raw `**bold**`
    // and backticks stayed on screen — styled in pi's TUI, raw in the browser.
    expect(bodyRenderKey(streaming)).not.toBe(bodyRenderKey(settled))
  })

  it("is stable while nothing changes, so a turn does not re-render every frame", () => {
    expect(bodyRenderKey(settled)).toBe(bodyRenderKey({ ...settled }))
    expect(bodyRenderKey(streaming)).toBe(
      bodyRenderKey({ ...settled, streaming: true }),
    )
  })

  it("changes when the text changes", () => {
    expect(bodyRenderKey(settled)).not.toBe(
      bodyRenderKey({ ...settled, text: "different" }),
    )
  })

  it("keys a pairing notice by its token, and by the payload riding in the text", () => {
    // The notice's QR block is drawn from `item.text`, so its length belongs in
    // the key; the token is what makes two different pairings differ.
    expect(bodyRenderKey(settled, "unbien://pair?t=x")).toBe(
      bodyRenderKey({ ...settled }, "unbien://pair?t=x"),
    )
    expect(bodyRenderKey(settled, "unbien://pair?t=x")).not.toBe(
      bodyRenderKey(settled, "unbien://pair?t=y"),
    )
    expect(bodyRenderKey(settled, "unbien://pair?t=x")).not.toBe(
      bodyRenderKey(
        { ...settled, text: "a different QR payload" },
        "unbien://pair?t=x",
      ),
    )
    // And a notice still re-renders when it stops streaming.
    expect(bodyRenderKey(streaming, "unbien://pair?t=x")).toBe(
      bodyRenderKey(settled, "unbien://pair?t=x"),
    )
  })
})

describe("wantsMarkdown", () => {
  it("parses assistant prose", () => {
    expect(wantsMarkdown(settled)).toBe(true)
  })

  it("leaves tool, reasoning and compaction bodies alone", () => {
    for (const kind of ["tool", "reasoning", "compaction"])
      expect(wantsMarkdown({ ...settled, kind })).toBe(false)
  })

  it("stops parsing past the budget the native app uses", () => {
    const huge = { ...settled, text: "x".repeat(MARKDOWN_BUDGET + 1) }
    expect(wantsMarkdown(huge)).toBe(false)
  })
})
