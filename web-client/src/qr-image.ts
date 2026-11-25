import { decodeBarcodes } from "./qr-decode.js"
import { scalePlanFor } from "./qr-scan.js"

/**
 * File → pixels → decoded strings. The only module in this feature that touches
 * a canvas, and deliberately dumb: every decision (which pass to try, whether a
 * result is a pairing code, what a failure means) lives in `qr-scan.ts` where it
 * can be tested.
 *
 * The image source is a `File` from `<input type="file" accept="image/*"
 * capture="environment">`, or from a paste. Not a camera stream: see the header
 * of `qr-scan.ts` for why the OS camera UI, not `getUserMedia`, is what this
 * client can rely on over plain http.
 */

/** Draw the image into a canvas capped at `maxDim` and hand back its pixels. */
function pixelsOf(
  source: CanvasImageSource,
  sourceW: number,
  sourceH: number,
  maxDim: number,
): ImageData | null {
  const scale = Math.min(1, maxDim / Math.max(sourceW, sourceH))
  const width = Math.max(1, Math.round(sourceW * scale))
  const height = Math.max(1, Math.round(sourceH * scale))
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(source, 0, 0, width, height)
  return ctx.getImageData(0, 0, width, height)
}

type ImageSource = {
  source: CanvasImageSource
  width: number
  height: number
  close?: () => void
}

/**
 * Decode the EXIF orientation with the pixels rather than correcting it later.
 *
 * A phone's photo is stored sideways with an orientation tag; a QR decoded from
 * the raw pixels is still a QR (the code is rotation-invariant), but the tag is
 * what the browser already knows how to honour, so asking for it costs nothing
 * and keeps the passes square-ish.
 */
async function loadBitmap(file: File): Promise<ImageSource> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file, {
      imageOrientation: "from-image",
    })
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close(),
    }
  }
  // Older Safari. Slower and it leaks an object URL until the page moves on,
  // which is the right trade for a once-per-machine flow on a browser this old.
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    return { source: img, width: img.width, height: img.height }
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}

/**
 * Every QR payload found in the image, plus what the attempt actually did.
 *
 * The extra fields exist for `?qrdebug`: on a phone the difference between "the
 * image never decoded", "it decoded at a size too small to read" and "the
 * browser could not open the file at all" is invisible from the UI, and each
 * needs different advice.
 */
export type ScanOutcome = {
  values: string[]
  width: number
  height: number
  passes: number[]
  ms: number
}

export async function readBarcodesFromFile(file: File): Promise<ScanOutcome> {
  const started = Date.now()
  const image = await loadBitmap(file)
  const passes: number[] = []
  try {
    for (const maxDim of scalePlanFor(image.width, image.height)) {
      passes.push(maxDim)
      const pixels = pixelsOf(image.source, image.width, image.height, maxDim)
      if (!pixels) continue
      const found = await decodeBarcodes(
        pixels.data,
        pixels.width,
        pixels.height,
      )
      if (found.length > 0)
        return {
          values: found,
          width: image.width,
          height: image.height,
          passes,
          ms: Date.now() - started,
        }
    }
    return {
      values: [],
      width: image.width,
      height: image.height,
      passes,
      ms: Date.now() - started,
    }
  } finally {
    image.close?.()
  }
}
