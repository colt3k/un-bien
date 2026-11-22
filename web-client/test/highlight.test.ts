import { describe, expect, it } from "vitest"
import { tokenize, type TokenRole } from "../src/highlight.js"

/** Roles of every token carrying a given text, for assertions that do not care
 *  how the surrounding whitespace was grouped. */
function rolesOf(tokens: { role: TokenRole; text: string }[], word: string) {
  return tokens.filter((t) => t.text.includes(word)).map((t) => t.role)
}

describe("tokenize", () => {
  it("returns null for a language it does not know", () => {
    // The caller colours the whole block one colour for these, exactly as pi
    // does when highlight.js has no language: an unknown fence is still
    // coloured, never left flat and never guessed at.
    expect(tokenize("elaborate thing", null)).toBeNull()
    expect(tokenize("x", "klingon")).toBeNull()
  })

  it("paints a CSS block the way pi does: values green, properties named", () => {
    const tokens = tokenize(
      ".body code {\n  color: var(--code);\n  font-size: 0.92em; /* pi's violet */\n}",
      "css",
    )!
    expect(rolesOf(tokens, "#a878d8")).toEqual([]) // not present here; the hex case is its own test
    expect(rolesOf(tokens, "color")).toEqual(["variable"])
    expect(rolesOf(tokens, "var")).toEqual(["func"])
    expect(rolesOf(tokens, "0.92")).toEqual(["number"])
    expect(rolesOf(tokens, "/* pi's violet */")).toEqual(["comment"])
  })

  it("reads a #hex colour as a value, but a # in shell as a comment", () => {
    // The same character, opposite meanings, and only the family tells them
    // apart — this is the one rule most hand-rolled highlighters get wrong.
    expect(rolesOf(tokenize("--code: #a798d7;", "css")!, "#a798d7")).toEqual([
      "number",
    ])
    expect(
      rolesOf(tokenize("# find the tests\nrg -l vitest", "bash")!, "# find the tests"),
    ).toEqual(["comment"])
  })

  it("colours the verbs of a shell block", () => {
    const tokens = tokenize('git commit -m "colour code blocks"', "bash")!
    expect(rolesOf(tokens, "git")).toEqual(["func"])
    expect(rolesOf(tokens, '"colour code blocks"')).toEqual(["string"])
  })

  it("knows keywords, calls and numbers in a TS block", () => {
    const tokens = tokenize("const seen = new Map<string, number>()", "ts")!
    expect(rolesOf(tokens, "const")).toEqual(["keyword"])
    expect(rolesOf(tokens, "new")).toEqual(["keyword"])
    expect(rolesOf(tokens, "Map")).toEqual(["type"])
  })

  it("treats a JSON key as a name and its value as a string", () => {
    const tokens = tokenize('{"kind": "code", "count": 3}', "json")!
    expect(rolesOf(tokens, '"kind"')).toEqual(["variable"])
    expect(rolesOf(tokens, '"code"')).toEqual(["string"])
    expect(rolesOf(tokens, "3")).toEqual(["number"])
  })

  it("names a tag and its attributes in markup", () => {
    const tokens = tokenize('<datalist id="launchDirOptions"></datalist>', "html")!
    expect(rolesOf(tokens, "datalist")).toEqual(["keyword", "keyword"])
    expect(rolesOf(tokens, "id")).toEqual(["variable"])
  })
})

describe("tokenize keeps the text intact", () => {
  // The invariant that makes a wrong colour harmless rather than lossy: token
  // texts must concatenate back to the block, byte for byte.
  const blocks: Array<[string, string]> = [
    [
      "ts",
      "function f(a: string): number {\n  // unterminated string: '\n  return a.length\n}",
    ],
    ["css", ".a { color: #fff; background: color-mix(in oklab, var(--c) 10%, transparent) }"],
    ["bash", 'echo "a | b" # pipe not a table\nfor i in 1 2; do sleep 0.1; done'],
    ["json", '{"a": "unterminated'],
    ["html", "<!-- a comment -->\n<p class='x'>a &amp; b</p>"],
    ["py", "def f(x):\n    return x  # note"],
    ["sql", "SELECT * FROM t -- note\nWHERE n = 3"],
    ["go", "package main\nfunc main() { /* block */ }"],
  ]
  for (const [lang, code] of blocks) {
    it(`${lang}: tokens concatenate back`, () => {
      const tokens = tokenize(code, lang)!
      expect(tokens.map((t) => t.text).join("")).toBe(code)
    })
  }

  it("never leaves a token empty", () => {
    for (const token of tokenize("  \n\n\t ", "ts")!) expect(token.text).not.toBe("")
  })
})
