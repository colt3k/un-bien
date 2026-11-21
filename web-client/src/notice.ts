/**
 * Toast text shaping.
 *
 * The toast box is a fixed, centred, amber-outlined panel above the composer.
 * When it was shown with an empty string it rendered as a small empty pill —
 * visible, alarming, and saying nothing. Both halves are fixed here: no
 * message reaches the toast empty, and an error with no `message` still
 * produces something you can act on.
 */

/** Turn any thrown value into text worth showing. Never returns "". */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const message = err.message.trim()
    if (message) return message
    // An Error with no message still has a name and usually a stack. "Error at
    // App.pair (app.ts:471)" is a clue; an empty toast is not.
    const frame = firstFrame(err.stack)
    const name = err.name?.trim() || "Error"
    return frame ? `${name} at ${frame}` : name
  }
  if (typeof err === "string") return err.trim() || "unknown error"
  if (err === null || err === undefined) return "unknown error"
  try {
    const text = JSON.stringify(err)
    return text && text !== '""' && text !== "{}" ? text : "unknown error"
  } catch {
    return "unknown error"
  }
}

/** The innermost stack line that names a call site, if there is one. */
function firstFrame(stack: string | undefined): string {
  if (!stack) return ""
  for (const line of stack.split("\n").slice(1)) {
    const frame = line.trim()
    if (frame && frame !== "<anonymous>") return frame
  }
  return ""
}

/**
 * Text for the toast stack, or null when there is nothing to say. The caller
 * must not render null — that is what produced the empty amber pill.
 */
export function toastMessage(message: string): string | null {
  const text = message?.trim() ?? ""
  return text === "" ? null : text
}
