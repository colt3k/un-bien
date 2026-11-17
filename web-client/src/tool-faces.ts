/**
 * Tool card RESULT faces, ported from the app's reference
 * (`UnBienCore/Session/ToolFace.swift` + `ToolKinds.swift`).
 *
 * A card's result is drawn from the tool's declared result spec: the tool NAME
 * plus pi's canonical `{content, details?}` shape, identical on the live plane
 * and on replay. The built-in faces apply only when `details` validates against
 * that tool's declared keys — tool names are not unique across agents (pi-find
 * ships its own grep/find), so anything unexpected falls back to plain text
 * rather than a guess. That guard is the whole reason the face is a fact and not
 * a heuristic.
 *
 * `faceName` is the conformance projection's `blocks` field, so the corpus
 * checks this file directly.
 */

export type ToolCardState = "running" | "ok" | "failed"

export type ToolCategory =
  | "shell"
  | "reads"
  | "edits"
  | "writes"
  | "searches"
  | "codemode"
  | "mcp"
  | "agents"
  | "web"
  | "other"

export interface DiffLine {
  kind: "add" | "remove" | "context"
  oldLine?: number
  newLine?: number
  text: string
}

export interface DiffHunk {
  lines: DiffLine[]
}

export interface ScriptCall {
  name: string
  args: string
  status: string
  durationMs?: number
  error?: string
}

export type ToolFace =
  /** No settled result yet (a running call without partial text). */
  | { kind: "pending" }
  /** Shell output. `diff` is set when the output IS a unified diff (`git diff`). */
  | {
      kind: "terminal"
      text: string
      notices: string[]
      diff?: { hunks: DiffHunk[] }
    }
  /** A file read: the stored text as read, highlighted by `lang`. */
  | { kind: "file"; text: string; lang?: string; notices: string[] }
  /** An edit's diff from the record's patch. */
  | { kind: "diff"; hunks?: DiffHunk[]; confirmation?: string }
  /** A success line with nothing else to show (write). */
  | { kind: "confirmation"; text: string }
  /** Search / listing output: one entry per line. */
  | { kind: "lines"; text: string; notices: string[] }
  /** A codemode script's nested calls and its output, header removed. */
  | { kind: "script"; calls: ScriptCall[]; output: string }
  /** A failed call's error text. */
  | { kind: "error"; text: string }
  /** Prose (a fetched page, search results, an agent's report). */
  | { kind: "markdown"; text: string }
  /** Plain text: the result's text blocks joined (the universal fallback). */
  | { kind: "text"; text: string }

export interface ToolResultView {
  face: ToolFace
  category: ToolCategory
  /** pi-durable's `<harness>` diagnostics, one per `[severity] message`. */
  diagnostics: string[]
  /** A unified diff found in a text or script face's output. */
  outputDiff?: { hunks: DiffHunk[] }
  /** The conformance projection's `blocks` entry. */
  faceName: string
  /** Structured faces hide the raw arguments in the app's "rich results" mode. */
  structured: boolean
}

type Frame = Record<string, unknown>

// ── tool name families (ToolKinds) ───────────────────────────────────────────
// Whole names, or a family name followed by `_` (exec_command,
// run_terminal_cmd); a bare prefix would take show_*, share_*, run_tests or
// shopify_* for shell.

const BASH_TOOL =
  /^((bash|shell|zsh|sh|exec|command|terminal|powershell|pwsh)(_.*)?|run(_(terminal|shell|command)(_.*)?)?)$/i
const CODEMODE_TOOL = /^(codemode|mcpscript)/i
const READ_TOOL = /^(read|view|cat|open)(_(text_)?file)?$|^file_read$/i

export function isBashFamily(tool: string): boolean {
  return BASH_TOOL.test(tool)
}
export function isCodemodeFamily(tool: string): boolean {
  return CODEMODE_TOOL.test(tool)
}
export function isReadFamily(tool: string): boolean {
  return READ_TOOL.test(tool)
}

const EXT_LANG: Record<string, string> = {
  swift: "swift",
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  rb: "ruby",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  md: "markdown",
  markdown: "markdown",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  html: "xml",
  xml: "xml",
  css: "css",
  scss: "scss",
  sql: "sql",
  php: "php",
  lua: "lua",
  scala: "scala",
  dart: "dart",
  m: "objectivec",
  mm: "objectivec",
}

/** Highlight language for a path, or undefined when unknown (auto-detect). */
export function languageForPath(path: string): string | undefined {
  const match = /\.([A-Za-z0-9]+)$/.exec(path)
  if (!match) return undefined
  return EXT_LANG[match[1]!.toLowerCase()]
}

// ── output cleaning ──────────────────────────────────────────────────────────

// pi's utils/ansi.ts: OSC up to its string terminator, or a CSI sequence.
const ANSI =
  /(?:\x1B\][\s\S]*?(?:\x07|\x1B\\|\u009C))|[\x1B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g
// Control characters other than tab and newline, CR included.
const CONTROLS = /[\x00-\x08\x0B-\x1F\uFFF9-\uFFFB]/g

/** Tool output as pi's renderers show it: ANSI, control characters and carriage
 *  returns removed. Text without any of them is returned untouched. */
export function cleanOutput(text: string): string {
  let dirty = false
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x20 && code !== 0x0a && code !== 0x09) {
      dirty = true
      break
    }
    if (code === 0x9b || code === 0x9c || (code >= 0xfff9 && code <= 0xfffb)) {
      dirty = true
      break
    }
  }
  if (!dirty) return text
  return text.replace(ANSI, "").replace(CONTROLS, "")
}

// ── unified diff ─────────────────────────────────────────────────────────────

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/

/** Parse a unified diff into hunks, seeding line counters from each header.
 *  Preamble and `+++`/`---` markers are ignored. */
export function parseDiff(text: string): { hunks: DiffHunk[] } | undefined {
  const hunks: DiffHunk[] = []
  let current: DiffLine[] = []
  let inHunk = false
  let oldLine = 0
  let newLine = 0
  const flush = (): void => {
    if (inHunk) hunks.push({ lines: current })
  }
  for (const row of text.split("\n")) {
    const header = HUNK_HEADER.exec(row)
    if (header) {
      flush()
      current = []
      inHunk = true
      const parts = row.split(" ")
      oldLine = Number.parseInt(parts[1]!.slice(1).split(",")[0]!, 10)
      newLine = Number.parseInt(parts[2]!.slice(1).split(",")[0]!, 10)
      continue
    }
    if (!inHunk) continue
    if (row.startsWith("+++") || row.startsWith("---")) continue
    const marker = row[0]
    const body = row.slice(1)
    if (marker === "-") {
      current.push({ kind: "remove", oldLine, text: body })
      oldLine += 1
    } else if (marker === "+") {
      current.push({ kind: "add", newLine, text: body })
      newLine += 1
    } else if (marker === " ") {
      current.push({ kind: "context", oldLine, newLine, text: body })
      oldLine += 1
      newLine += 1
    }
  }
  flush()
  return hunks.length > 0 ? { hunks } : undefined
}

/** The parsed diff when output is a unified diff. A plain `@@ -` scan gates the
 *  parse, so output without one stays cheap. */
function outputDiffIn(text: string): { hunks: DiffHunk[] } | undefined {
  if (!hasHunkHeaderStart(text)) return undefined
  return parseDiff(text)
}

function hasHunkHeaderStart(text: string): boolean {
  const needle = "@@ -"
  let lineStart = true
  let matched = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (matched > 0 || lineStart) {
      if (ch === needle[matched]) {
        matched += 1
        if (matched === needle.length) return true
        lineStart = false
        continue
      }
      matched = 0
    }
    lineStart = ch === "\n"
  }
  return false
}

// ── trimming ─────────────────────────────────────────────────────────────────

/** Leading and trailing blank lines dropped (pi's renderers trim output); the
 *  first line's indentation is kept. */
function trimLines(text: string): string {
  let out = text
  while (out.length > 0 && /\s/.test(out[out.length - 1]!))
    out = out.slice(0, -1)
  for (;;) {
    const newline = out.indexOf("\n")
    if (newline < 0) break
    if (!/^[\s]*$/.test(out.slice(0, newline))) break
    out = out.slice(newline + 1)
  }
  return out
}

function trimTrailingEmptyLines(text: string): string {
  let out = text
  while (out.endsWith("\n")) out = out.slice(0, -1)
  return out
}

// ── resolve ──────────────────────────────────────────────────────────────────

export function toolCategory(tool: string): ToolCategory {
  if (isBashFamily(tool)) return "shell"
  if (isCodemodeFamily(tool)) return "codemode"
  if (isReadFamily(tool)) return "reads"
  if (tool === "edit") return "edits"
  if (tool === "write") return "writes"
  if (tool === "grep" || tool === "find" || tool === "ls") return "searches"
  if (tool === "mcp") return "mcp"
  if (
    tool === "subagent" ||
    tool === "get_subagent_result" ||
    tool === "steer_subagent" ||
    tool === "agent" ||
    tool === "Agent" ||
    tool === "task"
  )
    return "agents"
  if (/(^|_)web_(fetch|search)$/.test(tool)) return "web"
  return "other"
}

function faceName(face: ToolFace): string {
  switch (face.kind) {
    case "terminal":
      return face.diff ? "terminal-diff" : "terminal"
    case "file":
      return "file"
    case "diff":
      return "diff"
    case "confirmation":
      return "confirmation"
    case "lines":
      return "lines"
    case "script":
      return "script"
    case "markdown":
      return "markdown"
    case "error":
      return "error"
    case "pending":
      return "pending"
    case "text":
      return "text"
  }
}

const STRUCTURED = new Set([
  "terminal",
  "file",
  "diff",
  "confirmation",
  "lines",
  "script",
  "markdown",
])

/** The message of an `[error] …` harness diagnostic, undefined otherwise. */
export function errorMessage(diagnostic: string): string | undefined {
  return diagnostic.startsWith("[error] ")
    ? diagnostic.slice("[error] ".length)
    : undefined
}

/** A harness diagnostic as a notice: `[info]`/`[warn]` severities are dropped
 *  (pi shows the same notices bare); others are kept as given. */
export function noticeText(diagnostic: string): string {
  for (const prefix of ["[info] ", "[warn] "])
    if (diagnostic.startsWith(prefix)) return diagnostic.slice(prefix.length)
  return diagnostic
}

/** `details` validates when absent, null, or an object whose keys are all among
 *  the tool's declared ones (pi omits empty details, or stores `{}`). */
function detailsFit(details: unknown, keys: readonly string[]): boolean {
  if (details === undefined || details === null) return true
  if (typeof details !== "object" || Array.isArray(details)) return false
  const allowed = new Set(keys)
  return Object.keys(details).every((key) => allowed.has(key))
}

function textBlocks(result: unknown): string[] {
  const content = (result as Frame | undefined)?.content
  if (!Array.isArray(content)) return []
  const out: string[] = []
  for (const block of content) {
    const frame = block as Frame
    if (frame?.type === "text" && typeof frame.text === "string")
      out.push(frame.text)
  }
  return out
}

/** pi-durable's diagnostics block: the LAST text block, exactly
 *  `<harness>\n…\n</harness>`. Removed from the text, returned one entry per
 *  `[severity] message`; a line that does not open a severity continues the
 *  previous one. */
function takeHarnessBlock(texts: string[]): {
  rest: string[]
  diagnostics: string[]
} {
  const last = texts[texts.length - 1]
  if (
    last === undefined ||
    !last.startsWith("<harness>\n") ||
    !last.endsWith("\n</harness>")
  )
    return { rest: texts, diagnostics: [] }
  const rest = texts.slice(0, -1)
  const body = last.slice("<harness>\n".length, -"\n</harness>".length)
  const out: string[] = []
  for (const line of body.split("\n")) {
    if (/^\[[a-z]+\] /.test(line) || out.length === 0) out.push(line)
    else out[out.length - 1] += "\n" + line
  }
  return { rest, diagnostics: out.filter((line) => line.length > 0) }
}

/** The trailing notice block pi appends after a blank line: `…\n\n[notice]`. */
function splitNotice(text: string): { body: string; notices: string[] } {
  if (!text.endsWith("]")) return { body: text, notices: [] }
  const at = text.lastIndexOf("\n\n[")
  if (at < 0) return { body: text, notices: [] }
  const notice = text.slice(at + 3, text.length - 1)
  return { body: text.slice(0, at), notices: [notice] }
}

/** read's notices are recognised by their templates (a ranged read adds one
 *  with no `details`), so file text that merely ENDS in brackets is never cut. */
function splitReadNotice(text: string): { body: string; notices: string[] } {
  const { body, notices } = splitNotice(text)
  const notice = notices[0]
  if (notice === undefined) return { body: text, notices: [] }
  const templates = [
    /^\d+ more lines in file\. Use offset=\d+ to continue\.$/,
    /^Showing lines \d+-\d+ of \d+( \([^)]*\))?\. Use offset=\d+ to continue\.$/,
  ]
  const known = templates.some((pattern) => pattern.test(notice))
  return known ? { body, notices } : { body: text, notices: [] }
}

function stripScriptHeader(texts: string[], tool: string): string[] {
  const first = texts[0]
  if (
    !isCodemodeFamily(tool) ||
    first === undefined ||
    !/^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/.test(
      first,
    )
  )
    return texts
  return texts.slice(1)
}

function scriptCalls(details: unknown): ScriptCall[] | undefined {
  if (typeof details !== "object" || details === null) return undefined
  const fields = details as Frame
  const allowed = new Set(["calls", "fullOutputPath"])
  if (!Object.keys(fields).every((key) => allowed.has(key))) return undefined
  const calls = fields.calls
  if (!Array.isArray(calls)) return undefined
  const out: ScriptCall[] = []
  for (const raw of calls) {
    const call = raw as Frame
    const name = typeof call?.name === "string" ? call.name : undefined
    const status = typeof call?.status === "string" ? call.status : undefined
    if (name === undefined || status === undefined) return undefined
    out.push({
      name,
      args: typeof call.args === "string" ? call.args : "",
      status,
      ...(typeof call.durationMs === "number"
        ? { durationMs: call.durationMs }
        : {}),
      ...(typeof call.error === "string" ? { error: call.error } : {}),
    })
  }
  return out
}

function pathArg(args: Frame): string | undefined {
  for (const key of ["path", "file_path"])
    if (typeof args[key] === "string") return args[key] as string
  return undefined
}

/** Pretty-printed JSON, sorted keys — what the app shows for a result that is a
 *  bare object rather than pi's `{content, details?}`. */
function prettyString(value: unknown): string {
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted)
    if (value && typeof value === "object") {
      const out: Frame = {}
      for (const key of Object.keys(value).sort())
        out[key] = sorted((value as Frame)[key])
      return out
    }
    return value
  }
  try {
    return JSON.stringify(sorted(value), null, 2) ?? ""
  } catch {
    return ""
  }
}

function settledFace(
  tool: string,
  args: Frame,
  category: ToolCategory,
  texts: string[],
  joined: string,
  details: unknown,
): ToolFace {
  if (category === "shell") {
    if (!detailsFit(details, ["truncation", "fullOutputPath"]))
      return { kind: "text", text: trimLines(joined) }
    const split =
      (details as Frame | undefined)?.truncation !== undefined
        ? splitNotice(joined)
        : { body: joined, notices: [] as string[] }
    const text = trimLines(split.body)
    const diff = outputDiffIn(text)
    return {
      kind: "terminal",
      text,
      notices: split.notices,
      ...(diff ? { diff } : {}),
    }
  }
  if (category === "reads" && tool === "read") {
    if (!detailsFit(details, ["truncation"]))
      return { kind: "text", text: trimLines(joined) }
    const { body, notices } = splitReadNotice(joined)
    const lang = languageForPath(pathArg(args) ?? "")
    return {
      kind: "file",
      text: trimTrailingEmptyLines(body),
      ...(lang ? { lang } : {}),
      notices,
    }
  }
  if (category === "reads") {
    // Another agent's reader: text as read, highlighted by its path; its
    // details are not pi's, so no notices.
    const lang = languageForPath(pathArg(args) ?? "")
    return {
      kind: "file",
      text: trimTrailingEmptyLines(joined),
      ...(lang ? { lang } : {}),
      notices: [],
    }
  }
  if (category === "edits" && tool === "edit") {
    if (!detailsFit(details, ["diff", "patch", "firstChangedLine"]))
      return { kind: "text", text: trimLines(joined) }
    const patch = (details as Frame | undefined)?.patch
    const parsed = typeof patch === "string" ? parseDiff(patch) : undefined
    return {
      kind: "diff",
      ...(parsed ? { hunks: parsed.hunks } : {}),
      ...(joined.length > 0 ? { confirmation: joined } : {}),
    }
  }
  if (category === "writes" && tool === "write") {
    if (!detailsFit(details, []))
      return { kind: "text", text: trimLines(joined) }
    return { kind: "confirmation", text: trimLines(joined) }
  }
  if (category === "searches") {
    const allowed: Record<string, string[]> = {
      grep: ["truncation", "matchLimitReached", "linesTruncated"],
      find: ["truncation", "resultLimitReached"],
      ls: ["truncation", "entryLimitReached"],
    }
    const keys = allowed[tool]
    if (!keys || !detailsFit(details, keys))
      return { kind: "text", text: trimLines(joined) }
    const flagged =
      details !== undefined &&
      details !== null &&
      Object.keys(details as Frame).length > 0
    const split = flagged
      ? splitNotice(joined)
      : { body: joined, notices: [] as string[] }
    return {
      kind: "lines",
      text: trimLines(split.body),
      notices: split.notices,
    }
  }
  if (category === "codemode") {
    return {
      kind: "script",
      calls: scriptCalls(details) ?? [],
      output: trimLines(stripScriptHeader(texts, tool).join("\n")),
    }
  }
  if (category === "web" || category === "agents") {
    const text = trimLines(joined)
    return text.length === 0
      ? { kind: "text", text }
      : { kind: "markdown", text }
  }
  return { kind: "text", text: trimLines(joined) }
}

export function resolveToolResult(options: {
  tool: string
  args: Frame
  result: unknown
  state: ToolCardState
}): ToolResultView {
  const { tool, result, state } = options
  const args = options.args ?? {}
  const category = toolCategory(tool)
  const split = takeHarnessBlock(textBlocks(result))
  const texts = split.rest.map(cleanOutput)
  const joined = texts.join("\n")
  const details = (result as Frame | undefined)?.details

  let face: ToolFace
  let outputDiff: { hunks: DiffHunk[] } | undefined
  if (state === "running") {
    // Partial output streams as it arrives: shell as terminal text, anything
    // else (an agent's progress) as plain text.
    const text = trimLines(joined)
    face =
      text.length === 0
        ? { kind: "pending" }
        : category === "shell"
          ? { kind: "terminal", text, notices: [] }
          : { kind: "text", text }
  } else if (state === "failed") {
    const text = trimLines(stripScriptHeader(texts, tool).join("\n"))
    const reasons = split.diagnostics
      .map(errorMessage)
      .filter((value): value is string => value !== undefined)
    face = {
      kind: "error",
      text: [text, ...reasons].filter((part) => part.length > 0).join("\n\n"),
    }
  } else {
    const isBareObject =
      typeof result === "object" &&
      result !== null &&
      !Array.isArray(result) &&
      !("content" in (result as Frame))
    face = isBareObject
      ? // Not a {content, details?} result (a foreign tool returning a bare
        // object): its JSON is all there is to show. A result that is a bare
        // STRING (the corpus's `"ok"`) is NOT this — it falls through to the
        // tool's own face, which is how an edit with args-only history still
        // resolves to a diff card.
        { kind: "text", text: prettyString(result) }
      : settledFace(tool, args, category, texts, joined, details)
    if (face.kind === "text") outputDiff = outputDiffIn(face.text)
    else if (face.kind === "script") outputDiff = outputDiffIn(face.output)
  }

  const name = faceName(face)
  return {
    face,
    category,
    diagnostics: split.diagnostics,
    ...(outputDiff ? { outputDiff } : {}),
    faceName: name,
    structured: STRUCTURED.has(name),
  }
}

/** The conformance projection for a card: the face, plus "hunks" when the card
 *  carries a diff — from its own patch or from the `aux` sidecar the extension
 *  rides on the envelope (the corpus's edit scenario has only that). */
export function projectionBlocks(
  view: ToolResultView,
  cardHunks?: unknown[],
): string[] {
  const fromFace =
    view.face.kind === "diff"
      ? (view.face.hunks?.length ?? 0) > 0
      : view.face.kind === "terminal"
        ? (view.face.diff?.hunks.length ?? 0) > 0
        : false
  return fromFace || (cardHunks?.length ?? 0) > 0
    ? [view.faceName, "hunks"]
    : [view.faceName]
}
