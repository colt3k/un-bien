#!/usr/bin/env python3
"""Build this scenario's two inputs from ONE raw client-side capture.

    ./capture.py raw.jsonl

One session, one arrival order, aimed at a single event: a `/compact` that the web
client WATCHES (a live `compaction_end` frame) and that a later walk then brings
back as a durable `compaction` ENTRY, on the active path. That is the pair the
"one compaction, one row" rule in vocab.md is about — the live marker must re-key
onto pi's entry id instead of growing a second row. Read capture-steps.md for the
driving order; step 3 (a turn AFTER the compaction) is what makes the walk happen.

Scrub and reduction rules are the ones 020/021/022 worked out, unchanged: walk
collapse to the first and final run of `get_entries` pages; delta trim that keeps
whole turns; message content as length-preserving filler (row identity is a hash of
message content, so a marker there breaks the pair); tool-result prose, base64
`data` and long `details.*` values as `«length»`; structural keys never touched.

Two of those are already known-divergent and this fixture will pin it rather than
leave it in a comment: the reference's entry tree maps `branch_summary` to a
`branch` notice (`SessionState+Tree.swift:90`) and reads `session_info`, and this
client handles NEITHER (its `birthEntry` switch covers compaction,
custom_message and message only). So the scenario's first run is expected to
fail on those rows; fixing the client is the work the scenario exists to drive.

The capture is the web client's own tee: load it with `?capture=1`, then call
`__unbienDump("021")` in the console to download every inbound envelope as JSONL
(see web-client/src/app.ts). Nothing here is hand-written.

Scrub is 020's, field-aware and LENGTH-PRESERVING, with one addition:

  * content fields (`text`, `thinking`, `summary`, `delta`, `errorMessage`) -> a
    run of `░` per character, so a row that really is identical on both planes
    scrubs to an identical string;
  * a base64 image `data` payload -> `«length»` rather than filler. It is counted,
    never compared, and 100 KB of block-shade characters would make the fixture
    unreadable for nothing;
  * every value under `details` -> `«length»` at any length (a pairing token in a
    fixture is a credential in a repository);
  * `sessionId` -> `«length»`; any other string over the 48-char readable cap ->
    filler;
  * ids, parentIds, roles, tool names, mimeTypes, timestamps, stopReasons, usage
    numbers, sequence numbers: VERBATIM.
"""

import json
import sys

MAX_READABLE = 48  # the projection's own readable cap (Conformance.textLimit)
# Filler past this point buys nothing a length marker does not. Ordinary prose
# (deltas, replies, thinking) stays length-preserving so the two planes' text is
# string-comparable; a 120 KB tool output would add 120 KB of block-shade noise
# per walk page that repeats it.
# Field names that carry shape, not content, and are therefore NEVER replaced at
# any length or nesting: a tool result's `type: "image"` is what makes a card
# show an image, and a first cut that scrubbed it left 53 entries whose role read
# "«10»" and whose cards sat at `running` forever.
STRUCTURAL = {
    "type", "role", "mimeType", "toolName", "toolCallId", "id", "parentId",
    "timestamp", "stopReason", "sessionName", "customType", "toolCallName",
}
# IMPORTANT: length markers are only allowed where they cannot break the pair.
# Row identity is a hash of MESSAGE content, and the projection prints a row's
# text, so MESSAGE text stays length-preserving filler at any length: `«3190»` on
# the durable plane never matches the 3 190 characters a watcher streamed, and
# the row ends up keyed by entry id on one plane and `assistant#n` on the other.
# This took two passes to get right — a MAX_FILLER backstop that applied to
# everything long produced exactly that failure, on a reply of 3 190 characters.

CONTENT_KEYS = {"text", "thinking", "summary", "delta", "errorMessage"}
# Named at any length: they identify a real room/session on a real relay.
OPAQUE_KEYS = {"sessionId"}


def mark(value):
    # Length-preserving filler, see the docstring.
    return "\u2591" * len(value)


def mark_len(value):
    # For payloads that are counted rather than compared (base64 image data):
    # filler would preserve a length nobody checks at the cost of 100 KB of noise.
    return f"\u00ab{len(value)}\u00bb"


def scrub(node, key=None, inside_details=False, inside_result=False):
    if isinstance(node, dict):
        # Only a toolResult's `content` is result prose; its other fields are
        # structure. See the `inside_result` branch above.
        isResult = node.get("role") == "toolResult"
        return {
            k: scrub(v, k, inside_details or k == "details",
                     inside_result
                     or (isResult and k == "content")
                     # The LIVE plane's tool payload is a bare result object, not a
                     # toolResult message, so it needs its own marker rule. Without
                     # it this fixture was 11.5 MB: 4.6 MB of `tool_execution_end`
                     # results (one frame 1.75 MB) plus 1.4 MB of streamed partials.
                     or k in ("result", "partialResult"))
            for k, v in node.items()
        }
    if isinstance(node, list):
        return [scrub(v, key, inside_details, inside_result) for v in node]
    if not isinstance(node, str):
        return node
    if inside_details:
        # Short detail values stay length-preserving filler, because the reference
        # projects `details` with its own filler and the corpus compares the two.
        # LONG ones become length markers: pi rides a copy of everything it
        # truncated under `details.truncation.content`, and 300 KB of `░` per frame
        # (in `message_start`, `message_end`, `turn_end` and `agent_end` alike) is
        # where this fixture's 11.5 MB actually was.
        return mark_len(node) if len(node) > MAX_READABLE else mark(node)
    if key in OPAQUE_KEYS:
        return mark(node)
    if key == "data" and len(node) > 64:  # a base64 image payload, not a field name
        return mark_len(node)
    if key in STRUCTURAL:
        return node
    if inside_result or key == "partialResult":
        # A tool RESULT string: the projection draws a card's face from the
        # result's shape, never from its prose, and row identity is computed from
        # the message content, not the result — so a 120 KB HAR dump can become a
        # length marker with nothing observable lost. ONLY the result's content
        # reaches here: `role`, `toolCallId`, `toolCallName` and friends are
        # structure, and a first cut that marked them produced 53 entries whose
        # role read "«10»" — every card then sat at `running` forever.
        return mark_len(node)
    if key in CONTENT_KEYS or len(node) > MAX_READABLE:
        return mark(node)
    return node


def is_get_entries_response(frame):
    rpc = frame.get("rpc")
    return isinstance(rpc, dict) and rpc.get("type") == "response" and rpc.get("command") == "get_entries"


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    frames = []
    for line in open(sys.argv[1], encoding="utf-8"):
        line = line.strip()
        if line:
            frames.append(json.loads(line))
    if not frames:
        raise SystemExit("no frames in raw capture")

    def write(path, rows):
        with open(path, "w", encoding="utf-8") as out:
            for frame in rows:
                out.write(json.dumps(scrub(frame), ensure_ascii=False) + "\n")
        print(f"{path}: {len(rows)} frames")

    # WALK COLLAPSE. The client re-syncs on a 6-second timer, so this capture
    # holds 81 walk runs / 136 pages, and the later walks each re-send the whole
    # history — 20 MB of the raw file is the same entries arriving again. Keep the
    # FIRST walk and the FINAL walk and drop the runs in between: the final walk
    # carries the complete history, so the live run still folds every entry, and
    # first+final still exercises what matters (rows keyed by live ids getting
    # re-keyed by a walk, and a walk re-folded over rows that already exist).
    # This is a trim of an OBSERVED redundancy, and meta.json says so.
    def is_page_(f):
        return isinstance(f.get("rpc"), dict) and f.get("rpc").get("type") == "response" and f.get("rpc").get("command") == "get_entries"

    runs, cur = [], []
    for i, f in enumerate(frames):
        if is_page_(f):
            cur.append(i)
        elif cur:
            runs.append(cur)
            cur = []
    if cur:
        runs.append(cur)
    drop = set()
    if len(runs) > 2:
        for run in runs[1:-1]:
            drop.update(run)
    # DELTA TRIM. This session streamed 27 107 `message_update` frames — 10 MB of
    # prose, most of it the session's ordinary tool-chatter turns. Deltas are the
    # only frames trimmed here, and only for turns that carry NONE of this
    # scenario's vocabulary; every `message_start` / `message_end` /
    # `tool_execution_*` / `turn_*` frame is kept, so every row is still BIRTHED on
    # the live plane, and every dropped turn's entry still arrives through the
    # final walk page. What is kept: the deltas of the turns that pin the faces
    # (image result, error result, the big read, the compaction, the branch, the
    # abort), which is the last KEEP_TURNS turns plus any turn matching MARKERS.
    MARKERS = ("red-16.png", "nope.txt", "ws.har")
    KEEP_TURNS = 8
    bounds, tstart = [], None
    for i, f in enumerate(frames):
        t = (f.get("rpc") or {}).get("type")
        if t == "turn_start":
            tstart = i
        elif t == "turn_end" and tstart is not None:
            bounds.append((tstart, i))
            tstart = None
    interesting = set()
    for n, (a, b) in enumerate(bounds):
        if n >= len(bounds) - KEEP_TURNS:
            interesting.add(n)
            continue
        for f in frames[a : b + 1]:
            rpc = f.get("rpc") or {}
            if rpc.get("type") == "tool_execution_start":
                args = rpc.get("args") or {}
                if any(m in str(args.get("path", "")) or m in str(args.get("command", "")) for m in MARKERS):
                    interesting.add(n)
                    break
            if rpc.get("type") in ("compaction_end", "session_compact"):
                interesting.add(n)
                break
            if rpc.get("type") == "turn_end" and rpc.get("aborted") is True:
                interesting.add(n)
                break
    def turn_of(i):
        for n, (a, b) in enumerate(bounds):
            if a <= i <= b:
                return n
        return None

    delta_types = {"message_update", "tool_execution_update"}
    for i, f in enumerate(frames):
        if (f.get("rpc") or {}).get("type") in delta_types:
            n = turn_of(i)
            if n is not None and n not in interesting:
                drop.add(i)
    kept = [f for i, f in enumerate(frames) if i not in drop]
    print(f"walk collapse: {len(runs)} runs, {len(runs) - 2 if len(runs) > 2 else 0} interior runs dropped")
    print(f"delta trim: {len(bounds)} turns, deltas kept for {len(interesting)} -> {len(kept)} frames")
    write("input.jsonl", kept)

    # The trailing run of walk pages: the capture ends on the client's post-turn
    # resync walk, so the last thing in it IS a cold arrival's whole view.
    end = len(frames)
    # A dump lands whenever a human says "dump", so a capture can end on a
    # heartbeat or a state poll that arrived AFTER the last walk. Those frames
    # change nothing, so the cold-arrival input may end at the walk behind them.
    # Only a whitelist of non-mutating frames qualifies: anything else is live
    # traffic after the walk, and dropping it silently would hide it from the pair.
    NON_MUTATING = {"ub", "get_state", "extension_ui_request", "rpc:get_state"}
    skipped = []
    while end > 0 and not is_get_entries_response(frames[end - 1]):
        f = frames[end - 1]
        rpc = f.get("rpc") or {}
        # A `get_state` reply arrives as rpc.type=="response" with the command name,
        # so the command is what identifies it — rpc.type alone would read every
        # reply as the same opaque "response".
        kind = ("rpc:" + rpc["command"]) if rpc.get("command") else (
            rpc.get("type") or f.get("type") or (f.get("ub") or {}).get("type"))
        if kind not in NON_MUTATING:
            raise SystemExit(
                "capture does not end on a get_entries page, and the frames behind it "
                f"are not all non-mutating (last: {kind}); a cold-arrival input has to "
                "end where a walk ends (the empty terminal page carries the leaf beacon)"
            )
        skipped.append(kind)
        end -= 1
    if skipped:
        print(f"trailing non-mutating frames skipped: {len(skipped)} ({sorted(set(skipped))})")
    start = end
    while start > 0 and is_get_entries_response(frames[start - 1]):
        start -= 1
    trailing = frames[start:end]
    if not any(not (f.get("rpc", {}).get("data") or {}).get("entries") for f in trailing):
        raise SystemExit(
            "the trailing walk never returned an empty page, so it never delivered the "
            "active-leaf beacon — re-capture with the walk left running to completion"
        )
    write("replay.jsonl", trailing)
    print(f"trailing walk = capture frames {start}..{end - 1}")
    for i, frame in enumerate(trailing):
        data = frame["rpc"].get("data") or {}
        print(f"  page {i}: {len(data.get('entries') or [])} entries, leafId={str(data.get('leafId'))[:8]}")


if __name__ == "__main__":
    main()
