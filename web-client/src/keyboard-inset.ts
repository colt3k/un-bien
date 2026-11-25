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
 *    actually is. That is the exact answer, and the only one.
 * 2. The visual viewport: `innerHeight − visualHeight − offsetTop`. Correct on
 *    iOS, ~14px short on Android.
 * 3. Where the bottom box ENDED UP (`liftForPokePx`): whatever still hangs below
 *    the line is added to the inset. This is the catch-all for the rest of the
 *    arithmetic disagreements — `100dvh` not matching `innerHeight`, fractional
 *    scale factors, a pan the browser made.
 *
 * The API is not always there to ask. One phone that reported this bug had no
 * `navigator.virtualKeyboard` at all, and the reason is now settled rather than
 * suspected: the API is gated to secure contexts. Measured on the same browser,
 * two origins — `http://192.168.1.86:4173` reports `isSecureContext false` and
 * `virtualKeyboard undefined`; `https://<node>.tailnet.ts.net` reports `true` and
 * `object`. Serving the client over https therefore SWITCHES which source the
 * inset comes from, and the two sources disagree by about 20px of clearance —
 * which is how a fixed bug came back without the fix being touched. `?kbdebug`
 * prints `secure context …` precisely so this is checked rather than assumed.
 * When the API is absent the viewport arithmetic is all that is left, and that is
 * what `keyboardSlackPx` pays for: a small measured floor, on Android only, used
 * when the line came from the viewport rather than from the keyboard itself.
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
 * What Android's viewport arithmetic is short by, when it is the only source.
 *
 * Measured, not guessed: two screenshots of the same phone (891px of layout
 * viewport, keyboard up), calibrated against the on-screen readout's own numbers
 * — the composer's top at 451px and its top border at 460px — put the keyboard's
 * toolbar strip at 494px and 496px while `visualViewport` said 509px. So the box
 * was 13-15px under the keys, and the number is stable across both shots.
 *
 * 20 rather than 14: the measurement is good to a pixel or two, and Gboard's
 * toolbar strip is not one height across versions and layouts. The cost is a
 * 20px gap between the composer and the keys on an Android browser that was
 * already telling the truth, which is a much worse bug to have than the one it
 * prevents. It never applies where the keyboard's own rectangle was used, nor on
 * iOS, where the arithmetic is honest.
 */
export const ANDROID_KEYBOARD_SLACK_PX = 20

/**
 * The layout's own bottom breathing room, as declared in CSS (`--bottom-gap`).
 *
 * The gap between a field and the keyboard IS the gap the field keeps from the
 * bottom of the screen, so it is read from the stylesheet instead of duplicated
 * here: one number, defined where its effect is visible without a phone in
 * sight. A missing or unparseable value falls back to the stylesheet's default
 * rather than to 0 — 0 is exactly the flush layout this exists to prevent.
 */
export const DEFAULT_BOTTOM_GAP_PX = 16

export function bottomGapPx(declared: string | null | undefined): number {
  const n = Number.parseFloat(declared ?? "")
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_BOTTOM_GAP_PX
}

/**
 * The line the app's bottom edge must not cross.
 *
 * Two candidates, one per source, and the higher (smaller) wins:
 *
 *   - the viewport's bottom, minus `ANDROID_KEYBOARD_SLACK_PX` when Android's
 *     arithmetic is the only thing we have;
 *   - the keyboard's own top, exactly, when the browser admitted where it is.
 *
 * With `overlaysContent` on, the first candidate is the whole viewport — the
 * browser was told not to resize it — so the rectangle is the only thing that
 * pulls the line up. With the API absent, the rectangle is absent and the
 * viewport carries the whole answer. `Infinity` when neither is known, which
 * means "do not move the bottom of the app".
 *
 * **No margin is added to the rectangle, deliberately.** The rectangle is
 * accurate — measured on the https origin (Chrome/158, Android, `innerHeight
 * 891`): it reported the keyboard at `y 510 height 381`, and Gboard's toolbar
 * strip lands on the pixel that arithmetic predicts. What looked wrong was not
 * the measurement but the layout: the app's bottom edge parked one pixel above
 * the keys, and a text field flush against any edge reads as a covered one.
 *
 * Breathing room is a property of the layout, not of the keyboard, so it lives
 * in the stylesheet as `--bottom-gap` — the same padding that lifts the composer
 * off the bottom of the screen when no keyboard is up. One number, visible on a
 * desktop with no phone in sight. A constant here could only be tuned by loading
 * the page on a device, which is how it became a number we kept adjusting;
 * `?kbdebug` prints the resulting `gap to keyboard` so the next adjustment
 * starts from a measurement rather than a screenshot.
 */
export function bottomLimitPx(f: {
  keyboardTop: number | null
  visualHeight: number
  visualOffsetTop: number
  slack: number
}): number {
  const fromViewport = f.visualHeight + f.visualOffsetTop - f.slack
  const fromRect = f.keyboardTop ?? Number.POSITIVE_INFINITY
  const limit = Math.min(fromViewport, fromRect)
  return Number.isFinite(limit) ? limit : Number.POSITIVE_INFINITY
}

/**
 * Whether this is an Android browser — the platform Android's keyboard
 * under-counting happens on. Used for that and nothing else; there is no
 * capability signal for "the reported keyboard is short".
 */
export function isAndroidUserAgent(userAgent: string): boolean {
  return /\bandroid\b/i.test(userAgent)
}

/**
 * Whether that floor is owed right now.
 *
 * `limitFromViewport` is the important condition: the API can be present and its
 * rectangle absent, and then the line we are using is the arithmetic, arithmetic
 * which Android is known to be short on.
 *
 * `keyboardReported` must NOT be derived from the viewport's claim. With
 * `overlaysContent` on — which is exactly when the rectangle is the source — the
 * browser was told not to resize the viewport, so that claim is structurally 0
 * and a keyboard that is plainly up reads as "none". Either source saying
 * "keyboard" is enough.
 *
 * `isAndroid` is a user-agent test. There is no capability signal for "this
 * browser under-counts its keyboard", which is what a workaround for a browser
 * bug needs, so the platform is the signal. It is used for nothing else.
 */
export function keyboardSlackPx(facts: {
  isAndroid: boolean
  limitFromViewport: boolean
  keyboardReported: boolean
}): number {
  if (!facts.isAndroid || !facts.limitFromViewport || !facts.keyboardReported)
    return 0
  return ANDROID_KEYBOARD_SLACK_PX
}

/**
 * The browser's name and version, trimmed out of the user agent for the readout.
 *
 * Only ever printed, so it can stay crude: the first token that names the engine
 * family, which is what tells you whether to expect `virtualKeyboard` at all.
 */
export function browserLabel(userAgent: string): string {
  const token = userAgent
    .split(/[ ()]/)
    .find((part) =>
      /^(Chrome|EdgA|Edg|Firefox|FxiOS|CriOS|SamsungBrowser)\//.test(part),
    )
  return token ?? userAgent.slice(0, 24)
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
  secureContext: boolean
  browser: string
  slack: number
  bottomLimit: number
  inset: number
  composerBottom: number
  composerHeight: number
  /** The padding the stylesheet actually applied. That padding is the whole
   *  mechanism for keeping the field off the keyboard, so print it: a screenshot
   *  where the field is flush means this number is a lie somewhere between the
   *  stylesheet and the painted pixel. */
  composerPadBottom: number
  /** Bottom of the field the person is looking at (`#input`). The gap has to be
   *  measured to that, not to the composer's box, which sits lower. */
  fieldBottom: number
  fieldHeight: number
  keyboardTop: number | null
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
    `secure context ${facts.secureContext}  ${facts.browser}`,
    // Two lines, not one: on a phone the combined line wrapped past the panel's
    // width and the value being read (`clearance 20px`) fell off the edge — the
    // one number the screenshot was taken to show. Each line here has to survive
    // a 360px-wide screen.
    `android slack ${px(facts.slack)}`,
    `bottom limit ${px(facts.bottomLimit)}   viewport claim ${px(claimed)}   painted ${px(facts.inset)}`,
    // The number that answers "is it too tight?" without a phone in the room.
    `gap to keyboard ${
      facts.keyboardTop === null
        ? "(no keyboard)"
        : px(facts.keyboardTop - facts.fieldBottom)
    }`,
    `env safe-area-inset-bottom ${px(facts.safeAreaBottom)}`,
    `composer top ${px(facts.composerBottom - facts.composerHeight)}  bottom ${px(facts.composerBottom)}  pad ${px(facts.composerPadBottom)}`,
    `field h ${px(facts.fieldHeight)}  bottom ${px(facts.fieldBottom)}`,
    `focused ${facts.focused}`,
  ]
}
