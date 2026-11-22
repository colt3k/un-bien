/**
 * Colour inside a fenced code block, the way pi's terminal does it.
 *
 * pi runs highlight.js over a block and paints the resulting scopes with its
 * theme tokens (`syntaxNumber: green`, `syntaxKeyword: blue`, `syntaxString:
 * orange`, `mdCodeBlock: green` for a block it cannot parse). A browser already
 * has the paint; what it lacks is the parse. That is all this file is: one
 * scanner, no grammar, no dependency.
 *
 * It is deliberately NOT a parser. It reads tokens — comments, strings, numbers,
 * keywords, names — which is what colouring needs and nothing more. A block it
 * gets wrong is still the same text; the difference is hue.
 *
 * Roles are named after pi's THEME TOKENS, not after another highlighter's, so
 * matching pi is a matter of hex values in one stylesheet rather than mapping
 * two grammars onto each other.
 */

export type TokenRole =
  | "comment"
  | "string"
  | "number"
  | "keyword"
  | "type"
  | "func"
  | "variable"
  | "punct"
  | "plain"

export interface Token {
  role: TokenRole
  text: string
}

type Family = "c" | "py" | "sh" | "css" | "sql" | "markup" | "json"

/** What we recognise, by the fence label an author writes. Anything absent is
 *  returned as `null` and the caller colours the block as ONE colour — exactly
 *  what pi does when highlight.js has no language for it. */
const FAMILY: Record<string, Family> = {
  bash: "sh",
  c: "c",
  cpp: "c",
  cs: "c",
  css: "css",
  dockerfile: "sh",
  go: "c",
  h: "c",
  hpp: "c",
  html: "markup",
  java: "c",
  js: "c",
  json: "json",
  jsx: "c",
  kotlin: "c",
  less: "css",
  makefile: "sh",
  php: "c",
  py: "py",
  python: "py",
  rb: "py",
  rs: "c",
  scss: "css",
  sh: "sh",
  shell: "sh",
  sql: "sql",
  swift: "c",
  toml: "py",
  ts: "c",
  tsx: "c",
  xml: "markup",
  yaml: "py",
  yml: "py",
  zsh: "sh",
}

/** Deliberately short lists: a wrong word costs one hue, a long list costs a
 *  maintenance promise nobody keeps. */
const C_KEYWORDS = new Set([
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "chan",
  "class",
  "const",
  "continue",
  "defer",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "finally",
  "fn",
  "for",
  "func",
  "function",
  "go",
  "if",
  "impl",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "match",
  "mod",
  "mut",
  "namespace",
  "new",
  "of",
  "package",
  "pub",
  "public",
  "private",
  "protected",
  "return",
  "sizeof",
  "static",
  "struct",
  "super",
  "switch",
  "template",
  "this",
  "throw",
  "try",
  "type",
  "typeof",
  "unsafe",
  "use",
  "var",
  "where",
  "while",
  "yield",
])

const PY_KEYWORDS = new Set([
  "and",
  "as",
  "async",
  "await",
  "break",
  "class",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
])

const SH_KEYWORDS = new Set([
  "&&",
  "case",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "fi",
  "for",
  "function",
  "if",
  "in",
  "local",
  "then",
  "until",
  "while",
])

/** Names that read as a type in every family we handle. Capitalised identifiers
 *  are covered separately. */
const TYPES = new Set([
  "array",
  "bigint",
  "bool",
  "boolean",
  "byte",
  "char",
  "dict",
  "double",
  "error",
  "f32",
  "f64",
  "false",
  "float",
  "i32",
  "i64",
  "int",
  "integer",
  "list",
  "map",
  "nil",
  "none",
  "null",
  "number",
  "object",
  "set",
  "str",
  "string",
  "struct",
  "true",
  "u32",
  "u64",
  "uint",
  "undefined",
  "usize",
  "void",
])

/** A handful of shell commands colour as functions, because a transcript's
 *  `bash` block is usually a line of commands and painting the verb is what
 *  makes it scannable. */
const SH_COMMANDS = new Set([
  "brew",
  "cat",
  "cd",
  "chmod",
  "curl",
  "docker",
  "find",
  "git",
  "grep",
  "ls",
  "mkdir",
  "node",
  "npm",
  "npx",
  "pi",
  "pnpm",
  "python",
  "python3",
  "rg",
  "rm",
  "sed",
  "sleep",
  "ssh",
  "tail",
  "tmux",
  "vitest",
  "vite",
])

const SQL_KEYWORDS = new Set([
  "and",
  "as",
  "begin",
  "by",
  "commit",
  "create",
  "delete",
  "distinct",
  "drop",
  "end",
  "from",
  "group",
  "having",
  "in",
  "index",
  "insert",
  "into",
  "join",
  "left",
  "like",
  "limit",
  "not",
  "null",
  "order",
  "rollback",
  "select",
  "set",
  "table",
  "transaction",
  "union",
  "update",
  "values",
  "where",
])

const IDENT = /^[A-Za-z_$@][A-Za-z0-9_$.-]*/
const NUMBER = /^(0x[\da-f]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?%?)/i
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\b/i

/**
 * Tokenise a code block. `null` means "no idea what language this is", and the
 * caller colours the whole block one colour, as pi does.
 */
export function tokenize(code: string, lang: string | null): Token[] | null {
  const family = lang ? FAMILY[lang.toLowerCase()] : undefined
  if (!family) return null
  const out: Token[] = []
  const push = (role: TokenRole, text: string): void => {
    if (text === "") return
    const last = out[out.length - 1]
    if (last && last.role === role) last.text += text
    else out.push({ role, text })
  }
  /** What follows, ignoring whitespace — how a name decides what it is. */
  const after = (at: number): string =>
    code.slice(at).match(/^\s*(.+)/)?.[1] ?? ""

  let i = 0
  while (i < code.length) {
    const rest = code.slice(i)
    const c = rest[0] as string

    // Whitespace keeps the block readable without a span per space.
    const ws = /^\s+/.exec(rest)
    if (ws) {
      push("plain", ws[0])
      i += ws[0].length
      continue
    }

    const comment = commentAt(rest, family)
    if (comment) {
      push("comment", comment)
      i += comment.length
      continue
    }

    // A CSS hex colour (`#a878d8`) is a value, not a comment start. Same `#`,
    // opposite meaning, and the family is the only thing that tells them apart.
    if (family === "css" || family === "markup") {
      const hex = HEX_COLOR.exec(rest)
      if (hex) {
        push("number", hex[0])
        i += hex[0].length
        continue
      }
    }

    if (c === '"' || c === "'" || c === "`") {
      const text = quotedAt(rest)
      // A JSON key, or a markup attribute on the left of a `:`, reads as a
      // name rather than a value.
      const asName =
        (family === "json" || family === "css") &&
        after(i + text.length).startsWith(":")
      push(asName ? "variable" : "string", text)
      i += text.length
      continue
    }

    if (family === "markup" && c === "<") {
      const tag = /^<\/?[A-Za-z][\w-]*/.exec(rest)
      if (tag) {
        push("punct", tag[0].startsWith("</") ? "</" : "<")
        push("keyword", tag[0].replace(/^<\/?/, ""))
        i += tag[0].length
        continue
      }
    }

    // Numbers in a script (`sleep 5`) are still numbers; the families that
    // treat a leading digit as part of a bare word are the exception, not the
    // rule, so only those skip this.
    if (/[0-9]/.test(c)) {
      const num = NUMBER.exec(rest)
      if (num) {
        push("number", num[0])
        i += num[0].length
        continue
      }
    }

    const word = IDENT.exec(rest)
    if (word) {
      const token = word[0]
      const next = after(i + token.length)
      push(classify(token, next, family), token)
      i += token.length
      continue
    }

    push("punct", c)
    i += 1
  }
  return out
}

function commentAt(rest: string, family: Family): string | null {
  const line = /^\/\/[^\n]*/.exec(rest)
  if (line && (family === "c" || family === "css" || family === "json"))
    return line[0]
  const block = /^\/\*[\s\S]*?(?:\*\/|$)/.exec(rest)
  if (block && (family === "c" || family === "css")) return block[0]
  const hash = /^#[^\n]*/.exec(rest)
  if (hash && (family === "sh" || family === "py")) return hash[0]
  const dash = /^--[^\n]*/.exec(rest)
  if (dash && family === "sql") return dash[0]
  const xml = /^<!--[\s\S]*?(?:-->|$)/.exec(rest)
  if (xml && family === "markup") return xml[0]
  return null
}

/** A quoted run, ending at the closing quote, an escaped quote, or the end of
 *  the line — whichever comes first. Never runs off the end of a block. */
function quotedAt(rest: string): string {
  const quote = rest[0] as string
  for (let j = 1; j < rest.length; j++) {
    if (rest[j] === "\\") {
      j++
      continue
    }
    if (rest[j] === quote) return rest.slice(0, j + 1)
    if (rest[j] === "\n") return rest.slice(0, j)
  }
  return rest
}

function classify(word: string, next: string, family: Family): TokenRole {
  const lower = word.toLowerCase()
  if (family === "sql") {
    if (SQL_KEYWORDS.has(lower)) return "keyword"
    return "plain"
  }
  if (family === "css") {
    if (word.startsWith("@")) return "keyword"
    if (next.startsWith(":") && !next.startsWith("::")) return "variable"
    // `color-mix(...)`, `var(...)` — a name before a parenthesis is a function
    // here too, which is the one thing hljs gets right about CSS that a
    // property rule alone misses.
    if (next.startsWith("(")) return "func"
    return "plain"
  }
  if (family === "sh") {
    if (SH_KEYWORDS.has(lower)) return "keyword"
    if (SH_COMMANDS.has(lower)) return "func"
    return "plain"
  }
  if (family === "py") {
    if (PY_KEYWORDS.has(lower)) return "keyword"
    if (TYPES.has(lower)) return "type"
    if (next.startsWith("(")) return "func"
    return "plain"
  }
  if (family === "markup") {
    if (next.startsWith("=")) return "variable"
    return "plain"
  }
  if (C_KEYWORDS.has(lower)) return "keyword"
  if (TYPES.has(lower)) return "type"
  // pi's theme paints a capitalised name as a type and a name before `(` as a
  // function, which covers most of what a transcript pastes without a grammar.
  if (next.startsWith("(")) return "func"
  if (/^[A-Z]/.test(word)) return "type"
  return "plain"
}
