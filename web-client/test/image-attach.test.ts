import { describe, expect, it } from "vitest"
import {
  ImageTooLargeError,
  MAX_ATTACHMENTS,
  MAX_BASE64_BYTES,
  MAX_SIDE_PX,
  UnsupportedImageError,
  attachFailureMessage,
  attachmentCaption,
  attachmentRoom,
  base64Length,
  encodePlan,
  fitsBudget,
  isAttachableFile,
  isSendableMime,
  sendGate,
  stepSize,
  withinLimits,
} from "../src/image-attach.js"

// A phone photo's real shape: 12 MP, several megabytes. Every size question here
// is answered against that, not against a tidy 800x600.
const PHOTO = {
  width: 4032,
  height: 3024,
  bytes: 3_400_000,
  mime: "image/jpeg",
}

describe("isSendableMime", () => {
  it("takes the four types the machine's image pipeline knows", () => {
    for (const mime of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
      expect(isSendableMime(mime)).toBe(true)
    }
  })

  it("refuses HEIC, which is what an iPhone camera hands over by default", () => {
    // `_imageExtension` in extension/src/image_codec.ts has no case for it, and
    // several browsers cannot decode it either. Refusing it at the picker is
    // what turns "the send did nothing" into a settings change.
    expect(isSendableMime("image/heic")).toBe(false)
    expect(isSendableMime("image/heif")).toBe(false)
    expect(isSendableMime("image/svg+xml")).toBe(false)
    expect(isSendableMime(undefined)).toBe(false)
  })

  it("ignores the charset parameter a picker sometimes appends", () => {
    expect(isSendableMime("image/jpeg;base64")).toBe(true)
  })
})

describe("isAttachableFile", () => {
  it("accepts an image type the machine can take", () => {
    expect(isAttachableFile({ type: "image/jpeg", name: "IMG_0017.JPG" })).toBe(
      true,
    )
  })

  it("rejects an image type the machine cannot use, even though it is an image", () => {
    // Stricter than qr-scan.ts's `isImageLike` on purpose: a QR decoder can be
    // pointed at anything the browser opens; here the type decides whether the
    // bytes are usable at the other end.
    expect(
      isAttachableFile({ type: "image/heic", name: "IMG_0017.HEIC" }),
    ).toBe(false)
  })

  it("falls back to the extension when the picker reports no type", () => {
    expect(isAttachableFile({ type: "", name: "shot.png" })).toBe(true)
    expect(isAttachableFile({ type: "", name: "shot.heic" })).toBe(false)
    expect(isAttachableFile({ type: "", name: "notes.txt" })).toBe(false)
  })
})

describe("stepSize", () => {
  it("caps the longest side and keeps the aspect ratio", () => {
    expect(stepSize(4032, 3024)).toEqual({ width: 1568, height: 1176 })
    expect(stepSize(1080, 2400)).toEqual({ width: 706, height: 1568 })
  })

  it("leaves an image that is already small alone", () => {
    expect(stepSize(640, 480)).toEqual({ width: 640, height: 480 })
  })

  it("shrinks further on the dimension rungs, never enlarges", () => {
    expect(stepSize(4032, 3024, 0.8)).toEqual({ width: 1254, height: 941 })
    expect(stepSize(640, 480, 0.64)).toEqual({ width: 410, height: 307 })
  })

  it("never returns a zero side, which a canvas would reject", () => {
    expect(stepSize(3, 2, 0.64)).toEqual({ width: 2, height: 1 })
    expect(stepSize(0, 0)).toEqual({ width: 1, height: 1 })
  })
})

describe("the budget", () => {
  it("counts the base64 TEXT, which is what the relay and the log pay for", () => {
    expect(base64Length(3)).toBe(4)
    expect(base64Length(4)).toBe(8) // ceil(4/3)*4
    expect(base64Length(0)).toBe(0)
  })

  it("sits far under the machine's and the relay's own ceilings", () => {
    // extension/src/image_codec.ts rejects a decoded image over 10 MB; the relay
    // caps an envelope's ct at 16 MB. The point of the client budget is not to
    // dodge those — it is the session log, which replays every attachment to
    // every device on every attach, for the life of the session.
    expect(MAX_BASE64_BYTES).toBeLessThan(10 * 1024 * 1024)
    expect(MAX_SIDE_PX).toBeLessThan(2000) // pi resizes at 2000px server-side
    expect(fitsBudget(MAX_BASE64_BYTES)).toBe(true)
    expect(fitsBudget(MAX_BASE64_BYTES + 1)).toBe(false)
  })

  it("rejects a phone photo as it came out of the camera", () => {
    expect(fitsBudget(base64Length(PHOTO.bytes))).toBe(false)
    expect(withinLimits(PHOTO)).toBe(false)
  })

  it("sends a small screenshot across untouched, so it stays crisp", () => {
    expect(
      withinLimits({
        width: 1200,
        height: 800,
        bytes: 180_000,
        mime: "image/png",
      }),
    ).toBe(true)
  })

  it("re-encodes anything oversized, and anything of an unusable type", () => {
    expect(
      withinLimits({
        width: 3000,
        height: 2000,
        bytes: 100_000,
        mime: "image/png",
      }),
    ).toBe(false)
    expect(
      withinLimits({
        width: 400,
        height: 300,
        bytes: 20_000,
        mime: "image/heic",
      }),
    ).toBe(false)
  })
})

describe("encodePlan", () => {
  it("walks quality before dimensions, because quality is the cheaper loss", () => {
    const plan = encodePlan({ mime: "image/jpeg" })
    expect(plan[0]).toEqual({ scale: 1, mime: "image/jpeg", quality: 0.85 })
    expect(plan[1]).toEqual({ scale: 1, mime: "image/jpeg", quality: 0.72 })
    // The first rung that drops the side is the LAST jpeg rung, not the first.
    expect(plan.at(-1)).toEqual({
      scale: 0.64,
      mime: "image/jpeg",
      quality: 0.6,
    })
    expect(plan.map((s) => s.scale)).toEqual([
      1, 1, 1, 0.8, 0.8, 0.8, 0.64, 0.64, 0.64,
    ])
  })

  it("tries lossless first for a PNG source, and only at full size", () => {
    // A screenshot is mostly text: PNG usually wins and stays sharp. For a
    // photo a lossless pass is guaranteed to blow the budget, so it is skipped.
    const plan = encodePlan({ mime: "image/png" })
    expect(plan[0]).toEqual({ scale: 1, mime: "image/png" })
    expect(plan.filter((s) => s.mime === "image/png").length).toBe(1)
  })

  it("does not try PNG for a jpeg or a gif", () => {
    for (const mime of ["image/jpeg", "image/gif", "image/webp", undefined]) {
      expect(encodePlan({ mime }).every((s) => s.mime === "image/jpeg")).toBe(
        true,
      )
    }
  })
})

describe("attachmentRoom", () => {
  it("counts what still fits, and never goes negative", () => {
    expect(attachmentRoom(0)).toBe(MAX_ATTACHMENTS)
    expect(attachmentRoom(MAX_ATTACHMENTS - 1)).toBe(1)
    expect(attachmentRoom(MAX_ATTACHMENTS)).toBe(0)
    expect(attachmentRoom(MAX_ATTACHMENTS + 3)).toBe(0)
  })
})

describe("sendGate", () => {
  it("sends text on its own", () => {
    expect(sendGate("  explain this  ", [])).toEqual({
      kind: "send",
      text: "explain this",
      images: [],
    })
  })

  it("sends an image with NO text — 'here, look at this' is a message", () => {
    const img = { data: "QUJD", mime: "image/png" }
    expect(sendGate("", [img])).toEqual({
      kind: "send",
      text: "",
      images: [img],
    })
  })

  it("refuses an empty composer", () => {
    expect(sendGate("   ", [])).toEqual({ kind: "empty" })
  })

  it("refuses a slash command carrying an image instead of losing the image", () => {
    // The extension intercepts pi's built-in slashes before any image is handed
    // over, and pi runs a registered command and returns without the content
    // blocks. Either way the photo vanishes, so the refusal is the honest send.
    const gate = sendGate("/compact focus on the tests", [
      { data: "QUJD", mime: "image/png" },
    ])
    expect(gate).toEqual({ kind: "slash-with-image", command: "/compact" })
  })

  it("does not mistake a message that merely contains a slash for a command", () => {
    const gate = sendGate("what about src/app.ts?", [
      { data: "QUJD", mime: "image/png" },
    ])
    expect(gate.kind).toBe("send")
  })
})

describe("attachmentCaption", () => {
  it("says what is being sent", () => {
    expect(
      attachmentCaption({
        mime: "image/jpeg",
        bytes: 240_000,
        width: 1568,
        height: 1176,
      }),
    ).toBe("jpeg 234 KB · 1568x1176")
  })

  it("says what it cost to get there, when the copy is a shrunk version", () => {
    expect(
      attachmentCaption({
        mime: "image/png",
        bytes: 410_000,
        width: 1568,
        height: 1176,
        from: { width: 4032, height: 3024 },
      }),
    ).toBe("png 400 KB · 1568x1176 (from 4032x3024)")
  })
})

describe("attachFailureMessage", () => {
  it("names the type when the browser could not open it, and offers the fix", () => {
    const line = attachFailureMessage(
      new UnsupportedImageError("image/heic"),
      "image/heic",
    )
    expect(line).toContain("image/heic")
    expect(line).toContain("High Efficiency")
  })

  it("says the image would not fit, rather than reporting an anonymous error", () => {
    expect(attachFailureMessage(new ImageTooLargeError())).toContain("KB")
  })

  it("reads a declined picker as a declined picker", () => {
    const err = new Error("permission denied")
    err.name = "NotAllowedError"
    expect(attachFailureMessage(err)).toContain("declined")
  })
})
