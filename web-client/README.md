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
pnpm --filter web-client test           # 50 passing (see Conformance)
```

Then open `http://<tailnet-host>:5173` (e.g. `http://m5max.tail5f1ece.ts.net:5173`)
and put the relay URL in the drawer. Dev-server-only exposure; a real deployment
wants TLS (WebCrypto subtle crypto and a `wss://` relay) and a static host.

To exercise it without a real pi, there is a scripted machine double:

```sh
relay/target/release/unbien-relay                       # UNBIEN_STATE_DIR to isolate it
node web-client/scripts/fake-machine.ts --turn-ms 8     # prints the pairing URI
```

That double is **not** a second implementation of the extension and proves
nothing about the real one; it exists so the browser end can be driven against
the real Rust relay. Everything it emits was copied from `extension/src`.

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

- **Conformance is (kind, row) only.** `test/corpus.test.ts` runs all ten
  `contracts/conformance/` scenarios and compares `(kind, row)` in **render
  order** — no skips. What that does NOT cover: `blocks`, `flags`,
  `pendingAsks`, `leafId`, the panel projections, and `replay` mode (the corpus
  records no paged fixture, so paging is only covered by `test/derive.test.ts`).
  Three scenarios expect zero items, so for them this means "no spurious rows".
- **Row identity and the derived path are ported**, from the app's reference:
  `SessionState.swift` (`applyEntries` / `derivePath` /
  `renderPendingPathEntries`), `SessionState+Identify.swift` and
  `SessionState+BirthEntry.swift` — NOT `RowBoundsStore.swift`, which despite the
  name holds measured row *heights* for windowed layout and says nothing about
  identity. So: entries are indexed and retained, the active path is backwalked
  from pi's leaf beacon, and rows are born only for path entries (an abandoned
  branch is data with no row). A live row is matched to its entry by
  `identify = hash(role|timestamp|contentSignature)` and re-keyed to the durable
  entry id instead of twinning.
- **Known deviation from the reference:** the app keeps delta-built bubble text at
  `message_end`; this fold takes pi's stored content when it holds MORE (a client
  that joined mid-stream saw a prefix). Never loses content, never truncates.
  Entry-born rows also append at the tail rather than inserting before the live
  tail (`insertBeforeLiveTail`), so a reconnect that folds old entries alongside
  live rows can float them low.
- No model/thinking pickers, no session list controls (fork/compact/new/navigate),
  no `session_launch` UI beyond `App.launch()`, no image rendering, no
  tool-arg/`partial` streaming detail beyond a tail.
- No service worker: "Add to Home screen" works, offline does not.
- Slash commands are sent as ordinary prompts (pi expands them on the machine).
  The iOS app's command registry and its refusal toasts for TUI-only commands are
  not reimplemented.

## Layout

| file | job |
| --- | --- |
| `src/main.ts` | boot; import order is load-bearing (polyfills first) |
| `src/derive.ts` | pi's entry tree: backwalk the leaf, derive the active path, birth only path rows |
| `src/content-identity.ts` | `identify` — the id-less live frame to durable entry bridge |
| `src/polyfills.ts` | `Buffer` global before anything touches the core |
| `src/session-client.ts` | port of `unbien-cli/src/client.ts`: pairing awaited, `rooms_check` honesty, paged `get_entries`, identity pin |
| `src/framing.ts` | outer envelope, plane stamping (`rpc`/`evt`/`ub` — an unstamped frame is silently dropped), inbound classification |
| `src/reducer.ts` | the fold: live frames and replayed entries through one path |
| `src/identity.ts`, `src/store.ts` | device Ed25519 key in localStorage, relay pins (TOFU), pairing records |
| `src/invite.ts` | `unbien://pair?…` parsing + key canonicalization |
| `src/app.ts` | DOM: drawer, transcript patching, composer, dialogs |
| `src/shims/` | `node:crypto` (noble), `ws` (native socket), `debug_log` |
| `scripts/fake-machine.ts` | scripted machine double for the smoke test |
