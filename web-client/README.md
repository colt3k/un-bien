# web-client

A browser client for un-bien: pair with a pi session, watch its transcript, and
drive it from a phone. It is a **spike** — one file per concern, no framework, no
offline story — built to answer "can a non-Swift client drive a session using the
real wire, and how much of the transcript fold is actually hard?"

The wire is not re-implemented. `@geohar/un-bien/client` (the same transport,
Ed25519 pairing crypto, base64 canonicalization and envelope framing the machine
runs) is imported directly, aliased through Vite so three node-isms don't drag
`fs` into the bundle — see `vite.config.ts`.

## Run it

```sh
pnpm --filter web-client dev            # vite dev server, bound to all interfaces
pnpm --filter web-client build          # dist/ (88 kB JS, 30 kB gzip)
pnpm --filter web-client preview        # serve dist/ — use THIS on a phone
pnpm --filter web-client test           # 76 passing (see Conformance)
```

On a phone, use `preview`, not `dev`: the dev server's HMR socket drops on a
tailnet blip or a backgrounded tab and full-reloads the page, which looks exactly
like the client losing the session.

````

Then open `http://<tailnet-host>:5173` (e.g. `http://m5max.tail5f1ece.ts.net:5173`)
and put the relay URL in the drawer. Dev-server-only exposure; a real deployment
wants TLS (WebCrypto subtle crypto and a `wss://` relay) and a static host.

To exercise it without a real pi, there is a scripted machine double:

```sh
relay/target/release/unbien-relay                       # UNBIEN_STATE_DIR to isolate it
node web-client/scripts/fake-machine.ts --turn-ms 8     # prints the pairing URI
````

That double is **not** a second implementation of the extension and proves
nothing about the real one; it exists so the browser end can be driven against
the real Rust relay. Everything it emits was copied from `extension/src`.

To capture what a REAL session sends, as a fixture for this fold:

```sh
# in the pi session: /unbien pair   → copy the pairing URI ("camera-less devices")
npx tsx web-client/scripts/dump-entries.ts \
  --relay http://<tailnet-host>:3000 \
  --pair  'unbien://pair?t=…&epk=…&n=…&rm=…' \
  --out   /tmp/unbien-fixture.json
```

It pairs as a throwaway device (Node has no stored identity, so each run needs a
fresh code — the machine's code is single-use), lists rooms, walks `get_entries`
to its leaf, and writes the entries verbatim. The output file IS your session —
prompts, tool output, paths — so it goes in `/tmp`, never in the repo.

## What was verified end to end (Chrome + real relay + the double)

- Connect: Ed25519 challenge/response over the browser's native `WebSocket`
  through the `ws` shim; relay identity pinned TOFU at pair time.
- Pair: pasted `unbien://pair?…` code whose `epk` is **base64url** → stored as
  standard padded base64 (`…X-6NY` → `…X+6NY=`). The DESIGN.md §10.1 trap, in a
  live pairing.
- Discovery: `rooms_check` returned the machine's real `room_meta` (name, cwd,
  caps); the room card listed every advertised cap before attach.
- Replay: paged `get_entries` (two pages, walk terminated by the empty page)
  folded into rows keyed by pi's entry ids — `e1`, `e2`, `e2#1`, `call_read_1`.
- Live turn: deltas coalesced into one row per content block; the authoritative
  `message_end` landed on the same row instead of duplicating it; tool card ran
  `running → ok`; `turn_end`/`agent_settled` cleared the streaming flag.
- Composer: `prompt` when idle, `steer` while the turn was running, and
  `prompt` + `streamingBehavior: "followUp"` for the queue button — all three
  observed in the machine's log.
- Dialog: an `extension_ui_request select` rendered as an overlay; answering it
  sent `extension_ui_response` and cleared the overlay.
- Abort: the ■ button sent `abort`.
- Machine restart: the relay's `room_announced` re-triggered a full re-attach,
  so the transcript re-synced instead of ageing.
- Relay restart: reconnect, re-subscribe, re-attach; the pinned identity still
  matched.
- **Relay key rotation refused**: with the relay's `relay-keypair.json` replaced,
  the client refused the socket, said why ("this URL is serving a different relay
  than the one you paired with"), left the pin untouched and sent no session
  traffic. Restore the key, reload, working again.

Screenshot of a live turn: `/tmp/unbien-smoke/web-client-live.png`.

## What is not here

- **Conformance covers the projection, not the pixels.** `test/corpus.test.ts`
  runs all ten `contracts/conformance/` scenarios with no skips and compares,
  in **render order**: `(kind, row)`, `text` (prefix — the corpus scrubs long
  strings and escapes their newlines), `streaming`, `images`, `state`, `tool`,
  `flags`, `leafId`, `subagents` and `pendingAsks`. Not compared: `blocks` — the
  tool card's result face (`ToolFaceResolver.resolve`: terminal / file / diff /
  lines / script / markdown / …), which this client does not resolve yet — plus
  `plan`, and `replay` mode (the corpus records no paged fixture, so paging is
  covered only by `test/derive.test.ts`). Three scenarios expect zero items, so
  for them this means "no spurious rows".
- **Widening that comparison paid for itself immediately.** It found eight
  `setStatus`/`notify` frames folded as eight blocking dialogs (the overlay
  popped for a status line), `turn_end` setting `ended` (the session looked dead
  after every reply — `session_shutdown` is the only frame that says that), a
  subagent panel stuck at `started` because the status is the CHANNEL name
  (`subagents:completed`), a subagent `type` the panel never carried, and
  `tool_execution_end` asserting a turn was in flight.
- **Row identity and the derived path are ported**, from the app's reference:
  `SessionState.swift` (`applyEntries` / `derivePath` /
  `renderPendingPathEntries`), `SessionState+Identify.swift` and
  `SessionState+BirthEntry.swift` — NOT `RowBoundsStore.swift`, which despite the
  name holds measured row _heights_ for windowed layout and says nothing about
  identity. So: entries are indexed and retained, the active path is backwalked
  from pi's leaf beacon, and rows are born only for path entries (an abandoned
  branch is data with no row). A live row is matched to its entry by
  `identify = hash(role|timestamp|contentSignature)` and re-keyed to the durable
  entry id instead of twinning.
- **One known deviation from the reference:** the app keeps delta-built bubble
  text at `message_end`; this fold takes pi's stored content when it holds MORE
  (a client that joined mid-stream saw a prefix). Never loses content, never
  truncates. Everything else above matches the app's shape: entry-born rows
  insert BEFORE the live tail (`insertBeforeLiveTail`), and a live row is
  re-keyed to its durable entry id by a debounced `get_entries` re-read after
  each `turn_end` — without that re-read the rows you watched stream stay
  `assistant#7` forever and the next replay twins them.

## Session continuity

- **A reload resumes the session.** The attached room is stored
  (`unbien.web.lastRoom.v1`); on connect the client re-attaches it. pi's room id
  rotates per session, so the stored id is a hint: if the machine no longer
  advertises it and has exactly one live room, that one is taken; with several,
  the client says so and waits for a pick. Unpairing, or the room being reported
  ended, drops the record so a boot does not chase a dead session.
- **Scrolling holds still.** The row at the top edge is the anchor: a render that
  adds rows above it (a rootward extension) or re-keys rows compensates the
  scroll so the anchor does not move. Only when the reader was already at the
  tail does the view follow new output — so a mid-turn extension no longer yanks
  a reader who scrolled up, and a reload no longer dumps them at the top of an
  empty column.
- **Thinking can be hidden.** The drawer's "Hide thinking" toggles reasoning
  rows, named after the app's `hideReasoning` so the preference means the same
  thing on both devices. Like the app's, it is a VIEW preference: the fold keeps
  every thinking delta, so flipping it back mid-session shows what already
  arrived — and hidden rows stop pinning a reader to the tail.
- **Notices stack, three deep.** A batch can carry several real problems; one
  label showed only the last, so the important one was lost to a later cosmetic
  one.
- No model/thinking pickers, no session list controls (fork/compact/new/navigate),
  no `session_launch` UI beyond `App.launch()`, no syntax highlighting (the file
  face records its language and nothing paints it), and the call's ARGUMENTS are
  not shown — only the face chip and the result. Partial output streams as the
  running face (terminal text for a shell, plain text otherwise).
- **Images are drawn, and they cost memory.** pi rides image content blocks
  inline as base64, so a screenshot session carries the bytes in the transcript
  for as long as the tab lives. The view caps a row at 8 images (the projected
  count stays honest); there is no disk cache and no eviction of old ones. A
  long image-heavy session on a phone is the case to watch.
- No service worker: "Add to Home screen" works, offline does not.
- Slash commands are sent as ordinary prompts (pi expands them on the machine).
  The iOS app's command registry and its refusal toasts for TUI-only commands are
  not reimplemented.

## Layout

| file                              | job                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `src/main.ts`                     | boot; import order is load-bearing (polyfills first)                                                               |
| `src/derive.ts`                   | pi's entry tree: backwalk the leaf, derive the active path, birth only path rows                                   |
| `src/content-identity.ts`         | `identify` — the id-less live frame to durable entry bridge                                                        |
| `src/tool-faces.ts`               | a tool card's RESULT face, resolved from the tool's declared spec — the corpus's `blocks`                          |
| `src/polyfills.ts`                | `Buffer` global before anything touches the core                                                                   |
| `src/session-client.ts`           | port of `unbien-cli/src/client.ts`: pairing awaited, `rooms_check` honesty, paged `get_entries`, identity pin      |
| `src/framing.ts`                  | outer envelope, plane stamping (`rpc`/`evt`/`ub` — an unstamped frame is silently dropped), inbound classification |
| `src/reducer.ts`                  | the fold: live frames and replayed entries through one path                                                        |
| `src/identity.ts`, `src/store.ts` | device Ed25519 key in localStorage, relay pins (TOFU), pairing records                                             |
| `src/invite.ts`                   | `unbien://pair?…` parsing + key canonicalization                                                                   |
| `src/app.ts`                      | DOM: drawer, transcript patching, composer, dialogs                                                                |
| `src/shims/`                      | `node:crypto` (noble), `ws` (native socket), `debug_log`                                                           |
| `scripts/fake-machine.ts`         | scripted machine double for the smoke test                                                                         |
