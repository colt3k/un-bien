import { describe, expect, it } from "vitest"
import qrcode from "qrcode"
import { decodeBarcodes } from "../src/qr-decode.js"

/**
 * The decode seam, tested with no camera and no canvas.
 *
 * The QR is drawn here as a pixel grid from `qrcode`'s module matrix rather than
 * loaded from a committed PNG, because the thing under test is the pixels-in /
 * string-out contract — and a fixture file would only prove that some image once
 * decoded. The values are synthetic: never put a live pairing token in a test.
 */
const URI =
  "unbien://pair?t=ZmFrZXRva2VuMTIz&epk=2x8lJ4lGZ0qjP9Z7dVY1cQ&n=tmpunbien&rm=1iVugrrsyGRP"

type Rgba = { data: Uint8ClampedArray; width: number; height: number }

/**
 * Render a QR as RGBA at `px` pixels per module, with the 4-module quiet zone a
 * real code needs. `inverted` flips it to light-on-dark — what a terminal
 * actually shows, and the case a naive decoder silently fails on.
 */
function renderQr(text: string, px: number, inverted = false): Rgba {
  const qr = qrcode.create(text, { errorCorrectionLevel: "M" })
  const size = qr.modules.size
  const quiet = 4
  const dim = size + quiet * 2
  const width = dim * px
  const height = dim * px
  const bg: [number, number, number] = inverted ? [18, 18, 24] : [255, 255, 255]
  const fg: [number, number, number] = inverted ? [236, 236, 236] : [12, 12, 16]
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / px) - quiet
    for (let x = 0; x < width; x++) {
      const col = Math.floor(x / px) - quiet
      const on =
        row >= 0 &&
        row < size &&
        col >= 0 &&
        col < size &&
        qr.modules.get(col, row)
      const [r, g, b] = on ? fg : bg
      const i = (y * width + x) * 4
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = 255
    }
  }
  return { data, width, height }
}

describe("decodeBarcodes", () => {
  it("round-trips a pairing URI through the pixels", async () => {
    const image = renderQr(URI, 8)
    expect(await decodeBarcodes(image.data, image.width, image.height)).toEqual(
      [URI],
    )
  })

  it("reads the light-on-dark code a terminal shows", async () => {
    // The whole point of the feature: `qrcode-terminal` draws `█ ▀ ▄` on the
    // page background, which to a camera is an INVERTED QR. A decoder pinned to
    // dark-on-light returns null here and the user just sees "no QR found" on
    // the one screen they are standing in front of.
    const image = renderQr(URI, 8, true)
    expect(await decodeBarcodes(image.data, image.width, image.height)).toEqual(
      [URI],
    )
  })

  it("still reads a code that is small in the frame", async () => {
    // 2px per module is what a phone held at arm's length gives you: a ~200px
    // code inside a photo several thousand pixels wide. This is the pass the
    // bigger scales in `scalePlanFor` exist to catch.
    const image = renderQr(URI, 2)
    expect(await decodeBarcodes(image.data, image.width, image.height)).toEqual(
      [URI],
    )
  })

  it("returns nothing rather than throwing on a blank frame", async () => {
    const width = 320
    const height = 240
    const data = new Uint8ClampedArray(width * height * 4).fill(255)
    expect(await decodeBarcodes(data, width, height)).toEqual([])
  })

  it("returns nothing for a zero-sized image", async () => {
    expect(await decodeBarcodes(new Uint8ClampedArray(0), 0, 0)).toEqual([])
  })
})
