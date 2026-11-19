#!/usr/bin/env python3
"""Build this scenario's two inputs from ONE raw client-side capture.

    ./capture.py raw.jsonl

Two files come out, and the whole point of the scenario is that they describe
the SAME session at the SAME instant, arriving two different ways:

  input.jsonl   every captured frame, in order — what a client that was
                CONNECTED for the window sees: the attach walk, the live turn
                (streaming deltas, tool start/end), and the post-turn resync walk.
  replay.jsonl  ONLY the trailing `get_entries` walk — what a client that
                ARRIVES cold at the end of that window sees: durable pages and
                the empty terminal page carrying the active-leaf beacon.

Both runs must end with the same transcript. That is the claim the corpus has
been promising ("identical across modes") and had never actually tested.

The capture itself is the web client's own tee: load it with `?capture=1` and it
pushes every inbound envelope to `window.__unbienFrames` (see
web-client/src/app.ts). Nothing was hand-written here — no synthetic entry, no
authored page. What the client received is what these files contain.

Scrub (field-aware, and LENGTH-PRESERVING — that is the part that matters here):
  * content fields (`text`, `thinking`, `summary`, `delta`, `errorMessage`, an
    image `data` payload) -> a run of `░`, one per character, at any length.
    A length MARKER (`«762»`) would break this scenario: the same row arrives as
    78 streamed deltas on one plane and one 762-char block on the other, and
    joining 78 markers never equals one marker. Filler preserves length, so a
    row whose text really is identical scrubs to an identical string — and if the
    two planes disagree about the text, the length shows it.
  * every value under `details` -> `«length»` at any length: a pairing token in
    a fixture is a credential in a repository;
  * `sessionId` -> `«length»` (36 chars, below the readable cap, but it names a
    real room+session on a real relay, and no fold needs its value);
  * any other string longer than the projection's readable cap (48) -> marked;
  * ids (entry ids, toolCallIds, correlation ids), parentIds, roles, tool names,
    mimeTypes, timestamps, stopReasons, usage numbers, sequence numbers: VERBATIM.
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
        return mark(node)
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
