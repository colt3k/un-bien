# Conformance Corpus — Fixture Format & Normalized Vocabulary (spec v1)

Design: `01M25GXCQ3W7NKB2DJ4RM9T8EHW` (conformance harness — cross-implementation:
un-bien Swift `SessionState` reducer + remote_pi TS fork interpretation, both
asserting against the SAME expected artifact).

## Scenario unit

`contracts/conformance/scenarios/<NNN-name>/`:

| File | Contents |
|---|---|
| `input.jsonl` | The exact wire frames, one JSON per line, **as delivered app-side**: bare rpc frames (wrapped by the runner as `{rpc:}`), `get_entries` pages, or `{evt}` envelopes — whatever the mode prescribes. Recorded from live sessions via the envelope debug log (`debug.envelope`), or authored. |
| `expected.json` | The normalized interpreted state — the vocabulary below — the single artifact BOTH implementations assert against. |
| `meta.json` | Provenance: `origin` (`real-capture` \| `synthetic`), source run / author, capture date, scrub notes, modes. |

## Modes

Each scenario declares `modes` in meta: one or both of

- `live` — frames delivered as pushes, in order, to a fresh `SessionState`/reducer.
- `replay` — durable content delivered as `get_entries` **response frames**
  (`{type:"response", command:"get_entries", data:{entries, leafId}}`), which
  both folds route to the entry tree — not as direct `applyEntries` calls, so the
  paging rule itself is under test: a non-empty page's `leafId` is a resume
  cursor, and the ACTIVE-LEAF BEACON is the `leafId` of the page that came back
  EMPTY.

Both runners run every declared mode (an unknown mode name fails the harness
rather than going inert); the interpreted state must be **identical across modes
and across implementations**.

Honest status: two scenarios now feed the SAME session through both planes —
020 (an ordinary session: watch it, then arrive cold at the same instant) and
021 (a session driven through the durable vocabulary: image result, failed card,
120 KB read, `/compact`, a branch with its summary accepted, an Esc interrupt).
So "identical across modes" is an asserted fact with one documented exception,
spelled out under "Paired inputs": a branched session can show a watcher rows a
cold arrival never sees, and the claim that survives that is containment.

## Normalized vocabulary (`expected.json`)

```json
{
  "version": 1,
  "items": [
    { "kind": "notice", "row": "<row-id>", "code": "...", "text": "<scrubbed>",
      "customType": "<scrubbed>", "details": { "...": "deep-scrubbed, structure kept" } },
    { "kind": "user", "row": "<row-id>", "text": "<scrubbed>", "images": 0 },
    { "kind": "assistant", "row": "<row-id>", "text": "<scrubbed>",
      "streaming": false, "images": 0 },
    { "kind": "reasoning", "row": "<row-id>", "text": "<scrubbed>", "streaming": true },
    { "kind": "tool", "row": "<row-id>", "tool": "<scrubbed>", "state": "running|ok|failed",
      "blocks": ["diff"|"code"|...], "images": 0 },
    { "kind": "compaction", "row": "<row-id>" }
  ],
  "flags": { "streaming": false, "ended": false },
  "subagents": [ { "id": "<scrubbed>", "status": "started|steered|completed|failed",
                   "description": "<scrubbed>", "result": "<scrubbed>", "error": "<scrubbed>" } ],
  "plan": { "project": "<scrubbed>", "itemCount": 2 },
  "panels": [ { "key": "<scrubbed>", "title": "<scrubbed>", "icon": "<scrubbed>",
                "items": [ { "id": "<scrubbed>", "kind": "agent|plan", "title": "<scrubbed>",
                             "status": "<scrubbed>", "deps": ["<scrubbed>"],
                             "meta": { "agentType": "<scrubbed>", "startedAt": 0 } } ] } } ],
  "pendingAsks": [ { "id": "<scrubbed>", "method": "select", "title": "<scrubbed>", "options": ["<scrubbed>"] } ],
  "leafId": "<scrubbed entry id | null>"
}
```

Reducer-level fields (`subagents`, `plan`, `pendingAsks`) come from the
`{evt}` plane (`subagents:*`, `plan:snapshot`) and the extension_ui side-state
(`extension_ui_request` select flows) folded by `EnvelopeReducer` — present
when the scenario exercises panels/asks, absent otherwise. `leafId` is the
delta-refetch cursor. `version` bumps when the vocabulary changes — runners
assert the version they implement.

**`panels` is the live panel plane** (`{evt channel:"panel"}`, `panel_update`:
one frame per panel key, carrying that panel's WHOLE item set, so folding
replaces the panel rather than merging into it — see `PanelSnapshot`). It is
listed always (empty array when the scenario has no panel frames), because an
optional field cannot pin "this machine sent no panels" apart from "this client
ignored them". `items` is pi's own wire shape, deep-scrubbed in place and
otherwise UNTOUCHED: the value of comparing panels is that both clients read the
same schema, so a projection that renames or reshapes items compares each
client's guess instead. The legacy `subagents`/`plan` fields above stay (older
extensions, pinned by 002) and are NOT derived from `panels`.

Version 2 = `panels` added.

**A notice may carry `customType` + `details`** (a custom-role message: what the
machine sent, and its structured payload). They are emitted only when present.
`details` follows the panel rule — deep-scrubbed in place, structure untouched —
so a golden pins the SHAPE of a pairing payload without pinning a credential.
The point is that a client renders from the payload the producer sent for that
purpose (`pairing.ts:124-136`: "render their own QR from `uri` + show the
expiry, without scraping the display string") instead of scraping text back out
of what it was told to display. Pinned by 018.

Version 3 = notice `customType` / `details` added.
```

- `items` is in render order. `n` is implicit (array index + 1).
- A block not on the derived path is **absent** (abandoned branch — retained
  data, no row): the projection's membership gate is part of the contract.
- `streaming` in `flags` = an in-flight turn exists (`activeTurnID != nil`).

## Row ids & scrubbing

- A row's `row` value is its **entry id when replay-stable** (`replayStable ==
  true` — pi entry ids are stable hex and identical across live/replay), else a
  **deterministic placeholder** `"<kind>#<seq>"` numbered by order of appearance
  (live synthetic ids are UUIDs — nondeterministic across runs, so the
  projection replaces them; seq numbers make failures debuggable).
- **Text scrub, in place, readable**: newlines → `\n` literals, truncate at
  48 chars with `…`. No hashing (george 2026-09-25: "scrubbed but readable is
  the right approach given it'll live in repo"). ANSI stripped.
- Tool `args`/`result` raw payloads are NOT emitted — only the card's rendered
  **block kinds** (`output[].kind`, `hunks` → `hunks`, images count). Content
  fidelity comes from the input frames; the expected file asserts the *shape*.
- Timestamps, token counts, session-start times: omitted (unstable).

## Paired inputs: one session, reached two ways

A scenario may ship `replay.jsonl` beside `input.jsonl`: the frames of a client
that arrives COLD — durable `get_entries` pages and the terminal active-leaf
page, no live frames. `modes` then lists both `live` and `replay`, and a runner
that never opens `replay.jsonl` is not testing the claim the scenario makes.

There is still ONE golden — the connected run's projection. The cold run is held
to it by **containment**, not equality: every row a cold viewer sees must exist
in the watched transcript with the same fields, and both runs must agree on the
`leafId` they would resume from. 021 is why the direction matters. That session
was BRANCHED in the tree: the watcher saw a stretch of turns, the leaf then moved
to a different branch, and `get_entries` only ever serves the ACTIVE path (the
derivation rule at "a block not on the derived path is absent"). So the cold run
holds 41 of the 92 rows and cannot hold the rest — correct behaviour on both
sides, not a fold disagreement. The extras are logged by both runners rather than
asserted away, so a fixture that silently shrinks the comparison is visible.

Four parts of the projection are plane-specific by construction, so the cross-plane
comparison drops them. Dropping is a claim, so it is spelled out here rather than
left to a filter:

| dropped | why |
| --- | --- |
| `panels`, `subagents`, `pendingAsks` | pi does not persist them: panels ride `{evt channel:"panel"}` frames, an ask is a moment rather than a record |
| `reasoning` rows | pi persists `thinking` blocks ON the message entry, and neither fold turns a persisted block into a row — a client that attaches cold shows no thinking rows at all. 020 records this as a gap. The equality is not expressible in the vocabulary yet either: reasoning rows are keyed synthetic `reasoning#n` with `replayStable: false` |
| the `hunks` block on a card | the diff sidecar rides the live `tool_execution_start` frame and nothing else, so a watched card settles to `[diff, hunks]` and a cold one to `[diff]` |

### What 021 pinned, and what it found

- A `compaction` ENTRY folds to the same `compaction` row a live
  `compaction_end` frame does — text built from `tokensBefore`, row keyed by the
  bare sequence number (`replayStable: false`). 103 812 tokens before, one row.
- A `branch_summary` entry produced **no row at all**: its parent is an ancestor
  of the old leaf, and the accepted summary sits on the branch that is no longer
  the active path. Neither fold renders an off-path entry, so the durable summary
  is invisible to a viewer unless the tree moves back to it. Not modelled as a
  bug here — stated so nobody re-derives it.
- 59 `custom` entries (an extension's own state blobs) fold to nothing in both
  folds. One `custom_message`-derived notice DOES render: the pairing payload,
  which is why `details` is length-scrubbed everywhere.
- An image tool result reaches the cold plane as a `toolResult` message with an
  `image` content block, and the cold card shows `images: 1` like the watched
  one. `type`, `mimeType` and `toolCallId` are therefore structure that a scrub
  must never touch — a first pass of 021's scrubber marked them and every card
  sat at `running` with no image, which is the fixture earning its keep.
- **A hand-written entry in a live session file reaches nobody.** `get_entries`
  answers from pi's in-memory `fileEntries`, which a running session never
  re-reads from disk. A `session_info` line appended out of band sits in the
  JSONL, is ignored by pi's own `getSessionName()`, and is never served — so
  `session_info` is deliberately NOT pinned by any fixture. Only a `/name` typed
  at the prompt produces one a viewer can see.
- **The client re-walks on a 6-second timer** whether or not anything changed:
  81 walk runs / 136 pages in a ten-minute capture, the leaf beacon moving
  through 23 ids. 021's `capture.py` collapses the interior runs (the final walk
  carries the whole history); the cadence itself is a live-plane fact.

## Which build produced this

Every captured fixture names the extension build that produced it
(`meta.json → extensionVersion`), because the published packages and this
repository drift: the repo's `extension/package.json` sits at **0.25.11** while
npm carries **0.25.13, 0.25.14, 0.25.15** with no matching commits or tags in
this repository. So a claim cited against `extension/src` needs re-checking
against the build that a fixture was captured from — from the artifacts, not from
memory. The published package ships its compiled `dist/`:

```sh
npm pack @geohar/un-bien@0.25.11 @geohar/un-bien@<installed>
diff -rq <a>/package/dist <b>/package/dist | grep -v '\.map'
```

As of 0.25.15 the answer for the whole wire path is *nothing*: `dist/index.js`,
`routing.js`, `session/rpc_envelope.js`, `durable.js`, `client.js`,
`commands/pairing.js`, `subagent_rooms.js`, `session/received_images.js`,
`pi_binding/session_port.js` are byte-identical to 0.25.11. Exactly seven files
moved — `commands/housekeeping.js`, `daemon/{cliInstall,install,launcherInstall,service_env}.js`
(plus a new `daemon/packageManager.js`), `session/leader_election.js` and
`session/peer.js`. Those are install/daemon plumbing and the broker join path (the
unregistered liveness probe became `broker_ping`, and `register_ack` now waits
through stray control frames instead of aborting on one). None of it reaches a
viewer's frames, so what this spec and 019/020 claim still describes the machine
that made them.

Two cautions when you do this: `dist` line numbers are NOT the TypeScript line
numbers — read `extension/src`, check behaviour in `dist`; and the source maps
ship without `sourcesContent`, so a published build cannot be turned back into the
TS that produced it.

## Golden regeneration

`expected.json` files are committed. A runner may regenerate goldens when
`UNBIEN_CONFORMANCE_REGENERATE=1` is set (writes the current projection into
`expected.json`); CI always asserts. A golden change in a PR is a reviewable
behaviour change.

## Adding a scenario

Create the directory; both runners pick it up by convention. Zero runner
changes. If a scenario needs new vocabulary, extend this spec first, both
runners in the same commit.

A directory may be committed BEFORE its fixture exists: a `capture-steps.md` that
spells out how the capture will be made is reviewable on its own, and it puts the
plan in the same place as the result. Both runners then skip such a directory —
and both insist on the marker, because a directory with no `input.jsonl` and no
`capture-steps.md` is a fixture that went missing, and that has to fail. Captures
come from the web client's own tee: load it with `?capture=1`, then
`__unbienDump("NNN")` in the console (see `web-client/src/app.ts`).