#!/bin/sh
# https.sh — put TLS in front of the web client and the relay.
#
# WHY THIS EXISTS
# The browser only exposes the camera (`navigator.mediaDevices.getUserMedia`)
# to a secure context. Over plain http on a LAN or tailnet host the API does
# not exist at all — not denied, absent — which is why pairing-by-scan is a
# photo upload today (see web-client/README.md, "Pairing by QR scan"). An
# https page is a secure context, so the live viewfinder needs this first.
#
# It is a deployment change before it is a client change, and it comes as a
# pair: an https page also cannot open a plain `ws://` socket (mixed content,
# blocked before any of our code runs), so the relay has to be reachable over
# wss too. The relay itself never speaks TLS — `relay/src/peering.rs:74` says
# termination is the public edge's job — so both fronts live here.
#
# WHY tailscale serve, AND WHY THAT BEATS A SELF-SIGNED CERT
# `tailscale serve` terminates TLS with the node's own `.ts.net` certificate,
# which every device already on the tailnet trusts. No warning page, no CA to
# install on the phone, and it proxies WebSocket upgrades (verified: the client
# completes hello -> challenge -> auth over wss through it). A self-signed cert
# means a warning on every device and a root CA to install and then fully trust
# on each phone — on iOS that is a profile install plus the Certificate Trust
# Settings toggle that nobody finds. The `mkcert` mode below is the fallback
# for when you are off the tailnet and cannot use serve.
#
# THE PORT IS A CONTRACT
# RELAY_TLS_PORT here must equal RELAY_TLS_PORT in
# web-client/src/framing.ts, which is what an https page defaults the relay box
# to. Change one without the other and the client dials a port nothing is
# listening on, with a failure message that says nothing about why.
#
# Usage:
#   scripts/https.sh status                 what is served, and the URLs to open
#   scripts/https.sh on [--dev] [--yes]     serve the client on 443, the relay on 3443
#   scripts/https.sh off [--yes]            remove the handlers this script adds
#   scripts/https.sh mkcert [--serve]       fallback: local CA cert + socat relay front
#
# Every mode accepts --dry-run: print what would run, change nothing.
# ASCII-only on purpose: /bin/sh is bash 3.2 (see build-iphone.sh).

set -eu

SCRIPT_DIR=$( # shellcheck disable=SC1007
  CDPATH= cd -- "$(dirname -- "$0")" && pwd
)
ROOT="$SCRIPT_DIR/.."

# What is served where. The targets are the plain-HTTP ports the rest of the
# repo already uses; the TLS ports are what the tailnet sees.
WEB_TLS_PORT="${UNBIEN_WEB_TLS_PORT:-443}"
WEB_TARGET="${UNBIEN_WEB_TARGET:-4173}" # vite preview (dist/) — the phone path
DEV_TLS_PORT="${UNBIEN_DEV_TLS_PORT:-5174}"
DEV_TARGET="${UNBIEN_DEV_TARGET:-5173}" # vite dev — HMR, and its own reload traps
RELAY_TLS_PORT="${UNBIEN_RELAY_TLS_PORT:-3443}" # keep in sync with framing.ts
RELAY_TARGET="${UNBIEN_RELAY_TARGET:-3000}"

TLS_DIR="$ROOT/.tls"

MODE=""
WITH_DEV=0
ASSUME_YES=0
DRY_RUN=0
DO_SERVE=0

for arg in "$@"; do
  case "$arg" in
  status | on | off | mkcert) MODE="$arg" ;;
  --dev) WITH_DEV=1 ;;
  --serve) DO_SERVE=1 ;;
  --yes | -y) ASSUME_YES=1 ;;
  --dry-run) DRY_RUN=1 ;;
  *)
    echo "usage: scripts/https.sh <status|on|off|mkcert> [--dev] [--yes] [--serve] [--dry-run]" >&2
    exit 2
    ;;
  esac
done
[ -n "$MODE" ] || MODE="status"

run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '  would run: %s\n' "$*"
    return 0
  fi
  "$@"
}

node_json() { # node_json <json> <function body over `o>; must return a string>
  node -e '
    const j = JSON.parse(process.argv[1] || "{}")
    const out = (function (o) { '"$2"' })(j)
    process.stdout.write(out == null ? "" : String(out))
  ' "$1" 2>/dev/null || true
}

tailnet_host() {
  tailscale status --json 2>/dev/null | node -e '
    let s = ""
    process.stdin.on("data", (d) => (s += d))
    process.stdin.on("end", () => {
      try {
        const d = JSON.parse(s).Self.DNSName || ""
        process.stdout.write(d.replace(/\.$/, ""))
      } catch { process.stdout.write("") }
    })
  '
}

serve_json() { tailscale serve status --json 2>/dev/null || echo "{}"; }

listening() { # listening <port> -> 0 when something is listening
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

require_tailscale() {
  if ! command -v tailscale >/dev/null 2>&1; then
    echo "tailscale is not installed. Use 'scripts/https.sh mkcert' instead." >&2
    exit 1
  fi
  if ! tailscale status >/dev/null 2>&1; then
    echo "tailscale is installed but not up. Bring the tailnet up first:" >&2
    echo "  tailscale up" >&2
    exit 1
  fi
}

# ── status ──────────────────────────────────────────────────────────────────

do_status() {
  host=$(tailnet_host)
  [ -n "$host" ] || host="<this node>"
  echo "tailnet name: $host"
  echo ""
  echo "what tailscale serve is doing right now:"
  tailscale serve status 2>&1 || echo "  (nothing)"
  echo ""
  echo "URLs this deployment would use:"
  # 443 is the scheme's own port: a browser URL omits it, so the printed URL
  # should be the one you can paste.
  web_url="https://$host"
  [ "$WEB_TLS_PORT" = "443" ] || web_url="https://$host:$WEB_TLS_PORT"
  echo "  web    $web_url/    -> 127.0.0.1:$WEB_TARGET $(listening "$WEB_TARGET" && echo "(up)" || echo "(NOT running)")"
  echo "  relay  wss://$host:$RELAY_TLS_PORT/    -> 127.0.0.1:$RELAY_TARGET $(listening "$RELAY_TARGET" && echo "(up)" || echo "(NOT running)")"
  echo ""
  echo "The web client defaults its relay box to the second URL when the page is"
  echo "https, because an https page cannot open a ws:// socket at all."
}

# ── on ──────────────────────────────────────────────────────────────────────

# Refuse to silently replace someone else's handler on the port we want.
confirm_overwrite() {
  before=$(serve_json)
  taken=$(node_json "$before" '
    const w = o.Web || {}
    for (const k of Object.keys(w)) {
      const h = (w[k].Handlers || {})["/"]
      if (h && h.Proxy) return k + " " + h.Proxy
    }
    return ""')
  [ -n "$taken" ] || return 0
  case "$taken" in
    *"127.0.0.1:$WEB_TARGET") return 0 ;; # already ours
  esac
  echo "port $WEB_TLS_PORT already serves something else:"
  echo "  $taken"
  echo "  (nothing is listening there right now, but it was configured)"
  [ "$ASSUME_YES" = 1 ] || {
    printf 'replace it with 127.0.0.1:%s? [y/N] ' "$WEB_TARGET"
    read -r answer
    case "$answer" in y | Y | yes | YES) : ;; *) echo "aborted."; exit 1 ;; esac
  }
}

do_on() {
  require_tailscale
  host=$(tailnet_host)
  listening "$WEB_TARGET" ||
    echo "note: nothing is listening on :$WEB_TARGET — start the client first (scripts/start.sh preview)."
  listening "$RELAY_TARGET" ||
    echo "note: nothing is listening on :$RELAY_TARGET — the relay front will answer 502 until it is up."
  confirm_overwrite

  echo "serving the web client: https://$host:$WEB_TLS_PORT/ -> 127.0.0.1:$WEB_TARGET"
  run tailscale serve --bg --https="$WEB_TLS_PORT" "$WEB_TARGET"
  echo ""
  echo "serving the relay:      wss://$host:$RELAY_TLS_PORT/ -> 127.0.0.1:$RELAY_TARGET"
  run tailscale serve --bg --https="$RELAY_TLS_PORT" "$RELAY_TARGET"

  if [ "$WITH_DEV" = 1 ]; then
    echo ""
    echo "serving the dev server: https://$host:$DEV_TLS_PORT/ -> 127.0.0.1:$DEV_TARGET"
    echo "  (dev over https works, and HMR becomes wss. It also still full-reloads"
    echo "   every connected client whenever a non-HMR-boundary file is saved —"
    echo "   which is how a phone test of the camera ends up losing the photo.)"
    run tailscale serve --bg --https="$DEV_TLS_PORT" "$DEV_TARGET"
  fi

  echo ""
  echo "done. Open https://$host:$WEB_TLS_PORT/ on the phone."
  echo "Undo with: scripts/https.sh off"
}

# ── off ─────────────────────────────────────────────────────────────────────

do_off() {
  require_tailscale
  # Targeted removal, not `serve reset`: reset would also delete handlers this
  # script never made (this node had one pointing at 127.0.0.1:8787 before).
  for port in "$WEB_TLS_PORT" "$RELAY_TLS_PORT" "$DEV_TLS_PORT"; do
    echo "removing https://...:$port"
    run tailscale serve --https="$port" off
  done
  echo ""
  echo "remaining:"
  tailscale serve status 2>&1 || true
}

# ── mkcert (fallback, off the tailnet) ──────────────────────────────────────

do_mkcert() {
  command -v mkcert >/dev/null 2>&1 || {
    echo "mkcert is not installed (brew install mkcert)." >&2
    exit 1
  }
  host=$(tailnet_host)
  names="localhost 127.0.0.1"
  lan=$(ipconfig getifaddr en0 2>/dev/null || true)
  [ -n "$lan" ] && names="$names $lan"
  [ -n "$host" ] && names="$names $host"

  if [ ! -f "$(mkcert -CAROOT)/rootCA.pem" ]; then
    echo "creating and trusting the local CA (this prompts for your keychain password)"
    run mkcert -install
  fi

  echo "minting a cert for: $names"
  if [ "$DRY_RUN" = 1 ]; then
    echo "  would run: mkcert -cert-file $TLS_DIR/dev.crt -key-file $TLS_DIR/dev.key $names"
  else
    mkdir -p "$TLS_DIR"
    mkcert -cert-file "$TLS_DIR/dev.crt" -key-file "$TLS_DIR/dev.key" $names >/dev/null
  fi

  echo ""
  echo "serve the client over https with it:"
  echo "  UNBIEN_TLS_KEY=$TLS_DIR/dev.key UNBIEN_TLS_CERT=$TLS_DIR/dev.crt \\"
  echo "    pnpm -C web-client preview --host"
  echo "  (vite.config.ts reads those two variables; without them it stays http.)"
  echo ""
  echo "and the relay front, because an https page cannot open ws://:"
  echo "  socat OPENSSL-LISTEN:$RELAY_TLS_PORT,cert=$TLS_DIR/dev.crt,key=$TLS_DIR/dev.key,verify=0,fork,reuseaddr TCP:127.0.0.1:$RELAY_TARGET"
  if [ "$DO_SERVE" = 1 ]; then
    echo ""
    echo "starting the relay front in the background..."
    run sh -c "nohup socat OPENSSL-LISTEN:$RELAY_TLS_PORT,cert=$TLS_DIR/dev.crt,key=$TLS_DIR/dev.key,verify=0,fork,reuseaddr TCP:127.0.0.1:$RELAY_TARGET >$TLS_DIR/socat.log 2>&1 &"
    echo "  log: $TLS_DIR/socat.log"
  fi
  echo ""
  echo "The part that costs: every OTHER device must trust the CA, or it shows a"
  echo "warning page instead of the app. The CA is $(mkcert -CAROOT)/rootCA.pem."
  echo "  iOS:     open it on the device -> Install Profile, then Settings >"
  echo "           General > About > Certificate Trust Settings > enable full trust."
  echo "  Android: Settings > Security > Install a certificate > CA certificate."
  echo "This is why 'scripts/https.sh on' (tailscale serve) is the default path:"
  echo "a .ts.net cert is already trusted by everything on the tailnet."
}

case "$MODE" in
status) do_status ;;
on) do_on ;;
off) do_off ;;
mkcert) do_mkcert ;;
esac
