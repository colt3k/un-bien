#!/usr/bin/env bash
# Start the un-bien web client without remembering the ports, the relay URL, or
# where pnpm is.
#
#   scripts/start.sh              # dev server (what you almost always want)
#   scripts/start.sh preview      # build + serve dist/ — use this on a phone
#   scripts/start.sh doctor       # check everything, start nothing
#   scripts/start.sh stop         # kill the dev/preview servers this repo started
#
# It never starts a relay: that is pi's job (`/unbien pair` bootstraps the
# services). If no relay is answering, doctor tells you exactly that, so you do
# not spend ten minutes debugging a client that has nothing to connect to.
set -euo pipefail

DEV_PORT=5173
PREVIEW_PORT=4173
RELAY_PORT="${UNBIEN_RELAY_PORT:-3000}"

# Repo root = two levels up from this script, so it works from any cwd.
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
WEB="$ROOT/web-client"

say()  { printf '%s\n' "$*"; }
bad()  { printf '✗ %s\n' "$*" >&2; }
ok()   { printf '✓ %s\n' "$*"; }
warn() { printf '! %s\n' "$*"; }

# pnpm is frequently NOT on PATH on a mac (corepack is, or nothing). Resolve it
# the same way CI does — the version pinned in the root package.json's
# packageManager field — so the lockfile never churns behind our backs.
pnpm_cmd() {
  if command -v pnpm >/dev/null 2>&1; then
    echo "pnpm"
    return
  fi
  if command -v corepack >/dev/null 2>&1; then
    echo "corepack pnpm"
    return
  fi
  if command -v npx >/dev/null 2>&1; then
    local want
    want="$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' "$ROOT/package.json" 2>/dev/null || true)"
    echo "npx --yes pnpm@${want:-latest}"
    return
  fi
  bad "no pnpm, corepack, or npx on PATH — install one (see web-client/USAGE.md §1)"
  exit 1
}

listening() { # port
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

listener_pid() { # port
  lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1
}

# The URL to type into the drawer, and the URL to open on another device.
show_urls() { # port
  local port="$1" host
  say ""
  say "  open here:      http://localhost:${port}"
  if command -v tailscale >/dev/null 2>&1; then
    host="$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty' 2>/dev/null | sed 's/\.$//')"
    if [[ -n "${host:-}" ]]; then
      say "  open elsewhere: http://${host}:${port}"
      say "  relay URL:    http://${host}:${RELAY_PORT}"
      return
    fi
  fi
  host="$(ipconfig getifaddr en0 2>/dev/null || true)"
  if [[ -n "${host:-}" ]]; then
    say "  open elsewhere: http://${host}:${port}"
    say "  relay URL:    http://${host}:${RELAY_PORT}"
  else
    warn "could not find a tailnet/lan hostname — use http://localhost:${port}"
  fi
}

relay_up() {
  nc -z 127.0.0.1 "$RELAY_PORT" >/dev/null 2>&1
}

doctor() {
  local -a pm
  say "web-client doctor"
  node --version >/dev/null 2>&1 && ok "node $(node --version)" || { bad "node missing"; exit 1; }
  pm=($(pnpm_cmd)); ok "pnpm via: ${pm[*]}"
  [[ -d "$WEB/node_modules" ]] && ok "workspace installed" || warn "run: ${pm[*]} install --frozen-lockfile   (from $ROOT)"

  if listening "$DEV_PORT"; then
    warn ":${DEV_PORT} is busy (pid $(listener_pid "$DEV_PORT")) — a dev server is already up"
  else
    ok ":${DEV_PORT} free for dev"
  fi
  if listening "$PREVIEW_PORT"; then
    warn ":${PREVIEW_PORT} is busy (pid $(listener_pid "$PREVIEW_PORT"))"
  else
    ok ":${PREVIEW_PORT} free for preview"
  fi

  if relay_up; then
    ok "relay answering on :${RELAY_PORT}"
  else
    bad "no relay on :${RELAY_PORT}. In a pi session run:  /unbien pair
      (it starts the services and prints a single-use pairing code)"
  fi
  show_urls "$DEV_PORT"
}

already_running() { # port
  if listening "$1"; then
    say "Already running on :$1 (pid $(listener_pid "$1")) — open http://localhost:$1"
    say "Restart it with:  scripts/start.sh stop && scripts/start.sh ${MODE}"
    exit 0
  fi
}

MODE="${1:-dev}"
case "$MODE" in
  dev)
    already_running "$DEV_PORT"
    cd "$ROOT"
    say "dev server on :${DEV_PORT} (strictPort — if the port is taken Vite refuses, it does not pick another)"
    show_urls "$DEV_PORT"
    exec $(pnpm_cmd) -C web-client dev
    ;;
  preview)
    already_running "$PREVIEW_PORT"
    cd "$ROOT"
    say "building dist/ …"
    $(pnpm_cmd) -C web-client build
    say "serving dist/ on :${PREVIEW_PORT} — this is the one to use from a phone"
    show_urls "$PREVIEW_PORT"
    exec $(pnpm_cmd) -C web-client preview
    ;;
  doctor)
    doctor
    ;;
  stop)
    stopped=0
    for port in "$DEV_PORT" "$PREVIEW_PORT"; do
      if listening "$port"; then
        pid="$(listener_pid "$port")"
        # Only kill what this checkout started: a listener whose CWD is this repo.
        # Matching on the process name alone once killed an unrelated dev server
        # that happened to be a node process on the same port.
        cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
        if [[ "$cwd" == "$ROOT" || "$cwd" == "$WEB" ]]; then
          kill "$pid" 2>/dev/null || true
          ok "stopped :${port} (pid ${pid}, cwd ${cwd})"
          stopped=1
        else
          warn ":${port} is held by pid ${pid} ($(ps -o comm= -p "$pid" 2>/dev/null), cwd ${cwd:-?}) — not this checkout, left alone"
        fi
      fi
    done
    [[ "$stopped" == 0 ]] && say "nothing to stop on :${DEV_PORT} / :${PREVIEW_PORT}"
    ;;
  -h|--help|help)
    sed -n '2,12p' "${BASH_SOURCE[0]}"
    ;;
  *)
    bad "unknown mode: ${MODE} (dev | preview | doctor | stop)"
    exit 2
    ;;
esac
