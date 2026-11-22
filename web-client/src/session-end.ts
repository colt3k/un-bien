/**
 * Ending a session from the browser — the remote equivalent of typing `/quit`
 * in a local pi window.
 *
 * The wire already speaks it: `ub {type:"terminate", id, reason?}`, which the
 * machine answers with its graceful host shutdown (abort a running turn, then
 * shut the session down) rather than by killing a process. The browser was the
 * missing half.
 *
 * Gating belongs to the machine, twice over: it advertises `remote_terminate`
 * only while its own config allows remote terminate, and it re-checks that
 * config when the frame arrives. So the client offers the control when the
 * capability is present — and says plainly when the machine stays silent,
 * instead of pretending the click did something.
 */

/** The capability that says "this session may be ended from here". */
export const TERMINATE_CAP = "remote_terminate"

/**
 * How long to wait for the relay's `room_ended` before admitting the machine
 * ignored the request. A machine that refuses never answers at all (its gate is
 * checked before anything is sent back), so this window exists only to bound how
 * long the browser is allowed to look like it is doing something.
 */
export const TERMINATE_QUIET_MS = 4000

/** How long the confirmation stays armed before the button goes back to being
 *  an idle control. Ending a session is destructive and unrecoverable — a
 *  mis-click should cost a second click, never a session. */
export const END_CONFIRM_MS = 5000

export interface EndControlState {
  /** A session is open in the transcript. */
  attached: boolean
  /** The caps its machine advertised for it. */
  caps: readonly string[]
  /** That session is known to have ended. Its caps stay in the client's memory
   *  after the room is gone, so without this the control would sit there
   *  offering to end a session that is already over. */
  ended: boolean
}

/**
 * Whether to offer the control. A control room advertises `remote_launch` and
 * `is_daemon` but never `remote_terminate`, and a session with the setting off
 * does not either — so this one test covers both cases without naming either.
 */
export function canEndSession(state: EndControlState): boolean {
  return state.attached && !state.ended && state.caps.includes(TERMINATE_CAP)
}

export const END_LABELS = {
  idle: "end",
  armed: "sure?",
  sent: "ending…",
  title: "end this session on the machine, the way /quit does locally",
} as const

export const END_REASON = "ended from the browser"

/** What to say when the machine never answered. It names the setting, because
 *  "it didn't work" sends the reader hunting through docs. */
export function refusalNotice(): string {
  return "the machine did not end the session — remote terminate is off there (its /unbien settings)"
}
