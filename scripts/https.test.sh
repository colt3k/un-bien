#!/usr/bin/env bash
#
# https.test.sh — exercise scripts/https.sh without touching a real tailnet.
#
# What is worth testing here is not the TLS (tailscale's problem) but the
# decisions this script makes: which port fronts which service, that it refuses
# to overwrite someone else's handler without being told, that `off` removes
# only what it added (never `serve reset`), and — the one that rots silently —
# that the relay's TLS port still matches the constant the web client dials by
# default. A mismatch there is a phone that says "connection failed" and
# nothing in the message that explains why.
#
# `tailscale` is replaced on PATH with a recorder, so no serve config on this
# machine is read or changed by these tests.
#
# Run: scripts/https.test.sh
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/https.sh"
FRAMING="$HERE/../web-client/src/framing.ts"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/https-test-XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
case "$TMP" in
  /*) : ;;
  *) printf 'mktemp gave a relative path: %s\n' "$TMP" >&2; exit 1 ;;
esac
want="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
got="$(cd "$TMP" 2>/dev/null && pwd -P || true)"
[[ -n "$got" ]] || { printf 'mktemp path vanished: %s\n' "$TMP" >&2; exit 1; }
case "$got" in
  "$want"/*) : ;;
  *) printf 'refusing to write outside the temp root: %s (not under %s)\n' "$got" "$want" >&2; exit 1 ;;
esac

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

# ── the fake tailscale ──────────────────────────────────────────────────────
# Records every argv on one line per call, and answers the read-only queries
# from env so each case can set its own starting config.
BIN="$TMP/bin"
mkdir -p "$BIN"
cat >"$BIN/tailscale" <<'FAKE'
#!/bin/sh
printf '%s\n' "$*" >>"$TAILSCALE_LOG"
# Match the WHOLE argv, not "$1 $2": `serve status --json` is three words, and
# a two-word match silently answers a JSON query with nothing — which is
# exactly how the overwrite guard below looked like it worked.
case "$*" in
  "status") echo "100.0.0.1 m5max.tail5f1ece.ts.net" ;;
  "status --json")
    printf '{"Self":{"DNSName":"m5max.tail5f1ece.ts.net.","TailscaleIPs":["100.0.0.1"]}}'
    ;;
  "serve status --json")
    # Not `${FAKE_SERVE_JSON:-{}}`: the shell ends the expansion at the FIRST
    # brace, so that form appends a stray `}` to every JSON it returns.
    if [ -n "${FAKE_SERVE_JSON:-}" ]; then printf '%s' "$FAKE_SERVE_JSON"
    else printf '%s' "{}"; fi
    ;;
  "serve status")
    [ -n "${FAKE_SERVE_TEXT:-}" ] && printf '%s\n' "$FAKE_SERVE_TEXT"
    ;;
esac
exit 0
FAKE
chmod +x "$BIN/tailscale"

run_script() { # run_script <args...> ; stdin is /dev/null so prompts abort
  LOG="$TMP/calls.log"
  : >"$LOG"
  PATH="$BIN:$PATH" TAILSCALE_LOG="$LOG" FAKE_SERVE_JSON="${FAKE_SERVE_JSON:-}" \
    FAKE_SERVE_TEXT="${FAKE_SERVE_TEXT:-}" "$@"
}

printf 'on: what it serves where\n'

out=$(FAKE_SERVE_JSON='{}' run_script sh "$SCRIPT" on --dry-run </dev/null 2>&1)
grep -q -- "--https=443 4173" <<<"$out" &&
  ok "web client: 443 -> 4173 (preview, the phone path)" ||
  no "web client: 443 -> 4173" "$out"
grep -q -- "--https=3443 3000" <<<"$out" &&
  ok "relay: 3443 -> 3000" || no "relay: 3443 -> 3000" "$out"
grep -q -- "--https=5174" <<<"$out" &&
  no "dev server stays off unless --dev asks" "$out" ||
  ok "dev server stays off unless --dev asks"

out=$(FAKE_SERVE_JSON='{}' run_script sh "$SCRIPT" on --dev --dry-run </dev/null 2>&1)
grep -q -- "--https=5174 5173" <<<"$out" &&
  ok "--dev adds 5174 -> 5173" || no "--dev adds 5174 -> 5173" "$out"
grep -q "full-reloads" <<<"$out" &&
  ok "--dev says out loud what the dev server does to a phone" ||
  no "--dev warns about full reloads" "$out"

# Dry run must be inert: the recorder sees the reads, never a write.
FAKE_SERVE_JSON='{}' run_script sh "$SCRIPT" on --dry-run </dev/null >/dev/null 2>&1
grep -q -- "serve --bg" "$TMP/calls.log" &&
  no "--dry-run changes nothing" "$(cat "$TMP/calls.log")" ||
  ok "--dry-run changes nothing"

printf 'on: it does not silently take over another handler\n'

# The real history of this node: 443 used to proxy 127.0.0.1:8787.
occupied='{"Web":{"m5max.tail5f1ece.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8787"}}}}}'
out=$(FAKE_SERVE_JSON="$occupied" run_script sh "$SCRIPT" on </dev/null 2>&1)
grep -q "127.0.0.1:8787" <<<"$out" &&
  ok "names the handler it is about to replace" ||
  no "names the handler it is about to replace" "$out"
grep -q -- "serve --bg" "$TMP/calls.log" &&
  no "refuses without a yes" "$(cat "$TMP/calls.log")" ||
  ok "refuses without a yes"

out=$(FAKE_SERVE_JSON="$occupied" run_script sh "$SCRIPT" on --yes </dev/null 2>&1)
grep -q -- "--https=443 4173" "$TMP/calls.log" &&
  ok "--yes applies it" || no "--yes applies it" "$out"

# Already ours: no prompt, no fuss.
ours='{"Web":{"m5max.tail5f1ece.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:4173"}}}}}'
out=$(FAKE_SERVE_JSON="$ours" run_script sh "$SCRIPT" on --dry-run </dev/null 2>&1)
grep -q "already serves something else" <<<"$out" &&
  no "re-running on the same config does not nag" "$out" ||
  ok "re-running on the same config does not nag"

printf 'off: removes what it added, and nothing else\n'

out=$(run_script sh "$SCRIPT" off --dry-run </dev/null 2>&1)
for port in 443 3443 5174; do
  grep -q -- "--https=$port off" <<<"$out" &&
    ok "removes :$port" || no "removes :$port" "$out"
done
grep -q "serve reset\|serve  *reset" <<<"$out" &&
  no "never resets the whole serve config" "$out" ||
  ok "never resets the whole serve config"

printf 'the port is a contract with the client\n'

# The script fronts the relay here; web-client/src/framing.ts dials it by
# default for an https page. If these drift, the client connects to nothing.
script_port=$(grep -o 'UNBIEN_RELAY_TLS_PORT:-[0-9]*' "$SCRIPT" | cut -d- -f2)
client_port=$(grep -o 'RELAY_TLS_PORT = [0-9]*' "$FRAMING" | cut -d' ' -f3)
if [[ -n "$script_port" && "$script_port" == "$client_port" ]]; then
  ok "https.sh fronts :$script_port, framing.ts dials :$client_port"
else
  no "relay TLS port matches framing.ts" "https.sh=$script_port framing.ts=$client_port"
fi

printf 'status and the mkcert fallback\n'

out=$(FAKE_SERVE_TEXT='https://m5max.tail5f1ece.ts.net (tailnet only)' \
  run_script sh "$SCRIPT" status </dev/null 2>&1)
# The URL to PASTE: 443 is the scheme's own port, so it must not appear.
grep -q "https://m5max.tail5f1ece.ts.net/ " <<<"$out" &&
  ok "status prints the URL to open on the phone" ||
  no "status prints the URL to open" "$out"
grep -q "ts.net:443/" <<<"$out" &&
  no "status omits the port a browser would omit" "$out" ||
  ok "status omits the port a browser would omit"
grep -q "wss://m5max.tail5f1ece.ts.net:3443/" <<<"$out" &&
  ok "status prints the wss relay URL" || no "status prints the wss relay URL" "$out"
grep -qi "cannot open a ws:// socket" <<<"$out" &&
  ok "status says why the relay needs its own front" ||
  no "status explains mixed content" "$out"

out=$(run_script sh "$SCRIPT" mkcert --dry-run </dev/null 2>&1)
grep -q "UNBIEN_TLS_KEY=" <<<"$out" && grep -q "UNBIEN_TLS_CERT=" <<<"$out" &&
  ok "mkcert prints the env pair vite.config.ts reads" ||
  no "mkcert prints the env pair" "$out"
grep -q "OPENSSL-LISTEN:3443" <<<"$out" &&
  ok "mkcert fronts the relay on the same port as serve mode" ||
  no "mkcert fronts the relay" "$out"
grep -q "Certificate Trust Settings" <<<"$out" &&
  ok "mkcert says the CA has to be trusted on every device" ||
  no "mkcert warns about the CA" "$out"

printf 'argument handling\n'

run_script sh "$SCRIPT" nonsense </dev/null >/dev/null 2>&1
[[ $? -eq 2 ]] && ok "unknown mode exits 2" || no "unknown mode exits 2" "rc=$?"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]] || exit 1
