/**
 * A TEST DOUBLE for the machine end of the protocol — NOT a second
 * implementation of the extension, and not evidence about the real one.
 *
 * It exists so the browser client can be driven end to end (pair → discover →
 * attach → replay → live turn → dialog) against the REAL Rust relay without
 * installing the pi extension into anyone's editor. Everything it "knows" it
 * copied from `extension/src`: the outer envelope, the stamped planes, the
 * machine-signed allow-list blob, the `ub hello` / `session_sync_end` shapes.
 *
 * Run:  node web-client/scripts/fake-machine.ts [--relay ws://localhost:3000]
 * It prints the pairing URI to paste into the web client.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import {
  RelayClient,
  ed25519KeypairFromSeed,
  ed25519Sign,
  encodeEd25519PublicKey,
  generateEd25519Keypair,
  type Ed25519Keypair,
} from "@geohar/un-bien/client"

const RELAY = arg("--relay") ?? "ws://localhost:3000"
const ROOM_ID = "aB12cD34eF56"
/** Slow the scripted turn down so a human (or a test) can send a second message
 *  while it is still running — that is the steer/queue paths, not the prompt one. */
const TURN_MS = Number(arg("--turn-ms") ?? 1) // real rooms are 12-char base64url, cwd-derived
/** A valid 1x1 transparent PNG, for the inline image blocks the double sends. */
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
const SESSION_ID = "smoke-session-1"
/** Distinct on purpose: `pair_ok.hostname` is the MACHINE, `session_name` /
 *  `room_meta.name` is the SESSION. Same field names the real extension sends
 *  (`_emitPairOk`) — a double that invents its own field names hides bugs. */
const HOSTNAME = "m5max-fake"
const SESSION_NAME = "un-bien \u00b7 fake session"
const STATE = "/tmp/unbien-smoke/machine.json"
const CAPS = [
  "session_sync",
  "session_resume",
  "remote_terminate",
  "session_fork",
  "session_new",
  "session_nav",
  "session_compact",
  "list_models",
  "model_set",
  "thinking_set",
  "remote_launch",
]

interface Persisted {
  seed: string // base64 Ed25519 secret key
  paired: string[] // owner device keys, canonical base64
  allowVersion: number
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function load(): { persisted: Persisted; keypair: Ed25519Keypair } {
  if (existsSync(STATE)) {
    const persisted = JSON.parse(readFileSync(STATE, "utf8")) as Persisted
    // The core's own derivation: same seed bytes, same peer id across restarts
    // (the relay pins the machine's key, so it must survive this script dying).
    return {
      persisted,
      keypair: ed25519KeypairFromSeed(
        new Uint8Array(Buffer.from(persisted.seed, "base64")),
      ),
    }
  }
  const keypair = generateEd25519Keypair()
  const persisted: Persisted = {
    seed: Buffer.from(keypair.secretKey).toString("base64"),
    paired: [],
    allowVersion: 0,
  }
  writeFileSync(STATE, JSON.stringify(persisted, null, 2))
  return { persisted, keypair }
}

const { persisted: state, keypair } = load()

const machinePk = encodeEd25519PublicKey(keypair.publicKey)
const relay = new RelayClient(RELAY.replace(/^http/, "ws"), keypair)
const token = `SMOKE-${Math.random().toString(36).slice(2, 8).toUpperCase()}`

/** Transcript the double serves: pi's entry shape, since the client replays
 *  history through `get_entries` exactly like the real machine. */
interface Entry {
  id: string
  type: "message"
  parentId: string | null
  timestamp: string
  message: Record<string, unknown>
}
const entries: Entry[] = []
let entrySeq = 0

function addEntry(message: Record<string, unknown>): Entry {
  // pi's message objects carry their own `timestamp`, and the live plane sends
  // the SAME object the entry stores. That is what lets a viewer match a live
  // row to its durable entry (`identify` hashes role|timestamp|content) — a
  // double that left it out would only look alike, and would collapse two
  // identical-text messages into one row.
  const timestamp = new Date().toISOString()
  const stamped = { timestamp, ...message }
  const entry: Entry = {
    id: `e${++entrySeq}`,
    type: "message",
    parentId: entries.length ? entries[entries.length - 1].id : null,
    timestamp,
    message: stamped,
  }
  entries.push(entry)
  return entry
}

addEntry({
  role: "user",
  content: [{ type: "text", text: "what does this project do?" }],
})
addEntry({
  role: "assistant",
  content: [
    { type: "thinking", thinking: "Read the manifest first." },
    { type: "text", text: "It's a Rust relay plus a pi extension." },
    {
      type: "toolCall",
      id: "call_read_1",
      name: "read",
      arguments: { path: "relay/README.md" },
    },
  ],
})
addEntry({
  role: "toolResult",
  toolCallId: "call_read_1",
  toolName: "read",
  content: [
    { type: "text", text: "un-bien relay: single port 3000, WS + /health" },
  ],
  isError: false,
})
addEntry({
  role: "assistant",
  content: [{ type: "text", text: "Relay serves WS on one port." }],
})

// ── allow-list ───────────────────────────────────────────────────────────────

function pushAllowList(): void {
  state.allowVersion += 1
  const blobObject = {
    machine_pk: machinePk,
    owners: state.paired,
    version: state.allowVersion,
    issued_at: Date.now(),
  }
  const blobBytes = Buffer.from(JSON.stringify(blobObject), "utf8")
  const sig = ed25519Sign(keypair.secretKey, new Uint8Array(blobBytes))
  relay.sendControl({
    type: "pairing_set",
    blob: blobBytes.toString("base64"),
    sig: Buffer.from(sig).toString("base64"),
  })
  log(`pairing_set v${state.allowVersion}: ${state.paired.length} owner(s)`)
}

// ── outbound ─────────────────────────────────────────────────────────────────

function sendTo(peer: string, inner: unknown): void {
  const ct = Buffer.from(JSON.stringify(inner)).toString("base64")
  relay.send(JSON.stringify({ peer, ct }))
}

function sendEnvelope(
  peer: string,
  plane: "rpc" | "evt" | "ub",
  body: unknown,
): void {
  sendTo(peer, {
    type: plane,
    ts: Date.now(),
    sessionId: SESSION_ID,
    [plane]: body,
  })
}

const rpc = (peer: string, body: unknown): void =>
  sendEnvelope(peer, "rpc", body)

// ── the scripted turn ────────────────────────────────────────────────────────

const wait = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms))
/** Set by an `abort` frame; the scripted turn bails at its next checkpoint. */
let aborted = false

async function runTurn(
  peer: string,
  prompt: string,
  callId: string,
): Promise<void> {
  const user = addEntry({
    role: "user",
    content: [{ type: "text", text: prompt }],
  })
  rpc(peer, { type: "agent_start" })
  rpc(peer, { type: "turn_start" })
  rpc(peer, { type: "message_start", message: { role: "user", content: [] } })
  rpc(peer, { type: "message_end", message: user.message })

  rpc(peer, {
    type: "message_start",
    message: { role: "assistant", content: [] },
  })
  rpc(peer, {
    type: "message_update",
    assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
  })
  rpc(peer, {
    type: "message_update",
    assistantMessageEvent: {
      type: "thinking_delta",
      contentIndex: 0,
      delta: "Check the tests. ",
    },
  })
  rpc(peer, {
    type: "message_update",
    assistantMessageEvent: {
      type: "thinking_end",
      contentIndex: 0,
      content: "Check the tests.",
    },
  })
  aborted = false
  for (const chunk of [
    "Running the suite",
    " for you now",
    " — one bash call.",
  ]) {
    await wait(120 * TURN_MS)
    if (aborted) return
    rpc(peer, {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 1,
        delta: chunk,
      },
    })
  }
  rpc(peer, {
    type: "message_update",
    assistantMessageEvent: {
      type: "toolcall_start",
      contentIndex: 2,
      id: callId,
      toolName: "bash",
    },
  })
  rpc(peer, {
    type: "tool_execution_start",
    toolCallId: callId,
    toolName: "bash",
    args: { command: "pnpm test" },
  })
  for (const line of [
    "pnpm test",
    "\nTest Files  3 passed (3)",
    "\nTests  27 passed | 4 skipped (31)",
  ]) {
    await wait(220 * TURN_MS)
    if (aborted) return
    rpc(peer, {
      type: "tool_execution_update",
      toolCallId: callId,
      partialResult: { content: [{ type: "text", text: line }] },
    })
  }
  rpc(peer, {
    type: "tool_execution_end",
    toolCallId: callId,
    toolName: "bash",
    result: {
      content: [
        {
          type: "text",
          text: "Test Files  3 passed (3)\nTests  27 passed | 4 skipped (31)",
        },
      ],
    },
    isError: false,
  })
  // pi writes ONE entry per assistant message, and the live `message_end` for
  // that message carries the SAME message object the entry stores. Same role,
  // same timestamp, same content — that is exactly what lets a viewer match the
  // row it built from deltas to the durable entry id later. Created before the
  // toolResult so the parent chain matches pi's (assistant → toolResult).
  const first = addEntry({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Check the tests." },
      {
        type: "text",
        text: "Running the suite for you now — one bash call.",
      },
      {
        type: "toolCall",
        id: callId,
        name: "bash",
        arguments: { command: "pnpm test" },
      },
    ],
  })
  const toolResult = addEntry({
    role: "toolResult",
    toolCallId: callId,
    toolName: "bash",
    content: [
      {
        type: "text",
        text: "Test Files  3 passed (3)\nTests  27 passed | 4 skipped (31)",
      },
      { type: "image", mimeType: "image/png", data: TINY_PNG },
    ],
    isError: false,
  })
  rpc(peer, { type: "message_end", message: first.message })
  rpc(peer, { type: "entry_appended", entry: first })
  rpc(peer, { type: "entry_appended", entry: toolResult })
  const final = addEntry({
    role: "assistant",
    content: [
      { type: "text", text: "Green: 27 passed, 4 skipped with named reasons." },
      {
        type: "toolCall",
        id: callId,
        name: "bash",
        arguments: { command: "pnpm test" },
      },
    ],
  })
  // The turn's second assistant message: streamed live, stored as an entry.
  rpc(peer, {
    type: "message_start",
    message: { role: "assistant", content: [] },
  })
  rpc(peer, {
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "Green: 27 passed, 4 skipped with named reasons.",
    },
  })
  rpc(peer, { type: "message_end", message: final.message })
  rpc(peer, { type: "entry_appended", entry: final })
  // An actionable dialog, so the ask overlay gets exercised too.
  rpc(peer, {
    type: "extension_ui_request",
    id: `ask-${callId}`,
    method: "select",
    title: "Commit this?",
    options: ["yes, commit", "no, leave it"],
  })
  rpc(peer, { type: "turn_end", message: final.message })
  rpc(peer, { type: "agent_end", messages: [] })
  rpc(peer, { type: "agent_settled" })
}

// ── inbound ──────────────────────────────────────────────────────────────────

relay.on("message", (line: string) => {
  let outer: { peer?: string; room?: string; ct?: string }
  try {
    outer = JSON.parse(line)
  } catch {
    return
  }
  if (!outer.ct || !outer.peer) return
  const sender = outer.peer
  let inner: Record<string, unknown>
  try {
    inner = JSON.parse(Buffer.from(outer.ct, "base64").toString("utf8"))
  } catch {
    return
  }

  if (inner.type === "pair_request") {
    const req = inner as { id?: string; token?: string; device_name?: string }
    if (req.token !== token) {
      sendTo(sender, {
        type: "pair_error",
        in_reply_to: req.id,
        code: "token_unknown",
        message: "Token was not issued by this machine.",
      })
      log(
        `pair_request refused (bad token ${String(req.token)}) from ${short(sender)}`,
      )
      return
    }
    if (!state.paired.includes(sender)) state.paired.push(sender)
    writeFileSync(STATE, JSON.stringify(state, null, 2))
    pushAllowList()
    sendTo(sender, {
      type: "pair_ok",
      in_reply_to: req.id,
      session_name: SESSION_NAME,
      session_started_at: Date.now(),
      room_id: ROOM_ID,
      harness: { name: "Pi coding agent", version: "0.0.0-smoke" },
      hostname: HOSTNAME,
      protocol_version: 1,
      capabilities: CAPS,
    })
    log(`paired ${short(sender)} (${req.device_name ?? "?"})`)
    return
  }

  const ub = inner.ub as Record<string, unknown> | undefined
  if (ub?.type === "session_sync") {
    sendEnvelope(sender, "ub", {
      type: "hello",
      caps: CAPS,
      sessionId: SESSION_ID,
    })
    sendEnvelope(sender, "ub", {
      type: "session_sync_end",
      ...(typeof ub.id === "string" ? { in_reply_to: ub.id } : {}),
      session_started_at: Date.now(),
      session_name: SESSION_NAME,
    })
    log(`session_sync from ${short(sender)} → hello + session_sync_end`)
    return
  }

  const frame = (inner.rpc ?? inner) as Record<string, unknown>
  if (typeof frame.type !== "string") return
  const id = typeof frame.id === "string" ? frame.id : undefined

  switch (frame.type) {
    case "get_state":
      rpc(sender, {
        type: "response",
        id,
        command: "get_state",
        success: true,
        data: {
          model: { id: "claude-test" },
          thinkingLevel: "medium",
          isStreaming: false,
        },
      })
      return
    case "get_entries": {
      const since = typeof frame.since === "string" ? frame.since : undefined
      const from = since ? entries.findIndex((e) => e.id === since) + 1 : 0
      const page = entries.slice(from, from + 50)
      rpc(sender, {
        type: "response",
        id,
        command: "get_entries",
        success: true,
        data: {
          entries: page,
          leafId: page.length ? page[page.length - 1]?.id : undefined,
        },
      })
      log(`get_entries since=${since ?? "root"} → ${page.length} entries`)
      return
    }
    case "prompt":
    case "steer": {
      const message = String(frame.message ?? "")
      rpc(sender, {
        type: "response",
        id,
        command: frame.type,
        success: true,
        data: { ok: true },
      })
      log(
        `${frame.type}${frame.streamingBehavior === "followUp" ? " (queued followUp)" : ""}: ${JSON.stringify(message.slice(0, 60))}`,
      )
      void runTurn(sender, message, `call_${Date.now().toString(36)}`)
      return
    }
    case "abort":
      log("abort")
      aborted = true
      rpc(sender, {
        type: "response",
        id,
        command: "abort",
        success: true,
        data: { ok: true },
      })
      return
    case "extension_ui_response":
      log(
        `ui_response ${String(frame.value ?? frame.confirmed ?? "cancelled")}`,
      )
      return
    default:
      log(`(ignored rpc ${String(frame.type)})`)
      return
  }
})

function short(pk: string): string {
  return pk.slice(0, 10)
}
function log(message: string): void {
  console.log(`[fake-machine] ${message}`)
}

async function main(): Promise<void> {
  await relay.connect({
    roomId: ROOM_ID,
    roomMeta: {
      name: SESSION_NAME,
      cwd: "/tmp/fake-project",
      caps: CAPS,
      model: "claude-test",
      working: false,
    },
  })
  pushAllowList()
  console.log(`[fake-machine] peer   ${machinePk}`)
  console.log(`[fake-machine] room   ${ROOM_ID}`)
  console.log(`[fake-machine] relay  ${RELAY}`)
  console.log(
    `[fake-machine] pair with:\nunbien://pair?t=${token}&epk=${Buffer.from(keypair.publicKey).toString("base64url")}&n=${encodeURIComponent(SESSION_NAME)}&rm=${ROOM_ID}`,
  )
}

void main().catch((err) => {
  console.error(
    "[fake-machine] failed:",
    err instanceof Error ? err.message : err,
  )
  process.exit(1)
})
