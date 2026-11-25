/**
 * Decode QR codes out of raw RGBA pixels.
 *
 * This is the seam that keeps the camera out of the interesting code: it takes
 * pixels in and gives decoded strings out, so it runs under vitest with no DOM,
 * no canvas and no camera. Everything above it (`qr-image.ts`) is plumbing that
 * turns a `File` into pixels; everything below it is `jsQR`.
 *
 * The return type is an ARRAY even though `jsQR` reports at most one code,
 * because the browser's own `BarcodeDetector` reports several, and the pairing
 * URI has to be picked out of whatever was decoded. Keeping the plural shape
 * here is what lets the live-viewfinder path reuse this classification instead
 * of restating it.
 */

let decoder: (typeof import("jsqr"))["default"] | undefined

/** Whether the chunk is in the page. `?qrdebug` prints it: a scan that fails
 *  before the decoder ever arrived is a loading problem, not a photo problem. */
export function decoderLoaded(): boolean {
  return decoder !== undefined
}

/**
 * Load the decoder once per page.
 *
 * `jsQR` is ~128 KB minified / ~47 KB gzipped against a client whose whole
 * bundle is 168 KB / 55 KB. A static import would double the payload every
 * visitor pays for a feature used once per machine, so the import is dynamic
 * and Vite splits it into a chunk fetched only when someone taps "scan". This
 * warm-up puts the fetch inside the camera handover — the OS shutter UI, the
 * "allow" prompt — where the network has somewhere to hide, rather than as a
 * stall after the photo is already in hand.
 */
export async function warmDecoder(): Promise<void> {
  if (decoder) return
  decoder = (await import("jsqr")).default
}

/** Decoded payloads, in the order they were found. Empty when nothing decoded. */
export async function decodeBarcodes(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<string[]> {
  if (width <= 0 || height <= 0) return []
  const jsQR = decoder ?? (await import("jsqr")).default
  // `attemptBoth` is jsQR's own default, but it is load-bearing here rather than
  // a default to lean on: the code being scanned is drawn by `qrcode-terminal`
  // in a terminal, which is usually light blocks on a dark background — an
  // INVERTED QR to a camera. `dontInvert` would decode the screenshot off a
  // light page and fail on the screen that is the whole point of the feature.
  const result = jsQR(rgba, width, height, { inversionAttempts: "attemptBoth" })
  return result && typeof result.data === "string" ? [result.data] : []
}
