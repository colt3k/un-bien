/**
 * Message-intrinsic identity + content signatures.
 *
 * Port of `app/Sources/UnBienCore/Session/SessionState+Identify.swift`. A pi
 * message carries NO id, so a row built from the live stream has to be matched
 * to the same message when it comes back in a `get_entries` page. `identify` is
 * that bridge: `hash(role | timestamp | contentSignature)`.
 *
 * It deliberately uses NOTHING from the vendor. The Swift comment records what
 * happened when `responseId` was trusted there: one real ollama-cloud session
 * had 426 of 744 responseIds shared across different messages, so every message
 * sharing an id looked like "the same message" to the match loop and its row
 * was swallowed by a re-key — invisible forever, with the walk/cache/derive all
 * reporting themselves healthy. Same content at the same timestamp IS the same
 * message; different content or time is not.
 *
 * Keep this byte-identical to the Swift: the hash has to agree across launches
 * and across implementations, which is why it is FNV-1a over UTF-8 in base 36
 * rather than a language-native hash.
 */

const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const MASK64 = 0xffffffffffffffffn

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz"

/** Deterministic FNV-1a over UTF-8, base-36. */
export function stableHash(input: string): string {
  let hash = FNV_OFFSET
  for (const byte of new TextEncoder().encode(input)) {
    hash ^= BigInt(byte)
    hash = (hash * FNV_PRIME) & MASK64
  }
  if (hash === 0n) return "0"
  let out = ""
  let n = hash
  while (n > 0n) {
    out = BASE36[Number(n % 36n)] + out
    n /= 36n
  }
  return out
}

type Frame = Record<string, unknown>

function asFrame(value: unknown): Frame | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Frame)
    : null
}

function str(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/**
 * Canonical, order-preserving signature of a message `content` (an array of
 * blocks, or a bare user string). Tool-call ids are included so tool-only
 * messages do not collide on empty text.
 */
export function contentSignature(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .map((raw) => {
        const block = asFrame(raw) ?? {}
        switch (str(block.type)) {
          case "text":
            return `t:${str(block.text)}`
          case "thinking":
            return `k:${str(block.thinking)}`
          case "toolCall":
            return `c:${str(block.id)}:${str(block.name)}`
          case "image":
            return `i:${str(block.mimeType)}`
          default:
            return str(block.type)
        }
      })
      .join("\n")
  }
  return typeof content === "string" ? content : ""
}

/** The message's own joined text — what an assistant/user row displays. */
export function joinedText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((raw) => str(asFrame(raw)?.text))
    .filter((text) => text.length > 0)
    .join("\n")
}

/**
 * Stable, message-intrinsic identity. One row per pi message; identical on the
 * live `message_end` frame and on a later entry replay of that message.
 */
export function identify(message: unknown): string {
  const msg = asFrame(message) ?? {}
  const role = str(msg.role) || "?"
  const ts = typeof msg.timestamp === "number" ? msg.timestamp : 0
  return `m${stableHash(`${role}|${ts}|${contentSignature(msg.content)}`)}`
}

/** Image blocks (`{type:"image", data, mimeType}`) from a message `content`. */
export function imagesFromContent(
  content: unknown,
): { data: string; mime: string }[] {
  if (!Array.isArray(content)) return []
  const out: { data: string; mime: string }[] = []
  for (const raw of content) {
    const block = asFrame(raw)
    if (!block || str(block.type) !== "image") continue
    const data = str(block.data)
    const mime = str(block.mimeType)
    if (data && mime) out.push({ data, mime })
  }
  return out
}

/**
 * Images from a `tool_execution_end` result. The live result is a wrapper
 * `{content:[...], details}`, so unwrap `content` first.
 */
export function imagesFromToolResult(
  result: unknown,
): { data: string; mime: string }[] {
  if (Array.isArray(result)) return imagesFromContent(result)
  const frame = asFrame(result)
  return frame?.content !== undefined ? imagesFromContent(frame.content) : []
}
