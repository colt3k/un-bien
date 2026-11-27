/**
 * Breaking a line in the composer without sending.
 *
 * Enter sends. Shift+Enter does not — `app.ts` gates the send on
 * `!event.shiftKey`, and the textarea's own default then inserts the break.
 * That is the whole mechanism, and it is unreachable on a soft keyboard: Gboard
 * and SwiftKey give you a Shift you TAP, not one you rest a thumb on, so the
 * modifier is never held down at the moment Enter is pressed. A hardware
 * keyboard is fine. A phone is not, and on a phone the only other way to put a
 * newline in the box is to type it somewhere else and paste it.
 *
 * So the break gets a control of its own. The insertion lives here rather than
 * in the view because it is the part with edge cases — a caret in the middle of
 * the text, a selection being replaced, an empty field — and the view has no
 * way to exercise any of them.
 */

export type ComposerCaret = {
  value: string
  selectionStart: number
  selectionEnd: number
}

/** Insert one line break at the caret and say where the caret ends up.
 *
 *  A selection is REPLACED, not preserved: a highlighted range is what the user
 *  is about to do something to, and the caret marks where they are working.
 *
 *  The caret lands AFTER the break, so the next keystroke types on the new
 *  line — what every editor does, and what the user expects from a key labelled
 *  like a return.
 *
 *  The indices are clamped rather than trusted. `selectionStart` and
 *  `selectionEnd` are numbers the element reports, and a value written from a
 *  draft restore can leave them past the end of the text; slicing there would
 *  not throw, it would quietly insert in the wrong place.
 */
export function insertNewlineAt(c: ComposerCaret): {
  value: string
  caret: number
} {
  const start = Math.max(0, Math.min(c.selectionStart, c.value.length))
  const end = Math.max(start, Math.min(c.selectionEnd, c.value.length))
  return {
    value: c.value.slice(0, start) + "\n" + c.value.slice(end),
    caret: start + 1,
  }
}
