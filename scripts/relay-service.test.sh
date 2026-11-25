#!/usr/bin/env bash
#
# relay-service.test.sh — exercise the STATE reporting in relay-service.sh.
#
# `status` is what you type when the relay seems down, so the first word it
# prints has to be true: running, stopped, starting, failed, not installed.
# Those words come out of launchctl/systemctl parsing, and that parsing is the
# fragile part — `launchctl print` nests a second `state = active` (the resource
# coalition's) under the job's own `state = running`, and reading the wrong one
# would call a dead relay "active". A test cannot drive the real service
# manager, so both backends are shimmed: a fake `launchctl`/`systemctl` on PATH
# emitting canned output, and HOME pointed at a temp root so no real plist,
# unit, installed binary or state dir is read or written.
#
# The health probe is pinned to a dead port (UNBIEN_RELAY_PORT) so the tests do
# not change shape depending on whether some relay happens to be up on :3000.
#
# Run: scripts/relay-service.test.sh
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/relay-service.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/relay-service-test-XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# Guard, not decoration: everything the script under test writes must land under
# the temp root, resolved for symlinks (/var ↔ /private/var on macOS).
case "$TMP" in
  /*) : ;;
  *) printf 'mktemp gave a relative path: %s\n' "$TMP" >&2; exit 1 ;;
esac
want="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
got="$(cd "$TMP" 2>/dev/null && pwd -P || true)"
[[ -n "$got" ]] || { printf 'mktemp path vanished: %s\n' "$TMP" >&2; exit 1; }
case "$got" in
  "$want"/*) : ;;
  *) printf 'refusing to write outside the temp root: %s\n' "$got" >&2; exit 1 ;;
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

# ── shims ───────────────────────────────────────────────────────────────────
FAKE_HOME="$TMP/home"
SHIM="$TMP/shim"
DEAD_PORT=59999
mkdir -p "$FAKE_HOME" "$SHIM"

# Fake launchctl. Only `print` is exercised by status. The dump mirrors the real
# one: one tab of indentation per level, and a nested `state = active` that must
# never be mistaken for the job's state.
cat >"$SHIM/launchctl" <<'SHIM'
#!/usr/bin/env bash
case "${1:-}" in
  print)
    case "${FAKE_LAUNCHD:-notloaded}" in
      notloaded) exit 1 ;;
      running)
        printf 'gui/501/com.georgeharker.unbien.relay = {\n'
        printf '\tactive count = 1\n'
        printf '\tstate = running\n'
        printf '\truns = 4\n'
        printf '\tpid = 4242\n'
        printf '\tlast exit code = 1\n'
        printf '\tresource coalition = {\n'
        printf '\t\tID = 55111\n'
        printf '\t\tstate = active\n'
        printf '\t}\n}\n'
        ;;
      stopped)
        printf 'gui/501/com.georgeharker.unbien.relay = {\n'
        printf '\tstate = not running\n'
        printf '\truns = 3\n'
        printf '\tlast exit code = 101\n'
        printf '\tresource coalition = {\n'
        printf '\t\tstate = active\n'
        printf '\t}\n}\n'
        ;;
      scheduled)
        printf 'gui/501/com.georgeharker.unbien.relay = {\n'
        printf '\tstate = spawn scheduled\n}\n'
        ;;
      disabled)
        printf 'gui/501/com.georgeharker.unbien.relay = {\n'
        printf '\tstate = disabled\n}\n'
        ;;
    esac
    ;;
  *) exit 0 ;;
esac
SHIM

# Fake systemctl --user. `show` answers with the properties status asks for;
# FAKE_SYSTEMD=empty simulates the user bus being unreachable (no output).
cat >"$SHIM/systemctl" <<'SHIM'
#!/usr/bin/env bash
if [[ "${1:-}" != "--user" ]]; then exit 2; fi
case "${2:-}" in
  show)
    case "${FAKE_SYSTEMD:-active}" in
      active)
        printf 'MainPID=4242\nActiveState=active\nSubState=running\n'
        printf 'Result=success\nNRestarts=2\n'
        printf 'ExecMainStartTimestamp=Mon 2026-01-05 09:00:00 UTC\n'
        ;;
      failed)
        printf 'MainPID=0\nActiveState=failed\nSubState=failed\n'
        printf 'Result=exit-code\nNRestarts=7\n'
        printf 'ExecMainStartTimestamp=Mon 2026-01-05 09:00:00 UTC\n'
        ;;
      stopped)
        printf 'MainPID=0\nActiveState=inactive\nSubState=dead\n'
        printf 'Result=success\nNRestarts=2\n'
        printf 'ExecMainStartTimestamp=Mon 2026-01-05 09:00:00 UTC\n'
        ;;
      starting)
        printf 'MainPID=0\nActiveState=activating\nSubState=start-pre\n'
        printf 'Result=success\nNRestarts=0\n'
        ;;
      empty) exit 0 ;;
    esac
    ;;
  is-enabled) printf 'enabled\n' ;;
  *) exit 0 ;;
esac
SHIM
chmod +x "$SHIM/launchctl" "$SHIM/systemctl"

# Run status under the fake HOME, shimmed backends, dead health port.
run_status() {
  env -i \
    HOME="$FAKE_HOME" \
    PATH="$SHIM:/usr/bin:/bin" \
    UNBIEN_RELAY_PORT="$DEAD_PORT" \
    FAKE_LAUNCHD="${FAKE_LAUNCHD:-}" \
    FAKE_SYSTEMD="${FAKE_SYSTEMD:-}" \
    bash "$SCRIPT" status "$@" 2>&1
}

# The headline line, without its key.
state_of() { sed -n 's/^state  *//p' <<<"$1" | head -1; }

want_state() { # out, expected prefix, label
  [[ "$(state_of "$1")" == "$2"* ]] && ok "$3" ||
    no "$3" "state line was '$(state_of "$1")', wanted '$2...'"
}
want_line() { # out, substring, label
  grep -qF -- "$2" <<<"$1" && ok "$3" || no "$3" "no line containing '$2'"
}
want_absent() {
  grep -qF -- "$2" <<<"$1" && no "$3" "unexpected '$2'" || ok "$3"
}

# ── launchd ─────────────────────────────────────────────────────────────────
PLIST="$FAKE_HOME/Library/LaunchAgents/com.georgeharker.unbien.relay.plist"
make_plist() {
  mkdir -p "$(dirname "$PLIST")"
  cat >"$PLIST" <<'PL'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>ProgramArguments</key><array><string>/usr/bin/true</string></array>
  <key>RunAtLoad</key><false/>
  <key>KeepAlive</key><dict>
    <key>Crashed</key><true/><key>SuccessfulExit</key><false/>
  </dict>
</dict></plist>
PL
}

printf 'launchd: no plist\n'
FAKE_LAUNCHD=notloaded out="$(run_status --backend launchd)"
want_state "$out" "not installed (no plist at" "no plist -> not installed"

printf 'launchd: plist installed, not loaded\n'
make_plist
FAKE_LAUNCHD=notloaded out="$(run_status --backend launchd)"
want_state "$out" "stopped (plist installed, not loaded" "not bootstrapped -> stopped"
want_line "$out" "launchctl bootstrap gui/" "tells you how to load it"

printf 'launchd: running\n'
FAKE_LAUNCHD=running out="$(run_status --backend launchd)"
want_state "$out" "running (pid 4242" "running -> running, with the pid"
want_absent "$out" "state         active" "nested coalition state=active is not the job state"
want_line "$out" "launchd: state=running, runs=4, last exit code=1" "launchd's own words, counters included"

printf 'launchd: loaded but no process\n'
FAKE_LAUNCHD=stopped out="$(run_status --backend launchd)"
want_state "$out" "stopped (loaded, no process, runs=3, last exit code=101)" \
  "not running -> stopped, with runs and exit code"
want_line "$out" "KeepAlive is on" "KeepAlive on + stopped says launchd should respawn it"

printf 'launchd: spawn scheduled / disabled\n'
FAKE_LAUNCHD=scheduled out="$(run_status --backend launchd)"
want_state "$out" "starting (launchd has it queued to spawn)" "spawn scheduled -> starting"
FAKE_LAUNCHD=disabled out="$(run_status --backend launchd)"
want_state "$out" "disabled (launchd refuses to start this label)" "disabled -> disabled"

# A running service on a dead port is its own failure mode: the process is up,
# but it is not the thing serving clients.
printf 'launchd: running but not serving the port\n'
FAKE_LAUNCHD=running out="$(run_status --backend launchd --port "$DEAD_PORT")"
want_line "$out" "the service is running but nothing answers on" "running + dead port is called out"

# ── systemd ─────────────────────────────────────────────────────────────────
UNIT="$FAKE_HOME/.config/systemd/user/unbien-relay.service"
make_unit() {
  mkdir -p "$(dirname "$UNIT")"
  cat >"$UNIT" <<'U'
[Unit]
Description=unbien relay
[Service]
ExecStart=/usr/bin/true
Restart=always
[Install]
WantedBy=default.target
U
}

printf 'systemd: no unit\n'
FAKE_SYSTEMD=active out="$(run_status --backend systemd)"
want_state "$out" "not installed (no unit at" "no unit -> not installed"

make_unit
printf 'systemd: active\n'
FAKE_SYSTEMD=active out="$(run_status --backend systemd)"
want_state "$out" "running (pid 4242" "active/running -> running, with the pid"
want_line "$out" "systemd: active/running, restarts=2, result=success" "systemd's own words, counters included"

printf 'systemd: failed\n'
FAKE_SYSTEMD=failed out="$(run_status --backend systemd)"
want_state "$out" "FAILED (systemd: failed, result=exit-code)" "failed -> FAILED"
want_line "$out" "reset-failed" "says the failure has to be reset, not just restarted"

printf 'systemd: inactive / activating\n'
FAKE_SYSTEMD=stopped out="$(run_status --backend systemd)"
want_state "$out" "stopped (systemd: dead, restarts=2" "inactive/dead -> stopped"
FAKE_SYSTEMD=starting out="$(run_status --backend systemd)"
want_state "$out" "starting (systemd: start-pre)" "activating -> starting"

printf 'systemd: no user bus\n'
FAKE_SYSTEMD=empty out="$(run_status --backend systemd)"
want_state "$out" "unknown (systemctl --user show answered nothing)" "empty show -> unknown"
want_line "$out" "user bus / D-Bus" "points at the user-bus explanation"

# ── verdict ─────────────────────────────────────────────────────────────────
printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" == "0" ]] || exit 1
