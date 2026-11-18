#!/usr/bin/env python3
"""Build this scenario's input: a REAL session's durable entries, delivered as
the `get_entries` response pages a client actually receives.

    ./capture.py <path-to-pi-session-log>

Provenance, in the order it matters:
  * the ENTRIES are copied verbatim from pi's durable log — ids, parentIds,
    timestamps, types, roles, tool names, mimeTypes all as written. Only
    content is replaced by a length marker (`«N»`), the same convention the
    frame captures use, plus one stricter rule: every value under `details`
    (a pairing token, a URI) is marked regardless of length.
  * the PAGE FRAMING is not observable from the log — pi pages by its own byte
    budget — so it is authored from the two folds that read it:
    `EnvelopeReducer.swift:145-159` and `web-client/src/reducer.ts:571-587`.
    Both say the same thing: a non-empty page's `leafId` is only a resume
    cursor, and the ACTIVE-LEAF BEACON is the leafId of the page that came back
    EMPTY. So: two non-empty pages, then one empty page carrying the tip.
"""

import json
import sys

MAX_READABLE = 48  # the projection's own readable cap (Conformance.textLimit)

# Content-bearing fields: replaced by a length marker, never kept.
CONTENT_KEYS = {"text", "thinking", "summary", "data", "errorMessage", "message"}


def mark(value):
    return f"\u00ab{len(value)}\u00bb"


def scrub(node, key=None, inside_details=False):
    if isinstance(node, dict):
        return {k: scrub(v, k, inside_details or k == "details") for k, v in node.items()}
    if isinstance(node, list):
        return [scrub(v, key, inside_details) for v in node]
    if not isinstance(node, str):
        return node
    # Secrets first, whatever their length: a pairing token in a fixture is a
    # credential in a repository.
    if inside_details:
        return mark(node)
    if key in CONTENT_KEYS or key == "args" or len(node) > MAX_READABLE:
        return mark(node)
    return node


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    log = sys.argv[1]
    entries = []
    for line in open(log, encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        entries.append(json.loads(line))

    session_id = next((e.get("id") for e in entries if e.get("type") == "session"), None)
    if session_id is None:
        raise SystemExit("no session header in log")

    tip = entries[-1]["id"]
    pages = [entries[:30], entries[30:], []]
    ts = 1795300000000
    out = []
    for index, page in enumerate(pages):
        data = {"entries": [scrub(e) for e in page]}
        # Non-empty pages: a cursor (the page's last id). Empty page: the tip,
        # which is the beacon both folds derive the active path from.
        data["leafId"] = page[-1]["id"] if page else tip
        out.append(
            {
                "rpc": {"type": "response", "command": "get_entries", "data": data},
                "sessionId": session_id,
                "ts": ts + index,
            }
        )
    sys.stdout.write("".join(json.dumps(o, ensure_ascii=False) + "\n" for o in out))


if __name__ == "__main__":
    main()
