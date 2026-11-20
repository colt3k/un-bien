# pi: nothing on the wire identifies a compaction

Found while building the conformance corpus for the un-bien clients
(`contracts/conformance/vocab.md`, "One compaction, one row — anchored by
causality, never by content"). Not a bug in either client, and we work around it —
but it is why a client has to guess, and guessing is where duplicate rows come from.

Observed against `@geohar/un-bien` **0.25.15** (pi coding agent 0.25.15),
2026-11-20, session `01a1f574-af12-7123-80ef-00d266b465b7`, cwd
`/private/tmp/unbien-capture`. Scenario: `023-live-compaction-pair`.

## What we see

A `/compact` reaches a connected viewer twice: as a live rpc frame, and later as
the durable entry a `get_entries` walk brings back. Both describe ONE compaction.
For that one compaction:

| source | `tokensBefore` | `summary` |
| --- | --- | --- |
| live `compaction_end` frame | **127 248** | 1840 chars |
| its own `compaction` entry (`8663f793…`) | **127 749** | byte-identical |

And the *previous* compaction in the same session (`4156e442…`) reported:

| source | `tokensBefore` | `summary` |
| --- | --- | --- |
| its `compaction` entry | **127 248** | byte-identical to the one above |

Three consequences:

1. **The live frame and the entry disagree about the token count of the same
   event** (127 248 vs 127 749 — a 501-token difference).
2. **The count is therefore not a join key**, and it collides with an earlier
   compaction's count.
3. **The summary is not a join key either**: pi regenerated a byte-identical
   summary for two different compactions.

So a client that links the live marker to the entry by *any* field either picks the
wrong compaction or matches nothing. On a real screen the symptom is a second
"Context compacted" row — one watched, one replayed.

## What we do instead

Both folds anchor by **causality**: compactions are strictly sequential in the log
and walks birth entries in log order, so an entry-born compaction anchors the
oldest live marker that is still unanchored, keeps its position, and takes the
**entry's** caption (the log's count is what a client that arrives cold shows).
That is correct for the order pi writes, but it is inference, not identity — it
breaks the moment a client attaches in the middle, or a walk brings entries in a
different grouping.

## The fix we would like upstream

**Put the entry id on the live `compaction_end` frame.** That is the one piece of
durable identity the entry already has and the frame does not — the same thing
`message_end` does for messages, which is why message identity works everywhere
else in the fold. No new entry type, no schema change, no behaviour change: just
carry `entryId` on the frame the extension already emits.

Secondary, if it is cheap:

- **Agree on the count.** Whichever of 127 248 / 127 749 is right, reporting one
  number in both places would let clients show a stable value instead of a caption
  that visibly changes when the walk lands (which ours does today, deliberately).
- **Identical summaries for different compactions are legal but surprising.** We no
  longer rely on the text, and we would rather not have to assume it.
