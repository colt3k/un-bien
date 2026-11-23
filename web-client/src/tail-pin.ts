/**
 * The tail pin: the standing decision to keep the reader at the newest line.
 *
 * The client used to decide this by measuring, once per render, how far the
 * scroll box sat from its bottom
 * (`scrollHeight - scrollTop - clientHeight < 220`, `render()`). That question
 * is "where is the scroll right now", not "is the reader following the output",
 * and the two disagree exactly when it matters. While a model streams, deltas
 * land every ~100ms; a reader who drags 100px up is still inside the band, so
 * the next delta pins them back to the bottom, and the one after that, and the
 * one after that. Their gesture and the app fight, and the app wins every time
 * — on a phone, where a flick starts from zero, scrolling up mid-turn looks
 * impossible rather than merely hard.
 *
 * So this is a STATE with two writers, the same shape the iOS app settled on
 * (`shouldPin`, `app/Sources/UnBienApp/Views/TranscriptView.swift`):
 *
 * - **Disarm on reader intent.** Any deliberate move into history stops the
 *   follow: a wheel up, a finger drag, a scrollbar drag, PageUp. No band and no
 *   threshold — 10px of intent is intent. This is what ends the fight: the very
 *   first event of the gesture takes the pin off, so nothing moves under the
 *   reader's own scroll.
 * - **Arm on arriving at the newest line.** The scroll lands at the bottom of
 *   what is drawn, the reader presses "jump to end", or they send a message.
 *
 * Content growth never touches it. A pinned reader keeps being pinned as the
 * answer grows; an unpinned reader keeps their place however much lands above
 * or below them, and gets it back by scrolling down to the end — which is the
 * same rule that re-arms the follow, so there is no mode to learn.
 */

/** Within this many px of the bottom edge of the scroll box counts as "at the
 *  newest line". Deliberately small: the pin re-arms when the reader has
 *  actually arrived, not when they get vaguely close. (The old band was 220px —
 *  a third of a phone viewport, and the whole reason an upward scroll was
 *  undone.) */
export const ARRIVE_PX = 8

/** A scroll event smaller than this is rounding or a browser correction, not a
 *  reader moving. */
const NOISE_PX = 2

/** Pixels from the bottom edge of the scroll box to the bottom of its content.
 *  0 (or a hair negative, with sub-pixel layout) means the newest drawn row is
 *  sitting on the fold. */
export function belowTail(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
): number {
  return scrollHeight - scrollTop - clientHeight
}

/** The reader moved the scroll box by `delta` (positive = toward the newest
 *  line) and now sits `below` px from its bottom.
 *
 *  Arrival outranks everything: it is the re-arm. Moving away from the bottom
 *  is the disarm. Anything else — a drift toward the bottom that stops short,
 *  or no movement at all — leaves the decision alone, which is the point of
 *  calling it a policy rather than a measurement. */
export function pinAfterScroll(
  prev: boolean,
  delta: number,
  below: number,
): boolean {
  if (below <= ARRIVE_PX) return true
  if (delta < -NOISE_PX) return false
  return prev
}

/** Is there a wheel/touch/key gesture asking to read earlier content?
 *  `deltaY` is in the usual "positive = toward the bottom" sense.
 *
 *  `canScrollUp` guards a trap: with the whole log inside the viewport there is
 *  nothing above to move into, so a scroll up is not "leave the tail" — and
 *  disarming there would let the next rows land below the fold with no gesture
 *  left to reach them (the "jump to end" pill would be the only way out, for a
 *  reader who never saw anything move). */
export function gestureDisarms(deltaY: number, canScrollUp: boolean): boolean {
  return canScrollUp && deltaY < 0
}

/** The keys that mean "read earlier". PageDown/End are not here: they move
 *  toward the tail, and `pinAfterScroll` arms when one lands on it. */
export function keyDisarms(key: string): boolean {
  return key === "PageUp" || key === "Home" || key === "ArrowUp"
}
