import { parseInvite } from "./invite.js"
import { describeError } from "./notice.js"
import type { ScanAttempt } from "./store.js"

/**
 * The decisions behind scanning a pairing QR with a phone camera.
 *
 * Deliberately free of DOM, camera and canvas: what a camera actually produces
 * is a photo of a terminal, and the interesting questions are all answerable
 * without one — did anything decode, is what decoded a pairing code, and what
 * does each failure look like in a sentence. `qr-image.ts` is the thin layer
 * that touches `File`s and pixels; `app.ts` only paints the outcomes.
 *
 * Why a photo and not a live viewfinder: `getUserMedia` is restricted to secure
 * contexts, and this client is routinely served over plain `http` on a LAN or
 * tailnet host (`http://box.tailnet.ts.net:5173`), where `navigator.mediaDevices`
 * is simply absent. A file input with `capture="environment"` opens the same OS
 * camera and is NOT gated, so pairing from a phone works today, before the
 * `https` page + `wss` relay a live scanner needs.
 */

/**
 * What a decode attempt produced.
 *
 * `other` is a separate outcome from `empty` on purpose. "The camera saw a
 * barcode that is not a pairing code" and "nothing was recognised" need
 * different sentences: the first means you are pointing at the wrong QR (a
 * package label, a Wi-Fi code), the second means the photo is too far, too
 * blurry or too dark.
 */
export type ScanVerdict =
  | { kind: "pair"; uri: string }
  | { kind: "empty" }
  | { kind: "other"; sample: string }

/** How much of a foreign payload to quote back. Enough to recognise, not a wall. */
const SAMPLE_CHARS = 60

/**
 * Pick the pairing code out of whatever the image yielded.
 *
 * Parsing is the test, not a `unbien:` prefix match: a code that starts right
 * but is missing `epk` is a mis-scan, and it should read as "that is not a
 * pairing code" rather than being sent at a relay that will refuse it.
 */
export function classifyScan(values: readonly string[]): ScanVerdict {
  const usable = values.filter((v) => typeof v === "string" && v.trim())
  if (usable.length === 0) return { kind: "empty" }
  for (const value of usable) {
    try {
      parseInvite(value)
      return { kind: "pair", uri: value.trim() }
    } catch {
      // Not this one. Keep looking — a photo can catch two codes.
    }
  }
  const sample = (usable[0] ?? "").trim().replace(/\s+/g, " ")
  return {
    kind: "other",
    sample:
      sample.length > SAMPLE_CHARS
        ? `${sample.slice(0, SAMPLE_CHARS - 1)}…`
        : sample,
  }
}

/**
 * The passes to decode a photo at, as maximum pixel dimensions, easiest first.
 *
 * A phone photo is 4000×3000 and a terminal QR in the middle of it is 300px
 * wide. One decode at full size is slow and binarizes badly (jsQR's local
 * thresholding wants a code that fills a decent share of the frame); one decode
 * at a small size loses the code entirely if the phone was far away. So: try
 * small, then bigger, then the largest pass as a cap on the native size.
 * Usually the first pass answers; the cost of being wrong is a few hundred ms.
 */
const SCAN_PASSES_PX = [1024, 1792, 2600]

export function scalePlanFor(width: number, height: number): number[] {
  const longest = Math.max(width, height)
  if (!Number.isFinite(longest) || longest <= 0) return []
  const plan = SCAN_PASSES_PX.filter((pass) => pass < longest)
  // Smaller than every pass: decode at its own size. Upscaling invents pixels
  // and jsQR then has to binarize around them.
  return plan.length > 0 ? plan : [longest]
}

/**
 * The last scan, in one line.
 *
 * Printed in the pairing form itself rather than only in a debug panel, because
 * "I scanned and nothing happened" is answered by the file the picker handed
 * over and whether the decoder ever ran — and that answer has to be where the
 * person is already looking, not behind a URL they have to remember to open.
 */
export function scanAttemptLine(a: ScanAttempt): string {
  if (a.outcome === "cancelled") {
    // The camera opened and closed with nothing attached. On Android that is
    // usually the review screen: BACK discards the shot, ✓ attaches it.
    return "last scan: the camera closed without attaching a photo"
  }
  if (a.outcome === "not-an-image") {
    return `last scan: the picker handed over ${a.fileName || "a file"} (${a.fileType || "no type"}), which is not an image`
  }
  const size = `${(a.fileSize / 1024).toFixed(0)} KB`
  const head = `last scan: ${a.fileType || "(no type)"} ${size}`
  if (a.stage === "started") {
    // Written before the decode and never updated: the page did not come back
    // to finish the work. On iOS that is the camera UI unloading the page.
    return `${head} — the photo never came back to the page (the browser unloaded it while the camera was open)`
  }
  const shape = a.width ? ` → ${a.width}x${a.height}` : ""
  const effort = a.passes?.length
    ? `${a.passes.length} pass${a.passes.length === 1 ? "" : "es"}, ${a.ms}ms`
    : `${a.ms ?? 0}ms`
  switch (a.outcome) {
    case "pairing-code":
      return `${head}${shape} → pairing code (${effort})`
    case "no-code":
      return `${head}${shape} → no QR code found (${effort})`
    case "foreign-code":
      return `${head}${shape} → a QR code, but not a pairing code (${effort})`
    case "error":
      return `${head}${shape} → ${a.error ?? "the image could not be read"}`
    default:
      return `${head}${shape} (${effort})`
  }
}

/**
 * What one scan attempt is worth reading off a phone.
 *
 * Same reason `?kbdebug` exists: the interesting facts live on the device, and
 * a screenshot of them answers in one round trip what a laptop can only guess
 * at. A scan that does nothing has several unrelated causes — the decoder chunk
 * never arrived, the photo is not decodable by this browser (HEIC out of an iOS
 * camera is the usual), the code is too small in the frame — and they look
 * identical from the outside.
 */
export type ScanFacts = {
  fileType: string
  fileSize: number
  width: number
  height: number
  passes: number[]
  decoded: number
  ms: number
  verdict: string
  secureContext: boolean
  decoderLoaded: boolean
  userAgent: string
}

export function scanProbeLines(f: ScanFacts): string[] {
  return [
    `secure ${f.secureContext ? "yes" : "no"} · decoder ${f.decoderLoaded ? "loaded" : "NOT loaded"}`,
    `file ${f.fileType || "(no type)"} ${(f.fileSize / 1024).toFixed(0)} KB`,
    `image ${f.width}x${f.height} · passes ${f.passes.join("/") || "-"} · ${f.ms}ms`,
    `decoded ${f.decoded} · ${f.verdict}`,
    f.userAgent.slice(0, 60),
  ]
}

/** Does this look like something the decoder can be pointed at? */
export function isImageLike(file: { type?: string; name?: string }): boolean {
  if (typeof file.type === "string" && file.type.startsWith("image/")) {
    return true
  }
  // A paste from a screenshot tool sometimes arrives with an empty MIME type.
  // The extension is the only thing left to ask.
  return /\.(png|jpe?g|heic|heif|webp|gif|bmp)$/i.test(file.name ?? "")
}

/**
 * A failure in terms of what the user should do next.
 *
 * The DOMException names are the whole interface here — a cancelled picker, a
 * declined permission and an unreadable file all arrive as anonymous `Error`s
 * otherwise, and an anonymous error in a pairing flow reads as a broken button.
 * (Same lesson as `pair-status.ts`: the wording IS the feature.)
 */
export function scanFailureMessage(err: unknown, fileType?: string): string {
  const name =
    err && typeof err === "object"
      ? String((err as { name?: unknown }).name ?? "")
      : ""
  // An image the browser cannot open at all. Naming the TYPE in the sentence is
  // the actionable part: an iPhone camera set to High Efficiency hands over
  // HEIC/HEIF, which several browsers will not decode, and "image/heic" in the
  // line is what turns a mystery into a setting to change.
  const undecodable = (detail: string): string =>
    `could not read the image${fileType ? ` (${fileType})` : ""}: ${detail}`
  switch (name) {
    case "NotAllowedError":
      return "camera access was declined — paste the pairing code instead, or allow the camera for this site"
    case "SecurityError":
      // The route-B wall, named here so it is diagnosable if a live scanner ever
      // is wired up on a plain-http origin: the browser will not hand over a
      // camera to a non-secure context.
      return "the browser blocked camera access on this address — it needs https"
    case "NotFoundError":
      return "no camera found — paste the pairing code instead"
    case "NotReadableError":
      return "the camera is busy in another app — close it and try again"
    case "OverconstrainedError":
      return "this camera cannot be used — paste the pairing code instead"
    case "AbortError":
      return "camera cancelled"
    case "TypeError":
    case "EncodingError":
      // createImageBitmap's answer to "this is not a decodable image".
      return undecodable(
        describeError(err) || "this browser cannot open that file type",
      )
    default:
      return undecodable(describeError(err))
  }
}
