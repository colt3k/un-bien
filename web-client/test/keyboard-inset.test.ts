import { describe, expect, it } from "vitest"
import {
  ANDROID_KEYBOARD_SLACK_PX,
  bottomGapPx,
  bottomLimitPx,
  browserLabel,
  insetForLimitPx,
  DEFAULT_BOTTOM_GAP_PX,
  isAndroidUserAgent,
  keyboardInsetPx,
  keyboardProbeLines,
  keyboardSlackPx,
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

describe("bottomLimitPx", () => {
  // The numbers off a real phone on the https origin (Chrome/158, Android,
  // `?kbdebug`): innerHeight 891, visualViewport 891 (not resized, because
  // overlaysContent is on), keyboard rect y 510 height 381.
  it("uses the keyboard's own top exactly", () => {
    // No margin here on purpose. The rectangle is accurate; the air a field
    // needs is the composer's own bottom padding (`--bottom-gap`), which is
    // visible without a phone. A constant in this file could only be tuned on a
    // device, and that is the loop this breaks.
    expect(
      bottomLimitPx({
        keyboardTop: 510,
        visualHeight: 891,
        visualOffsetTop: 0,
        slack: 0,
      }),
    ).toBe(510)
    expect(
      insetForLimitPx({
        layoutHeight: 891,
        bottomLimit: bottomLimitPx({
          keyboardTop: 510,
          visualHeight: 891,
          visualOffsetTop: 0,
          slack: 0,
        }),
      }),
    ).toBe(381)
  })

  it("takes the viewport's line when the keyboard will not say", () => {
    // The http path: no API, so the viewport arithmetic carries it, and the
    // Android slack is what pays for Android's under-count.
    expect(
      bottomLimitPx({
        keyboardTop: null,
        visualHeight: 509,
        visualOffsetTop: 0,
        slack: ANDROID_KEYBOARD_SLACK_PX,
      }),
    ).toBe(509 - ANDROID_KEYBOARD_SLACK_PX)
  })

  it("takes whichever line is higher when both are known", () => {
    expect(
      bottomLimitPx({
        keyboardTop: 700,
        visualHeight: 509,
        visualOffsetTop: 0,
        slack: 0,
      }),
    ).toBe(509)
    expect(
      bottomLimitPx({
        keyboardTop: 400,
        visualHeight: 509,
        visualOffsetTop: 0,
        slack: 0,
      }),
    ).toBe(400)
  })

  it("moves nothing when neither source is known", () => {
    expect(
      bottomLimitPx({
        keyboardTop: null,
        visualHeight: Number.NaN,
        visualOffsetTop: 0,
        slack: 0,
      }),
    ).toBe(Number.POSITIVE_INFINITY)
  })
})

describe("bottomGapPx", () => {
  it("reads the stylesheet's number", () => {
    expect(bottomGapPx(" 16px ")).toBe(16)
    expect(bottomGapPx("24")).toBe(24)
  })

  it("falls back to the default, never to zero", () => {
    // Zero is the flush layout the gap exists to prevent, so an unreadable
    // declaration must not quietly produce it.
    expect(bottomGapPx("")).toBe(DEFAULT_BOTTOM_GAP_PX)
    expect(bottomGapPx(null)).toBe(DEFAULT_BOTTOM_GAP_PX)
    expect(bottomGapPx("auto")).toBe(DEFAULT_BOTTOM_GAP_PX)
    expect(bottomGapPx("-8")).toBe(DEFAULT_BOTTOM_GAP_PX)
  })
})

describe("isAndroidUserAgent", () => {
  it("recognises the platform the short keyboard happens on", () => {
    expect(
      isAndroidUserAgent(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
      ),
    ).toBe(true)
  })

  it("is not iOS, and not a desktop browser", () => {
    expect(
      isAndroidUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      ),
    ).toBe(false)
    expect(
      isAndroidUserAgent(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      ),
    ).toBe(false)
  })
})

describe("keyboardSlackPx", () => {
  it("is owed on Android when the line came from the viewport arithmetic", () => {
    // The phone that started this: no VirtualKeyboard API (an untrusted
    // certificate hides a secure-context-only API), a keyboard the viewport
    // admits to, and the keys ~14px higher than the arithmetic says.
    expect(
      keyboardSlackPx({
        isAndroid: true,
        limitFromViewport: true,
        keyboardReported: true,
      }),
    ).toBe(ANDROID_KEYBOARD_SLACK_PX)
  })

  it("is not owed when the keyboard itself said where it is", () => {
    expect(
      keyboardSlackPx({
        isAndroid: true,
        limitFromViewport: false,
        keyboardReported: true,
      }),
    ).toBe(0)
  })

  it("is not owed with no keyboard, nor on iOS where the arithmetic is honest", () => {
    expect(
      keyboardSlackPx({
        isAndroid: true,
        limitFromViewport: true,
        keyboardReported: false,
      }),
    ).toBe(0)
    expect(
      keyboardSlackPx({
        isAndroid: false,
        limitFromViewport: true,
        keyboardReported: true,
      }),
    ).toBe(0)
  })

  it("clears the measured shortfall with room to spare", () => {
    // Two screenshots put the deficit at 13-15px; the floor has to cover the
    // larger of them even if the measurement is a pixel or two out.
    expect(ANDROID_KEYBOARD_SLACK_PX).toBeGreaterThan(15)
  })
})

describe("browserLabel", () => {
  it("names the engine family the readout needs to see", () => {
    expect(
      browserLabel(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
      ),
    ).toBe("Chrome/131.0.0.0")
    expect(
      browserLabel(
        "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/122.0.0.0 Mobile Safari/537.36",
      ),
    ).toBe("SamsungBrowser/25.0")
    expect(
      browserLabel(
        "Mozilla/5.0 (Android; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0",
      ),
    ).toBe("Firefox/131.0")
  })
})

describe("keyboardProbeLines", () => {
  it("says which source set the line, and what the phone is missing", () => {
    const lines = keyboardProbeLines({
      innerHeight: 891,
      visualHeight: 509,
      visualOffsetTop: 0,
      visualScale: 1,
      dynamicViewportHeight: 891,
      safeAreaBottom: 0,
      keyboardRect: null,
      overlaysContent: null,
      secureContext: false,
      browser: browserLabel(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
      ),
      slack: ANDROID_KEYBOARD_SLACK_PX,
      bottomLimit: 489,
      inset: 402,
      composerBottom: 489,
      composerHeight: 58,
      composerPadBottom: 16,
      fieldHeight: 42,
      fieldBottom: 473,
      keyboardTop: null,
      focused: "input",
    })
    expect(lines.join("\n")).toContain("virtualKeyboard overlays=n/a")
    expect(lines.join("\n")).toContain("secure context false")
    expect(lines.join("\n")).toContain("Chrome/131.0.0.0")
    expect(lines.join("\n")).toContain("android slack 20px")
    expect(lines.join("\n")).toContain("gap to keyboard (no keyboard)")
    expect(lines.join("\n")).toContain(
      "bottom limit 489px   viewport claim 382px   painted 402px",
    )
  })

  it("keeps every line short enough to read on a phone", () => {
    // The panel's whole job is to be legible in one screenshot. A line that
    // wraps past the panel's width loses the value someone opened the URL to
    // read — which is exactly what `clearance 20px` did on a real phone.
    const lines = keyboardProbeLines({
      innerHeight: 891,
      visualHeight: 891,
      visualOffsetTop: 0,
      visualScale: 1,
      dynamicViewportHeight: 891,
      safeAreaBottom: 0,
      keyboardRect: { top: 510, height: 381 },
      overlaysContent: true,
      secureContext: true,
      browser: browserLabel(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Mobile Safari/537.36",
      ),
      slack: 0,
      bottomLimit: 510,
      inset: 381,
      composerBottom: 509,
      composerHeight: 58,
      composerPadBottom: 16,
      fieldHeight: 42,
      fieldBottom: 493,
      keyboardTop: 510,
      focused: "input",
    })
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(56)
    }
    expect(lines.join("\n")).toContain("secure context true")
    // The number that makes "it looks tight" answerable without a phone.
    expect(lines.join("\n")).toContain("gap to keyboard 17px")
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
