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
pnpm --filter web-client test           # 28 passing, 4 skipped (see Conformance)
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

- **Conformance is partial.** `test/corpus.test.ts` asserts `(kind, row)` against
  `contracts/conformance/`. 6/10 live scenarios match. The 4 skips are two
  subsystems this fold lacks, named in that file:
  1. *row identity across live and replay* — pi's `RowBoundsStore` derives row
     identity from entry ids + parent links + content hashes, so a block seen
     live and again in a `get_entries` page is one row. This fold keys live rows
     `<kind>#<seq>`, so redelivery duplicates them (001, 007).
  2. *derived-path membership* — rows exist only for blocks on pi's derived path;
     an abandoned branch is retained data with no row. This fold is linear
     (002, 009).
  `blocks`, `flags`, `pendingAsks`, `leafId`, the panel projections and the
  replay paging contract are not compared at all.
- No model/thinking pickers, no session list controls (fork/compact/new/navigate),
  no `session_launch` UI beyond `App.launch()`, no image rendering, no
  tool-arg/`partial` streaming detail beyond a tail.
- No service worker: "Add to Home screen" works, offline does not.
- Slash commands are sent as ordinary prompts (pi expands them on the machine).
  The iOS app's command registry and its refusal toasts for TUI-only commands are
  not reimplemented.
- Not on the pnpm workspace's lint/format gate yet.

## Layout

| file | job |
| --- | --- |
| `src/main.ts` | boot; import order is load-bearing (polyfills first) |
| `src/polyfills.ts` | `Buffer` global before anything touches the core |
| `src/session-client.ts` | port of `unbien-cli/src/client.ts`: pairing awaited, `rooms_check` honesty, paged `get_entries`, identity pin |
| `src/framing.ts` | outer envelope, plane stamping (`rpc`/`evt`/`ub` — an unstamped frame is silently dropped), inbound classification |
| `src/reducer.ts` | the fold: live frames and replayed entries through one path |
| `src/identity.ts`, `src/store.ts` | device Ed25519 key in localStorage, relay pins (TOFU), pairing records |
| `src/invite.ts` | `unbien://pair?…` parsing + key canonicalization |
| `src/app.ts` | DOM: drawer, transcript patching, composer, dialogs |
| `src/shims/` | `node:crypto` (noble), `ws` (native socket), `debug_log` |
| `scripts/fake-machine.ts` | scripted machine double for the smoke test |
