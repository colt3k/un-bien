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

/**
 * What a refused remote launch means, in terms the user can act on.
 *
 * The machine sends only a code (`session_launch_result.code`,
 * extension/src/launch.ts). `permission_denied` alone tells you nothing about
 * which of the two gates refused — the folder's `allow_remote_launch` flag or
 * the `launch.dirs` allow-list — and both are fixed in different files. So the
 * code is mapped to the setting that owns it. Unknown codes get the raw code,
 * never a guess.
 */
export function launchFailureHint(code: string): string {
  switch (code) {
    case "remote_launch_disabled":
      return "remote launch is off for that folder — set allow_remote_launch true in its .pi/un-bien/config.json, or defaults.allow_remote_launch in the machine's un-bien.json"
    case "permission_denied":
      return "that folder is outside the machine's launch.dirs allow-list (~/.pi/agent/extensions/un-bien.json)"
    case "cwd_missing":
      return "that folder does not exist on the machine — launch in its parent and create it there"
    case "unknown_peer":
      return "this device is not paired on that machine — run /unbien pair again"
    case "backend_missing":
      return "the machine has no tmux/herdr/Rex on PATH — install one, then re-run unbien-admin install to refresh the service PATH"
    case "backend_unavailable":
      return "the configured launch backend is not running (a Rex server the launcher will not start itself)"
    case "spawn_failed":
      return "the machine could not start pi in that folder"
    case "exited_early":
      return "pi died within 20s of starting — the machine reported its output tail"
    default:
      return code
        ? `the machine refused the launch (code ${code})`
        : "the machine refused the launch"
  }
}
