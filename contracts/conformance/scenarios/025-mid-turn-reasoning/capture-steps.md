# How to capture this scenario

**Already captured (2026-11-20):** a viewer that joins a turn while pi is
REASONING, watches the rest of the thinking arrive, and settles.

1. Pre-open a second `?capture=1` tab so attaching costs ~2 seconds (the first
   attempt missed the window: a 1500-word answer streamed faster than opening a tab,
   refreshing the machine list and clicking attach took).
2. In pi, start a reasoning-heavy, tool-less question, e.g.
   `Prose only, no tool calls. Think it through carefully before answering: give the
   exact time, to the minute, in Tokyo, Cairo, São Paulo, Anchorage and Reykjavik
   when the 2026 Northern Hemisphere winter solstice occurs, and show how you got there.`
3. Say "go"; attach the pre-opened tab immediately.
4. Let it settle, then WAIT for the post-turn walk (the 6-second timer) — a capture
   that ends on `agent_settled` has no cold-arrival input. Then dump.
5. `./capture.py raw.jsonl`

Watch for: `thinking_start` and a long run of `thinking_delta` frames **after** the
attach, `turn_start` arriving after the attach (the turn began before the viewer
joined), and exactly one thinking row plus one answer at the end.
