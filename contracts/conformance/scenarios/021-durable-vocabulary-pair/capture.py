#!/usr/bin/env python3
"""Build this scenario's two inputs from ONE raw client-side capture.

    ./capture.py raw.jsonl

Structured like 020 (one session, two arrivals, both runs must agree), and aimed
at the entry types 020 did not contain. 020's session was quiet: messages, tool
calls, one pairing notice. The durable plane has more vocabulary than that, and
none of it was ever fed through a page:

  * `compaction`          — pi's own /compact (marker row + the folded summary)
  * `branch_summary`      — branching/rewinding the session
  * `session_info`        — renaming the session
  * `model_change`        — /model
  * `thinking_level_change`
  * a tool result with an IMAGE content block (base64 on the entry)
  * an error tool result, and an aborted/errored turn

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


def scrub(node, key=None, inside_details=False):
    if isinstance(node, dict):
        return {
            k: scrub(v, k, inside_details or k == "details") for k, v in node.items()
        }
    if isinstance(node, list):
        return [scrub(v, key, inside_details) for v in node]
    if not isinstance(node, str):
        return node
    if inside_details:
        return mark(node)
    if key in OPAQUE_KEYS:
        return mark(node)
    if key == "data" and len(node) > 64:  # a base64 image payload, not a field name
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

    write("input.jsonl", frames)

    # The trailing run of walk pages: the capture ends on the client's post-turn
    # resync walk, so the last thing in it IS a cold arrival's whole view.
    end = len(frames)
    if not is_get_entries_response(frames[-1]):
        raise SystemExit(
            "capture does not end on a get_entries page; a cold-arrival input has to "
            "end where a walk ends (the empty terminal page carries the leaf beacon)"
        )
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
