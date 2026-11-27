#!/usr/bin/env bash
# Start the un-bien web client without remembering the ports, the relay URL, or
# where pnpm is.
#
#   scripts/start.sh              # dev server (what you almost always want)
#   scripts/start.sh preview      # build + serve dist/ — use this on a phone
#   scripts/start.sh doctor       # check everything, start nothing
#   scripts/start.sh stop         # kill the dev/preview servers this repo started
#   scripts/start.sh relay status|up|down
#
# The relay is supervised by launchd (com.georgeharker.unbien.relay) but is NOT
# started at login: `dev`/`preview` bring it up, and `relay down` takes it down.
# Staying down after `relay down` is the point — it is not a KeepAlive-always job.
#
# This script only STARTS and STOPS that unit. To INSTALL it from a clone (binary
# in ~/.cargo/bin, plist rendered from extension/service-templates/), use
# `scripts/relay-service.sh install` — see docs/from-clone.md §4.
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
# Reads `tailscale status --json` on stdin and prints Self.DNSName (empty if
# there is no tailnet). jq is NOT required: node is a hard prerequisite of this
# repo, so the JSON is parsed with it. One fewer thing a fresh clone must install.
tailscale_field() {
  node -e '
    let raw = "";
    process.stdin.on("data", (d) => (raw += d));
    process.stdin.on("end", () => {
      try {
        const v = JSON.parse(raw).Self?.DNSName ?? "";
        process.stdout.write(String(v));
      } catch {
        /* not JSON, not running, no tailnet — leave empty */
      }
    });
  '
}

show_urls() { # port
  local port="$1" host
  say ""
  say "  open here:      http://localhost:${port}"
  if command -v tailscale >/dev/null 2>&1; then
    host=""
    # `|| true` matters: with set -e + pipefail, a pipeline where tailscale is
    # merely NOT RUNNING would otherwise abort the script mid-report.
    host="$( { tailscale status --json 2>/dev/null || true; } | tailscale_field | sed 's/\.$//' || true)"
    # No MagicDNS name (no tailnet, or tailscale too old to report one): the
    # tailnet IP still works in a URL.
    if [[ -z "${host:-}" ]]; then
      host="$(tailscale ip -4 2>/dev/null || true)"
    fi
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
  # No nc dependency: /dev/tcp is a bash builtin, and the subshell closes the
  # socket when it exits. nc is the fallback for shells built without /dev/tcp.
  if (exec 3<>"/dev/tcp/127.0.0.1/$RELAY_PORT") 2>/dev/null; then
    return 0
  fi
  command -v nc >/dev/null 2>&1 && nc -z 127.0.0.1 "$RELAY_PORT" >/dev/null 2>&1
}

doctor() {
  local -a pm
  say "web-client doctor"
  node --version >/dev/null 2>&1 && ok "node $(node --version)" || { bad "node missing"; exit 1; }
  read -r -a pm <<<"$(pnpm_cmd)"; ok "pnpm via: ${pm[*]}"
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

# --- relay control -------------------------------------------------------------
# The LaunchAgent is installed with RunAtLoad=false + KeepAlive={Crashed,
# SuccessfulExit=false}: launchd supervises it, restarts a crash, and does NOT
# fight a deliberate stop. bootstrap loads the job; kickstart starts/restarts it.
RELAY_LABEL="com.georgeharker.unbien.relay"
RELAY_PLIST="$HOME/Library/LaunchAgents/$RELAY_LABEL.plist"

relay_loaded() { launchctl print "gui/$(id -u)/$RELAY_LABEL" >/dev/null 2>&1; }
relay_up_cmd()   {
  if [[ ! -f "$RELAY_PLIST" ]]; then
    warn "no LaunchAgent at $RELAY_PLIST"
    warn "  from a clone:      scripts/relay-service.sh install"
    warn "  from the package:  run /unbien install relay in pi"
    return 1
  fi
  relay_loaded || launchctl bootstrap "gui/$(id -u)" "$RELAY_PLIST" >/dev/null 2>&1 \
    || { warn "launchctl bootstrap failed"; return 1; }
  launchctl kickstart -k "gui/$(id -u)/$RELAY_LABEL" >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do relay_up && break; sleep 0.5; done
  relay_up && ok "relay up on :${RELAY_PORT}" || warn "relay did not answer on :${RELAY_PORT}"
}
relay_down_cmd() {
  if relay_loaded; then
    launchctl bootout "gui/$(id -u)/$RELAY_LABEL" >/dev/null 2>&1 && ok "relay stopped (launchd job removed)" || warn "bootout failed"
  elif listening "$RELAY_PORT"; then
    warn ":${RELAY_PORT} is answered by a process launchd does not own (pid $(listener_pid "$RELAY_PORT")) — not touching it"
  else
    say "relay already down"
  fi
}
relay_status_cmd() {
  if relay_loaded; then
    ok "launchd job loaded (pid $(launchctl print "gui/$(id -u)/$RELAY_LABEL" 2>/dev/null | sed -n 's/.*pid = \([0-9]*\).*/\1/p' | head -1))"
  else
    say "launchd job not loaded"
  fi
  relay_up && ok "answering on :${RELAY_PORT}" || say "not answering on :${RELAY_PORT}"
}

if [[ "${1:-}" == "relay" ]]; then
  case "${2:-status}" in
    up)    relay_up_cmd ;;
    down)  relay_down_cmd ;;
    status) relay_status_cmd ;;
    *) bad "usage: start.sh relay [status|up|down]"; exit 2 ;;
  esac
  exit 0
fi

MODE="${1:-dev}"
case "$MODE" in
  dev)
    already_running "$DEV_PORT"
    relay_up || relay_up_cmd
    cd "$ROOT"
    say "dev server on :${DEV_PORT} (strictPort — if the port is taken Vite refuses, it does not pick another)"
    show_urls "$DEV_PORT"
    exec $(pnpm_cmd) -C web-client dev
    ;;
  preview)
    already_running "$PREVIEW_PORT"
    relay_up || relay_up_cmd
    cd "$ROOT"
    # The swap build, not a bare `vite build`. A plain build empties dist/
    # before writing it, so anyone reloading gets a 404 — and a tab that never
    # reloaded still breaks, because jsQR is a lazily-imported chunk whose old
    # hashed filename has just been deleted. build-swap.sh builds beside dist/
    # and renames the symlink over, atomically.
    say "building dist/ (swap build — a live preview never sees an empty dist/) …"
    "$WEB/scripts/build-swap.sh"
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
