import {
  ImageTooLargeError,
  UnsupportedImageError,
  base64Length,
  encodePlan,
  fitsBudget,
  isSendableMime,
  stepSize,
  withinLimits,
  type WireImage,
} from "./image-attach.js"
import { drawInto, loadImageSource } from "./image-load.js"

/**
 * `File` → the bytes the wire wants. The thin half of the attach feature: it
 * touches canvas and base64 and makes no decisions — every limit, ladder and
 * sentence lives in `image-attach.ts`, where it can be tested.
 */

/** One staged attachment: what will be sent, plus what to draw for it. */
export type Attachment = {
  /** The frame content, ready for `prompt.images`. */
  wire: WireImage
  /** A small data URL for the composer's strip. Local only — never sent. */
  thumb: string
  /** Encoded bytes of the copy that will actually go across. */
  bytes: number
  width: number
  height: number
  /** The source's size, when the copy is a smaller version of it. */
  from?: { width: number; height: number }
}

/** STANDARD base64, padded — DESIGN §10.1. `btoa` already produces this; the
 *  url-safe variant the pairing layer uses would be REJECTED by the machine's
 *  `_isStrictBase64`, so do not "normalise" this to match the pairing code. */
function toBase64(bytes: Uint8Array): string {
  // Chunked: `String.fromCharCode(...bytes)` on a 1 MB array blows the argument
  // limit, and a phone is exactly where that would surface.
  const CHUNK = 0x8000
  let binary = ""
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK)
    binary += String.fromCharCode.apply(
      null,
      Array.from(slice) as unknown as number[],
    )
  }
  return btoa(binary)
}

async function blobToBase64(blob: Blob): Promise<string> {
  return toBase64(new Uint8Array(await blob.arrayBuffer()))
}

/** Encode a canvas to `mime` (optionally at `quality`). */
function encode(
  canvas: HTMLCanvasElement,
  mime: string,
  quality?: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => resolve(blob),
      mime,
      ...(quality === undefined ? [] : [quality]),
    )
  })
}

/** The strip's thumbnail. Local only, so it is deliberately cheap: 160px of
 *  JPEG, which is smaller than the copy being sent and costs nothing. */
function thumbOf(
  source: CanvasImageSource,
  width: number,
  height: number,
): string {
  const size = stepSize(width, height, 1, 160)
  const drawn = drawInto(source, size.width, size.height)
  if (!drawn) return ""
  return drawn.canvas.toDataURL("image/jpeg", 0.7)
}

/**
 * Read one picked file and return the attachment to send.
 *
 * Order matters for the phone case:
 *  1. Already small and a type the machine takes → send the bytes untouched. No
 *     re-encode, so a small screenshot stays crisp and an animated GIF stays
 *     animated (any canvas pass flattens it).
 *  2. Otherwise walk `encodePlan` — quality rungs first, then smaller
 *     dimensions — and take the first copy that fits the budget.
 *
 * Throws `UnsupportedImageError` when the pixels never arrived (HEIC, or a file
 * the picker mislabelled) and `ImageTooLargeError` when no rung fits.
 */
export async function prepareAttachment(file: File): Promise<Attachment> {
  const mime = file.type || undefined
  if (!isSendableMime(mime) && !/\.(png|jpe?g|webp|gif)$/i.test(file.name)) {
    throw new UnsupportedImageError(mime ?? file.name)
  }

  let image: Awaited<ReturnType<typeof loadImageSource>>
  try {
    image = await loadImageSource(file)
  } catch {
    // createImageBitmap's answer to an undecodable type is a DOMException with
    // no useful message; the type is the part the reader can act on.
    throw new UnsupportedImageError(mime ?? file.name)
  }

  try {
    const { source, width, height } = image
    if (
      withinLimits({
        width,
        height,
        bytes: file.size,
        mime,
      })
    ) {
      const data = toBase64(new Uint8Array(await file.arrayBuffer()))
      return {
        wire: { data, mime: mime ?? "image/png" },
        thumb: thumbOf(source, width, height),
        bytes: file.size,
        width,
        height,
      }
    }

    for (const step of encodePlan({ mime })) {
      const size = stepSize(width, height, step.scale)
      const drawn = drawInto(source, size.width, size.height)
      if (!drawn) continue
      const blob = await encode(drawn.canvas, step.mime, step.quality)
      if (!blob) continue
      if (!fitsBudget(base64Length(blob.size))) continue
      return {
        wire: { data: await blobToBase64(blob), mime: step.mime },
        thumb: thumbOf(source, width, height),
        bytes: blob.size,
        width: size.width,
        height: size.height,
        from: { width, height },
      }
    }
    throw new ImageTooLargeError()
  } finally {
    image.close?.()
  }
}
