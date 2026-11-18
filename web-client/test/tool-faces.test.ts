import { describe, expect, it } from "vitest"
import {
  cleanOutput,
  parseDiff,
  projectionBlocks,
  resolveToolResult,
  toolCategory,
  type ToolFace,
} from "../src/tool-faces.js"

/**
 * The result faces behind a tool card. The corpus compares only the face NAME
 * (`blocks`), so the rules that decide WHICH face and WHAT is in it live here:
 * the `details` spec guard, notice splitting, harness diagnostics, ANSI
 * cleaning, diff parsing.
 */
const ok = (
  tool: string,
  result: unknown,
  args: Record<string, unknown> = {},
) => resolveToolResult({ tool, args, result, state: "ok" })

/** Narrow the face union before a direct property read: asserts the kind first,
 *  so a face that changed shape fails as an assertion rather than a cast. */
function face<K extends ToolFace["kind"]>(
  view: ReturnType<typeof resolveToolResult>,
  kind: K,
): Extract<ToolFace, { kind: K }> {
  expect(view.face.kind).toBe(kind)
  return view.face as Extract<ToolFace, { kind: K }>
}

describe("tool categories", () => {
  it("names families by whole name or `_` suffix, never by bare prefix", () => {
    expect(toolCategory("bash")).toBe("shell")
    expect(toolCategory("exec_command")).toBe("shell")
    expect(toolCategory("run_terminal_cmd")).toBe("shell")
    // A prefix match would make these shell, and their cards would render as
    // terminals.
    expect(toolCategory("run_tests")).toBe("other")
    expect(toolCategory("show_chart")).toBe("other")
    expect(toolCategory("shopify_fetch")).toBe("other")
    expect(toolCategory("read_file")).toBe("reads")
    expect(toolCategory("file_read")).toBe("reads")
    expect(toolCategory("web_search")).toBe("web")
    expect(toolCategory("Agent")).toBe("agents")
    expect(toolCategory("codemode")).toBe("codemode")
  })
})

describe("output cleaning", () => {
  it("strips ANSI and control characters, keeps tab and newline", () => {
    expect(cleanOutput("\u001B[31mred\u001B[0m")).toBe("red")
    expect(cleanOutput("a\tb\nc\r\n")).toBe("a\tb\nc\n")
    expect(cleanOutput("bell\u0007x")).toBe("bellx")
    expect(cleanOutput("plain")).toBe("plain")
  })
})

describe("unified diffs", () => {
  it("parses hunks with line counters from the header", () => {
    const diff = parseDiff(
      [
        "--- a/x",
        "+++ b/x",
        "@@ -10,3 +10,3 @@",
        " context",
        "-old",
        "+new",
      ].join("\n"),
    )
    expect(diff?.hunks).toEqual([
      {
        lines: [
          { kind: "context", oldLine: 10, newLine: 10, text: "context" },
          { kind: "remove", oldLine: 11, text: "old" },
          { kind: "add", newLine: 11, text: "new" },
        ],
      },
    ])
  })

  it("returns nothing when there is no hunk header", () => {
    expect(parseDiff("just output\nno patch here")).toBeUndefined()
  })
})

describe("settled faces", () => {
  it("bash output is a terminal, with its truncation notice split off", () => {
    const view = ok("bash", {
      content: [
        {
          type: "text",
          text: "line one\nline two\n\n[200 lines truncated]",
        },
      ],
      details: { truncation: { outputLines: 200 } },
    })
    expect(view.faceName).toBe("terminal")
    expect(view.face.kind).toBe("terminal")
    expect(view.face).toMatchObject({
      text: "line one\nline two",
      notices: ["200 lines truncated"],
    })
    expect(projectionBlocks(view)).toEqual(["terminal"])
  })

  it("bracketed text at the END of real output is not a notice", () => {
    // Captured from a live session (corpus scenario 012): a `df` usage line
    // whose last characters are brackets. `splitNotice` keys on the "\n\n["
    // seam pi writes, so the whole line stays output. A resolver that only
    // asked "does it end in ]?" would eat the usage text.
    const text =
      "usage: df [-g | -h | -k | -m] [-a | -s | -d depth] " +
      "[-B blocksize] [-I mask] [-t threshold] [file ...]"
    const view = ok("bash", { content: [{ type: "text", text }], details: {} })
    const terminal = face(view, "terminal")
    expect(terminal.notices).toEqual([])
    expect(terminal.text).toBe(text)
  })

  it("a read truncated mid-file reports its offset from the TEXT alone", () => {
    // The other half of the same capture: pi sent NO `details` at all on the
    // replayed toolResult, so the continuation notice has nothing to
    // corroborate it — it is recognised by its template, not by a payload.
    const view = ok("read", {
      content: [
        {
          type: "text",
          text: "1\timport x\n2\tfoo\n\n[965 more lines in file. Use offset=201 to continue.]",
        },
      ],
    })
    const file = face(view, "file")
    expect(file.notices).toEqual([
      "965 more lines in file. Use offset=201 to continue.",
    ])
    expect(file.text).toBe("1\timport x\n2\tfoo")
  })

  it("a shell command whose output IS a diff becomes terminal-diff", () => {
    const view = ok("bash", {
      content: [
        {
          type: "text",
          text: "diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new",
        },
      ],
      details: {},
    })
    expect(view.faceName).toBe("terminal-diff")
    // The face parsed a diff out of the output, but the projection says
    // "hunks" only for a card the `aux` sidecar fed — see the real edit case
    // below, which shows the same split on machine data.
    expect(face(view, "terminal").diff?.hunks.length).toBe(1)
    expect(projectionBlocks(view)).toEqual(["terminal-diff"])
  })

  it("read is a file face, highlighted by its path, notice by template", () => {
    const view = ok(
      "read",
      {
        content: [
          {
            type: "text",
            // pi brackets its notice, which is what `splitNotice` keys on.
            text: "1\timport x\n2\t\n\n[198 more lines in file. Use offset=3 to continue.]",
          },
        ],
        details: { truncation: {} },
      },
      { path: "src/main.ts" },
    )
    expect(view.faceName).toBe("file")
    expect(view.face).toMatchObject({ lang: "typescript" })
    expect(view.face).toMatchObject({
      text: "1\timport x\n2\t",
      notices: ["198 more lines in file. Use offset=3 to continue."],
    })
  })

  it("file text that merely ENDS in brackets is not cut", () => {
    const view = ok("read", {
      content: [{ type: "text", text: "flags = [a, b, c]" }],
      details: {},
    })
    expect(view.face).toMatchObject({ text: "flags = [a, b, c]", notices: [] })
  })

  it("an edit's patch becomes hunks plus the success line", () => {
    const view = ok("edit", {
      content: [{ type: "text", text: "Edited src/x.swift" }],
      details: {
        patch: "@@ -1 +1 @@\n-let a = 1\n+let a = 2",
        firstChangedLine: 1,
      },
    })
    expect(view.faceName).toBe("diff")
    expect(projectionBlocks(view)).toEqual(["diff"])
    expect(view.face).toMatchObject({ confirmation: "Edited src/x.swift" })
  })

  it("an edit captured from a live session: patch is parsed, `diff` is not", () => {
    // Verbatim from corpus scenario 012. pi sends TWO diff-shaped fields in
    // different formats: `diff` is line-number prefixed (`-1 # Heading A`),
    // `patch` is a unified diff. The face parses `patch` — the reference does
    // the same (`ToolFace.swift:193`) — and a resolver that reached for the
    // shorter `diff` name would render line numbers as content.
    const view = ok("edit", {
      content: [
        { type: "text", text: "Successfully replaced 2 block(s) in «path»." },
      ],
      details: {
        diff:
          "-1 # Heading A\n+1 # Heading B\n 2 \n 3 body line\n" +
          "-4 old tail\n+4 new tail",
        patch:
          "--- «path»\n+++ «path»\n@@ -1,4 +1,4 @@\n-# Heading A\n+# Heading B\n" +
          " \n body line\n-old tail\n+new tail",
        firstChangedLine: 1,
      },
    })
    expect(view.faceName).toBe("diff")
    const hunks = face(view, "diff").hunks ?? []
    expect(hunks.length).toBe(1)
    expect(hunks[0]?.lines.slice(0, 2)).toEqual([
      { kind: "remove", oldLine: 1, text: "# Heading A" },
      { kind: "add", newLine: 1, text: "# Heading B" },
    ])
    // Replay plane: no `aux` sidecar, so the projection stays at ["diff"] even
    // though the card visibly holds a diff.
    expect(projectionBlocks(view)).toEqual(["diff"])
    // Live plane: the sidecar attaches raw hunks to the card, which IS reported.
    expect(projectionBlocks(view, [{ header: "@@ -1,4 +1,4 @@" }])).toEqual([
      "diff",
      "hunks",
    ])
  })

  it("write is just a confirmation line", () => {
    const view = ok("write", {
      content: [{ type: "text", text: "wrote 12 lines" }],
      details: {},
    })
    expect(view.faceName).toBe("confirmation")
    expect(projectionBlocks(view)).toEqual(["confirmation"])
  })

  it("grep is lines, and an unexpected details key drops it to text", () => {
    const known = ok("grep", {
      content: [{ type: "text", text: "a.ts:1:hit\n\n[match limit reached]" }],
      details: { matchLimitReached: true },
    })
    expect(known.faceName).toBe("lines")
    expect(known.face).toMatchObject({
      text: "a.ts:1:hit",
      notices: ["match limit reached"],
    })
    // A different tool shipped under the name `grep`: its details are not pi's,
    // so no built-in face may claim it.
    const foreign = ok("grep", {
      content: [{ type: "text", text: "a.ts:1:hit" }],
      details: { somethingElse: true },
    })
    expect(foreign.faceName).toBe("text")
  })

  it("an agent's or a web fetch's text is prose", () => {
    expect(
      ok("Agent", {
        content: [{ type: "text", text: "## Findings\n- all green" }],
      }).faceName,
    ).toBe("markdown")
    expect(
      ok("web_search", {
        content: [{ type: "text", text: "1. a result" }],
      }).faceName,
    ).toBe("markdown")
  })

  it("a bare object result shows its JSON, a bare string result does not", () => {
    const bare = ok("some_tool", { anything: 1 } as never)
    expect(bare.faceName).toBe("text")
    expect(bare.face).toMatchObject({ text: '{\n  "anything": 1\n}' })
    // The corpus's edit scenario ends with `result: "ok"` — a string, not an
    // object, so the tool's own face still applies.
    expect(ok("edit", "ok" as never, {}).faceName).toBe("diff")
  })
})

describe("running and failed", () => {
  it("no output yet is pending; shell partial output is already a terminal", () => {
    const empty = resolveToolResult({
      tool: "bash",
      args: {},
      result: undefined,
      state: "running",
    })
    expect(empty.faceName).toBe("pending")
    const partial = resolveToolResult({
      tool: "bash",
      args: {},
      result: { content: [{ type: "text", text: "partial out" }] },
      state: "running",
    })
    expect(partial.faceName).toBe("terminal")
    const agent = resolveToolResult({
      tool: "Agent",
      args: {},
      result: { content: [{ type: "text", text: "still working" }] },
      state: "running",
    })
    expect(agent.faceName).toBe("text")
  })

  it("a failure joins the call's text with its harness [error] diagnostics", () => {
    const view = resolveToolResult({
      tool: "bash",
      args: {},
      result: {
        content: [
          { type: "text", text: "some output" },
          {
            type: "text",
            text: "<harness>\n[error] exit status 2\n[info] note\n</harness>",
          },
        ],
      },
      state: "failed",
    })
    expect(view.faceName).toBe("error")
    expect(view.face).toMatchObject({ text: "some output\n\nexit status 2" })
    expect(view.diagnostics).toEqual(["[error] exit status 2", "[info] note"])
  })
})

describe("codemode scripts", () => {
  it("lists nested calls and strips the wall-time header", () => {
    const view = ok("codemode", {
      // The wall-time header is its OWN text block, ending at "Output:\n" —
      // the shape pi sends, and what the strip keys on.
      content: [
        {
          type: "text",
          text: "Script completed\nWall time 0.4 seconds\nOutput:\n",
        },
        { type: "text", text: "result text" },
      ],
      details: {
        calls: [
          { name: "fs.read", args: "{path}", status: "ok", durationMs: 3 },
        ],
      },
    })
    expect(view.faceName).toBe("script")
    expect(view.face).toMatchObject({
      output: "result text",
      calls: [{ name: "fs.read", status: "ok", durationMs: 3 }],
    })
  })
})
