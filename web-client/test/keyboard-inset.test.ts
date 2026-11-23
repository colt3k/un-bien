import { describe, expect, it } from "vitest"
import {
  insetForLimitPx,
  keyboardInsetPx,
  keyboardTopFromRectPx,
  liftForPokePx,
} from "../src/keyboard-inset.js"

describe("keyboardInsetPx", () => {
  it("is the keyboard's height when only the visual viewport shrank", () => {
    // The shape every mobile browser now uses (Safari on iOS always; Chrome on
    // Android since 108): the page is still laid out against 852px, and 300px of
    // it is under the keys.
    expect(
      keyboardInsetPx({
        layoutHeight: 852,
        visualHeight: 552,
        visualOffsetTop: 0,
      }),
    ).toBe(300)
  })

  it("is 0 with no keyboard up", () => {
    expect(
      keyboardInsetPx({
        layoutHeight: 852,
        visualHeight: 852,
        visualOffsetTop: 0,
      }),
    ).toBe(0)
  })

  it("is 0 when the browser shrank the layout viewport too", () => {
    // `interactive-widget=resizes-content`, and Android before Chrome 108: both
    // viewports move together, so the difference answers 0 and the composer is
    // not lifted twice.
    expect(
      keyboardInsetPx({
        layoutHeight: 552,
        visualHeight: 552,
        visualOffsetTop: 0,
      }),
    ).toBe(0)
  })

  it("is 0 when overlaysContent handed us the keyboard to place ourselves", () => {
    // The Chromium path: the viewport deliberately does not move, so this source
    // has nothing to say and `insetForLimitPx` carries the answer.
    expect(
      keyboardInsetPx({
        layoutHeight: 891,
        visualHeight: 891,
        visualOffsetTop: 0,
      }),
    ).toBe(0)
  })

  it("does not count a pan the browser already made", () => {
    // Some browsers pan the layout viewport up to reveal the focused field. That
    // 40px of the keyboard's claim has been spent; counting it again would leave
    // a strip of dead panel above the keys.
    expect(
      keyboardInsetPx({
        layoutHeight: 852,
        visualHeight: 552,
        visualOffsetTop: 40,
      }),
    ).toBe(260)
  })

  it("refuses a negative claim", () => {
    // Reported visible area taller than the layout viewport — fractional device
    // scale factors round this way — must not stretch the app past the screen.
    expect(
      keyboardInsetPx({
        layoutHeight: 851,
        visualHeight: 852,
        visualOffsetTop: 0,
      }),
    ).toBe(0)
  })

  it("refuses a nonsense claim", () => {
    expect(
      keyboardInsetPx({
        layoutHeight: Number.NaN,
        visualHeight: 552,
        visualOffsetTop: 0,
      }),
    ).toBe(0)
  })

  it("hands back whole pixels, rounded away from the keyboard", () => {
    // 299.4px of claim. Rounding to nearest would shave 0.4px off the lift and
    // leave a sliver of the composer under the keys; the extra fraction of a
    // pixel of panel above them is invisible.
    expect(
      keyboardInsetPx({
        layoutHeight: 851.6,
        visualHeight: 552.2,
        visualOffsetTop: 0,
      }),
    ).toBe(300)
  })
})

describe("keyboardTopFromRectPx", () => {
  it("reads the keyboard's top out of the rectangle the browser offers", () => {
    // The phone that started this: 891px of layout viewport, the keys' top at
    // 481px — 28px higher than the visual viewport ever admitted.
    expect(keyboardTopFromRectPx({ top: 481, height: 410 }, 0)).toBe(481)
  })

  it("puts a visual-viewport rectangle back into layout coordinates", () => {
    expect(keyboardTopFromRectPx({ top: 441, height: 410 }, 40)).toBe(481)
  })

  it("is null when the keyboard is away", () => {
    expect(keyboardTopFromRectPx({ top: 0, height: 0 }, 0)).toBeNull()
    expect(keyboardTopFromRectPx(null, 0)).toBeNull()
    expect(keyboardTopFromRectPx(undefined, 0)).toBeNull()
  })

  it("is null when the rectangle cannot be trusted", () => {
    expect(
      keyboardTopFromRectPx({ top: Number.NaN, height: 410 }, 0),
    ).toBeNull()
    expect(keyboardTopFromRectPx({ top: 0, height: 410 }, 0)).toBeNull()
  })
})

describe("insetForLimitPx", () => {
  it("is the distance from the line to the bottom of the layout viewport", () => {
    expect(insetForLimitPx({ layoutHeight: 891, bottomLimit: 481 })).toBe(410)
  })

  it("is 0 when the line is already at or below the bottom", () => {
    expect(insetForLimitPx({ layoutHeight: 891, bottomLimit: 891 })).toBe(0)
    expect(insetForLimitPx({ layoutHeight: 891, bottomLimit: 1200 })).toBe(0)
  })

  it("is 0 when there is no line to aim at", () => {
    expect(insetForLimitPx({ layoutHeight: 891, bottomLimit: NaN })).toBe(0)
    expect(
      insetForLimitPx({
        layoutHeight: 891,
        bottomLimit: Number.POSITIVE_INFINITY,
      }),
    ).toBe(0)
  })

  it("rounds away from the keyboard", () => {
    expect(insetForLimitPx({ layoutHeight: 891.4, bottomLimit: 481 })).toBe(411)
  })
})

describe("liftForPokePx", () => {
  it("leaves the inset alone when the box is already clear", () => {
    expect(
      liftForPokePx({ inset: 300, boxBottom: 552, bottomLimit: 552 }),
    ).toBe(300)
    expect(
      liftForPokePx({ inset: 300, boxBottom: 480, bottomLimit: 552 }),
    ).toBe(300)
  })

  it("pays for what still hangs below the line", () => {
    // The CSS base (`100dvh`) taller than the height the claim was computed from
    // leaves exactly this: the composer 48px past the line the page took for the
    // bottom of the screen.
    expect(
      liftForPokePx({ inset: 300, boxBottom: 600, bottomLimit: 552 }),
    ).toBe(348)
  })

  it("rounds a fraction of a pixel of debt upward", () => {
    expect(
      liftForPokePx({ inset: 300, boxBottom: 552.3, bottomLimit: 552 }),
    ).toBe(301)
  })

  it("refuses a measurement that is not a number", () => {
    expect(
      liftForPokePx({
        inset: 300,
        boxBottom: Number.NaN,
        bottomLimit: 552,
      }),
    ).toBe(300)
  })

  it("converges: pay the debt once, measure again, owe nothing", () => {
    // A different fault than the limit catches: the CSS base (`100dvh` = 920px)
    // taller than the height the inset was computed from (`innerHeight` = 891px).
    // Aiming at the line gives 382px, which lands the composer at 538px — 29px
    // past the 509px line. Pass 1 pays; pass 2 measures nothing left.
    const bottomLimit = 509
    const baseHeight = 920
    let inset = insetForLimitPx({ layoutHeight: 891, bottomLimit })
    for (let pass = 0; pass < 3; pass++) {
      const next = liftForPokePx({
        inset,
        boxBottom: baseHeight - inset,
        bottomLimit,
      })
      if (next === inset) break
      inset = next
    }
    expect(inset).toBe(411)
    expect(baseHeight - inset).toBe(bottomLimit)
  })
})
