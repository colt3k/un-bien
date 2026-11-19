# How to capture this scenario

**Status: not captured yet.** The directory exists so the run is mechanical when a
human drives it. Both runners accept a scenario with a `capture-steps.md` and no
`input.jsonl` — that combination means "pending", not "broken".

## What this fixture is for

One thing, narrowly: **a compaction that is watched live AND later walked
on-path, in one plane.** Nothing captured so far shows both halves together, so
`web-client/test/compaction-durability.test.ts` currently assembles the pair from
two real shapes — 022's on-path entry and 021's live `compaction_end` frame. This
scenario replaces that assembly with the real thing, and with it the rule in
vocab.md, "One compaction, one row".

Why the halves never met before:

- **022** — a human compacted, THEN the client attached. Cold entry, no live frame.
- **021** — the client watched a live compaction, but a later **branch** moved the
  compaction entry off the active path, so no walk ever brought it back.
- A third attempt (dump `023-live-compaction`, 1073 frames) ended on the live
  `compaction_end` frame itself — the dump was taken before the next walk, so the
  entry never arrived. Not a client bug: the leaf had advanced normally
  (`a19bf1e2 → e5757980 → b270608d → 41fa910a → 899bd24a`) and the compaction
  landed at frame 1072, after the last walk at 1068.

## 1. Client up, tee on, ATTACH FIRST

```sh
pnpm --filter web-client dev
```

Open with `?capture=1`, attach to the session in the drawer **before driving
anything** — the live marker must be inside the window.

```js
__unbienFrames.length   // climbing = the tee is live
```

## 2. Drive pi, in this order

| # | do this in pi | why |
| --- | --- | --- |
| 1 | `run: head -c 120000 /tmp/unbien-capture/ws.har` (twice if `/compact` says there is nothing to compact) | enough context that a real compaction has work |
| 2 | `/compact` | the live `compaction_end` frame, and the `compaction` ENTRY pi writes |
| 3 | **one short turn** (`say ok`) | THE STEP THAT MATTERS: the client re-walks after a turn, and that walk must bring the compaction entry back to a viewer that already holds the live marker |
| 4 | wait a few seconds, do NOT branch | a branch moves the entry off the active path — that is exactly what hid this in 021 |

Then dump:

```js
__unbienDump("023-live-compaction-pair")
```

Check before building: the last run of `get_entries` pages must carry a
`compaction` entry whose `tokensBefore` matches the live frame you watched, and the
leaf beacon must be at or past that entry. If the last page does not carry it, step
3 did not happen — drive one more turn and dump again.

## 3. Build and check

```sh
mv ~/Downloads/023-live-compaction-pair-*.jsonl raw.jsonl
./capture.py raw.jsonl
```

Then in the repo root:

```sh
env UNBIEN_CONFORMANCE_REGENERATE=1 swift test --filter ConformanceHarnessTests   # mints expected.json
swift test --filter ConformanceHarnessTests
cd web-client && pnpm test
```

## 4. What to expect, and what to do about it

- **Expected green:** the watched run's compaction row re-keys from the bare
  sequence number to pi's entry id when the walk brings the entry, so the cold
  arrival lands on the same row. One "Context compacted" row on both planes.
- **If it fails with two rows on the watched plane:** the fix regressed — see
  `reducer.ts` (the `compaction_end` match) and `SessionState.appendCompaction`.
- **If the watched plane never anchors:** the walk after step 3 did not deliver the
  entry. That is a real finding about what `get_entries` serves to a connected
  client, and it belongs in this file and in vocab.md rather than being tuned away.

## 5. Afterwards

Replace the assembled pair in `web-client/test/compaction-durability.test.ts` with
this scenario's real frames, and drop the caveat sentence from
`022-cold-compacted-log/meta.json`.
