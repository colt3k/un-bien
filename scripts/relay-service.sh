#!/usr/bin/env bash
#
# relay-service.sh — own the unbien-relay user service (macOS launchd).
#
# WHY THIS EXISTS
# The service must not run out of `relay/target/release/`. That directory is
# build output: `cargo clean` empties it, and moving the repo invalidates the
# absolute path baked into the plist. launchd resolves that path fresh on every
# (re)start, so the day you move or clean the repo, the relay silently stops
# coming back (KeepAlive can't restart what it cannot find, and a reboot makes
# it permanent). So: copy the binary to a stable path OUTSIDE the repo, and
# point launchd at that.
#
# WHY ~/.cargo/bin BY DEFAULT
# The extension resolves the relay binary in `findRelayBinary()`
# (extension/src/daemon/relayService.ts) as: 1) `unbien-relay` on $PATH,
# 2) ~/.cargo/bin/unbien-relay. Keep the installed copy inside that set or
# `/unbien install relay` will not see it, will conclude the relay is missing,
# and will `cargo install` a published copy from crates.io over your service.
# Override with --bin-dir / UNBIEN_RELAY_BIN_DIR if you prefer e.g. ~/.local/bin
# (then make sure ~/.local/bin is on the PATH that pi itself runs with).
#
# WHAT IT TOUCHES
#   plist    ~/Library/LaunchAgents/com.georgeharker.unbien.relay.plist
#   binary   <bin-dir>/unbien-relay          (default ~/.cargo/bin)
# It never writes inside the repo, and it never deletes your state
# (~/.local/state/un-bien: pairing.db, mesh.db, relay.log).
#
# Note on the extension's own installer: `unbien install relay` regenerates the
# SAME plist from extension/service-templates/relay-launchd.plist.template and
# may upgrade the binary from crates.io. Running this script after that is
# fine — it re-points and restarts; running it before is what keeps a repo move
# from taking the relay down.
#
# Usage:
#   scripts/relay-service.sh status                    # what runs, from where
#   scripts/relay-service.sh install                   # build? no: copy repo build, write plist, start
#   scripts/relay-service.sh install --build           # cargo build --release first (needs cargo)
#   scripts/relay-service.sh update                    # re-copy the repo build + restart
#   scripts/relay-service.sh repoint                   # plist -> installed binary (after a repo move)
#   scripts/relay-service.sh repoint --path /abs/path  # plist -> an explicit binary
#   scripts/relay-service.sh uninstall                 # stop; keep plist as .disabled (restorable)
#   scripts/relay-service.sh uninstall --purge         # stop; delete plist + installed binary
#
# Flags:
#   --bin-dir DIR     where the stable binary lives   (default ~/.cargo/bin)
#   --path PATH       explicit binary for repoint/install
#   --port N          UNBIEN_RELAY_PORT for a freshly rendered plist (default 3000)
#   --build           cargo build --release before copying
#   --from-template   regenerate the plist from the repo template instead of
#                     editing the existing one in place (env is re-snapshotted)
#   --purge           with uninstall: remove plist + installed binary
#   --no-verify       skip the /health wait
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_BIN="$REPO_ROOT/relay/target/release/unbien-relay"
TEMPLATE="$REPO_ROOT/extension/service-templates/relay-launchd.plist.template"

LABEL="com.georgeharker.unbien.relay"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

BIN_DIR="${UNBIEN_RELAY_BIN_DIR:-$HOME/.cargo/bin}"
INSTALLED_BIN="$BIN_DIR/unbien-relay"
STATE_DIR="${UNBIEN_STATE_DIR:-$HOME/.local/state/un-bien}"
LOG_PATH="$STATE_DIR/relay.log"
PORT="${UNBIEN_RELAY_PORT:-3000}"

BUILD=0
FROM_TEMPLATE=0
PURGE=0
VERIFY=1
EXPLICIT_BIN=""

# ── helpers ────────────────────────────────────────────────────────────────

say() { printf '%s\n' "$*"; }
note() { printf '  %s\n' "$*"; }

plist_exists() { [[ -f "$PLIST" ]]; }

# ProgramArguments[0] of the loaded plist — the path launchd will exec.
plist_binary() {
  plist_exists || return 1
  /usr/libexec/PlistBuddy -c "Print :ProgramArguments:0" "$PLIST" 2>/dev/null
}

loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

service_pid() {
  launchctl print "$DOMAIN/$LABEL" 2>/dev/null | awk '/^[[:space:]]*pid = /{print $3; exit}'
}

version_of() {
  local bin="$1" out
  [[ -x "$bin" ]] || { printf '%s' "(missing)"; return; }
  if out="$("$bin" --version 2>/dev/null)"; then
    printf '%s' "$out"
  else
    printf '%s' "(unversionable)"
  fi
}

stop_service() {
  if loaded; then
    say "==> launchctl bootout $DOMAIN/$LABEL"
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || launchctl bootout "$DOMAIN" "$PLIST" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do loaded || break; sleep 0.5; done
  else
    say "==> service not loaded (ok)"
  fi
}

start_service() {
  [[ -f "$PLIST" ]] || { say "!! no plist at $PLIST — run install first"; exit 1; }
  mkdir -p "$(dirname "$LOG_PATH")"
  say "==> launchctl bootstrap $DOMAIN $(basename "$PLIST")"
  launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null ||
    launchctl load "$PLIST" 2>/dev/null ||
    { say "!! bootstrap failed — inspect with: launchctl print $DOMAIN/$LABEL"; exit 1; }
  # kickstart -k makes launchd exec the new binary even if a stale instance of
  # the same label lingers in the domain.
  launchctl kickstart -k "$DOMAIN/$LABEL" 2>/dev/null || true
}

verify_running() {
  [[ "$VERIFY" == "1" ]] || return 0
  local pid url ok=0
  pid="$(service_pid || true)"
  url="http://127.0.0.1:$PORT/health"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then ok=1; break; fi
    sleep 0.5
  done
  if [[ "$ok" == "1" ]]; then
    say "==> healthy: GET $url -> $(curl -fsS --max-time 2 "$url")  (pid ${pid:-unknown})"
  else
    say "!! $url did not answer within 5s. pid=${pid:-none}."
    say "   check: launchctl print $DOMAIN/$LABEL | head -30"
    say "   and:   tail -40 $LOG_PATH"
    return 1
  fi
}

backup_plist() {
  plist_exists || return 0
  local bak
  bak="$PLIST.bak-$(date +%Y%m%d-%H%M%S)"
  cp "$PLIST" "$bak"
  note "previous plist kept at $(basename "$bak")"
}

render_plist() {
  [[ -f "$TEMPLATE" ]] || { say "!! template missing: $TEMPLATE"; exit 1; }
  local env_block
  env_block=$(printf '    <key>UNBIEN_STATE_DIR</key>\n    <string>%s</string>\n    <key>RUST_LOG</key>\n    <string>info</string>' "$STATE_DIR")
  sed \
    -e "s|{RELAY_BIN}|$1|g" \
    -e "s|{PORT}|$PORT|g" \
    -e "s|{HOME}|$HOME|g" \
    -e "s|{LOG}|$LOG_PATH|g" \
    -e "s|{PI_AGENT_DIR}|${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}|g" \
    -e "s|{SESSION_DIR}|${PI_CODING_AGENT_SESSION_DIR:-}|g" \
    -e "s|{UNBIEN_ENV_PLIST}|$env_block|g" \
    "$TEMPLATE" >"$PLIST"
  note "plist rendered from extension/service-templates/"
}

# Keep whatever the running unit already runs (env snapshot, KeepAlive shape)
# and only move the binary. Least-surprise edit.
repoint_plist() {
  local target="$1"
  if ! plist_exists || [[ "$FROM_TEMPLATE" == "1" ]]; then
    render_plist "$target"
    return
  fi
  backup_plist
  /usr/libexec/PlistBuddy -c "Set :ProgramArguments:0 $target" "$PLIST"
  note "ProgramArguments[0] -> $target"
}

copy_binary() {
  local src="$1"
  [[ -x "$src" ]] || {
    say "!! no runnable relay binary at $src"
    say "   build one:  (cd relay && cargo build --release)   — needs Rust/cargo"
    exit 1
  }
  mkdir -p "$BIN_DIR"
  # install(1) replaces by copy, so this is safe while an old instance of the
  # same file is still running (unlike writing over an open inode).
  install -m 755 "$src" "$INSTALLED_BIN"
  note "$(version_of "$src") -> $INSTALLED_BIN"
}

build_repo_binary() {
  command -v cargo >/dev/null 2>&1 || {
    say "!! --build asked for a compile but cargo is not on PATH"
    say "   install Rust (https://rustup.rs) or drop --build and use the existing build"
    exit 1
  }
  say "==> cargo build --release (rusqlite's bundled SQLite: minutes)"
  (cd "$REPO_ROOT/relay" && cargo build --release)
}

# ── subcommands ────────────────────────────────────────────────────────────

cmd_status() {
  say "repo          $REPO_ROOT"
  say "repo build    $REPO_BIN  ($(version_of "$REPO_BIN"))"
  say "installed     $INSTALLED_BIN  ($(version_of "$INSTALLED_BIN"))"
  say "plist         $PLIST"
  if plist_exists; then
    say "runs          $(plist_binary || echo '(none)')"
    say "RunAtLoad     $(/usr/libexec/PlistBuddy -c 'Print :RunAtLoad' "$PLIST" 2>/dev/null || echo '(unset)')"
    say "KeepAlive     $(/usr/libexec/PlistBuddy -c 'Print :KeepAlive' "$PLIST" 2>/dev/null | tr '\n' ' ' || echo '(unset)')"
  else
    say "runs          (no plist installed)"
  fi
  if loaded; then
    say "launchd       loaded, pid $(service_pid)"
  else
    say "launchd       NOT loaded"
  fi
  local runs
  runs="$(plist_binary || true)"
  if [[ -n "$runs" && ! -x "$runs" ]]; then
    say ""
    say "!! the plist points at a binary that does not exist:"
    say "   $runs"
    say "   fix with: scripts/relay-service.sh repoint"
  fi
  if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    say "health        http://127.0.0.1:$PORT/health -> OK"
  else
    say "health        port $PORT not answering"
  fi
}

cmd_install() {
  say "==> install relay service (bin dir $BIN_DIR)"
  if [[ "$BUILD" == "1" ]]; then build_repo_binary; fi
  local src="$REPO_BIN"
  if [[ -n "$EXPLICIT_BIN" ]]; then src="$EXPLICIT_BIN"; fi
  copy_binary "$src"
  stop_service
  repoint_plist "$INSTALLED_BIN"
  start_service
  verify_running
  say "==> done. the service no longer depends on the repo path."
}

cmd_update() {
  say "==> update relay binary in place"
  if [[ "$BUILD" == "1" ]]; then build_repo_binary; fi
  local src="$REPO_BIN"
  if [[ -n "$EXPLICIT_BIN" ]]; then src="$EXPLICIT_BIN"; fi
  local before after
  before="$(version_of "$INSTALLED_BIN")"
  copy_binary "$src"
  after="$(version_of "$INSTALLED_BIN")"
  if [[ "$before" == "$after" ]]; then
    note "same version ($after) — restarting anyway, the bytes may differ"
  else
    note "$before -> $after"
  fi
  stop_service
  repoint_plist "$INSTALLED_BIN"
  start_service
  verify_running
}

cmd_repoint() {
  local target="$INSTALLED_BIN"
  if [[ -n "$EXPLICIT_BIN" ]]; then target="$EXPLICIT_BIN"; fi
  if [[ ! -x "$target" ]]; then
    say "!! target binary not runnable: $target"
    say "   run install first, or pass --path /abs/path/to/unbien-relay"
    exit 1
  fi
  say "==> repoint service -> $target"
  stop_service
  repoint_plist "$target"
  start_service
  verify_running
}

cmd_uninstall() {
  say "==> uninstall relay service"
  stop_service
  if plist_exists; then
    if [[ "$PURGE" == "1" ]]; then
      rm -f "$PLIST"
      note "plist deleted"
    else
      mv "$PLIST" "$PLIST.disabled"
      note "plist disabled (kept at $(basename "$PLIST").disabled); restore: mv it back and re-run install"
    fi
  fi
  if [[ "$PURGE" == "1" && -e "$INSTALLED_BIN" ]]; then
    rm -f "$INSTALLED_BIN"
    note "installed binary removed ($INSTALLED_BIN)"
  fi
  say "==> state left intact: $STATE_DIR (pairing.db, mesh.db, relay.log)"
}

usage() { sed -n '3,45p' "${BASH_SOURCE[0]}"; }

# ── arg parsing ────────────────────────────────────────────────────────────

CMD="${1:-status}"
shift || true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bin-dir) BIN_DIR="$2"; INSTALLED_BIN="$BIN_DIR/unbien-relay"; shift 2 ;;
    --path) EXPLICIT_BIN="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --build) BUILD=1; shift ;;
    --from-template) FROM_TEMPLATE=1; shift ;;
    --purge) PURGE=1; shift ;;
    --no-verify) VERIFY=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) say "unknown flag: $1"; usage; exit 2 ;;
  esac
done
LOG_PATH="$STATE_DIR/relay.log"

case "$CMD" in
  status) cmd_status ;;
  install) cmd_install ;;
  update) cmd_update ;;
  repoint) cmd_repoint ;;
  uninstall) cmd_uninstall ;;
  *) say "unknown command: $CMD"; usage; exit 2 ;;
esac
