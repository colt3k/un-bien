/**
 * A deliberately small markdown parser for transcript text.
 *
 * Two reasons it is hand-rolled rather than a dependency: this client has no
 * rendering framework and stays auditable at a glance, and — more important —
 * the text here is UNTRUSTED (it is whatever a remote machine streamed). The
 * parser never produces HTML strings: it returns plain data, and the view turns
 * that data into elements with text nodes, so a `<script>` in a transcript is
 * text forever and a `[x](javascript:…)` link cannot become an href.
 *
 * Scope is what transcripts actually contain: fenced code, headings, lists,
 * blockquotes, rules, paragraphs, and inline code / bold / emphasis / links.
 * Anything else is text. Tables and nested lists are out of scope on purpose —
 * the transcript is a log, not a document.
 */

/** Mirrors the app's `markdownBudget` (TranscriptRowViews.swift:284): past this
 *  many characters the text is shown as-is rather than parsed, because the cost
 *  of parsing a 100 KB dump into the scroll area is paid by every keystroke of a
 *  live stream. */
export const MARKDOWN_BUDGET = 32_000

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "bold"; text: string }
  | { type: "em"; text: string }
  | { type: "link"; text: string; href: string }

export type Block =
  | { type: "code"; lang: string | null; text: string }
  | { type: "heading"; level: number; inline: Inline[] }
  | { type: "list"; ordered: boolean; items: Inline[][] }
  | { type: "quote"; inline: Inline[] }
  | { type: "rule" }
  | { type: "para"; inline: Inline[] }

/** Schemes a link may use. `javascript:` and friends are the reason this list
 *  exists: the label of a link is model text, and the href is too. */
const SAFE_LINK_SCHEMES = /^https?:\/\/|^mailto:/i

export function parseMarkdown(text: string): Block[] {
  const blocks: Block[] = []
  const lines = text.split("\n")
  // `noUncheckedIndexedAccess` means every read can be undefined; the parser
  // walks with a cursor, so one accessor keeps that honest in one place.
  const at = (i: number): string => lines[i] ?? ""
  let index = 0

  while (index < lines.length) {
    const line = at(index)

    if (line.trim() === "") {
      index += 1
      continue
    }

    // Fenced code: nothing inside is parsed, which is the whole point of a fence.
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)/)
    if (fence) {
      const marker = (fence[1] ?? "`")[0] ?? "`"
      const lang = fence[2] || null
      const close = new RegExp(`^\\s{0,3}\\${marker}{3,}\\s*$`)
      const body: string[] = []
      index += 1
      while (index < lines.length && !close.test(at(index))) {
        body.push(at(index))
        index += 1
      }
      index += 1 // the closing fence, or past the end of the text
      blocks.push({ type: "code", lang, text: body.join("\n") })
      continue
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/)
    if (heading) {
      blocks.push({
        type: "heading",
        level: (heading[1] ?? "#").length,
        inline: parseInline(heading[2] ?? ""),
      })
      index += 1
      continue
    }

    if (/^\s{0,3}(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: "rule" })
      index += 1
      continue
    }

    if (/^\s{0,3}>/.test(line)) {
      const quoted: string[] = []
      while (index < lines.length && /^\s{0,3}>/.test(at(index))) {
        quoted.push(at(index).replace(/^\s{0,3}>\s?/, ""))
        index += 1
      }
      blocks.push({ type: "quote", inline: parseInline(quoted.join("\n")) })
      continue
    }

    const bullet = /^\s{0,3}[-*+]\s+(.*)$/.exec(line)
    const numbered = /^\s{0,3}\d+[.)]\s+(.*)$/.exec(line)
    if (bullet || numbered) {
      const ordered = Boolean(numbered)
      const pattern = ordered
        ? /^\s{0,3}\d+[.)]\s+(.*)$/
        : /^\s{0,3}[-*+]\s+(.*)$/
      const items: Inline[][] = []
      while (index < lines.length) {
        const match = pattern.exec(at(index))
        if (!match) break
        items.push(parseInline(match[1] ?? ""))
        index += 1
      }
      blocks.push({ type: "list", ordered, items })
      continue
    }

    // Paragraph: consecutive plain lines, kept as one block so a wrapped
    // sentence does not become a column of one-word lines.
    const para: string[] = []
    while (
      index < lines.length &&
      at(index).trim() !== "" &&
      !/^\s{0,3}(`{3,}|~{3,}|#{1,6}\s|>|[-*+]\s|\d+[.)]\s)/.test(at(index)) &&
      !/^\s{0,3}(\*{3,}|-{3,}|_{3,})\s*$/.test(at(index))
    ) {
      para.push(at(index))
      index += 1
    }
    blocks.push({ type: "para", inline: parseInline(para.join("\n")) })
  }

  return blocks
}

/** Inline pass. Order matters: a code span is taken first so `**not bold**`
 *  inside backticks stays literal, and a link label is parsed as text rather
 *  than re-entering the link rule. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  let rest = text

  const push = (value: string): void => {
    if (value) out.push({ type: "text", text: value })
  }

  while (rest.length > 0) {
    const code = /`([^`\n]+)`/.exec(rest)
    const bold = /\*\*([^*\n]+)\*\*|__([^_\n]+)__/.exec(rest)
    const em = /(^|[\s(])\*([^*\n]+)\*|(^|[\s(])_([^_\n]+)_/.exec(rest)
    const link = /\[([^\]\n]*)\]\(([^)\s]+)\)/.exec(rest)

    const candidates = [
      code && { at: code.index, kind: "code", match: code },
      link && { at: link.index, kind: "link", match: link },
      bold && { at: bold.index, kind: "bold", match: bold },
      em && { at: em.index, kind: "em", match: em },
    ].filter((c): c is NonNullable<typeof c> => c !== null && c.at >= 0)

    if (candidates.length === 0) {
      push(rest)
      break
    }
    candidates.sort((a, b) => a.at - b.at)
    const first = candidates[0]
    if (!first) {
      push(rest)
      break
    }

    push(rest.slice(0, first.at))
    if (first.kind === "code") {
      out.push({ type: "code", text: first.match[1] ?? "" })
    } else if (first.kind === "link") {
      const href = first.match[2] ?? ""
      const label = first.match[1] ?? ""
      if (SAFE_LINK_SCHEMES.test(href)) {
        out.push({ type: "link", text: label || href, href })
      } else {
        // Unsafe scheme: the label survives, the destination does not.
        push(`[${label}]`)
      }
    } else if (first.kind === "bold") {
      out.push({ type: "bold", text: first.match[1] ?? first.match[2] ?? "" })
    } else {
      // The emphasis rule matches a leading boundary (a space or bracket) so
      // `_snake_case_` mid-word is not emphasis; that boundary is part of the
      // match, so it has to go back into the text before the emphasis starts.
      push(first.match[1] ?? first.match[3] ?? "")
      out.push({ type: "em", text: first.match[2] ?? first.match[4] ?? "" })
    }
    rest = rest.slice(first.at + (first.match[0] ?? "").length)
  }

  // Adjacent text tokens are an artifact of the scanning order, not structure:
  // merging them keeps the view's node count at the number of things the reader
  // sees.
  const merged: Inline[] = []
  for (const token of out) {
    const previous = merged[merged.length - 1]
    if (token.type === "text" && previous && previous.type === "text")
      previous.text += token.text
    else merged.push(token)
  }
  return merged
}
