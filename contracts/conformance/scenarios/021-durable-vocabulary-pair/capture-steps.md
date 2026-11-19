# How to capture this scenario

The fixture needs a session that TOUCHES the durable vocabulary, captured by the
web client while it happens. Only a human can drive the pi side; everything after
step 4 is scripted.

## 1. Start the client with the capture tee on

```sh
pnpm --filter web-client dev            # http://localhost:5173
```

Pair as usual, then in the browser's address bar add `&capture=1` to the invite
URL (it already carries `t`, `epk`, `n`, `rm`) and reload. Check the tee is live
before driving anything:

```js
__unbienFrames.length   // should climb as pi works
```

## 2. Drive the session (in pi, in this order)

Order matters: everything must be inside the window, and the capture has to END on
a walk (the client re-walks after each turn, and `capture.py` takes the trailing
run of `get_entries` pages as the cold-arrival input).

| do this in pi | the entry it writes | why |
| --- | --- | --- |
| `/model` → another model, then send one short line | `model_change` | the fold must show a model notice from a page, not just a live frame |
| change the thinking level, send one short line | `thinking_level_change` | same |
| `read /tmp/unbien-capture/red-16.png and tell me the dimensions` | a tool result with an IMAGE content block | image counting on the durable plane; base64 lands on the entry |
| `read /tmp/unbien-capture/nope.txt` | an error tool result | the `[error]` face must resolve from the entry, with no live frame |
| `/compact` | `compaction` | marker row + folded summary, replayed |
| rename the session (`/name` or the rename UI) | `session_info` | the reference reads this entry type, this client does not |
| branch / rewind the session (the tree UI) | `branch_summary` | the reference maps it to a `branch` notice, this client drops it |
| start a longer turn and interrupt it (Esc) | an aborted turn | where a fold ends a row it should not |

Skipping the last two is fine for a first pass — the fixture still earns its keep
with compaction, the image and the error. Say which ones you did and the
`meta.json` will record exactly what the fixture does and does not pin.

## 3. Let the walk finish, then dump

Wait for the client to catch up (no spinner), then in the browser console:

```js
__unbienDump("021")   // downloads capture-<timestamp>.jsonl, returns the frame count
```

Move the download here as `raw.jsonl` (gitignored — it holds unscrubbed prompts,
reasoning text and a pairing payload):

```sh
mv ~/Downloads/capture-*.jsonl raw.jsonl
```

## 4. Build, mint, assert

```sh
./capture.py raw.jsonl                 # writes input.jsonl + replay.jsonl
cd ../../.. && UNBIEN_CONFORMANCE_REGENERATE=1 swift test --filter ConformanceHarnessTests
swift test --filter Conformance        # app + core
(cd web-client && pnpm test)
```

`capture.py` refuses a capture that does not end on a walk page, and refuses one
whose trailing walk never returned an empty terminal page — that page is what
carries the active-leaf beacon, and without it a cold run has no leaf to assert.

The FIRST expected failure is `branch_summary` and `session_info`: this client's
`birthEntry` handles compaction, custom messages and messages, and nothing else.
That is the work the scenario exists to drive, not a reason to weaken the fixture.
