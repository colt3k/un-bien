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
pnpm --filter web-client test           # 113 passing (see Conformance)
```

To build a conformance fixture from a real session, open the paired URL with
`&capture=1` and call `__unbienDump("NNN")` in the console — it downloads every
inbound envelope as JSONL. The tee is off unless the URL asks for it and nothing
in the app reads the buffer (`web-client/src/app.ts`).

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

- **`011`/`012` are captured, not authored** — a live pi session's
  `get_entries` pages, pulled by `scripts/dump-entries.ts`, with every string,
  thinking block, tool argument, tool output, system-prompt `sections` value and
  `details` value replaced by its length (`«62»`). Ids, the parentId chain,
  timestamps, entry/message key sets, tool names and `display` flags are verbatim.
  Its `expected.json` is generated by the REFERENCE reducer
  (`UNBIEN_CONFORMANCE_REGENERATE=1 swift test --filter ConformanceHarnessTests`),
  so the assertion is this fold against the app, not against my reading of it.
  It pins shapes no authored fixture had: a `system` entry (no row), assistant
  entries whose content is `[thinking, toolCall]` (no row; cards rebuilt from the
  `toolCall` blocks — thinking rides replay and births NO reasoning row),
  `toolResult` entries with no `details` (still a terminal face), `custom`
  entries with entry-level `data` (no row), and a trailing assistant whose
  toolCall has no result yet (`pending`).
- **`012` is the same session driven to 100 entries**, and it corrected
  something I had asserted a commit earlier. `read`/`bash` results carry **no
  `details` at all** — faces resolve from the empty-details path; a `read`
  truncation notice rides the TEXT
  (`[965 more lines in file. Use offset=201 to continue.]`) with no payload to
  corroborate it; and a `bash` result ending in `[file ...]` proves the split must
  key on pi's `\n\n[` seam, not on "ends in a bracket". But `edit` results DO
  carry `details: {diff, patch, firstChangedLine}`, and the two diff fields are
  **different formats** — `diff` is line-number prefixed (`-1 # Heading A`),
  `patch` is a unified diff. The face parses `patch` (reference
  `ToolFace.swift:193`); reaching for the shorter `diff` name renders line numbers
  as content.
- **What `blocks` reports, narrowed by the same capture.** `"hunks"` means the
  card has the `aux` sidecar's raw hunks attached, NOT "a diff is visible" —
  reference `ConformanceProjection.swift:89` checks `card.hunks != nil` alone. So
  a replayed edit projects `["diff"]` while a live one with a sidecar projects
  `["diff", "hunks"]`, both showing the same diff. My rule had folded the two
  together (face-derived hunks counted too) and 012 caught it. Reference
  projection for 012: 34 items — 26 tool cards (21 terminal, 4 file, 1 diff),
  4 user, 4 assistant — leaf `c8dde2c8`.
- **`013` is the compaction plane, and it exposed a dropped frame.** No paired
  room had ever compacted — the `test` room refused `/compact` ("Nothing to
  compact (session too small)") and wrote **no entry and no frame** for the
  attempt, so a client cannot learn about a failed compaction from history.
  The fixture therefore comes from one of pi's own session logs for this repo,
  cut after its first `compaction` entry: pi's log lines are the entries the
  extension forwards, minus the leading `session` line it does not send. What it
  proved: the live plane's only compaction shape is the rpc **`compaction_end`**,
  because the extension remaps pi's `session_compact` EVENT into it
  (`extension/src/session/rpc_envelope.ts:338`) — folding on the event name, or
  on pi's subscribe-only `compaction`, matches nothing and drops the marker
  silently. This client was doing exactly that, and its replay path built a row
  with no `tokensBefore` (the count the caption shows: "Context compacted
  (213920 tokens)"). Both fixed by routing the entry through the same funnel as
  the live frame, keyed on the entry id, as the reference does
  (`SessionState+BirthEntry.swift:18`). The row's kind survived; its content did
  not, which is the kind of bug a green projection can hide.
- **`013` now carries both compaction producers.** A second entry, captured
  from a native `/compact` (`fromHook: false`) rather than the pre-compact hook
  (`fromHook: true`), re-parented onto the chain. The shape is identical
  field-for-field — `summary`, `firstKeptEntryId`, `tokensBefore`,
  `details{readFiles,modifiedFiles}`, `usage{…}`, `systemMessage` — so a client
  that branches on `fromHook`, or hides hook compactions, diverges. Across all 72
  compaction entries in the local logs every one carries all of those fields (66
  hook, 6 native) and `tokensBefore` is always a real number (83,746–218,223);
  the `tokensBefore: 0` we saw elsewhere is pi-durable's, not the SDK's. Its
  `firstKeptEntryId` intentionally DANGLES (names an entry outside the fixture,
  which is normal for a paged walk) — and nothing reads that field today in the
  app, the extension or this client, so a future "context starts here" divider
  must tolerate it pointing off-page.
- **The compaction caption is now a compared string, not per-client copy.** It
  was SwiftUI-local (`Label("Context compacted (\(marker.tokensBefore) tokens)")`)
  and duplicated by this client's renderer with nothing checking either. It moved
  to core (`CompactionMarker.caption`) and into the projection, so the wording
  fails the corpus if a client rewords or drops it; the fold now carries it in
  `item.text` and the renderer just draws that.
- **`014` puts images on the replay plane** — a captured `chrome_screenshot`
  result whose content is `[image, text]`, image FIRST, then the
  "Screenshot 1024x578 png (42KB) saved to …" line, with
  `details: {path, width, height}` and the bytes inline as
  `{type: "image", data, mimeType: "image/png"}`. The card stays ONE row: its
  face is `text` (an unfamiliar tool name → the text face, not an image face) and
  `images: 1` is a per-card count, so a client that promotes images to their own
  rows, or to a new card kind, diverges. The fixture's payload is replaced by a
  **valid** 1×1 PNG rather than `«116164»`, because the reference decodes `data`
  before it counts: undecodable filler makes BOTH sides report `images: 0`, and
  the scenario then silently tests the decoder's rejection instead of the fold. I
  built it that way first and it was vacuously green.
- **Same fixture's second card is a `read` of an image FILE** — content
  `[text, image]`, the OPPOSITE order (pi's caption
  `Read image file [image/jpeg]…` first), `details` absent. Reference projects
  face `file` with `images: 1`: the caption is the face, the picture is a count
  on the card, and block order is not something a client may assume. (The pair is
  captured, not authored — at entry 2060 of a harnager session — but re-parented
  onto this chain, which `meta.json` says.)
- **`015` is the first scenario captured from the LIVE plane**, recorded with
  `scripts/dump-entries.ts --watch 300` (it walks entries, then writes every
  envelope the machine pushes, one per line). One complete turn: 229
  `message_update` deltas, the assistant's `message_end` with `[thinking,
toolCall]`, `tool_execution_start`/`_end` for a `read`, the toolResult
  `message_end`, `turn_end`. It found three places where I had quietly not been
  the reference:
  - **The image arrives three times per turn** — in `tool_execution_end.result
.content`, again in `result.structuredContent` (pi's machine-readable copy,
    repeating the same 142 KB base64), and again in the later `message_end`
    toolResult. The card counts it **once**. And the live `result` carries fields
    the stored record never has (`structuredContent`, `usage`, a nested
    `isError`), so I now canonicalize it to `{content, details?}` the way
    `canonicalToolResult` (`SessionState+ToolResult.swift:20`) does — keeping the
    live object both retained the payload twice and let a live card resolve a
    different face from its own replay.
  - **Settling never re-writes what streamed.** `text_end`/`thinking_end` carry
    the whole block, and the reference ignores them outright; a live `message_end`
    settles (attaches images, stops the streaming flag) without touching the text
    the deltas built. I was overwriting both. In production the two strings are
    identical, so this only shows up under a scrubbed fixture — which is exactly
    why the corpus caught it and a live demo would not.
  - **A turn is open until `agent_settled`, not until `turn_end`.** The
    reference's `streaming` flag is `activeTurnID != nil`, and `turn_end` only
    closes the bubble; `agent_end` has no case at all. I was clearing it at
    `turn_end`, which for a chained agent means the transcript stops looking live
    between turns.
- **`016` is the panel capture, and it says the panel plane the corpus pinned is
  fiction.** First capture with `evt` frames: 12 of them, all
  `{evt:{channel:"panel", data:{type:"panel_update", key, title, icon,
  data:{items}}}}` — coalesced **full snapshots**, one per source per 60 ms tick,
  the same payload re-sent many times. The shipped extension has no other panel
  producer (`routing.ts:120`, `session/relay_lifecycle.ts:246`). The app folds
  that form in its UI layer (`AppModel+Inbound.swift:569` re-routes the inner
  `panel_update` as a stock `ServerMessage`); core's `EnvelopeReducer` — what the
  harness runs — and this client both folded the granular `subagents:*` /
  `plan:snapshot` channels that **no producer emits**, so 016 passed with both
  sides showing an empty panel. This client now folds the real transport (replace
  the source's whole set; `snapshot().panels`) and renders it, with a test that
  reads 016's captured frames and pins 2 agent rows (`in_progress`, `done`) and 3
  plan rows (`done`, `in_progress`, `pending`) — and pins the legacy state being
  empty, because that emptiness is the finding. Still unpinned: panels are not in
  the reference projection at all (its `subagents`/`plan` come from the legacy
  path), so panel state is compared by this client's tests only. Corpus
  comparison would mean moving the app's panel store into core — an app-side
  call, and 002's `meta.json` now says so.
- **Busy state is reconciled from pi, never inferred from history.**
  `snapshot().busy` (what drives the stop button and busy dot) is the fold's own
  turn state **or** pi's `get_state.isStreaming`; `flags.streaming` — what the
  corpus compares — stays the frame-derived view, so a peer saying "mid-turn"
  cannot fabricate a local turn. `reconcileBusy` covers both directions, the way
  the app's design 01M1NFAE does: `false` while we hold an open stream means the
  terminal frames were missed (close it), `true` while we show idle means the
  turn's START was missed (busy, which event-by-event folding can never
  recover), and an **absent** `isStreaming` means unknown, not idle. It is
  re-asked when the tab becomes visible again — the browser's version of the
  app's foreground heal (`RootView.swift:78` → `AppModel.refreshBusyState`),
  since a hidden tab is throttled while its socket stays healthy. What is
  deliberately **not** used: the relay's `room_meta_updated` `meta.working`.
  Checked rather than assumed — it brackets *compaction*
  (`extension/src/index.ts:1830`, `:1836`), not a turn, so folding it as busy
  would be wrong.
- **Markdown is rendered, on purpose, in a deliberately small subset.** The app
  renders user, assistant and notice text as markdown
  (`TranscriptRowViews.swift:67, 112, 138`), so the browser client does too
  (`src/markdown.ts`): fenced code, headings, lists, blockquotes, rules,
  paragraphs, and inline code / bold / emphasis / links — nothing else, because
  a transcript is a log, not a document. Safety is structural rather than
  filtered: the parser returns **data**, the view builds elements with text
  nodes, so raw `<script>` in a transcript stays text forever and a
  `[x](javascript:…)` link keeps its label and loses its destination (scheme
  allowlist). A row that is still streaming is set as **plain text** and parsed
  once it settles — parsing per delta re-lays the row out mid-stream — and past
  the app's own budget (32 000 chars, `markdownBudget` at
  `TranscriptRowViews.swift:284`) text is shown as-is.

- **The live panel plane is now under the oracle, not just under this client's
  tests.** Conformance vocabulary **version 2** adds `panels`: the
  `{evt channel:"panel"}` / `panel_update` frames the shipped extension actually
  sends, folded into core (`PanelSnapshot`) and projected with pi's item shape
  carried verbatim — deep-scrubbed, never reshaped, because the point of
  comparing panels is that both clients read the machine's schema rather than a
  guess at it. The field is emitted always (empty array when there are none): an
  optional field cannot tell "this machine sent no panels" apart from "this
  client ignored the frames". Scenario 016 now pins 2 panels and their item ids,
  `deps` and `meta`; the legacy `subagents`/`plan` fields stay compared
  separately, because 002 exercises the older transport. What is still app-side
  is UI bookkeeping — `changed`/viewed badges and the subagent sound — so the
  reference now folds panels in two places (core's `panels`, the app's
  `PanelState`) and rewiring the app to read core's is the follow-up.

- **The durable plane is now in the corpus, and it immediately failed this
  client.** Scenario `019` feeds a real session's 52 entries as three
  `get_entries` response pages (two non-empty, then the empty terminal page that
  carries the active-leaf beacon) — the first fixture in 18 that exercises entry
  folding instead of live pushes, on either side. It caught a row-order bug: the
  pairing notice was appended, while the reference inserts entry-born rows at
  their **log position** (`insertBeforeLiveTail`). Fixed; the fold now decides
  insert-vs-append by whether the row came from an entry or a live frame, the way
  the reference's replay flag does. The fixture and its `capture.py` sit next to
  each other, and `meta.json` says plainly which parts are captured (entries,
  verbatim, content length-marked, `details` marked at any length) and which are
  authored (page boundaries — pi pages by its own byte budget and no capture ever
  contained a `get_entries` response, because the client sends that request
  itself).
  One honesty note the corpus recorded in vocab.md at the time: every scenario
  declared exactly **one** mode, and no scenario fed the same history through both
  planes, so "identical across modes" was a design claim rather than an asserted
  fact. (Scenario `020`, below, is the pair that closes that gap.) An unknown mode
  name now fails the harness instead of going inert.

- **The pair exists, and it found two real bugs plus one gap worth arguing
  about.** Scenario `020` captures ONE real session twice: `input.jsonl` is every
  envelope a connected client received (attach walk, a live 6-step tool turn with
  streaming deltas and an `aux.hunks` sidecar, five post-turn resync walks, a
  final walk — 859 frames), and `replay.jsonl` is only that final walk: 87 durable
  entries plus the empty page carrying the leaf beacon `69be0624`. A client that
  arrives cold sees nothing else. Both runners now hold the cold run to the same
  golden, and they agree. What it took to get there:

  * **Sidecar loss (fixed, pinned).** `aux.hunks` rides `tool_execution_start`,
    but a streamed tool call usually opens its card earlier — from a
    `toolcall_start` delta, which carries no aux. Attaching the sidecar only when
    creating the card lost it for good: the reference projected `[diff, hunks]`
    and this client `[diff]`. `startTool` now takes hunks onto an existing card.
  * **Delta dedup was stricter here than in the reference (fixed).** Both folds
    drop a `message_update` identical to the last one applied — a redelivery guard
    the reference added after run 2026-09-18 ("every chunk repeats", and this
    capture really does contain three byte-identical frames). This client compared
    only `type|delta`, so it ate legitimate text the reference kept. It now uses
    the same full-frame rule. The guard is still a heuristic, and 020's `meta.json`
    says where it can bite: with an all-zero-`usage` model and adjacent frames
    sharing a `ts`, a legitimate repeat is indistinguishable from a redelivery —
    and the projection's 48-char text window hides the resulting loss.
  * **A gap, not papered over:** pi persists `thinking` blocks ON the message
    entry (25 in this session) and NEITHER fold turns a persisted block into a row.
    So a client that attaches cold shows a transcript with every thinking row
    missing — while the content is sitting in the durable record. The projection
    cannot express that equality today either (`ConformanceProjection.swift:95`
    keys reasoning rows synthetic `reasoning#n`, `replayStable: false`), which is
    why the cross-plane comparison drops `reasoning` rows with the reason stated in
    vocab.md and in the scenario's `meta.json`, rather than quietly ignoring them.
    Fixing it properly means making reasoning row identity durable on both sides —
    the next change I would make, and I did not want to smuggle it into a fixture
    commit.
  * The fixture's scrub is length-preserving filler rather than `«length»`
    markers, for this scenario only: the durable plane gives one content block and
    the live plane gives the deltas that built it, and a marker per delta makes the
    two incomparable as strings. `capture.py` explains it at the top.

- **The vocabulary fixture landed, and it moved the claim from equality to
  containment.** Scenario `021` is one session driven by a human through the
  durable entry types no fixture had fed through a page: read an image, read a
  missing file, dump 120 KB of a HAR into context, `/compact` (103 812 tokens
  before), branch the session in the tree and ACCEPT the summary, then interrupt a
  long tool call with Esc. `input.jsonl` is 10 241 envelopes (11.5 MB),
  `replay.jsonl` is one cold arrival: a 185-entry page plus the empty page with
  leaf beacon `3d0107fa`. The reference folds both to 92 rows and 41 rows and
  passes.

  * **The pair assertion changed shape, and 021 is the reason.** Branching puts
    entries off the active path, and `get_entries` only serves the active path, so
    a client arriving afterwards CANNOT show rows a watcher saw. Equality would
    have failed a fixture that is demonstrating the tree working. Both runners now
    assert containment — every cold row exists in the watched transcript with the
    same fields, same `leafId` — and log the rows only the watcher saw, rather
    than filtering them away. See "Paired inputs" in vocab.md.
  * **One divergence found, and it was a rule about WHEN an id is decided.** All
    92 rows agreed in kind, face, state, image count and leaf, and the cold run
    held the same 41 rows. Nine rows kept synthetic keys, and this client's
    counters sat five ahead: `user#6..9` / `assistant#7..11` where the reference
    has `user#1..4` / `assistant#1..6`. Not a birth-order bug — a projection rule.
    The reference numbers `<kind>#<seq>` **at projection time, by order of
    appearance among the rows still standing** (`ConformanceProjection.swift:66-121`),
    and numbers per kind with its own rules: reasoning is always a placeholder,
    tool is always the tool call id, compaction and notice always their own id.
    This fold baked the number in at allocation, so five live rows that a walk
    later re-keyed to entry ids burned five numbers and left gaps behind them.
    `TranscriptReducer.conformanceItems()` now applies the vocabulary's per-kind
    rule at the comparison boundary. The fold keeps allocating its own ids,
    because they are what the UI keys an element by: a positional placeholder
    would shift every time a row above got anchored, and the element would remount
    mid-conversation.
  * **What the durable vocabulary actually does:** a `compaction` entry folds to
    the same row a live `compaction_end` does; a `branch_summary` entry renders
    NOTHING in either fold (its parent is an ancestor of the old leaf, so the
    summary lives on the abandoned branch — visible only if the tree moves back
    there); 59 `custom` entries — an extension's state blobs — render nothing in
    either fold; an image tool result arrives cold as an `image` content block and
    the card shows `images: 1` exactly as the watched one does.
  * **Two findings worth telling the owner.** (1) An entry appended to a live
    session's JSONL out of band reaches nobody: `get_entries` answers from pi's
    in-memory `fileEntries`, never re-read from disk, and pi's own
    `getSessionName()` ignores it too. That is why `session_info` is not pinned by
    any fixture — only a `/name` typed at the prompt produces one a viewer sees.
    (2) The client re-walks on a 6-second timer regardless of activity: 81 walk
    runs / 136 pages in ten minutes, 23 distinct leaf ids. `capture.py` collapses
    the interior runs; the cadence is a live-plane fact.
  * **Two scrub traps this fixture sprang on me, recorded so the next capture does
    not re-earn them.** A `«length»` marker is fine for a 120 KB tool result and
    fatal for MESSAGE text: row identity is a hash of message content, so marking
    a 3 190-character reply made the durable plane's text unmatchable with what a
    watcher streamed, and the row landed keyed by entry id on one plane and
    `assistant#n` on the other. And scrubbing must never touch shape: marking
    `role` / `type` / `mimeType` inside a `toolResult` gave 53 entries whose role
    read `«10»` and 53 cards stuck at `running` with no image. And the size of a
    capture is not where you'd guess: the 27 107 deltas were 4.2 MB, while pi's
    `details.truncation.content` — a COPY of everything it truncated, 300 KB in one
    `message_start` and again in `message_end`, `turn_end` and `agent_end` — was
    most of the rest. Marking those (prose the projection never reads) took 11.5 MB
    to 7.0 MB without dropping a frame.

- **The build the fixtures came from is now recorded, and the skew is measured.**
  The repo's extension source sits at 0.25.11 while the installed npm package is
  0.25.15, and npm has 0.25.13/14/15 with no commits or tags in this repository —
  so "the wire does X, see `rpc_envelope.ts:405`" was a claim about a build that
  might not be the one a capture came from. `npm pack` both versions and diff the
  shipped `dist/`: exactly seven files moved 0.25.11 → 0.25.15, all of them
  install/daemon plumbing or the broker join path. `index.js`, `routing.js`,
  `session/rpc_envelope.js`, `durable.js`, `client.js`, `commands/pairing.js`,
  `subagent_rooms.js` are byte-identical, so the envelope, paging and sidecar
  behaviour the corpus and this README describe is the behaviour of the build that
  made the captures. `meta.json → extensionVersion` now names the build per
  fixture, and vocab.md says how to re-derive the comparison (and why `dist` line
  numbers are not TS line numbers, and why the shipped maps cannot be turned back
  into TS). Flag for the owner: three published versions exist only as tarballs.

- **A pairing notice renders from its payload, not from its display text.**
  Conformance vocabulary **version 3** keeps `customType` and `details` on a
  custom-role notice (deep-scrubbed, structure intact — same rule as panel
  items), because the producer says so in its own comment: `details` is the
  "structured payload for RPC clients: render their own QR from `uri` + show the
  expiry, without scraping the display string"
  (`extension/src/commands/pairing.ts:124-136`). With that in the fold the view
  draws a card — which room, valid until when, and the code + ASCII QR behind a
  *show pairing code* reveal — instead of 30 lines of blocks with a live
  credential on screen by default. Verified live against the real entry that
  session had already written: "Pair a device · un-bien#2 · WF-jI-uORO6x ·
  expired 3:13:27 PM", reveal showing the URI (copyable) and 28 lines of QR.
  Scenario `018` pins the fold; its pairing values are synthetic on purpose.

- **A claim of mine about the diff sidecar was wrong, and a probe settled it.**
  Scenario 016's note asserted that zero frames in 2272 carried `aux`, "so the
  diff sidecar is dead on the live plane too". What it actually showed is that no
  kept frame in ONE capture carried it — five of its 37 `tool_execution_start`
  frames were edit-family, and I read absence in one capture as a property of the
  wire. A turn asking the live session to `write` then `edit` a scratch file
  produced, in the extension's own envelope log (0.25.15), `aux.hunks attached:
  edit (1 hunk(s))`, and this client drew that card with one hunk and four diff
  lines (1 add, 1 remove, 2 context). So the sidecar does ride live — on the
  **start** frame, not on the result frame (`extension/src/session/rpc_envelope.ts:405`,
  comment at :420 — checked against the running 0.25.15 build too, where the same
  code sits at `dist/session/rpc_envelope.js:205`),
  and it is missing when enrichment returns nothing, which the producer logs
  ("usually the target-file read failed (wrong cwd) or the arg shape didn't
  match", :209-214). Most likely that is what 016 caught: its edits target paths
  outside the session's cwd. 016's note is corrected in place; live hunks remain
  pinned by 004 and replay hunks by 012.

- **…and the entry path used to key those rows differently, which was a
  duplicate-row bug.** The live path keys a custom notice `cust<content hash>`;
  the durable replay path keyed it `notice@<content hash>`. Same message, two
  rows: rendered live, then rendered again when the entry came back in a
  refetch. Both folds now funnel the entry through the same `message_end` shape
  the reference does (`SessionState+BirthEntry.swift:28`), so one rule applies.
  Nothing in the corpus could have caught this — **no scenario feeds entries**
  (the harness's replay wiring is not built), so `applyEntries` is checked here
  by unit tests only, and that is a real limit of the oracle worth knowing
  before trusting a green corpus.

- **The compaction caption prints a token count only if the wire sent one.**
  "Context compacted (213920 tokens)" is a measurement; `(0 tokens)` is a lie the
  client tells itself, because both folds used to default a missing
  `tokensBefore` to zero (`SessionState+BirthEntry.swift:23`, and the same in
  this client). Every real compaction entry on this machine carries the field —
  73 of them across `~/.pi/agent/sessions/`, none zero — so the 0 was never
  observed, only invented. The field is now optional on both sides and the
  parenthetical appears only when a number arrived; scenario `017` is an authored
  fixture for the absent case, precisely because today's wire never produces it
  and only a fixture stops a client from re-inventing the default. Scenario 013
  is the paired case with real numbers and its golden is unchanged.

- **A live compaction marker's row id is a bare number.** `compaction_end`
  without an `entryId` is a live-born marker and takes
  `SyntheticID.compaction(seq:)` — the sequence number alone, so the projection
  row reads `compaction@1`, not `compaction@compaction#1`. Every scenario before
  017 replayed compaction *entries*, which carry pi's entry id, so this client's
  `kind#n` key sat wrong in a case the corpus could not see.

- **Long bodies are clamped behind a control, not suppressed.** `/unbien pair`
  sends its QR as a custom message with `display: true`
  (`extension/src/commands/pairing.ts:124`), so it arrives as an ordinary notice
  row — ~30 lines of blocks whose pairing URI (and token) is then on screen in
  every attached client. This client keeps the row (the app has **no** special
  case for `un-bien:pair-code`; grep it and you find nothing, so folding it away
  would diverge) and clamps anything taller than 12rem behind a *show more*
  toggle. Whether the token *should* be visible to already-paired devices is an
  extension-side question, and not the one-liner it looks like: `display: false`
  would also take the QR out of the operator's own TUI, which is where it is
  needed — the alternative is a structured pairing view built from the
  `details: {uri, token, expiresAt, roomId, name}` the same message already
  carries, and that is a change on both sides plus a corpus scenario.

- **A `read` of an image file is transcoded on the way in.** `docs/images/
01-welcome.png` is `PNG image data, 1206 x 2622`; what reached the log was
  `mimeType: "image/jpeg"` with a caption saying `original 1206x2622, displayed
at 920x2000. Multiply coordinates by 1.31…`. pi re-encodes and downscales, and
  puts the dimensions in prose. A client that labels a picture from its file path
  would be lying about both format and size.
- **A pasted screenshot is not an image on the wire.** Pasting one at pi's prompt
  writes a user message with one `text` block holding a temp path
  (`/var/folders/…/pasted-image-20261117-203807-….png`) — no base64, no image
  block. Every remote client renders a path that only exists on the host, and the
  picture exists for the client only once the model calls `describe_image` and
  gets text back. Neither client does anything smarter about that yet.

## What is not here

- **Conformance covers the projection, not the pixels.** `test/corpus.test.ts`
  runs all twenty-one `contracts/conformance/` scenarios with no skips and
  compares, in **render order**: `(kind, row)`, `text` (prefix — the corpus scrubs
  long strings and escapes their newlines), `streaming`, `images`, `state`, `tool`,
  `blocks` (the tool card's result face, `src/tool-faces.ts`), `flags`, `leafId`,
  `subagents`, `pendingAsks` and `plan`. Not compared: the face's CONTENTS (a
  terminal face's notices, a diff's hunks) — `blocks` names the face only, so
  `test/tool-faces.test.ts` carries that. Three scenarios expect zero items, so
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
