#!/usr/bin/env bash
#
# revoke-peer.sh — audit and revoke entries on THIS machine's pairing allow-list.
#
# WHY THIS EXISTS
# Every device that ever pairs stays on `peers.json` (and therefore on the
# signed allow-list the machine pushes to the relay) forever — there is no
# expiry, and a browser or capture tool mints a fresh device key each time, so
# the list accumulates identities nobody can name. Revoking one is a real
# security action (it removes a device's ability to see this machine's rooms),
# so the question is never "is this row ugly" but "can this key ever connect
# again?". Two kinds of evidence answer that, and neither is the pairing date:
#
#   1. the private key still exists locally → the device (or a tool holding it)
#      can come back. Provable: identity files carry the pubkey next to the
#      secret (pk/sk, publicKey/seed, public_key/private_key).
#   2. the key authenticated recently → *something* still holds it, even when
#      the secret is not in a place we can scan (a browser's localStorage).
#
# Log absence is NOT evidence of non-use: relay logs rotate (one retained file
# here, ~4 days), so "never in the logs" means "nothing since <oldest line>",
# which audit prints explicitly rather than implying.
#
# A peer with neither signal is `revocable`; anything else is kept and says why.
# `--force` overrides, because you may know things the files do not.
#
# It does NOT edit pairing.db or peers.json by hand. Removal goes through the
# extension's own verb (`extension/dist/index.js revoke <shortid>` →
# pairing/storage.ts removePeer), which is the same path `/unbien revoke` uses.
# The relay's copy of the list is updated by the machine re-PUSHING it (a
# full-set replace, signed), and clients push on connect — so by default this
# script restarts the relay afterwards, which makes every client reconnect and
# re-push. `--no-restart` skips that; until a push happens the relay still
# holds the old list, and `audit` says so.
#
# Usage:
#   scripts/revoke-peer.sh audit              # list + evidence + verdicts
#   scripts/revoke-peer.sh list               # plain peers.json listing
#   scripts/revoke-peer.sh revoke <shortid>   # gate, back up, revoke, re-push
#
# Flags:
#   --dry-run          show what would happen; change nothing
#   --force            revoke despite a local keypair / recent activity
#   --recent-days N    "recent" window for the activity gate (default 14)
#   --scan DIR         also look for identity files here (repeatable)
#   --no-restart       do not restart the relay to force the re-push
#
# Env: UNBIEN_STATE_DIR (state root), REVOKE_CMD (override the revoke verb —
# used by scripts/revoke-peer.test.sh to test without a live install).
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${UNBIEN_STATE_DIR:-$HOME/.local/state/un-bien}"
PEERS="$STATE_DIR/peers.json"
IDENTITY="$STATE_DIR/identity.json"
REVOKE_CMD="${REVOKE_CMD:-node $REPO_ROOT/extension/dist/index.js revoke}"

RECENT_DAYS=14
DRY=0
FORCE=0
RESTART=1
SCAN_DIRS=("$STATE_DIR")

say() { printf '%s\n' "$*"; }
note() { printf '  %s\n' "$*"; }
die() { printf '!! %s\n' "$*" >&2; exit 1; }

# ── the evidence, in one pass ───────────────────────────────────────────────
# JSON parsing and Ed25519-base64 comparisons in node (no jq dependency; the
# same handle can be stored base64, base64url or unpadded, so compare bytes,
# not strings).
_evidence() {
  STATE_DIR="$STATE_DIR" PEERS="$PEERS" IDENTITY="$IDENTITY" \
    RECENT_DAYS="$RECENT_DAYS" SCAN_DIRS="${SCAN_DIRS[*]}" \
    node --input-type=module -e '
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join } from "node:path"

const stateDir = process.env.STATE_DIR
const scanDirs = (process.env.SCAN_DIRS || "").split(" ").filter(Boolean)
const recentDays = Number(process.env.RECENT_DAYS || 14)

const rawOf = (s) => {
  for (const c of [s, s.replace(/-/g, "+").replace(/_/g, "/")]) {
    const p = c + "=".repeat((4 - (c.length % 4)) % 4)
    try {
      const b = Buffer.from(p, "base64")
      if (b.length === 32) return b
    } catch {}
  }
  return null
}
const jsonsIn = (dir) => {
  let out = []
  let ents
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out = out.concat(jsonsIn(p))
    else if (e.name.endsWith(".json")) out.push(p)
  }
  return out
}

// Private keys that exist locally, as raw bytes. peers.json is a PUBKEY list —
// never a keypair — so it is excluded from this scan.
const secretPairs = [
  ["pk", "sk"], ["publicKey", "seed"], ["public_key", "private_key"],
  ["pubkey", "secretKey"], ["publicKey", "privateKey"], ["pk", "seed"],
]
const localKeys = []
for (const dir of scanDirs) {
  for (const f of jsonsIn(dir)) {
    if (f.endsWith("/peers.json")) continue
    let d
    try { d = JSON.parse(readFileSync(f, "utf8")) } catch { continue }
    if (!d || typeof d !== "object") continue
    for (const [pub, priv] of secretPairs) {
      if (typeof d[pub] === "string" && typeof d[priv] === "string") {
        const r = rawOf(d[pub])
        if (r) localKeys.push({ file: f, raw: r })
      }
    }
  }
}

// relay.log* mentions, with the timestamp of the newest one and the oldest
// line we retained (the honest bound on "never seen"). Any line naming the
// peer counts — auth, grants, forwarding — because for a KEEP decision the
// question is only "is there evidence something still holds this key?".
const logs = (() => {
  try { return readdirSync(stateDir).filter((f) => /^relay\.log(\.\d+)?$/.test(f)) } catch { return [] }
})()
const tagHits = new Map()
let oldestLogLine = null
for (const f of logs) {
  let text
  try { text = readFileSync(join(stateDir, f), "utf8") } catch { continue }
  for (const line of text.split("\n")) {
    const m = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/)
    if (!m) continue
    if (!oldestLogLine || m[1] < oldestLogLine) oldestLogLine = m[1]
    const peer = line.match(/peer=([A-Za-z0-9+/]+={0,2})/)
    if (!peer) continue
    const prev = tagHits.get(peer[1])
    if (!prev || m[1] > prev.when) tagHits.set(peer[1], { when: m[1], file: f })
  }
}

let peers = []
try {
  const parsed = JSON.parse(readFileSync(process.env.PEERS, "utf8"))
  peers = Array.isArray(parsed.peers) ? parsed.peers : []
} catch {}

const now = Date.now()
const rows = []
for (const p of peers) {
  const raw = rawOf(p.remote_epk)
  const keyHit = raw ? localKeys.find((k) => k.raw.equals(raw)) : null
  const seen = tagHits.get(p.remote_epk.slice(-8)) || null
  const ageDays = seen ? (now - Date.parse(seen.when)) / 86400000 : null
  let verdict, why
  if (keyHit) { verdict = "KEEP"; why = `private key on disk (${keyHit.file})` }
  else if (ageDays !== null && ageDays <= recentDays) {
    verdict = "KEEP"
    why = `seen in ${seen.file} ${ageDays < 1 ? "today" : Math.round(ageDays) + "d ago"} — a log line names this peer, so something may still hold the key`
  } else { verdict = "REVOKABLE"; why = "no local keypair" + (seen ? `, no log mention since ${seen.when}` : ", no log mention in the retained window") }
  rows.push({ shortid: p.remote_epk.slice(0, 8), name: p.name || "(unnamed)", paired: (p.paired_at || "?").slice(0, 10), verdict, why, epk: p.remote_epk })
}
console.log(JSON.stringify({ rows, oldestLogLine, logCount: logs.length, localKeyCount: localKeys.length }))
'
}

_audit() {
  [[ -f "$PEERS" ]] || die "no peers file at $PEERS (state dir: $STATE_DIR)"
  local json
  json="$(_evidence)"
  printf '%s' "$json" | node --input-type=module -e '
let s = ""; await new Promise((r) => { process.stdin.on("data", (c) => (s += c)); process.stdin.on("end", r) })
const d = JSON.parse(s)
console.log(`pairing allow-list — ${d.rows.length} device(s) may see this machine'"'"'s rooms\n`)
for (const r of d.rows) {
  console.log(`  ${r.shortid}  ${(r.name).padEnd(24)} paired ${r.paired}  ${r.verdict.padEnd(9)} ${r.why}`)
}
console.log("")
console.log(`  evidence limits: ${d.logCount} retained relay log(s), oldest line ${d.oldestLogLine ?? "none"} —`)
console.log("    a key absent from that window may still have been used earlier, and a browser-held")
console.log("    key is not visible on disk at all. That is why recency, not the pairing date, gates a revoke.")
const n = d.rows.filter((r) => r.verdict === "REVOKABLE").length
console.log(`\n  ${n} revocable, ${d.rows.length - n} kept. Revoke with: scripts/revoke-peer.sh revoke <shortid>`)
'
}

_resolve() {
  PEERS="$PEERS" SHORTID="$1" node --input-type=module -e '
import { readFileSync } from "node:fs"
const peers = JSON.parse(readFileSync(process.env.PEERS, "utf8")).peers || []
const hit = peers.filter((p) => (p.remote_epk || "").startsWith(process.env.SHORTID))
if (hit.length === 1) {
  const p = hit[0]
  console.log(JSON.stringify({ name: p.name || "(unnamed)", epk: p.remote_epk }))
} else if (hit.length === 0) {
  console.error("no peer starts with that shortid")
  process.exit(3)
} else {
  console.error(`ambiguous: ${hit.map((p) => p.remote_epk.slice(0, 8)).join(", ")}`)
  process.exit(4)
}'
}

_restart_relay() {
  case "$(uname -s)" in
    Darwin)
      say "==> forcing a re-push: kickstart the relay so every client reconnects"
      launchctl kickstart -k "gui/$(id -u)/com.georgeharker.unbien.relay" 2>/dev/null ||
        die "could not kickstart the relay — restart it yourself, or the old list stays live"
      ;;
    Linux)
      say "==> forcing a re-push: restart the relay unit so every client reconnects"
      systemctl --user restart unbien-relay.service 2>/dev/null ||
        die "could not restart unbien-relay.service — do it yourself, or the old list stays live"
      ;;
    *) say "!! unknown OS — restart the relay yourself so the new list gets pushed" ;;
  esac
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    curl -fsS --max-time 2 http://127.0.0.1:3000/health >/dev/null 2>&1 && break
    sleep 0.5
  done
}

_verify_relay_side() {
  [[ -f "$STATE_DIR/pairing.db" ]] || { note "no pairing.db here — nothing to verify against"; return 0; }
  if ! command -v sqlite3 >/dev/null 2>&1; then
    note "sqlite3 not installed — check the relay log instead:"
    note "  grep 'stored SIGNED allow-list' $STATE_DIR/relay.log | tail -3"
    return 0
  fi
  local ours count
  # Env, not argv: under --input-type=module the extra argument is not
  # reliably argv[1], and an empty machine filter silently returns 0 rows.
  ours="$(IDENTITY="$IDENTITY" node --input-type=module -e '
import { readFileSync } from "node:fs"
try { console.log(JSON.parse(readFileSync(process.env.IDENTITY, "utf8")).pk ?? "") } catch { console.log("") }
')"
  [[ -n "$ours" ]] || { note "could not read our own pubkey from $IDENTITY — skipping verification"; return 0; }
  # Right after a restart the relay holds the db open and a read can fail with
  # "database is locked", which is transient — retry rather than report "?".
  # The sqlite3 CLI does NOT bind `?` from extra arguments — it treats them as
  # more SQL, so a base64 pubkey there is a syntax error and the count silently
  # comes back 0. Inline it as a string literal instead, having ruled out the
  # one character that could break out of it.
  case "$ours" in *"'"*) note "unexpected quote in our pubkey — skipping verification"; return 0 ;; esac
  local count=""
  for _ in 1 2 3 4 5 6; do
    count="$(sqlite3 "file:$STATE_DIR/pairing.db?mode=ro" "select count(*) from pairing_allow where machine='$ours';" 2>/dev/null)"
    [[ -n "$count" ]] && break
    sleep 0.5
  done
  [[ -n "$count" ]] || count="?"
  note "relay now holds: $count owner(s) for this machine"
  note "if that number did not drop, no client has re-pushed yet — a reconnect does it"
}

_cmd="${1:-audit}"
shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --force) FORCE=1; shift ;;
    --recent-days) RECENT_DAYS="$2"; shift 2 ;;
    --scan) SCAN_DIRS+=("$2"); shift 2 ;;
    --no-restart) RESTART=0; shift ;;
    -h | --help) sed -n '3,40p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) TARGET="$1"; shift ;;
  esac
done

case "$_cmd" in
  audit) _audit ;;
  list)
    [[ -f "$PEERS" ]] || die "no peers file at $PEERS"
    PEERS="$PEERS" node --input-type=module -e '
import { readFileSync } from "node:fs"
for (const p of (JSON.parse(readFileSync(process.env.PEERS, "utf8")).peers || []))
  console.log(`  ${(p.remote_epk || "").slice(0, 8)}  ${p.name || "(unnamed)"}  paired ${(p.paired_at || "?").slice(0, 10)}`)
'
    ;;
  revoke)
    [[ -n "${TARGET:-}" ]] || die "revoke needs a shortid — run 'audit' to see them"
    [[ -f "$PEERS" ]] || die "no peers file at $PEERS"
    resolved="$(_resolve "$TARGET" 2>&1)" || die "$resolved"
    name="$(printf '%s' "$resolved" | node --input-type=module -e '
let s = ""; await new Promise((r) => { process.stdin.on("data", (c) => (s += c)); process.stdin.on("end", r) })
console.log(JSON.parse(s).name)')"
    verdict="$(printf '%s' "$(_evidence)" | SHORTID="$TARGET" node --input-type=module -e '
let s = ""; await new Promise((r) => { process.stdin.on("data", (c) => (s += c)); process.stdin.on("end", r) })
const d = JSON.parse(s)
const r = d.rows.find((x) => x.shortid.startsWith(process.env.SHORTID))
console.log(r ? `${r.verdict}\t${r.why}` : "ABSENT\tnot in peers.json")')"
    gate="${verdict%%$'\t'*}"
    why="${verdict#*$'\t'}"

    say "peer:    $name ($TARGET)"
    say "evidence: $why"
    if [[ "$gate" == "ABSENT" ]]; then die "no such peer"; fi
    if [[ "$gate" == "KEEP" && "$FORCE" != 1 ]]; then
      die "refusing: $why
   (that is the point of this script — re-run with --force if you know better)"
    fi

    total="$(PEERS="$PEERS" node --input-type=module -e '
import { readFileSync } from "node:fs"
console.log((JSON.parse(readFileSync(process.env.PEERS, "utf8")).peers || []).length)')"
    if [[ "$total" == "1" && "$FORCE" != 1 ]]; then
      die "that is the ONLY peer — revoking it leaves no device able to see this machine's rooms.
   Re-pairing from a pi session works, but re-run with --force to mean it."
    fi

    if [[ "$DRY" == 1 ]]; then
      say "==> --dry-run: would back up $PEERS, run: $REVOKE_CMD $TARGET"
      [[ "$RESTART" == 1 ]] && say "    then restart the relay so the shorter list gets pushed"
      exit 0
    fi

    bak="$PEERS.bak-$(date +%Y%m%d-%H%M%S)"
    cp "$PEERS" "$bak"
    note "peers.json backed up to $(basename "$bak")"
    say "==> $REVOKE_CMD $TARGET"
    # shellcheck disable=SC2086
    $REVOKE_CMD "$TARGET" || die "the revoke command failed — restore with: cp $bak $PEERS"
    [[ "$RESTART" == 1 ]] && _restart_relay
    _verify_relay_side
    say "==> done. peers.json now:"
    PEERS="$PEERS" node --input-type=module -e '
import { readFileSync } from "node:fs"
for (const p of (JSON.parse(readFileSync(process.env.PEERS, "utf8")).peers || []))
  console.log(`  ${(p.remote_epk || "").slice(0, 8)}  ${p.name || "(unnamed)"}`)
'
    ;;
  *)
    say "unknown command: $_cmd"
    sed -n '3,40p' "${BASH_SOURCE[0]}"
    exit 2
    ;;
esac
