/**
 * Where the bottom of the screen really is.
 *
 * `#app` is `100dvh` tall and the composer is its last flex item, so the message
 * box sits at the bottom of the LAYOUT viewport. A soft keyboard is not folded
 * out of that viewport — it is painted over it. Since Chrome 108 Android does
 * this the way iOS always has: the keyboard shrinks only the VISUAL viewport,
 * leaving the layout viewport, `100dvh`, and every fixed-position box exactly
 * where they were. The field being typed into is therefore the thing the keyboard
 * ends up on top of, which is backwards: it is the one thing that must stay in
 * sight.
 *
 * The answer is one line — the bottom edge the app must not cross, in layout
 * coordinates — and the trouble is finding it, because the browser's own number
 * for it lies on Android. Measured on a Pixel-class phone (891px of layout
 * viewport) with Chrome's keyboard up: `visualViewport` reported 509px, so the
 * claim came out at 382px, and the keys started at ~481px — 28px higher. The keys
 * take over the strip the gesture navigation bar owned, so Chrome credits itself
 * for that strip and shrinks the viewport by LESS than the keyboard covers.
 * `env(safe-area-inset-bottom)` reads 0 there, so it cannot be recovered either.
 *
 * Three sources, in order of trust:
 *
 * 1. `navigator.virtualKeyboard.boundingRect` (Chromium), with `overlaysContent =
 *    true` so the browser stops resizing the viewport and says where its keyboard
 *    actually is. That is the only number that knows about the navigation-bar
 *    credit.
 * 2. The visual viewport: `innerHeight − visualHeight − offsetTop`. Correct on
 *    iOS, short on Android.
 * 3. Where the bottom box ENDED UP (`liftForPokePx`): whatever still hangs below
 *    the line is added to the inset. This is the catch-all for the rest of the
 *    arithmetic disagreements — `100dvh` not matching `innerHeight`, fractional
 *    scale factors, a pan the browser made.
 *
 * `interactive-widget=resizes-content` (the viewport-meta switch for this) is
 * deliberately not used: it is Chromium-only, so it would fix Android and leave
 * iOS broken, and on the browsers that honour it the two viewports shrink
 * together — which source 2 answers with 0, so nothing is counted twice.
 */

/**
 * The keyboard's claim as read off the two viewports (source 2 above).
 *
 * `layoutHeight` is what the page is laid out against (`window.innerHeight`),
 * `visualHeight` and `visualOffsetTop` come from `visualViewport`. The offset is
 * subtracted because a browser that has panned the layout viewport down has spent
 * part of that height already; counting it twice would lift the composer off the
 * keyboard's edge and leave a strip of dead panel.
 *
 * Zero when the keyboard is away — when the browser shrank the layout viewport
 * along with it — and when `overlaysContent` is on, because then the viewport is
 * deliberately not resized at all. Clamped rather than allowed to go negative: a
 * browser reporting the visible area taller than the layout one (rounding at a
 * fractional device scale factor does this) would otherwise stretch the app past
 * the bottom of the screen.
 */
export function keyboardInsetPx(input: {
  layoutHeight: number
  visualHeight: number
  visualOffsetTop: number
}): number {
  const claimed =
    input.layoutHeight - input.visualHeight - input.visualOffsetTop
  return Number.isFinite(claimed) && claimed > 0 ? Math.ceil(claimed) : 0
}

/** The part of a keyboard's rectangle this page reads. */
export type KeyboardRect = { top: number; height: number }

/**
 * The slice of the VirtualKeyboard API the page uses. It is Chromium-only, and a
 * typed version of it is not in every TypeScript's `lib.dom`, so the shape is
 * declared here rather than imported.
 */
export interface VirtualKeyboardLike {
  overlaysContent: boolean
  readonly boundingRect: KeyboardRect
  addEventListener(type: "geometrychange", listener: () => void): void
}

/**
 * The keyboard's top edge in layout coordinates, from the VirtualKeyboard API
 * (source 1), or null when the browser will not say.
 *
 * The rectangle is relative to the visual viewport, so `visualOffsetTop` puts it
 * back into the coordinates the rest of the page is measured in. A keyboard that
 * is away reports zero height — that is the common case, not an error.
 */
export function keyboardTopFromRectPx(
  rect: KeyboardRect | null | undefined,
  visualOffsetTop: number,
): number | null {
  if (!rect || !Number.isFinite(rect.top) || !(rect.height > 0)) return null
  const top = visualOffsetTop + rect.top
  return Number.isFinite(top) && top > 0 ? top : null
}

/**
 * The inset that puts the bottom of the app on a given line.
 *
 * `bottomLimit` is the line the app's bottom edge must not cross: the keyboard's
 * top when the browser admits where that is, otherwise the bottom of the visible
 * viewport. Zero when the line is already at or past the bottom.
 */
export function insetForLimitPx(input: {
  layoutHeight: number
  bottomLimit: number
}): number {
  if (
    !Number.isFinite(input.layoutHeight) ||
    !Number.isFinite(input.bottomLimit)
  )
    return 0
  const needed = input.layoutHeight - input.bottomLimit
  return needed > 0 ? Math.ceil(needed) : 0
}

/**
 * Pay for whatever still hangs below the line.
 *
 * `inset` is what has already been subtracted, `boxBottom` is where the box that
 * ends the app (the composer) actually sits after that subtraction, and
 * `bottomLimit` is the line it must not cross. If the box hangs below it, the
 * inset was short by the difference — by however much the browser's arithmetic
 * was wrong, whatever the reason.
 *
 * Called repeatedly until it returns the same number: each pass moves the box by
 * the last pass's debt, so it converges in two, three at most. It never lowers an
 * inset already paid, and it refuses a non-finite measurement rather than
 * inventing a lift.
 */
export function liftForPokePx(input: {
  inset: number
  boxBottom: number
  bottomLimit: number
}): number {
  const pokedOut = input.boxBottom - input.bottomLimit
  if (!Number.isFinite(pokedOut) || pokedOut <= 0) return input.inset
  return input.inset + Math.ceil(pokedOut)
}

/**
 * The numbers worth reading when a keyboard is wrong on a real phone.
 *
 * A dev-only readout (`?kbdebug`), because the interesting quantities are the
 * ones a phone refuses to agree about, and a screenshot of this panel answers in
 * one round trip what a laptop can only guess at. Keep it to facts, one per line,
 * each named so it can be read off the phone without a console.
 */
export function keyboardProbeLines(facts: {
  innerHeight: number
  visualHeight: number
  visualOffsetTop: number
  visualScale: number
  dynamicViewportHeight: number
  safeAreaBottom: number
  keyboardRect: KeyboardRect | null
  overlaysContent: boolean | null
  bottomLimit: number
  inset: number
  composerBottom: number
  composerHeight: number
  focused: string
}): string[] {
  const px = (n: number) => `${Math.round(n)}px`
  const claimed = keyboardInsetPx({
    layoutHeight: facts.innerHeight,
    visualHeight: facts.visualHeight,
    visualOffsetTop: facts.visualOffsetTop,
  })
  const keyboard =
    facts.keyboardRect && facts.keyboardRect.height > 0
      ? `y ${px(facts.keyboardRect.top)} height ${px(facts.keyboardRect.height)}`
      : "(none)"
  return [
    `innerHeight ${px(facts.innerHeight)}   dvh ${px(facts.dynamicViewportHeight)}`,
    `visualViewport ${px(facts.visualHeight)}  scale ${facts.visualScale}  offsetTop ${px(facts.visualOffsetTop)}`,
    `virtualKeyboard overlays=${facts.overlaysContent === null ? "n/a" : facts.overlaysContent}  ${keyboard}`,
    `bottom limit ${px(facts.bottomLimit)}   viewport claim ${px(claimed)}   painted ${px(facts.inset)}`,
    `env safe-area-inset-bottom ${px(facts.safeAreaBottom)}`,
    `composer top ${px(facts.composerBottom - facts.composerHeight)}  bottom ${px(facts.composerBottom)}`,
    `focused ${facts.focused}`,
  ]
}
