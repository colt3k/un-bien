/**
 * Alias target for the core's `session/debug_log.js`, a FILE-backed diagnostic
 * (`<state>/envelope-debug.log`) the detached extension writes when
 * `debug.envelope` is set.
 *
 * Aliasing the SPECIFIER (not just `node:fs`) does two things: it keeps a
 * browser bundle from pulling the extension's config → paths → `node:fs` chain,
 * and it leaves the core's logging call sites untouched, so a future core
 * change can't silently drag node code back in.
 */
const ENABLED =
  typeof localStorage !== "undefined" &&
  localStorage.getItem("unbien.debug") === "1"

export function envLog(message: string): void {
  if (!ENABLED) return
  console.debug(`[unbien] ${message}`)
}
