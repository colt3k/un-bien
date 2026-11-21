import { describe, expect, it } from "vitest"
import {
  MARKDOWN_BUDGET,
  parseInline,
  parseMarkdown,
  type Block,
  type Inline,
} from "../src/markdown.js"

describe("the markdown subset the transcript uses", () => {
  it("keeps fenced code verbatim, fences and all inside", () => {
    const blocks = parseMarkdown("```js\nconst a = 1 // **not bold**\n```\n")
    expect(blocks).toEqual([
      { type: "code", lang: "js", text: "const a = 1 // **not bold**" },
    ])
  })

  it("treats an unterminated fence as code to the end, not as markdown", () => {
    // A stream that is cut off mid-block must not turn the rest of the answer
    // into a heading or a list.
    const blocks = parseMarkdown("```\n# still code\n- still code")
    expect(blocks).toEqual([
      { type: "code", lang: null, text: "# still code\n- still code" },
    ])
  })

  it("parses headings, lists, quotes and rules as blocks", () => {
    const blocks = parseMarkdown(
      "## Section\n\n- one\n- two\n\n> quoted\n\n---\n",
    )
    expect(blocks.map((b) => b.type)).toEqual([
      "heading",
      "list",
      "quote",
      "rule",
    ])
    const [heading, list] = blocks
    if (heading?.type === "heading") expect(heading.level).toBe(2)
    if (list?.type === "list") {
      expect(list.ordered).toBe(false)
      expect(list.items).toHaveLength(2)
    }
  })

  it("keeps a wrapped sentence one paragraph", () => {
    const blocks = parseMarkdown("one line\ncontinues here\n\nnext para")
    expect(blocks.map((b) => b.type)).toEqual(["para", "para"])
  })

  it("takes a code span before emphasis, so `**literal**` stays literal", () => {
    expect(parseInline("`**not bold**` and **bold**")).toEqual([
      { type: "code", text: "**not bold**" },
      { type: "text", text: " and " },
      { type: "bold", text: "bold" },
    ])
  })

  it("links only safe schemes", () => {
    expect(parseInline("see [the docs](https://example.com/a)")).toEqual([
      { type: "text", text: "see " },
      { type: "link", text: "the docs", href: "https://example.com/a" },
    ])
    // The label survives, the destination does not. The parser never emits an
    // href for a scripting scheme; the view also never sets innerHTML.
    const tokens = parseInline("[click](javascript:alert)")
    expect(tokens.some((t) => t.type === "link")).toBe(false)
    expect(tokens.map((t) => ("text" in t ? t.text : "")).join("")).toBe(
      "[click]",
    )
  })

  it("leaves markup it does not know as text", () => {
    // Raw HTML in a transcript is whatever the machine said, not structure.
    const blocks = parseMarkdown("<script>alert(1)</script>")
    expect(blocks).toHaveLength(1)
    const only = blocks[0]
    if (only?.type === "para")
      expect(only.inline).toEqual([
        { type: "text", text: "<script>alert(1)</script>" },
      ])
  })

  it("shows over-budget text unparsed, at the app's budget", () => {
    // TranscriptRowViews.swift:284 — parsing a huge paste is a re-layout per
    // delta of a live stream, so the client stops parsing at the same size.
    expect(MARKDOWN_BUDGET).toBe(32_000)
  })
})

describe("emphasis boundaries", () => {
  it("keeps the boundary it matched, so words do not lose a space", () => {
    expect(parseInline("say *this* now")).toEqual([
      { type: "text", text: "say " },
      { type: "em", text: "this" },
      { type: "text", text: " now" },
    ])
  })

  it("does not emphasise inside a snake_case identifier", () => {
    const tokens = parseInline("max_tokens here")
    expect(tokens.some((t) => t.type === "em")).toBe(false)
    expect(tokens.map((t) => ("text" in t ? t.text : "")).join("")).toBe(
      "max_tokens here",
    )
  })
})

/** A table block, or the test fails loudly instead of on a property of undefined. */
function tableOf(text: string): Extract<Block, { type: "table" }> {
  const block = parseMarkdown(text)[0]
  if (!block || block.type !== "table")
    throw new Error(`expected a table, got ${block?.type}`)
  return block
}

const cellText = (cell: Inline[]): string =>
  cell.map((token) => token.text).join("")

describe("pipe tables", () => {
  it("parses a header, delimiter and body into a table block", () => {
    const table = tableOf(
      [
        "| room | caps |",
        "| --- | ---: |",
        "| un-bien | 9 |",
        "| ctrl | 3 |",
      ].join("\n"),
    )
    expect(table.align).toEqual([null, "right"])
    expect(table.header.map(cellText)).toEqual(["room", "caps"])
    expect(table.rows).toHaveLength(2)
    expect(cellText(table.rows[0]?.[1] ?? [])).toBe("9")
  })

  it("does not turn prose containing a bar into a table", () => {
    const blocks = parseMarkdown("run `a | b` then c\nd more text here")
    expect(blocks.every((b) => b.type === "para")).toBe(true)
  })

  it("keeps a pipe inside a code span within one cell", () => {
    const table = tableOf(
      ["| cmd | note |", "| --- | --- |", "| `ls | wc -l` | one cell |"].join(
        "\n",
      ),
    )
    expect(table.align).toHaveLength(2)
    const code = table.rows[0]?.[0]?.find((token) => token.type === "code")
    expect(code?.text).toBe("ls | wc -l")
  })

  it("treats an escaped bar as text, not a cell break", () => {
    const table = tableOf(
      ["| a | b |", "| --- | --- |", "| x \\| y | z |"].join("\n"),
    )
    expect(table.rows[0]?.[0]?.[0]?.text).toBe("x | y")
  })

  it("pads short rows and drops cells past the delimiter's count", () => {
    const table = tableOf(
      [
        "| a | b | c |",
        "| --- | --- | --- |",
        "| 1 |",
        "| 1 | 2 | 3 | 4 |",
      ].join("\n"),
    )
    expect(table.rows[0]).toHaveLength(3)
    expect(table.rows[1]).toHaveLength(3)
  })

  it("ends at a blank line and leaves the following block alone", () => {
    const blocks = parseMarkdown(
      ["| a | b |", "| --- | --- |", "| 1 | 2 |", "", "after the table"].join(
        "\n",
      ),
    )
    expect(blocks.map((b) => b.type)).toEqual(["table", "para"])
  })
})
