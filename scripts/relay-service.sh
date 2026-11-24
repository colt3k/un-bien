#!/usr/bin/env bash
#
# relay-service.sh — own the unbien-relay user service (macOS launchd,
# Linux systemd-user).
#
# WHY THIS EXISTS
# The service must not run out of `relay/target/release/`. That directory is
# build output: `cargo clean` empties it, and moving the repo invalidates the
# absolute path baked into the plist/unit. The service manager resolves that
# path fresh on every (re)start, so the day you move or clean the repo, the
# relay silently stops coming back (KeepAlive can't restart what it cannot
# find, and a reboot makes it permanent). So: copy the binary to a stable path
# OUTSIDE the repo, and point the service at that. `status` flags a unit whose
# ExecStart / ProgramArguments[0] is missing — or is inside the repo.
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
#   macOS    ~/Library/LaunchAgents/com.georgeharker.unbien.relay.plist
#   Linux    ~/.config/systemd/user/unbien-relay.service   (systemd --user)
#   binary   <bin-dir>/unbien-relay          (default ~/.cargo/bin)
# It never writes inside the repo, and it never deletes your state
# (~/.local/state/un-bien: pairing.db, mesh.db, relay.log).
#
# LINUX: LINGER, OR THE RELAY IS NOT ALWAYS-ON
# A systemd USER service only runs while that user has a session. On a headless
# box that means it is down from boot until someone logs in, and down at every
# logout — which defeats the point of a home hub. Turn lingering on once:
#   sudo loginctl enable-linger "$USER"
# `status` reports the current state and `install` says so when it is off.
# Logs go to the journal, not relay.log: journalctl --user -u unbien-relay.
#
# Note on the extension's own installer: `unbien install relay` regenerates the
# SAME plist from extension/service-templates/relay-launchd.plist.template and
# may upgrade the binary from crates.io. Running this script after that is
# fine — it re-points and restarts; running it before is what keeps a repo move
# from taking the relay down.
#
# Usage:
#   scripts/relay-service.sh status                    # what runs, from where
#   scripts/relay-service.sh install                   # copy repo build, write unit, start
#   scripts/relay-service.sh install --build           # cargo build --release first (needs cargo)
#   scripts/relay-service.sh update                    # re-copy the repo build + restart
#   scripts/relay-service.sh repoint                   # unit -> installed binary (after a repo move)
#   scripts/relay-service.sh repoint --path /abs/path  # unit -> an explicit binary
#   scripts/relay-service.sh unit                      # PRINT the service definition it would write
#   scripts/relay-service.sh uninstall                 # stop; keep unit as .disabled (restorable)
#   scripts/relay-service.sh uninstall --purge         # stop; delete unit + installed binary
#
# Flags:
#   --bin-dir DIR     where the stable binary lives   (default ~/.cargo/bin)
#   --path PATH       explicit binary for repoint/install/unit
#   --port N          UNBIEN_RELAY_PORT for a freshly rendered unit (default 3000)
#   --build           cargo build --release before copying
#   --from-template   regenerate the plist from the repo template instead of
#                     editing the existing one in place (env is re-snapshotted)
#   --backend B       launchd | systemd (default: launchd on macOS, systemd on
#                     Linux). Use --backend systemd unit to read the Linux unit
#                     on any machine.
#   --purge           with uninstall: remove unit + installed binary
#   --no-verify       skip the /health wait
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_BIN="$REPO_ROOT/relay/target/release/unbien-relay"
TEMPLATE="$REPO_ROOT/extension/service-templates/relay-launchd.plist.template"
UNIT_TEMPLATE="$REPO_ROOT/extension/service-templates/relay-systemd.service.template"

LABEL="com.georgeharker.unbien.relay"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

# Linux uses systemd --user; macOS uses launchd. Same policy either way: the
# unit points at the installed binary, never at the repo build.
SYSTEMD_UNIT="unbien-relay.service"
SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="$SYSTEMD_DIR/$SYSTEMD_UNIT"

case "$(uname -s)" in
  Darwin) BACKEND_DEFAULT="launchd" ;;
  Linux) BACKEND_DEFAULT="systemd" ;;
  *) BACKEND_DEFAULT="" ;;
esac
BACKEND="${UNBIEN_SERVICE_BACKEND:-$BACKEND_DEFAULT}"

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

usage() { sed -n '3,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d'; }

require_backend() {
  case "$BACKEND" in
    launchd | systemd) return 0 ;;
    "")
      say "!! unsupported OS ($(uname -s)) — this script drives launchd or systemd-user."
      say "   Pass --backend launchd|systemd if you know better, or see docs/install.md."
      exit 1
      ;;
    *)
      say "!! --backend must be launchd or systemd (got: $BACKEND)"
      exit 1
      ;;
  esac
}

# ── helpers ────────────────────────────────────────────────────────────────

say() { printf '%s\n' "$*"; }
note() { printf '  %s\n' "$*"; }

plist_exists() { [[ -f "$PLIST" ]]; }

# ProgramArguments[0] of the loaded plist — the path launchd will exec.
plist_binary() {
  plist_exists || return 1
  /usr/libexec/PlistBuddy -c "Print :ProgramArguments:0" "$PLIST" 2>/dev/null
}

unit_exists() { [[ -f "$UNIT_PATH" ]]; }

have_systemctl() { command -v systemctl >/dev/null 2>&1; }

# ExecStart of the unit file as written (not what systemd has loaded).
unit_exec() {
  unit_exists || return 1
  sed -n 's/^ExecStart=//p' "$UNIT_PATH" | head -1
}

# systemd-user services die with the user's session unless lingering is on.
linger_state() {
  command -v loginctl >/dev/null 2>&1 || { printf '%s' "(no loginctl)"; return; }
  local v
  v="$(loginctl show-user "$(id -un)" --property=Linger --value 2>/dev/null || true)"
  printf '%s' "${v:-unknown}"
}

linger_note() {
  [[ "$(linger_state)" == "yes" ]] && {
    note "linger on — the unit starts at boot and survives logout"
    return 0
  }
  note "linger is OFF: this unit is down from boot until you log in, and down"
  note "  again at every logout. For an always-on box:"
  note "    sudo loginctl enable-linger $(id -un)"
}

# systemctl --user needs a user bus: a login session (graphical, or SSH with
# lingering) and XDG_RUNTIME_DIR. Worth saying, because the failure message is
# cryptic and the fix is not a package install.
systemd_bus_hint() {
  note "if that mentioned the user bus / D-Bus: systemd --user needs a login"
  note "  session and XDG_RUNTIME_DIR (usually /run/user/$(id -u))."
  note "  Check: systemctl --user show-environment; on a headless box enable linger."
}

loaded() {
  case "$BACKEND" in
    systemd) have_systemctl && systemctl --user is-active --quiet "$SYSTEMD_UNIT" 2>/dev/null ;;
    *) launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 ;;
  esac
}

service_pid() {
  case "$BACKEND" in
    systemd)
      local p
      have_systemctl || return 0
      p="$(systemctl --user show "$SYSTEMD_UNIT" --property=MainPID --value 2>/dev/null || true)"
      [[ -n "$p" && "$p" != "0" ]] && printf '%s' "$p"
      ;;
    *)
      launchctl print "$DOMAIN/$LABEL" 2>/dev/null | awk '/^[[:space:]]*pid = /{print $3; exit}'
      ;;
  esac
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
    case "$BACKEND" in
      systemd) say "==> systemctl --user stop $SYSTEMD_UNIT" ;;
      *) say "==> launchctl bootout $DOMAIN/$LABEL" ;;
    esac
    if [[ "$BACKEND" == "systemd" ]]; then
      systemctl --user stop "$SYSTEMD_UNIT" 2>/dev/null || true
    else
      launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || launchctl bootout "$DOMAIN" "$PLIST" 2>/dev/null || true
    fi
    for _ in 1 2 3 4 5 6 7 8 9 10; do loaded || break; sleep 0.5; done
  else
    say "==> service not loaded (ok)"
  fi
}

start_service() {
  case "$BACKEND" in
    systemd)
      unit_exists || { say "!! no unit at $UNIT_PATH — run install first"; exit 1; }
      mkdir -p "$STATE_DIR"
      say "==> systemctl --user daemon-reload && enable --now $SYSTEMD_UNIT"
      systemctl --user daemon-reload 2>/dev/null || { systemd_bus_hint; exit 1; }
      systemctl --user enable --now "$SYSTEMD_UNIT" 2>/dev/null ||
        { systemd_bus_hint; say "!! could not enable/start — inspect with: systemctl --user status $SYSTEMD_UNIT"; exit 1; }
      # enable --now leaves a RUNNING unit untouched, so after update/repoint the
      # old binary would still be in memory. restart makes it exec the new one.
      systemctl --user restart "$SYSTEMD_UNIT" 2>/dev/null || true
      linger_note
      ;;
    *)
      [[ -f "$PLIST" ]] || { say "!! no plist at $PLIST — run install first"; exit 1; }
      mkdir -p "$(dirname "$LOG_PATH")"
      say "==> launchctl bootstrap $DOMAIN $(basename "$PLIST")"
      launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null ||
        launchctl load "$PLIST" 2>/dev/null ||
        { say "!! bootstrap failed — inspect with: launchctl print $DOMAIN/$LABEL"; exit 1; }
      # kickstart -k makes launchd exec the new binary even if a stale instance of
      # the same label lingers in the domain.
      launchctl kickstart -k "$DOMAIN/$LABEL" 2>/dev/null || true
      ;;
  esac
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
    if [[ "$BACKEND" == "systemd" ]]; then
      say "   check: systemctl --user status $SYSTEMD_UNIT"
      say "   and:   journalctl --user -u $SYSTEMD_UNIT -n 40"
    else
      say "   check: launchctl print $DOMAIN/$LABEL | head -30"
      say "   and:   tail -40 $LOG_PATH"
    fi
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
  local env_block out="${2:-$PLIST}"
  env_block=$(printf '    <key>UNBIEN_STATE_DIR</key>\n    <string>%s</string>\n    <key>RUST_LOG</key>\n    <string>info</string>' "$STATE_DIR")
  sed \
    -e "s|{RELAY_BIN}|$1|g" \
    -e "s|{PORT}|$PORT|g" \
    -e "s|{HOME}|$HOME|g" \
    -e "s|{LOG}|$LOG_PATH|g" \
    -e "s|{PI_AGENT_DIR}|${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}|g" \
    -e "s|{SESSION_DIR}|${PI_CODING_AGENT_SESSION_DIR:-}|g" \
    -e "s|{UNBIEN_ENV_PLIST}|$env_block|g" \
    "$TEMPLATE" >"$out"
  [[ "$out" == "$PLIST" ]] && note "plist rendered from extension/service-templates/"
}

# systemd equivalent. Rendered with awk, not sed: the env block is multi-line
# (a literal newline inside s|a|b| is an error in BSD sed, and splitting a {r
# file} block across -e arguments only works in GNU sed), and placeholder values
# are spliced by exact substring so a path containing & or \ cannot corrupt the
# result the way a sed/awk replacement string would.
render_unit() {
  [[ -f "$UNIT_TEMPLATE" ]] || { say "!! template missing: $UNIT_TEMPLATE"; exit 1; }
  local out="${2:-$UNIT_PATH}"
  awk \
    -v bin="$1" -v port="$PORT" -v home="$HOME" \
    -v agent="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}" \
    -v session="${PI_CODING_AGENT_SESSION_DIR:-}" \
    -v state="$STATE_DIR" '
    function repl(line, tok, val,   i, out) {
      out = ""
      while ((i = index(line, tok)) > 0) {
        out = out substr(line, 1, i - 1) val
        line = substr(line, i + length(tok))
      }
      return out line
    }
    {
      line = $0
      line = repl(line, "{RELAY_BIN}", bin)
      line = repl(line, "{PORT}", port)
      line = repl(line, "{HOME}", home)
      line = repl(line, "{PI_AGENT_DIR}", agent)
      line = repl(line, "{SESSION_DIR}", session)
      if (index(line, "{UNBIEN_ENV_SYSTEMD}") > 0) {
        printf "Environment=\"UNBIEN_STATE_DIR=%s\"\n", state
        printf "Environment=\"RUST_LOG=info\"\n"
        next
      }
      print line
    }' "$UNIT_TEMPLATE" >"$out"
  [[ "$out" == "$UNIT_PATH" ]] &&
    note "unit rendered from extension/service-templates/"
}

# Keep whatever the running unit already runs (env snapshot, KeepAlive shape)
# and only move the binary. Least-surprise edit. systemd has no such edit — its
# unit is generated, so it is re-rendered.
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

repoint_service() {
  case "$BACKEND" in
    systemd)
      mkdir -p "$SYSTEMD_DIR"
      render_unit "$1"
      systemctl --user daemon-reload 2>/dev/null || systemd_bus_hint
      ;;
    *) repoint_plist "$1" ;;
  esac
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
  say "backend       $BACKEND"
  local runs=""
  if [[ "$BACKEND" == "systemd" ]]; then
    say "unit          $UNIT_PATH"
    if unit_exists; then
      runs="$(unit_exec || true)"
      say "ExecStart     ${runs:-(none)}"
      say "Restart       $(sed -n 's/^Restart=//p' "$UNIT_PATH" | head -1)"
    else
      say "ExecStart     (no unit installed)"
    fi
    say "enabled       $(have_systemctl && systemctl --user is-enabled "$SYSTEMD_UNIT" 2>/dev/null || echo '(no systemctl, or no unit)')"
    if loaded; then
      say "systemd       active, pid $(service_pid || true)"
    else
      say "systemd       not active"
    fi
    say "linger        $(linger_state) — without 'yes' the unit is down at boot and at logout"
    say "logs          journalctl --user -u $SYSTEMD_UNIT -n 50"
  else
    say "plist         $PLIST"
    if plist_exists; then
      runs="$(plist_binary || true)"
      say "runs          ${runs:-(none)}"
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
  fi
  if [[ -n "$runs" && ! -x "$runs" ]]; then
    say ""
    say "!! the service points at a binary that does not exist:"
    say "   $runs"
    say "   fix with: scripts/relay-service.sh repoint"
  elif [[ "$runs" == "$REPO_ROOT/"* ]]; then
    say ""
    say "!! the service runs a binary from INSIDE the repo:"
    say "   $runs"
    say "   cargo clean empties that directory and moving the repo invalidates it;"
    say "   the service manager resolves the path on every restart, so the relay"
    say "   silently stops coming back. Fix with:"
    say "   scripts/relay-service.sh install      # copies it to $BIN_DIR"
  fi
  if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    say "health        http://127.0.0.1:$PORT/health -> OK"
  else
    say "health        port $PORT not answering"
  fi
}

cmd_install() {
  say "==> install relay service ($BACKEND, bin dir $BIN_DIR)"
  if [[ "$BUILD" == "1" ]]; then build_repo_binary; fi
  local src="$REPO_BIN"
  if [[ -n "$EXPLICIT_BIN" ]]; then src="$EXPLICIT_BIN"; fi
  copy_binary "$src"
  stop_service
  repoint_service "$INSTALLED_BIN"
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
  repoint_service "$INSTALLED_BIN"
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
  repoint_service "$target"
  start_service
  verify_running
}

# Print what would be written, write nothing. Useful for reviewing the unit
# (and for reading the Linux unit on a macOS machine).
cmd_unit() {
  local target="$INSTALLED_BIN"
  if [[ -n "$EXPLICIT_BIN" ]]; then target="$EXPLICIT_BIN"; fi
  if [[ "$BACKEND" == "systemd" ]]; then
    render_unit "$target" /dev/stdout
  else
    render_plist "$target" /dev/stdout
  fi
}

cmd_uninstall() {
  say "==> uninstall relay service"
  stop_service
  if [[ "$BACKEND" == "systemd" ]]; then
    systemctl --user disable "$SYSTEMD_UNIT" 2>/dev/null || true
    if unit_exists; then
      if [[ "$PURGE" == "1" ]]; then
        rm -f "$UNIT_PATH"
        note "unit deleted"
      else
        mv "$UNIT_PATH" "$UNIT_PATH.disabled"
        note "unit disabled (kept at $(basename "$UNIT_PATH").disabled); restore: mv it back and re-run install"
      fi
    fi
    systemctl --user daemon-reload 2>/dev/null || true
  elif plist_exists; then
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
    --backend) BACKEND="$2"; shift 2 ;;
    --purge) PURGE=1; shift ;;
    --no-verify) VERIFY=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) say "unknown flag: $1"; usage; exit 2 ;;
  esac
done
LOG_PATH="$STATE_DIR/relay.log"
require_backend

case "$CMD" in
  status) cmd_status ;;
  install) cmd_install ;;
  update) cmd_update ;;
  repoint) cmd_repoint ;;
  unit) cmd_unit ;;
  uninstall) cmd_uninstall ;;
  *) say "unknown command: $CMD"; usage; exit 2 ;;
esac
