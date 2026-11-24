# Feasibility: an Android client that mirrors the iOS app

> Notes about the author's setup (a Tailscale-linked Mac and an Android phone) —
> kept for continuity, not product documentation, and deliberately not in the
> Quarto site list. Hostnames, tailnet names, addresses and room ids here are
> placeholders: `mybox.my-tailnet.ts.net` means "your node, your tailnet".

Addendum to `docs/android-tailscale-plan.md`, same review of `cdee234`.
Short answer: **yes, feasible for personal use, and cheaper than it looks** — but
"mirror" is a ~2–4 week project, not an afternoon. Here's the measured breakdown.

---

## 1. Why this is tractable

| Asset in the repo | Why it matters for a second client |
| --- | --- |
| `docs/rpc-envelope.md` (483 lines) | The client↔extension protocol is written down: envelope shape (`{type:"rpc"\|"evt"\|"ub", protocolVersion, ct}`), the `ub` plane, handshake order, reconstruction flow, `session_sync_end`. Not reverse-engineered from Swift. |
| `contracts/conformance/` (10 scenarios + `vocab.md`) | A **cross-implementation conformance corpus**. Wire frames in, one normalized `expected.json` out (`items`/`flags`/`subagents`/`plan`/`pendingAsks`/`leafId`), asserted *identically* by two independent reducers today: `extension/src/session/conformance.test.ts` (TS) and `app/Tests/UnBienCoreTests/ConformanceHarnessTests.swift` (Swift). **A new client adds a third runner and is then *proven* correct**, which is the single biggest de-risker. |
| `app/Tests/UnBienCoreTests/Fixtures/*.jsonl` | More frame-level vectors (`pair_ok`, `approve_tool`, `cancel`, `peer_online`, …). |
| `@geohar/un-bien/client` export | A **reusable client core in TypeScript**: transport (488 lines), pairing crypto (44), mesh base64 canonicalization (292), rpc-envelope framing (433). Already consumed by the CLI. |
| `unbien-cli/` (6,230 lines, non-test) | A second, complete client implementation — including a transcript reducer (`reduce.ts`) that explicitly says it "mirrors the Swift `SessionState.applyRPC` role, so the same fixture corpus can be replayed through both." |
| Capability gating (`hello.caps`) | Unknown/old clients degrade gracefully instead of breaking. |
| MIT license, upstream attribution already in place | Forking for personal use is clean. |
| **No push notifications anywhere** | `grep` for APNs/Firebase/push in `app/Sources`, `relay/src`, `extension/src` finds nothing relevant. So there is no FCM/APNs sender to build for parity — and no "agent is waiting" alert on any platform today. |
| **Relay needs zero changes** | It routes opaque `ct` and does Ed25519 challenge-response. It doesn't know or care what client language dials it. Your tailnet relay from the other plan is unchanged. |

The split that makes the number honest:

```
app/Sources/UnBienCore/   6,090 lines  ← protocol/crypto/transport/transcript model  → PORTABLE (or replace with a TS import)
  Session/    3,388   (the reducer — the genuinely hard part)
  Protocol/     887   Transport/ 828   Crypto/ 466   Envelope/ 327   Pairing/ 110   Mesh/ 84
app/Sources/UnBienApp/   14,292 lines  ← SwiftUI: views, theming, markdown, highlighter → REWRITE per platform
app/Tests/                6,190 lines  ← reusable as vectors
```

So roughly a third of the app is logic you can inherit or re-derive from a spec,
two thirds is UI you must rebuild once.

---

## 2. The trap this repo documents for you

`DESIGN.md` §10 is written by someone who has been burned by exactly this port:

> **Base64 discipline — the self-revocation trap.** Dart emitted **standard**
> base64 (`+ / =`-padded) while the pairing layer emitted **URL-safe** (`- _`,
> no pad) — same 32 bytes, different strings → **silent self-revocations**.

Dart. They already made this mistake in a Dart/Flutter client. Consequence for
any Android work: canonicalize keys/ids through a port of `mesh/encoding.ts`, and
add the conformance runner *early* (day 2, not week 3). Also §10's advice
verbatim: lift the reference test vectors (`*.test.ts`, `relay/src/auth/auth_test.rs`)
into your test suite before trusting anything.

---

## 3. Four routes, with real numbers

### R0 — Ship nothing, use the CLI (baseline)
Termux `unbien` per the other plan. Zero new code, works today, but it's a
terminal, not the app. Everything below is measured against "how far from the
iOS UX do I want to be."

### R1 — Web client in TypeScript, reused client core + reused reducer  ← **recommended first**
Reuses `@geohar/un-bien/client` (wire, crypto, base64 canonicalization) and
`unbien-cli/src/reduce.ts` (transcript reducer) instead of implementing either a
second time. New work is UI (HTML/CSS or a web framework) plus a browser shim:

- `transport/relay_client.ts` uses `node:events` + `ws` → swap to native
  `WebSocket` + a tiny emitter (≈100–150 lines).
- `pairing/crypto.ts` is `@noble/ed25519` with a Node SHA-512 hook → point that
  hook at WebCrypto/subtle (browser-safe; noble's own sha512 also works).
- Scattered `Buffer` uses (~20 across crypto/encoding/transport) → `Uint8Array`
  or a buffer polyfill.
- Device keypair in IndexedDB (no OS keychain in a browser) — weaker at rest than
  native Keystore; acceptable on your own device, and revocable from the Mac.

Delivery: serve it from the Mac over the tailnet, **Add to Home screen** on the
Pixel (PWA-ish: icon, standalone, offline shell). Tailscale Serve can give you
`https://mybox.my-tailnet.ts.net` so `wss://` matches and mixed-content blocking
never bites. Bonus: the same page works in any browser — a laptop, a friend's
tablet — and it's the same code path you'll later wrap if you want a real APK
(WebView shell, ≈1 day).

Effort: **usable in ~1–2 days of focused work, iOS-parity-ish in ~4–6 days.**
Lowest risk because both the wire layer and the reducer are already proven in TS.

### R2 — Native Kotlin + Jetpack Compose
Proper Android feel: Keystore-backed owner key, camera QR via CameraX, real
notifications (you'd be the first to have them — see §5), background reconnect
with WorkManager/foreground service, better battery and scrolling behaviour.
Cost: you implement `UnBienCore` from scratch (Kotlin), with the conformance
corpus as the acceptance gate, then 14k lines of SwiftUI's worth of Compose.
Effort: **~2–4 weeks part-time to a daily driver.** Cleanest end state, most
total work.

### R3 — Fork the upstream Flutter client and port its protocol layer
The upstream reference app (**jacobaraujo7/remote_pi**, MIT, Dart/Flutter, 492★,
pushed today, has an `/android` build) ships exactly the screens you'd want:
`onboarding/{welcome,relay,pair}`, `home/{home_page, session_tile}`,
`chat/{chat_page 27k, input_bar 33k, tool_request_card, extension_ui_sheet
17k, model_picker_sheet}`, `pairing/{pairing_page, paste_qr_sheet,
nickname_sheet}`, `settings/{settings_page, peer_list_item, revoke_confirm_dialog}`,
plus voice (deferred in un-bien anyway).

**But I verified its wire layer is obsolete.** Grepping upstream
`pi-extension/src/session/envelope.ts`, `pi-extension/src/protocol/types.ts` and
`app/lib/protocol/protocol.dart` (1,653 lines) for `protocolVersion`,
`rpc_envelope`, `get_entries`, `session_sync_end`, `"ub"`: **zero hits**. The
rpc-envelope protocol is an Un Bien change (the root README says exactly that,
and `DESIGN.md` §12 keeps that Flutter app as the *parity floor* it must exceed).
So upstream's app will not speak to your extension as-is: you'd keep its UI and
throw away its transport + protocol + reducer.

Effort: **~2–3 weeks part-time**, plus you inherit a 176-file Flutter codebase and
the Flutter toolchain. Worth it only if you like Flutter and want iOS+iPad+Android
from one codebase eventually.

### R4 — Compose Multiplatform / shared-Kotlin core + reuse of Swift core
No. Nothing to share today; the Swift core isn't portable and the TS core isn't
Kotlin. R2 with the conformance corpus gives you the same assurance cheaper.

---

## 4. Recommended sequence

1. **R0 now** (other plan) so you're productive today and you understand the
   session model from the inside — the CLI's picker/steer/queue/approval semantics
   are exactly what your UI has to reproduce.
2. **R1 first build.** Reuse the TS client core; write the conformance runner as
   your *first* commit (a vitest file that replays
   `contracts/conformance/scenarios/*/input.jsonl` and diffs
   `expected.json`). Then: transport → pairing → reconstruction → rendering →
   controls. PWA over the tailnet; no APK needed.
3. **R2 later, only if R1 feels cramped.** By then you have a validated protocol
   model and a UI spec you actually use daily, so the native rewrite is a
   rendering exercise rather than a guessing game.

If you want, I can start with (a) the conformance runner in TS, or (b) a minimal
`web-client/` that pairs, lists sessions, and renders one live transcript.

---

## 5. What an Android client can't mirror 1:1

| iOS feature | Android status |
| --- | --- |
| **Owner-key sync via iCloud Keychain** (the "sync-required" gate) | Android equivalent is Keystore + Google Block Store auto-backup (upstream's Flutter `remote_pi_identity` package does this). Honest alternative: skip sync, re-pair per device — the protocol's `/mesh/<owner_pk_hash>` endpoint already handles peer-list recovery once the owner key exists on the device. |
| **Push / "agent needs approval" alerts** | Doesn't exist on *any* platform in this repo — the relay has no sender and the iOS app has none. If you want it on Android, it's new scope: FCM + a sender that knows a session has a pending `ask`. Do NOT promise parity here. |
| Camera QR pairing | Trivial on Android (CameraX / `mobile_camera`), and `/unbien pair` also prints a **copy-paste URI** (`extension/src/commands/pairing.ts:129`), so pairing works without a camera. |
| App Store update prompts | Sideload: `./gradlew installDebug` or a debug APK; or R1 needs no install at all. |
| Markdown + highlight.js theming (`MarkdownUI`, forked `HighlighterSwift`) | Web: `marked` + `highlight.js` — pi's own TUI already uses highlight.js semantics, so parity is easier than on Swift. Compose: Markwon/sheets. |
| Image attach from phone | Not in the iOS app either (DESIGN.md: inbound image *render* ✔, "no app attach UI yet"). Don't scope it as a port requirement. |
| Voice / two-way audio | Deferred by design upstream. |

---

## 6. Risks

- **Protocol churn.** The extension releases constantly (0.25.6→0.25.9 in the
  last handful of commits). Pin a client to an extension version, read
  `docs/changelog.md` on upgrade, and *capability-gate everything* — that's what
  `hello.caps` is for. Don't fork the extension; you want the Android client to
  track it, not to freeze it.
- **The reducer, not the transport, is where you'll lose a week.** Streaming
  deltas, `leafId` cursors, abandoned-branch membership rules, `queued_message_*`
  state, plan/subagent panel folding, tool-card `aux.hunks` post-enrichment
  (`contracts/conformance/scenarios/004-diff-edit`). Reuse the TS reducer (R1) or
  build against the corpus before writing views (R2).
- **Base64 / canonical identity** — see §2. Add the corpus runner on day 2.
- **Browser trust storage (R1).** IndexedDB key ≠ Keystore. Fine for your own
  Pixel on your own tailnet; say so in the UI and keep `/unbien revoke` close.
- **Battery/reconnect on Android.** Doze and background-killed Termux/browser tabs
  both drop sockets; the extension's own liveness-ping + reconnect (see
  `docs/install.md`) covers the machine side, but the client needs its own
  resume-with-`get_entries{since}` path — which the protocol supports, so use it
  rather than holding the socket alive by force.

---

## 7. Feature checklist to call it "mirrors the iOS app"

Capability-gated, per `app/README.md`:

1. Multi-relay config + add-relay URL, per-relay grouping.
2. Pair: paste `unbien://pair?…` (and/or QR scan) → awaited `pair_ok`;
   device list + revoke (`/unbien devices`).
3. Home: machines + live sessions across all paired machines/relays.
4. Attach: `hello.caps` gating; `get_entries{since}` + `session_sync`
   reconstruction; `session_sync_end` marks the boundary; reset on `sessionId`
   change in a stable room.
5. Transcript: user/assistant/reasoning/tool/notice/compaction items; markdown +
   syntax highlight; collapsible tool cards with diff/code blocks and images.
6. Composer: send, **steer while busy vs queue**, queued chips, cancel (red stop),
   slash-command refusal rules (machine-local commands refused with a toast,
   absolute paths treated as content).
7. `extension_ui_request` flows: select / confirm / input / preview, with
   `customText` freeform handling (a wrong answer here silently answers
   `"freeform"` — see `unbien-cli/src/ask.ts`).
8. Model + thinking pickers (`list_models`, `model_set`, `thinking_set`).
9. Session ops: rename, End Chat (`remote_terminate`), fork/clone/branch,
   subagent + plan panels, `create-session` (`remote_launch`) and
   `resume-session` (`session_resume`).
10. Reconnect/resume with cursor; per-relay provenance; theme + light/dark.

Items 1–5 are 60% of the value and the bulk of the work; 8–9 are small once the
control plane works.
