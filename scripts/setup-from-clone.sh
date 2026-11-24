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
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
WEB="$ROOT/web-client"
RELAY_PORT="${UNBIEN_RELAY_PORT:-3000}"

SERVE="preview" # preview = built dist/ on :4173; dev = Vite on :5173
RUN=1
DRY=0
SKIP_DEPS=0 SKIP_BUILD=0 SKIP_RELAY=0 SKIP_LAUNCHER=0 SKIP_PI=0
DOCTOR=0

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

usage() { sed -n '2,20p' "${BASH_SOURCE[0]}"; }

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
      export PATH="$(dirname "$cargo"):$PATH"
      note "not on PATH — added $(dirname "$cargo") for this run (put it in your shell profile to make it stick)"
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

  if command -v tmux >/dev/null 2>&1; then
    ok "tmux $(tmux -V 2>/dev/null) — needed to launch sessions from the phone"
  else
    warn "no tmux — pairing and watching work; launching a NEW session from the phone will not"
  fi

  if [[ "$(uname)" == "Darwin" ]]; then
    ok "macOS — services go through launchd"
  else
    warn "not macOS: the launchd steps are skipped. Use the systemd-user flow in docs/install.md (Flow A)"
    SKIP_RELAY=1
    SKIP_LAUNCHER=1
  fi

  if command -v tailscale >/dev/null 2>&1 && tailscale status --json >/dev/null 2>&1; then
    ok "tailscale up — a phone on your tailnet can reach this machine"
  else
    warn "no tailnet here — the client is only reachable on the LAN (or localhost)"
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
  warn "skipped (--skip-relay or non-macOS)"
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
  run node "$ROOT/extension/dist/index.js" install launcher
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

if [[ "$RUN" == 1 && "$DRY" == 0 ]]; then
  step "starting the web client ($SERVE) — Ctrl-C to stop"
  exec "$WEB/scripts/start.sh" "$SERVE"
elif [[ "$DRY" == 1 ]]; then
  echo
  echo "   (--dry-run: nothing above was executed)"
fi
