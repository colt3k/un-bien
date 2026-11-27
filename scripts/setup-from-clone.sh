#!/usr/bin/env bash
# One-shot setup for someone who cloned this repo and wants the browser client
# (web-client/) driving a Pi session on this machine, built from this checkout
# rather than installed from npm or crates.io.
#
#   scripts/setup-from-clone.sh                # set everything up, then serve the client
#   scripts/setup-from-clone.sh --dev          # ...serve it with Vite HMR (laptop, not phone)
#   scripts/setup-from-clone.sh --no-run       # set up only; print what to run next
#   scripts/setup-from-clone.sh --dry-run      # print every command, change nothing
#   scripts/setup-from-clone.sh doctor         # read-only: what is here, what is missing
#
# In order: workspace install → build → register THIS checkout as a Pi package →
# build + install the relay as an OS service → install the launcher daemon →
# start the web client. Re-runnable: each step checks before it writes, so
# running it twice is a no-op rather than a duplicate.
#
# What it deliberately does NOT do: pair a device. `/unbien pair` prints a
# single-use code inside a Pi session, and printing that code from a script
# would make it printable by something other than the human holding the phone.
#
# It also does not turn on TLS. `scripts/https.sh on` writes `tailscale serve`
# handlers, which is a decision about the public edge rather than a build step,
# so this script prints the pointer when a tailnet is up and leaves the choice
# to you. See docs/from-clone.md §6.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
WEB="$ROOT/web-client"
RELAY_PORT="${UNBIEN_RELAY_PORT:-3000}"

SERVE="preview" # preview = built dist/ on :4173; dev = Vite on :5173
RUN=1
DRY=0
SKIP_DEPS=0 SKIP_BUILD=0 SKIP_RELAY=0 SKIP_LAUNCHER=0 SKIP_PI=0
DOCTOR=0
TAILNET=0 # set by preflight; only used to decide whether to offer the TLS step

step() { printf '\n== %s\n' "$*"; }
ok()   { printf '   ok   %s\n' "$*"; }
warn() { printf '   warn %s\n' "$*"; }
bad()  { printf '   FAIL %s\n' "$*"; }
note() { printf '   ->   %s\n' "$*"; }

run() { # command and args; printed instead of executed under --dry-run
  if [[ "$DRY" == 1 ]]; then
    printf '   +    %s\n' "$*"
    return 0
  fi
  "$@"
}

usage() { sed -n '2,24p' "${BASH_SOURCE[0]}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dev) SERVE="dev" ;;
    --preview) SERVE="preview" ;;
    --no-run) RUN=0 ;;
    --dry-run) DRY=1 ;;
    --skip-deps) SKIP_DEPS=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --skip-relay) SKIP_RELAY=1 ;;
    --skip-launcher) SKIP_LAUNCHER=1 ;;
    --skip-pi) SKIP_PI=1 ;;
    doctor) DOCTOR=1 ;;
    -h | --help) usage; exit 0 ;;
    *) bad "unknown argument: $1"; usage; exit 2 ;;
  esac
  shift
done

# pnpm is frequently not on PATH on a mac. Resolve it the way CI does — the
# version pinned in the root package.json's packageManager field — so the
# lockfile never churns behind our backs.
pnpm_cmd() {
  if command -v pnpm >/dev/null 2>&1; then
    echo "pnpm"
  elif command -v corepack >/dev/null 2>&1; then
    echo "corepack pnpm"
  elif command -v npx >/dev/null 2>&1; then
    local want
    want="$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' "$ROOT/package.json" 2>/dev/null || true)"
    echo "npx --yes pnpm@${want:-latest}"
  else
    return 1
  fi
}

health_ok() {
  curl -fsS --max-time 3 "http://127.0.0.1:$RELAY_PORT/health" >/dev/null 2>&1
}

# What the launcher unit actually runs, read off disk. The install command's
# exit code is not the check: the unit is written BEFORE the launcher PACKAGE
# is fetched from the registry, so an offline run exits non-zero with a working
# daemon already in place.
LAUNCHER_LABEL="com.georgeharker.unbien.launcher"
LAUNCHER_UNIT="unbien-launcher.service"
launcher_state() {
  local target="" interp="" manager=""
  case "$(uname -s)" in
    Darwin)
      local plist="$HOME/Library/LaunchAgents/$LAUNCHER_LABEL.plist"
      if [[ ! -f "$plist" ]]; then
        warn "no launcher unit at $plist"
        return 1
      fi
      # ProgramArguments is `<node> <launcher.js> [args…]` — token 0 is the
      # runtime, and it is checked too, not just the entry file.
      interp="$(plutil -extract ProgramArguments.0 raw -o - "$plist" 2>/dev/null || true)"
      target="$(plutil -extract ProgramArguments.1 raw -o - "$plist" 2>/dev/null || true)"
      manager="launchd"
      ;;
    Linux)
      local unit="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$LAUNCHER_UNIT"
      if [[ ! -f "$unit" ]]; then
        warn "no launcher unit at $unit"
        return 1
      fi
      # ExecStart= is `<node> <launcher.js> [args…]`: the entry is token 2.
      local exec_line
      exec_line="$(sed -n 's/^ExecStart=//p' "$unit" | head -1)"
      interp="$(awk '{print $1}' <<<"$exec_line")"
      target="$(awk '{print $2}' <<<"$exec_line")"
      manager="systemd --user"
      ;;
    *)
      warn "launcher state: no check for $(uname -s)"
      return 1
      ;;
  esac
  printf '   unit   runs: %s\n' "${target:-?}"
  if [[ -n "${target:-}" && -f "$target" ]]; then
    ok "entry file exists"
  else
    bad "entry file is MISSING — that is a build problem, not a service problem"
    return 1
  fi

  # The INTERPRETER is the other half of the unit's command line, and it is the
  # half a package manager moves. `brew upgrade node` replaces
  # <prefix>/Cellar/node/<version>/bin/node and deletes the old version's
  # directory; a unit holding that path cannot start, launchd answers
  # EX_CONFIG (78), and launcher.log stays EMPTY. A daemon already running
  # survives the upgrade and dies at its next restart — a confusing day to be
  # debugging, and "entry file exists" says nothing about it.
  if [[ -z "$interp" ]]; then
    warn "unit command line is not readable — check it by hand"
  elif [[ ! -x "$interp" ]]; then
    bad "the unit's runtime no longer exists: $interp"
    note "a package-manager upgrade moved it. Point the unit at the stable alias:"
    note "  macOS:  /opt/homebrew/opt/node/bin/node   (Intel: /usr/local/opt/node/bin/node)"
    note "  Linux:  the ExecStart= line in systemd/user/$LAUNCHER_UNIT"
    return 1
  elif [[ "$interp" == *"/Cellar/"* ]]; then
    warn "unit bakes a versioned Cellar path: $interp"
    note "the next 'brew upgrade node' deletes it and the launcher stops coming back"
  else
    ok "runtime exists: $interp"
  fi

  if [[ "$manager" == "launchd" ]]; then
    local job="gui/$(id -u)/$LAUNCHER_LABEL" print
    print="$(launchctl print "$job" 2>/dev/null || true)"
    if [[ -z "$print" ]]; then
      warn "launchd does not have it loaded (start it, or log out/in)"
    elif grep -qE '^[[:space:]]*state = running' <<<"$print"; then
      ok "launchd has it running (pid $(grep -m1 -E '^[[:space:]]*pid = ' <<<"$print" | awk '{print $3}'))"
    else
      # Loaded-but-not-running is the shape of an unexecutable unit: launchd
      # keeps retrying, the daemon never logs a line.
      bad "launchd has it loaded but NOT running: $(grep -m1 -E '^[[:space:]]*state = ' <<<"$print" | awk -F' = ' '{print $2}')"
      grep -m1 -E '^[[:space:]]*last exit code' <<<"$print" | sed 's/^[[:space:]]*/   also: /'
      note "a non-zero exit with an EMPTY launcher.log means launchd could not exec the"
      note "runtime path above — fix that before reading the log for a cause"
    fi
  else
    if systemctl --user is-active --quiet "$LAUNCHER_UNIT" 2>/dev/null; then
      ok "systemd --user has it running"
    else
      warn "systemd --user is not running it: systemctl --user status $LAUNCHER_UNIT"
    fi
  fi
}

# Cargo is often present but NOT on PATH — a non-login shell (an IDE task, a
# cron job, this repo's own script run from a bare terminal) will not have
# rustup's shim dir. Probe the usual homes before declaring it missing, and put
# whichever one we found on PATH so relay-service.sh can call it by name.
find_cargo() {
  if command -v cargo >/dev/null 2>&1; then
    echo "cargo"
    return 0
  fi
  local c
  for c in "$HOME/.cargo/bin/cargo" "$HOME"/.rustup/toolchains/*/bin/cargo; do
    if [[ -x "$c" ]]; then
      echo "$c"
      return 0
    fi
  done
  return 1
}

# Copies of the extension installed OUTSIDE this checkout. They matter because
# the installer delegates: _delegateToGlobalCopy makes `install launcher` run
# the package manager's global copy of the extension, and that copy resolves the
# launcher entry from its OWN dist — so the unit ends up pointing at the global
# copy, not this one. Observed on a real machine: a stale fork build (0.25.19
# -fork.3, four months of fixes behind) was running as the launcher daemon
# because of a leftover global install nobody remembered.
global_extension_copies() {
  local -a roots=("$HOME/.pi/agent/npm/node_modules")
  if command -v npm >/dev/null 2>&1; then
    local r
    r="$(npm root -g 2>/dev/null || true)"
    [[ -n "$r" ]] && roots+=("$r")
  fi
  local root
  for root in "${roots[@]}"; do
    if [[ -d "$root/@geohar/un-bien" ]]; then
      printf '         %s\n' "$root/@geohar/un-bien"
    fi
  done
  return 0
}

# Is this checkout already registered as a Pi package? Pi stores local packages
# as a path relative to the settings file, so resolve before comparing. The
# published npm package is a DIFFERENT identity from this path — if both are
# present, both load, and it is luck which one's behaviour you see.
registered_in_pi() { # settings-file path
  node -e '
    const fs = require("fs"), path = require("path");
    const [file, want, probe] = process.argv.slice(1);
    let s;
    try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch { process.exit(2); }
    const base = path.dirname(file);
    const entries = (s.packages || []).map((e) => (typeof e === "string" ? e : e?.source ?? ""));
    const resolve = (e) =>
      /^(npm|git):/.test(e) || /^https?:|^ssh:/.test(e)
        ? e
        : path.resolve(base, e);
    const hit = entries.some((e) => resolve(e) === path.resolve(want));
    const npmDup = entries.some((e) => /@geohar\/un-bien$/.test(e) && e !== path.resolve(want));
    if (probe === "json") {
      process.stdout.write(JSON.stringify({ hit, npmDup, entries }));
      process.exit(0);
    }
    process.exit(hit ? 0 : 1);
  ' "$@"
}

# --- preflight ----------------------------------------------------------------
preflight() {
  local fail=0

  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -p 'process.versions.node.split(".")[0]')"
    if [[ "$major" -ge 20 ]]; then
      ok "node $(node --version)"
    else
      bad "node $(node --version) — this project needs 20 or newer"
      fail=1
    fi
  else
    bad "node not found — install Node 20+ (the repo is ESM + node: throughout)"
    fail=1
  fi

  local pm
  if pm="$(pnpm_cmd)"; then
    ok "pnpm via: $pm"
  else
    bad "no pnpm, corepack, or npx — one of them is required to install dependencies"
    fail=1
  fi

  if command -v pi >/dev/null 2>&1; then
    ok "pi found ($(command -v pi))"
  else
    bad "pi not found — this setup registers the extension with Pi; install Pi first"
    fail=1
  fi

  local cargo
  if cargo="$(find_cargo)"; then
    ok "cargo: $cargo — the relay will be built from relay/"
    if [[ "$cargo" != "cargo" ]]; then
      local cargodir
      cargodir="$(dirname "$cargo")"
      export PATH="$cargodir:$PATH"
      note "not on PATH — added $cargodir for this run (put it in your shell profile to make it stick)"
    fi
  elif [[ "$SKIP_RELAY" == 1 ]]; then
    warn "no cargo, and --skip-relay set — relay services not touched"
  else
    bad "cargo not found, and a relay is needed. Three ways, pick one:"
    note "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh    # rustup + stable toolchain"
    note "brew install ./HomebrewFormula/unbien-relay.rb                      # prebuilt formula"
    note "or run this with --skip-relay and start any relay yourself on :$RELAY_PORT"
    fail=1
  fi

  local copies
  copies="$(global_extension_copies)"
  if [[ -n "$copies" ]]; then
    warn "a copy of the extension is installed outside this checkout:"
    printf '%s\n' "$copies"
    warn "'install launcher/relay/cli' DELEGATES to that copy, so the service unit"
    warn "would run it rather than this checkout — a silent downgrade to whatever"
    warn "version is sitting in the global prefix."
    note "npm uninstall -g @geohar/un-bien      # then installs run from here"
  fi

  if command -v tmux >/dev/null 2>&1; then
    ok "tmux $(tmux -V 2>/dev/null) — needed to launch sessions from the phone"
  else
    warn "no tmux — pairing and watching work; launching a NEW session from the phone will not"
  fi

  case "$(uname -s)" in
    Darwin)
      ok "macOS — services go through launchd"
      ;;
    Linux)
      # systemd --user only answers inside a real user session (a login, or SSH
      # with lingering). Without it the install steps would fail cryptically.
      if command -v systemctl >/dev/null 2>&1 &&
        systemctl --user show-environment >/dev/null 2>&1; then
        ok "Linux — services go through systemd --user"
        if [[ "$(loginctl show-user "$(id -un)" --property=Linger --value 2>/dev/null)" != "yes" ]]; then
          warn "linger is off: the relay/launcher are down at boot and at logout"
          note "for an always-on box:  sudo loginctl enable-linger $(id -un)"
        fi
      else
        warn "no usable systemd user session (systemctl --user) — service steps skipped"
        note "log in graphically, or enable lingering, then re-run without --skip-relay"
        SKIP_RELAY=1
        SKIP_LAUNCHER=1
      fi
      ;;
    *)
      warn "neither macOS nor Linux: service steps skipped (see docs/install.md, Flow A)"
      SKIP_RELAY=1
      SKIP_LAUNCHER=1
      ;;
  esac

  if command -v tailscale >/dev/null 2>&1 && tailscale status --json >/dev/null 2>&1; then
    TAILNET=1
    ok "tailscale up — reachable from anywhere on your tailnet"
  else
    note "no tailnet, and that is fine: the phone reaches this machine by LAN address."
    note "a mesh VPN buys access from OUTSIDE your network — see docs/from-clone.md"
  fi

  return $fail
}

doctor() {
  echo "setup-from-clone doctor — $ROOT"
  preflight || true

  step "build outputs"
  for d in extension/dist launcher/dist web-client/dist; do
    [[ -d "$ROOT/$d" ]] && ok "$d present" || warn "$d missing (needs a build)"
  done
  [[ -f "$ROOT/relay/target/release/unbien-relay" ]] &&
    ok "relay/target/release/unbien-relay present" || warn "relay binary not built"

  step "Pi package registration"
  local settings="$HOME/.pi/agent/settings.json"
  if [[ -f "$settings" ]]; then
    registered_in_pi "$settings" "$ROOT/extension" json | node -e '
      let raw = "";
      process.stdin.on("data", (d) => (raw += d));
      process.stdin.on("end", () => {
        const r = JSON.parse(raw);
        console.log(r.hit ? "   ok   this checkout is registered" : "   warn this checkout is NOT registered (pi install ./extension)");
        if (r.npmDup) console.log("   warn an npm:@geohar/un-bien entry is ALSO present — that is the published package, not this fork");
        for (const e of r.entries) console.log("        " + e);
      });
    '
  else
    warn "no $settings"
  fi

  step "services"
  "$ROOT/scripts/relay-service.sh" status || true
  "$WEB/scripts/start.sh" relay status || true
  launcher_state || true

  # TLS is not part of the setup, so `doctor` says which side of that line you
  # are on rather than leaving it to be discovered from a broken connection.
  step "TLS edge (optional)"
  if command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1; then
    note "tailnet up. TLS is a deployment choice, not a setup step:"
    note "  $ROOT/scripts/https.sh status   what is served now, and the URLs to paste"
    note "  $ROOT/scripts/https.sh on       https page :443, wss relay :3443"
  else
    note "no tailnet — plain http on the LAN is a supported setup (docs/from-clone.md §6)"
  fi
}

if [[ "$DOCTOR" == 1 ]]; then
  doctor
  exit 0
fi

step "preflight"
if ! preflight; then
  echo
  bad "fix the above and re-run. --skip-relay / --skip-launcher skip those steps."
  exit 1
fi

# --- 1. workspace dependencies ------------------------------------------------
step "1/5  workspace dependencies"
if [[ "$SKIP_DEPS" == 1 ]]; then
  warn "skipped (--skip-deps)"
else
  read -r -a PM <<<"$(pnpm_cmd)"
  run "${PM[@]}" -C "$ROOT" install --frozen-lockfile
fi

# --- 2. build -----------------------------------------------------------------
# dist/ is gitignored everywhere, and the extension manifest points at ./dist —
# so an unbuilt checkout registers fine and contributes ZERO extensions. Build
# before registering, not after.
step "2/5  build (extension, launcher, unbien-cli, web client)"
if [[ "$SKIP_BUILD" == 1 ]]; then
  warn "skipped (--skip-build)"
else
  read -r -a PM <<<"$(pnpm_cmd)"
  run "${PM[@]}" -C "$ROOT" build
  run "${PM[@]}" -C "$WEB" build
fi

# --- 3. register this checkout with Pi ----------------------------------------
step "3/5  register this checkout as a Pi package"
if [[ "$SKIP_PI" == 1 ]]; then
  warn "skipped (--skip-pi)"
else
  settings="$HOME/.pi/agent/settings.json"
  if [[ -f "$settings" ]] && registered_in_pi "$settings" "$ROOT/extension"; then
    ok "already registered — nothing to do"
  else
    run pi install "$ROOT/extension"
  fi
  if [[ "$DRY" == 0 && -f "$settings" ]] && registered_in_pi "$settings" "$ROOT/extension" json |
    grep -q '"npmDup":true'; then
    warn "an 'npm:@geohar/un-bien' entry is still in settings.json."
    warn "Pi treats the registry package and this path as separate packages: BOTH load."
    note "pi remove npm:@geohar/un-bien"
  fi
fi

# --- 4. the relay, as an OS service -------------------------------------------
# The binary goes to ~/.cargo/bin, NOT relay/target/release: that is where the
# extension's findRelayBinary() looks, and build output is not a path worth
# pointing a service at (cargo clean empties it; moving the clone breaks it).
step "4/5  relay service"
if [[ "$SKIP_RELAY" == 1 ]]; then
  warn "skipped (--skip-relay, or no usable service manager)"
else
  if [[ -f "$ROOT/relay/target/release/unbien-relay" ]]; then
    run "$ROOT/scripts/relay-service.sh" install
  else
    run "$ROOT/scripts/relay-service.sh" install --build
  fi
  if [[ "$DRY" == 0 ]]; then
    for _ in 1 2 3 4 5 6 7 8 9 10; do health_ok && break; sleep 0.5; done
    health_ok && ok "relay answering on :$RELAY_PORT" ||
      { bad "relay is not answering on :$RELAY_PORT"; "$ROOT/scripts/relay-service.sh" status; exit 1; }
  fi
fi

# --- 5. the launcher daemon ---------------------------------------------------
# findLauncherScript()/findRemotePiScript() resolve from the extension's own
# dist/, so this points the service at this checkout: one build, no drift
# between what Pi loads and what the daemon runs. The unit embeds the node and
# PATH of THIS shell, which is why it matters that you run this script from a
# normal login shell, not a sparse one.
step "5/5  launcher daemon"
if [[ "$SKIP_LAUNCHER" == 1 ]]; then
  warn "skipped (--skip-launcher or non-macOS)"
elif [[ ! -f "$ROOT/extension/dist/index.js" ]]; then
  bad "extension/dist/index.js missing — run without --skip-build"
  exit 1
else
  if ! run node "$ROOT/extension/dist/index.js" install launcher; then
    warn "the install command exited non-zero. The unit is written BEFORE the"
    warn "launcher package is fetched from the registry, so check the state:"
  fi
  if [[ "$DRY" == 0 ]]; then
    launcher_state || { bad "the launcher is not usable"; exit 1; }
  fi
fi

# --- done ---------------------------------------------------------------------
step "ready"
echo "   Pair from a Pi session on this machine:"
echo "       /unbien pair"
echo "   It prints a single-use code; the browser drawer takes that code plus the"
echo "   relay URL shown below. Then the session's rooms appear in the client."
echo
echo "   Restart the client any time with:"
echo "       web-client/scripts/start.sh $SERVE"
echo "   Read-only health check:"
echo "       web-client/scripts/start.sh doctor"

# Offer TLS only when the thing that serves it can actually work. The script
# still does not run it: writing tailscale serve handlers is a decision about
# the public edge, and `on` is one command away for whoever wants it.
if [[ "$TAILNET" == 1 ]]; then
  serve_port=4173
  if [[ "$SERVE" == "dev" ]]; then serve_port=5173; fi
  echo
  echo "   On a tailnet, https is one command (deliberately not run for you):"
  echo "       scripts/https.sh on        # https page :443, wss relay :3443"
  echo "       scripts/https.sh status    # the exact URLs to paste"
  echo "   Until then the page is http://…:$serve_port, and QR pairing is a photo"
  echo "   upload — the camera API only exists on a secure page."
fi

if [[ "$RUN" == 1 && "$DRY" == 0 ]]; then
  step "starting the web client ($SERVE) — Ctrl-C to stop"
  exec "$WEB/scripts/start.sh" "$SERVE"
elif [[ "$DRY" == 1 ]]; then
  echo
  echo "   (--dry-run: nothing above was executed)"
fi
