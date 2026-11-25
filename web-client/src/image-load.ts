/**
 * `File` → drawable pixels. Shared by the two features that read a photo the
 * picker handed over: the pairing-QR scanner (`qr-image.ts`) and image
 * attachments (`image-send.ts`).
 *
 * The source is always a `File` from `<input type="file" accept="image/*">`,
 * never a camera stream: `getUserMedia` is restricted to secure contexts and
 * this client is routinely served over plain `http` on a LAN or tailnet host,
 * where `navigator.mediaDevices` is simply absent. See the header of
 * `qr-scan.ts` for the full argument.
 */

export type ImageSource = {
  source: CanvasImageSource
  width: number
  height: number
  close?: () => void
}

/**
 * Decode the EXIF orientation with the pixels rather than correcting it later.
 *
 * A phone's photo is stored sideways with an orientation tag. Honouring it at
 * decode time is what makes the copy the machine receives look the way the
 * camera showed it — a photo sent upside down is a photo the model has to
 * explain rather than read.
 */
export async function loadImageSource(file: File): Promise<ImageSource> {
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
  // Older Safari. Slower, and it holds an object URL until the page moves on,
  // which is the right trade for a browser this old.
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
 * Draw `source` into a fresh canvas at `width`x`height`.
 *
 * Returns null when the 2D context is unavailable — a canvas this size can be
 * refused outright on a memory-starved phone, which is a real failure mode and
 * not a crash to be surprised by.
 */
export function drawInto(
  source: CanvasImageSource,
  width: number,
  height: number,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d")
  if (!ctx) return null
  ctx.drawImage(source, 0, 0, width, height)
  return { canvas, ctx }
}
