/**
 * The decisions behind attaching an image to a chat message from a phone.
 *
 * Same split as `qr-scan.ts` / `qr-image.ts`: every question worth testing — is
 * this a type the machine takes, how big should the copy be, does it fit the
 * budget, what does each failure read like — is answered here, with no canvas
 * and no `File`. `image-send.ts` is the thin layer that touches pixels.
 *
 * Why the client resizes at all. pi resizes on the machine (2000px / 4.5 MB by
 * default, from the model's declared input limits), so a 4 MB phone photo WOULD
 * get through. But the base64 does not stop at the model: it is written into
 * pi's session log and replayed to every device on every `get_entries`, so an
 * oversized image is paid for again on every reload, for the life of the
 * session. Shrinking here is the only place that cost can be avoided — and the
 * copy is still well inside what the machine and relay accept (the extension
 * rejects a decoded image over 10 MB; the relay caps an envelope at 16 MB).
 */

/** One inline attachment, exactly as the wire wants it: STANDARD base64, padded
 *  (DESIGN §10.1). The machine's `_isStrictBase64` refuses a url-safe alphabet
 *  outright, so this is not a detail to "modernise" later. */
export type WireImage = { data: string; mime: string }

/** The types the machine's image pipeline knows — the same list `_imageExtension`
 *  keeps in `extension/src/image_codec.ts`. HEIC, which an iPhone camera hands
 *  over when it is set to High Efficiency, is NOT on it; several browsers cannot
 *  decode it either, so it fails at the picker rather than on the wire. */
export const SENDABLE_IMAGE_MIMES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]

/** Longest side of the copy we send. Under pi's own 2000px cap on purpose: the
 *  machine would only shrink it again, and the smaller copy is what sits in the
 *  session log forever. */
export const MAX_SIDE_PX = 1568

/** Budget for the BASE64 TEXT, not the pixels — base64 is what the relay counts
 *  and what the transcript re-sends on every attach. 1.5 MB of text is ~1.1 MB
 *  of image: enough for a legible screenshot, a fraction of a phone photo. */
export const MAX_BASE64_BYTES = 1_500_000

/** Per message. pi's registry allows 20 image blocks; four is what a phone
 *  composer can show without the strip eating the transcript. */
export const MAX_ATTACHMENTS = 4

/** The re-encode ladder. Quality first — it is the cheaper loss — then
 *  dimensions, which is the one the reader can see. */
export const JPEG_QUALITIES: readonly number[] = [0.85, 0.72, 0.6]
export const SIDE_STEPS: readonly number[] = [1, 0.8, 0.64]

/** Does the machine take this type? */
export function isSendableMime(mime: string | undefined): boolean {
  if (typeof mime !== "string") return false
  const base = mime.split(";")[0]?.trim().toLowerCase() ?? ""
  return SENDABLE_IMAGE_MIMES.includes(base)
}

/**
 * Is this file worth handing to the decoder?
 *
 * Deliberately stricter than `qr-scan.ts`'s `isImageLike`, which accepts HEIC
 * because a QR decoder can be pointed at anything the browser can open. Here
 * the type decides whether the machine can USE the bytes, so a `.heic` is
 * refused up front with a sentence instead of failing three steps later.
 */
export function isAttachableFile(file: {
  type?: string
  name?: string
}): boolean {
  if (typeof file.type === "string" && file.type.startsWith("image/")) {
    return isSendableMime(file.type)
  }
  // A picker that reports no MIME type at all: fall back to the extension, and
  // only accept the ones the machine can take.
  return /\.(png|jpe?g|webp|gif)$/i.test(file.name ?? "")
}

/** The copy's size at `scale`, capped so the longest side is `maxSide`. */
export function stepSize(
  width: number,
  height: number,
  scale = 1,
  maxSide = MAX_SIDE_PX,
): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (!Number.isFinite(longest) || longest <= 0) {
    return {
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
    }
  }
  const fit = Math.min(1, maxSide / longest)
  const factor = Math.min(scale, 1) * fit
  return {
    width: Math.max(1, Math.round(width * factor)),
    height: Math.max(1, Math.round(height * factor)),
  }
}

/** Length of the base64 text for `byteLength` bytes (3 bytes → 4 characters). */
export function base64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4
}

export function fitsBudget(
  base64Chars: number,
  max = MAX_BASE64_BYTES,
): boolean {
  return base64Chars <= max
}

/**
 * Can the file go across untouched?
 *
 * Worth asking before any decoding: a small screenshot is already the right
 * size, and re-encoding it costs quality for nothing. It also keeps an animated
 * GIF animated — the first canvas pass flattens it.
 */
export function withinLimits(source: {
  width: number
  height: number
  bytes: number
  mime: string | undefined
}): boolean {
  if (!isSendableMime(source.mime)) return false
  if (Math.max(source.width, source.height) > MAX_SIDE_PX) return false
  return fitsBudget(base64Length(source.bytes))
}

/** One candidate encoding, easiest first. */
export type EncodeStep = {
  scale: number
  mime: string
  quality?: number
}

/**
 * The encodings to try, in the order to try them.
 *
 * PNG only for a PNG source, and only at full scale: for a photo a lossless
 * pass is guaranteed to blow the budget, and encoding it is wasted work. For a
 * screenshot it is usually the winner — text stays crisp.
 */
export function encodePlan(source: { mime: string | undefined }): EncodeStep[] {
  const steps: EncodeStep[] = []
  if ((source.mime ?? "").split(";")[0]?.toLowerCase() === "image/png") {
    steps.push({ scale: 1, mime: "image/png" })
  }
  for (const scale of SIDE_STEPS) {
    for (const quality of JPEG_QUALITIES) {
      steps.push({ scale, mime: "image/jpeg", quality })
    }
  }
  return steps
}

/** How many more images the composer can take. */
export function attachmentRoom(
  staged: number,
  limit = MAX_ATTACHMENTS,
): number {
  return Math.max(0, limit - staged)
}

/**
 * Should this composer content go out?
 *
 * An image with NO text is a real message — pi takes a prompt whose text is
 * empty as long as it carries image blocks, and "here, look at this" is the
 * commonest thing a phone sends.
 *
 * A slash command with an image is refused rather than sent: the extension
 * intercepts pi's built-in slashes before the image is ever handed over
 * (`interceptTuiBuiltInSlash`), and pi runs a registered extension command and
 * drops the image on the floor. Silently losing the photo is worse than saying
 * the command cannot carry one.
 */
export type SendGate =
  | { kind: "send"; text: string; images: WireImage[] }
  | { kind: "empty" }
  | { kind: "slash-with-image"; command: string }

export function sendGate(text: string, images: readonly WireImage[]): SendGate {
  const trimmed = text.trim()
  if (images.length === 0) {
    return trimmed
      ? { kind: "send", text: trimmed, images: [] }
      : { kind: "empty" }
  }
  if (trimmed.startsWith("/")) {
    return {
      kind: "slash-with-image",
      command: trimmed.split(/\s/)[0] ?? trimmed,
    }
  }
  return { kind: "send", text: trimmed, images: [...images] }
}

/** One line under a thumbnail: what is being sent, and what it cost to get. */
export function attachmentCaption(a: {
  mime: string
  bytes: number
  width: number
  height: number
  from?: { width: number; height: number }
}): string {
  const type = a.mime.split("/")[1] ?? a.mime
  const size = `${Math.max(1, Math.round(a.bytes / 1024))} KB`
  const shape = `${a.width}x${a.height}`
  if (!a.from) return `${type} ${size} · ${shape}`
  return `${type} ${size} · ${shape} (from ${a.from.width}x${a.from.height})`
}

/**
 * A failed attach in terms of what to do next.
 *
 * The three real causes on a phone are unrelated and look identical from the
 * UI: the browser cannot open the type (HEIC out of an iOS camera), the file is
 * not an image at all, and an image so detailed that no rung of the ladder fits
 * its budget. Each needs its own sentence — the same lesson `pair-status.ts`
 * and `qr-scan.ts` already record: the wording is the feature.
 */
export function attachFailureMessage(err: unknown, fileType?: string): string {
  if (err instanceof ImageTooLargeError) {
    return `that image would not fit under ${Math.round(
      MAX_BASE64_BYTES / 1000,
    )} KB of base64 — crop it, or send a smaller one`
  }
  if (err instanceof UnsupportedImageError) {
    return `this browser cannot open that image${
      fileType ? ` (${fileType})` : ""
    } — an iPhone camera set to High Efficiency produces HEIC; switch it to Most Compatible`
  }
  const name =
    err && typeof err === "object"
      ? String((err as { name?: unknown }).name ?? "")
      : ""
  if (name === "NotAllowedError") {
    return "the picker was declined — allow photos for this site to attach an image"
  }
  if (name === "AbortError") return "the picker was cancelled"
  const detail = err instanceof Error && err.message ? `: ${err.message}` : ""
  return `could not read the image${fileType ? ` (${fileType})` : ""}${detail}`
}

/** Thrown when every rung of the ladder still overshoots the budget. */
export class ImageTooLargeError extends Error {
  constructor() {
    super("image exceeds the attachment budget after every re-encode")
    this.name = "ImageTooLargeError"
  }
}

/** Thrown when the pixels never arrived — an undecodable or non-image file. */
export class UnsupportedImageError extends Error {
  constructor(fileType?: string) {
    super(
      `the browser could not decode this image${fileType ? ` (${fileType})` : ""}`,
    )
    this.name = "UnsupportedImageError"
  }
}
