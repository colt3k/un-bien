#!/usr/bin/env bash
#
# revoke-peer.test.sh — exercise scripts/revoke-peer.sh against fixtures.
#
# The gate logic is the part worth testing: it must KEEP a peer whose private
# key exists locally, KEEP one that authenticated inside the recency window
# (a browser holds its key where no scan can see it), and only call the revoke
# verb for peers where neither holds. The revoke verb itself is stubbed, so
# these tests never touch a real install; the state dir, logs and identity
# files are all under a temp dir.
#
# Run: scripts/revoke-peer.test.sh
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/revoke-peer.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/revoke-peer-test-XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
ok() {
  pass=$((pass + 1))
  printf '  ok   %s\n' "$1"
}
no() {
  fail=$((fail + 1))
  printf '  FAIL %s\n' "$1"
  [[ -n "${2:-}" ]] && printf '       %s\n' "$2"
}

# ── fixtures ────────────────────────────────────────────────────────────────
STATE="$TMP/state"

node --input-type=module -e '
import { mkdirSync, writeFileSync } from "node:fs"
const state = process.argv[1]
mkdirSync(state, { recursive: true })
const b64 = (fill) => Buffer.alloc(32, fill).toString("base64")
const A = b64(0x41) // no keypair, no log mention           → REVOKABLE
const B = b64(0x42) // private key held in web-dump file    → KEEP
const C = b64(0x43) // authenticated yesterday              → KEEP
const D = b64(0x44) // authenticated 200 days ago           → REVOKABLE
const ISO = (days) => new Date(Date.now() - days * 86400000).toISOString()

writeFileSync(
  state + "/peers.json",
  JSON.stringify(
    {
      peers: [
        { name: "dead-fixture", remote_epk: A, paired_at: ISO(40) },
        { name: "key-held-tool", remote_epk: B, paired_at: ISO(30) },
        { name: "phone-browser", remote_epk: C, paired_at: ISO(20) },
        { name: "old-laptop", remote_epk: D, paired_at: ISO(210) },
      ],
    },
    null,
    2,
  ),
)
// This machine, with its own secret — must never be treated as a peer.
writeFileSync(state + "/identity.json", JSON.stringify({ pk: b64(0x5a), sk: b64(0x21) }))
// A tool identity that still holds peer B private key.
writeFileSync(
  state + "/web-dump-identity.json",
  JSON.stringify({ seed: b64(0x99), publicKey: B }),
)
// Retained log: yesterday for C, 200 days ago for D. Tags are the 8-char tail
// the relay logs use.
const line = (when, epk) =>
  `${when}  INFO relay::handlers::peer: authenticated peer=${epk.slice(-8)} room=HI5Ogu addr=100.64.0.2:50000\n`
writeFileSync(
  state + "/relay.log",
  [
    `${ISO(200)}  INFO relay::handlers::peer: pairing_set: stored SIGNED allow-list\n`,
    line(ISO(200), D),
    "not-a-timestamp line (must be ignored)\n",
    line(ISO(1), C),
  ].join(""),
)
// The stub revoke verb: same full-set semantics as pairing/storage.ts removePeer.
writeFileSync(
  process.argv[2],
  `import { readFileSync, writeFileSync } from "node:fs"
const p = process.env.UNBIEN_STATE_DIR + "/peers.json"
const sid = process.argv[2]
const d = JSON.parse(readFileSync(p, "utf8"))
const before = d.peers.length
d.peers = d.peers.filter((x) => !(x.remote_epk || "").startsWith(sid))
if (d.peers.length === before) { console.log("No peer matching that shortid"); process.exit(1) }
writeFileSync(p, JSON.stringify(d, null, 2))
console.log("Revoked: " + sid)
`,
)
' "$STATE" "$TMP/stub-revoke.mjs" || {
  echo "fixture generation failed"
  exit 1
}

export UNBIEN_STATE_DIR="$STATE"
export REVOKE_CMD="node $TMP/stub-revoke.mjs"
count_peers() {
  node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).peers.length)' "$STATE/peers.json"
}
# The real shortid prefixes, read back from the fixture in fixture order
# (dead, key-held, phone, old) — never guessed from how the bytes were built.
read -r ID_DEAD ID_KEY ID_PHONE ID_OLD <<EOF
$(node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).peers; console.log(p.map((x) => x.remote_epk.slice(0, 8)).join(" "))' "$STATE/peers.json")
EOF
echo "  fixture shortids: $ID_DEAD $ID_KEY $ID_PHONE $ID_OLD"

# A relay-side db, so the verification step reads something real. Worth having:
# the sqlite3 CLI does not bind `?` from extra arguments (it parses them as more
# SQL), so a base64 pubkey passed that way is a syntax error and the count comes
# back 0 — which looks like "the revoke had no effect" rather than a broken query.
HAVE_SQLITE=0
if command -v sqlite3 >/dev/null 2>&1; then
  OURS_PK="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pk)' "$STATE/identity.json")"
  sqlite3 "$STATE/pairing.db" "create table pairing_allow(machine text, owner text);
    insert into pairing_allow values
      ('$OURS_PK','$ID_DEAD'),('$OURS_PK','$ID_KEY'),('$OURS_PK','$ID_PHONE'),
      ('unrelatedmachineAAAAAAAAAAAAAAAAAAAAAAA=','$ID_OLD');"
  HAVE_SQLITE=1
fi

echo
echo "== audit: evidence and verdicts =="
audit="$("$SCRIPT" audit 2>&1)"
grep -q "dead-fixture.*REVOKABLE" <<<"$audit" && ok "no-keypair peer is REVOKABLE" || no "no-keypair peer is REVOKABLE" "$audit"
grep -q "key-held-tool.*KEEP.*private key on disk" <<<"$audit" && ok "locally-held keypair is KEEP" || no "locally-held keypair is KEEP" "$audit"
grep -q "phone-browser.*KEEP.*seen in relay.log" <<<"$audit" && ok "recently-active peer is KEEP" || no "recently-active peer is KEEP" "$audit"
grep -q "old-laptop.*REVOKABLE" <<<"$audit" && ok "mention outside the window is REVOKABLE" || no "mention outside the window is REVOKABLE" "$audit"
grep -q "oldest line 200\|oldest line 20" <<<"$audit" || grep -q "oldest line" <<<"$audit" && ok "audit states its evidence window" || no "audit states its evidence window" "$audit"

echo
echo "== revoke: the gates =="
out="$("$SCRIPT" revoke "$ID_KEY" --no-restart 2>&1)"; rc=$?
[[ $rc -ne 0 ]] && grep -q "refusing: private key on disk" <<<"$out" && ok "refuses a peer whose key is held locally" || no "refuses a peer whose key is held locally" "rc=$rc $out"
[[ $(count_peers) == 4 ]] && ok "refusal changed nothing" || no "refusal changed nothing" "peers=$(count_peers)"

out="$("$SCRIPT" revoke "$ID_PHONE" --no-restart 2>&1)"; rc=$?
[[ $rc -ne 0 ]] && grep -q "refusing:.*seen in relay.log" <<<"$out" && ok "refuses a recently active peer" || no "refuses a recently active peer" "rc=$rc $out"

out="$("$SCRIPT" revoke zzzzzzzz --no-restart 2>&1)"; rc=$?
[[ $rc -ne 0 ]] && grep -qi "no peer" <<<"$out" && ok "unknown shortid is an error" || no "unknown shortid is an error" "rc=$rc $out"

out="$("$SCRIPT" revoke "$ID_OLD" --no-restart --dry-run 2>&1)"
grep -q -- "--dry-run" <<<"$out" && [[ $(count_peers) == 4 ]] && ok "--dry-run changes nothing" || no "--dry-run changes nothing" "peers=$(count_peers) $out"

echo
echo "== revoke: the happy paths =="
out="$("$SCRIPT" revoke "$ID_DEAD" --no-restart 2>&1)"; rc=$?
[[ $rc -eq 0 ]] && grep -q "Revoked: $ID_DEAD" <<<"$out" && ok "revokes a peer with no evidence behind it" || no "revokes a peer with no evidence behind it" "rc=$rc $out"
[[ $(count_peers) == 3 ]] && ok "peers.json lost exactly that entry" || no "peers.json lost exactly that entry" "peers=$(count_peers)"
if [[ "$HAVE_SQLITE" == 1 ]]; then
  grep -q "relay now holds: 3 owner(s) for this machine" <<<"$out" && ok "reads the relay-side owner count back" || no "reads the relay-side owner count back" "$out"
else
  grep -q "no pairing.db here" <<<"$out" && ok "says so when there is no relay db to read" || no "says so when there is no relay db to read" "$out"
fi
ls "$STATE"/peers.json.bak-* >/dev/null 2>&1 && ok "backed up peers.json first" || no "backed up peers.json first"
grep -q "key-held-tool" "$STATE/peers.json" && ok "other peers untouched" || no "other peers untouched"

out="$("$SCRIPT" revoke "$ID_PHONE" --no-restart --force 2>&1)"; rc=$?
[[ $rc -eq 0 ]] && ok "--force overrides the recency gate" || no "--force overrides the recency gate" "rc=$rc $out"
[[ $(count_peers) == 2 ]] && ok "--force revoked it" || no "--force revoked it" "peers=$(count_peers)"

echo
echo "== the lock-yourself-out guard =="
"$SCRIPT" revoke "$ID_KEY" --no-restart --force >/dev/null 2>&1
out="$("$SCRIPT" revoke "$ID_OLD" --no-restart 2>&1)"; rc=$?
[[ $rc -ne 0 ]] && grep -q "ONLY peer" <<<"$out" && ok "refuses to empty the list without --force" || no "refuses to empty the list without --force" "rc=$rc $out"

echo
echo "── $pass passed, $fail failed"
[[ $fail -eq 0 ]] || exit 1
