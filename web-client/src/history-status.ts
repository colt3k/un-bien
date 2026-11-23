/**
 * What a history read came back with, in the reader's words.
 *
 * The transcript walk (`session-client.getEntries`) can stop early, and it used
 * to stop SILENTLY. Two ways that happens:
 *
 * - the machine ANSWERS `get_entries` with an error, because pi has no session
 *   bound to this peer yet — the extension throws on purpose rather than serve a
 *   silent empty page ("a silent empty page on the fork side reads as 'no
 *   history'", extension/src/session/rpc_handlers.ts); on a slow connection the
 *   reader's frames reach the machine before the attach finishes, so this is a
 *   race, not a verdict;
 * - a page never answers, and the request times out.
 *
 * Both used to leave zero rows on screen while the header said
 * "`name` · synced" — a blank column, no reason, and no way out except
 * detaching. The header also cannot say "synced" in that state: the sync
 * protocol did finish, the transcript did not. This turns the walk's outcome
 * into a short header label and a sentence for the transcript area, and says
 * plainly which of the four situations the reader is in.
 */

export interface HistoryRead {
  /** Rows the fold produced from whatever arrived. */
  rows: number
  /** Pages of the walk that actually came back. */
  pages: number
  /** Whether the walk ran to the end (an empty final page). */
  complete: boolean
  /** The machine's own words, when it answered with an error. */
  error?: string
  /** The walk stopped because a page never answered. */
  timedOut?: boolean
}

export type HistoryOutcome =
  /** The whole history is on screen. */
  | "full"
  /** Some rows arrived, then the walk stopped. */
  | "partial"
  /** Nothing arrived, and the reason is the machine or the link. */
  | "failed"
  /** The walk finished cleanly and the session really has no entries. */
  | "empty-session"

/**
 * Which of the four situations this is. `empty-session` is deliberately separate
 * from `failed`: a session that has just been launched legitimately has no
 * entries, and telling that reader "the machine did not answer" would be a lie
 * that sends them hunting for a network problem that does not exist.
 */
export function historyOutcome(read: HistoryRead): HistoryOutcome {
  const blamed = Boolean(read.error) || Boolean(read.timedOut) || !read.complete
  if (read.rows > 0) return blamed ? "partial" : "full"
  return blamed ? "failed" : "empty-session"
}

/** The header's short label, or null when "synced" is the honest word. */
export function historyLabel(read: HistoryRead): string | null {
  switch (historyOutcome(read)) {
    case "full":
    case "empty-session":
      return null
    case "partial":
      return "history incomplete"
    case "failed":
      return "no history loaded"
  }
}

/**
 * The sentence in the transcript area. The machine's own error text is quoted
 * rather than paraphrased: "no session bound" points at a machine that is still
 * coming up, which is a different thing to fix than a link that is too slow.
 */
export function historyDetail(read: HistoryRead): string | null {
  switch (historyOutcome(read)) {
    case "full":
      return null
    case "empty-session":
      return "This session has no entries yet."
    case "partial":
      return `Only part of the history arrived — ${read.rows} rows after ${read.pages} page${read.pages === 1 ? "" : "s"}, then the read stopped.${blame(read)}`
    case "failed":
      return `No history loaded.${blame(read)} The conversation is still there on the machine.`
  }
}

function blame(read: HistoryRead): string {
  if (read.error) {
    // Quoted, then closed with its own punctuation: the machine's sentence runs
    // straight into ours otherwise, and the reader cannot tell where the quote
    // ends.
    const said = read.error.trim()
    return ` The machine said: ${said.endsWith(".") ? said : `${said}.`}`
  }
  if (read.timedOut) return " The machine did not answer in time."
  return ""
}

/** Offer the retry control? A full read and a genuinely empty session have
 *  nothing to retry; everything else might do better the second time — a
 *  machine that had not bound the session a moment ago usually has. */
export function historyRetryable(read: HistoryRead): boolean {
  const outcome = historyOutcome(read)
  return outcome === "partial" || outcome === "failed"
}
