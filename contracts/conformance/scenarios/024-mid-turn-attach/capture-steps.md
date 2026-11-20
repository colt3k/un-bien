# How to capture this scenario

**Already captured (2026-11-20).** Kept so the shape can be reproduced: a viewer
that joins a turn ALREADY IN FLIGHT, watches it settle, and then takes a walk.

## Steps

1. Client up with `?capture=1`. Attach a SECOND client tab to the session AFTER a
   long turn has started (~25 s in is right) — that fresh tab is the mid-turn viewer.
2. In pi, start something long that trickles, e.g.
   `run: for i in $(seq 1 20); do echo "tick $i $(date +%T)"; sleep 3; done`
   (each echo is a `tool_execution_update`, so the card is visibly running).
3. Let it finish and settle. Then wait ~10 s for the post-turn walk. Do not branch.
4. `__unbienDump("024-mid-turn-attach")`, then `./capture.py raw.jsonl`.

## What to look for

- `isStreaming: true` on the first `get_state`, with `messageCount` unchanged: the
  turn's message is not durable yet, so the viewer has only live frames to build on.
- `tool_execution_update` while running, then `message_start`/`message_end` and the
  streaming deltas of the tail.
- `turn_start` arriving AFTER the attach (the turn began before the viewer joined) and
  TWO `turn_end` frames — boundaries out of their natural order. The fold must still
  end with ONE assistant row and ONE card.
- The post-turn walk must NOT re-birth what the live plane already built.
