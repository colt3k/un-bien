import { describe, expect, it } from "vitest"
import { generateEd25519Keypair } from "@geohar/un-bien/client"
import {
  classifyScan,
  isImageLike,
  scanAttemptLine,
  scanFailureMessage,
  scanProbeLines,
  scalePlanFor,
} from "../src/qr-scan.js"

// A real-shaped invite: `epk` is base64url of an actual 32-byte Ed25519 key,
// because `parseInvite` rejects a wrong-length one and a fixture that does not
// parse would test the rejection rather than the acceptance. The token is
// synthetic — never put a live pairing credential in a fixture.
const keypair = generateEd25519Keypair()
const URI =
  "unbien://pair?t=ZmFrZXRva2VuMTIz&epk=" +
  Buffer.from(keypair.publicKey).toString("base64url") +
  "&n=tmpunbien&rm=1iVugrrsyGRP"

describe("classifyScan", () => {
  it("accepts a decodable pairing URI", () => {
    expect(classifyScan([URI])).toEqual({ kind: "pair", uri: URI })
  })

  it("says nothing was found when the image yielded nothing", () => {
    expect(classifyScan([])).toEqual({ kind: "empty" })
    // A decoder that found a blank barcode reports it as an empty string, which
    // is the same outcome for the user.
    expect(classifyScan([""])).toEqual({ kind: "empty" })
    expect(classifyScan(["   "])).toEqual({ kind: "empty" })
  })

  it("separates the wrong QR from no QR", () => {
    const verdict = classifyScan(["https://example.com/download"])
    expect(verdict.kind).toBe("other")
    // "Point at the terminal, not at the package label" and "move closer" are
    // different advice, so the two outcomes cannot share one message.
    expect(classifyScan(["Wi-Fi:MyNetwork"])).not.toEqual(classifyScan([]))
  })

  it("picks the pairing code out of several barcodes", () => {
    const verdict = classifyScan(["https://example.com", URI])
    expect(verdict).toEqual({ kind: "pair", uri: URI })
  })

  it("rejects a mis-scanned invite instead of passing it to the relay", () => {
    // Starts right, lost the key. A prefix match would wave this through and
    // the failure would surface as a relay refusal seconds later.
    const truncated = "unbien://pair?t=abc123"
    expect(classifyScan([truncated]).kind).toBe("other")
  })

  it("trims the URI it hands on", () => {
    const verdict = classifyScan([`  ${URI}\n`])
    if (verdict.kind !== "pair") throw new Error("expected a pairing code")
    expect(verdict.uri).toBe(URI)
  })

  it("quotes a foreign payload back, shortened and on one line", () => {
    const verdict = classifyScan([`https://example.com/${"x".repeat(200)}`])
    if (verdict.kind !== "other") throw new Error("expected other")
    expect(verdict.sample.length).toBeLessThanOrEqual(60)
    expect(verdict.sample).toMatch(/…$/)
  })
})

describe("scalePlanFor", () => {
  it("tries the cheap passes before the expensive ones on a phone photo", () => {
    expect(scalePlanFor(4000, 3000)).toEqual([1024, 1792, 2600])
  })

  it("caps the largest pass rather than running at the native size", () => {
    // 2600 is a ceiling on every pass, so a 12 MP photo never gets decoded at
    // full resolution: jsQR's binarizer wants the code to fill the frame
    // anyway, and the pixels cost memory on a phone tab.
    expect(scalePlanFor(9000, 12000).at(-1)).toBe(2600)
  })

  it("decodes a small image at its own size", () => {
    // Upscaling invents pixels the binarizer then has to work around.
    expect(scalePlanFor(800, 600)).toEqual([800])
  })

  it("gives no plan for an image with no size", () => {
    expect(scalePlanFor(0, 0)).toEqual([])
    expect(scalePlanFor(Number.NaN, 100)).toEqual([])
  })
})

describe("scanFailureMessage", () => {
  const domError = (name: string): Error => {
    const err = new Error(name)
    err.name = name
    return err
  }

  it("names a declined camera as the thing it is", () => {
    expect(scanFailureMessage(domError("NotAllowedError"))).toMatch(/declined/)
  })

  it("says what a blocked origin means", () => {
    // The route-B wall: a live viewfinder cannot exist on a plain-http origin.
    // Named here so the diagnosis exists before the code that can hit it.
    expect(scanFailureMessage(domError("SecurityError"))).toMatch(/https/)
  })

  it("names the file type when the browser cannot open the image", () => {
    // The iPhone High-Efficiency case: the camera hands over HEIC and the
    // browser refuses it. "image/heic" in the line is the whole diagnosis.
    const err = new Error("The source image could not be decoded.")
    err.name = "EncodingError"
    expect(scanFailureMessage(err, "image/heic")).toMatch(/image\/heic/)
    expect(scanFailureMessage(err)).not.toMatch(/\(\)/)
  })

  it("keeps an unexpected failure readable", () => {
    expect(scanFailureMessage(new Error("canvas gone weird"))).toContain(
      "canvas gone weird",
    )
    expect(scanFailureMessage(undefined)).toContain("unknown error")
  })
})

describe("scanProbeLines", () => {
  const facts = {
    fileType: "image/heic",
    fileSize: 2_400_000,
    width: 0,
    height: 0,
    passes: [],
    decoded: 0,
    ms: 0,
    verdict: "the image could not be read",
    secureContext: false,
    decoderLoaded: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X)",
  }

  it("names the file the picker handed over", () => {
    // The iOS High-Efficiency case: the camera gives HEIC and the browser may
    // not open it. Only the file's type says so.
    expect(scanProbeLines(facts).join(" | ")).toMatch(/image\/heic/)
  })

  it("says when the decoder chunk never arrived", () => {
    // A loading failure and a photo failure look identical in the UI.
    expect(
      scanProbeLines({ ...facts, decoderLoaded: false }).join(" | "),
    ).toMatch(/decoder NOT loaded/)
    expect(scanProbeLines(facts).join(" | ")).toMatch(/decoder loaded/)
  })

  it("shows the passes that ran when nothing decoded", () => {
    const line = scanProbeLines({
      ...facts,
      fileType: "image/jpeg",
      width: 3024,
      height: 4032,
      passes: [1024, 1792, 2600],
    }).join(" | ")
    expect(line).toMatch(/3024x4032/)
    expect(line).toMatch(/1024\/1792\/2600/)
  })
})

describe("scanAttemptLine", () => {
  it("says when the photo never came back to the page", () => {
    // The iOS case: the camera UI unloads the page, the `change` handler never
    // runs, and the only trace is the record written before the decode.
    const line = scanAttemptLine({
      at: 1,
      stage: "started",
      fileType: "image/jpeg",
      fileSize: 2_100_000,
      outcome: "in-flight",
    })
    expect(line).toMatch(/never came back/)
    expect(line).toMatch(/image\/jpeg/)
  })

  it("reports the file, the pixels and the effort", () => {
    const line = scanAttemptLine({
      at: 1,
      stage: "done",
      fileType: "image/jpeg",
      fileSize: 2_100_000,
      width: 3024,
      height: 4032,
      passes: [1024, 1792, 2600],
      ms: 410,
      decoded: 0,
      outcome: "no-code",
    })
    expect(line).toMatch(/image\/jpeg 2051 KB/)
    expect(line).toMatch(/3024x4032/)
    expect(line).toMatch(/3 passes, 410ms/)
    expect(line).toMatch(/no QR code found/)
  })

  it("says when the camera attached nothing", () => {
    // Android: BACK from the review screen discards the shot. The page gets an
    // empty result, and that has to be a reportable outcome, not silence.
    const line = scanAttemptLine({
      at: 1,
      stage: "done",
      fileType: "",
      fileSize: 0,
      ms: 0,
      outcome: "cancelled",
    })
    expect(line).toMatch(/without attaching a photo/)
  })

  it("names the file when the picker hands over something odd", () => {
    const line = scanAttemptLine({
      at: 1,
      stage: "done",
      fileType: "",
      fileSize: 12,
      fileName: "notes.txt",
      ms: 0,
      outcome: "not-an-image",
    })
    expect(line).toMatch(/notes\.txt/)
    expect(line).toMatch(/not an image/)
  })

  it("separates the three ways an attempt can end", () => {
    const base = {
      at: 1,
      stage: "done" as const,
      fileType: "image/jpeg",
      fileSize: 1000,
      ms: 5,
    }
    expect(scanAttemptLine({ ...base, outcome: "pairing-code" })).toMatch(
      /pairing code/,
    )
    expect(scanAttemptLine({ ...base, outcome: "foreign-code" })).toMatch(
      /not a pairing code/,
    )
    expect(
      scanAttemptLine({
        ...base,
        outcome: "error",
        error: "could not read the image (image/heic)",
      }),
    ).toMatch(/image\/heic/)
  })
})

describe("isImageLike", () => {
  it("takes anything the decoder can be pointed at", () => {
    expect(isImageLike({ type: "image/jpeg" })).toBe(true)
    // A screenshot pasted from a tool often arrives with no MIME type at all.
    expect(isImageLike({ type: "", name: "Screenshot 2026-11-25.png" })).toBe(
      true,
    )
  })

  it("refuses a non-image", () => {
    expect(isImageLike({ type: "text/plain", name: "notes.txt" })).toBe(false)
    expect(isImageLike({})).toBe(false)
  })
})
