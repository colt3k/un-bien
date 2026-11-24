# Running Un Bien on mybox, driven from an Android phone over Tailscale

> Notes about the author's setup (a Tailscale-linked Mac and an Android phone) —
> kept for continuity, not product documentation, and deliberately not in the
> Quarto site list. Hostnames, tailnet names, addresses and room ids here are
> placeholders: `mybox.my-tailnet.ts.net` means "your node, your tailnet".

Plan written 2026-11-16 after reviewing the repo at `cdee234` and the state of this
machine. Every "current state" claim below was checked on the box, not assumed.

---

## Status after building the web spike (same day)

A fourth path now exists and is the one worth pushing on: **D — web client served
over the tailnet, added to the Android home screen.** It lives in `web-client/`;
`web-client/README.md` records what was proven end to end (pair → discovery →
replay → live turn → steer/queue/abort → dialog → relay-key-rotation refusal)
against the **real Rust relay**, and what is still missing.

Consequences for the phases below:

- The relay is built (`relay/target/release/unbien-relay`, v0.8.9) and runs. The
  web client connected to it from Chrome over `ws://localhost:3000`, and the dev
  server binds the tailnet (`http://mybox.my-tailnet.ts.net:5173`).
- **Phase A (Termux CLI) is still the fastest way to get a real session driven
  today**, because the pi extension is not installed on this Mac yet — nothing in
  the repo has been pointed at a live pi in this exercise. The web client was
  driven by a scripted machine double, not by pi.
- The one hard part the spike exposed is the transcript fold's row identity: pi's
  `RowBoundsStore` (entry ids + parent links + content hashes) and the derived-path
  membership gate. A third client cannot fake those; it has to port them, or
  accept duplicated/dropped rows. See `web-client/test/corpus.test.ts`.

---

## 0. The finding that shapes everything

**There is no Android client.** `app/` is SwiftUI, targets iOS 18 / macOS 15
(`app/project.yml`), and `APPSTORE.md` is iOS-only. Nothing in the repo builds an
APK, and there is no web/PWA client. Grep for "android" in the tree turns up one
docs line ("Tailscale on iOS/Android works fine") and an image-MIME comment.

So "Android phone drives Pi on this Mac" means one of:

| Path | What runs on the phone | What you get | Cost |
| --- | --- | --- | --- |
| **A — Termux + `unbien` CLI** *(recommended)* | Node TUI (`@geohar/unbien-cli`) | session picker, live transcript with pi's own tool cards / diffs / thinking blocks, steering, tool approvals (`ask` flows), model switching, `create-session` via the launcher. Own Ed25519 device key → revocable on its own. | Termux install, ~10 min, untested upstream |
| **B — SSH from Termux, CLI runs on the Mac** | ssh client only | same CLI, zero Android-side Node | sshd on the Mac is **off** today (nothing listening on 22); the "device" is then the Mac itself, so SSH key becomes the security boundary |
| **C — the iPad (`ipad157`, offline 33 d)** | native app from the App Store | the real UX: styled transcripts, launch sheet, fork/branch, image attachments | not Android; App Store install, zero build |

I'd do **A** now, and **C** opportunistically since the iPad is already in your
tailnet. **B** is the escape hatch if the Termux install fights you.

Everything below Phases 1–4 is identical whichever phone path you pick — the
phone is just a client of the relay.

---

## 1. Architecture as built (what we're standing up)

```
Pixel 8 Pro                          mybox (Mac17,6, this box, 100.64.0.2)
┌────────────────┐   Tailscale/WireGuard   ┌──────────────────────────────────┐
│ unbien CLI     │ ────── ws ────────────► │ unbien-relay :3000 (Rust)        │
│ (Termux)       │                         │  dumb router: rooms + presence   │
└────────────────┘                         │        + mesh/pairing SQLite     │
                                           │            ▲                     │
                                           │            │ ws (localhost path)│
                                           │  pi + @geohar/un-bien extension  │
                                           │  unbien-launcher (LaunchAgent)   │
                                           │    └─ tmux: one window per Pi ───┘
                                           └──────────────────────────────────┘
```

Three trust notes that matter for the design (`docs/rpc-envelope.md`,
`relay/README.md`):

- The relay never decodes the outer `ct` and doesn't log traffic, **but the relay
  operator controls the binary and host** — so the network layer is the privacy
  boundary. Tailnet-only is exactly the right posture; never port-forward 3000.
- Auth is Ed25519 challenge-response per connection; routing to a Pi room
  requires that machine's signed peer list to include your device key. An
  unpaired tailnet node connecting to your relay gets `unknown_peer`.
- The phone holds **no model credentials**. Provider auth stays on the Mac.

---

## 2. What this machine already has

| Thing | State |
| --- | --- |
| macOS | 26.6.2, arm64 (`Mac17,6` — a MacBook Pro, not a mini) |
| Tailscale | 1.104.6, GUI app (`/Applications/Tailscale.app`) + CLI, tailnet `my-tailnet.ts.net`, this node = `mybox` / `100.64.0.2` |
| Tailnet peers | `m3` (macOS, up), `ipad157` (iOS, **offline 33 d**), `pixel-8-pro` (android, **offline 16 d**) |
| pi | 1.5.2 at `/opt/homebrew/bin/pi`, providers already working (`strata-local` / `iq3_s`) |
| un-bien extension | **not installed** (`pi list` shows 4 other packages) |
| node / npm | node v26.13.1 ✓, `pnpm` **not** installed |
| tmux | ✓ `/opt/homebrew/bin/tmux` (launcher's default backend) |
| Rust | rustup installed (brew, keg-only) with a `stable-aarch64-apple-darwin` toolchain, but **no `cargo` on PATH** and no `~/.cargo/bin` |
| Port 3000 | free |
| launchd agents | no un-bien ones; state root `~/.local/state/un-bien` does not exist yet |
| Xcode + xcodegen | present, in case you later want the macOS app |

You don't need this clone to run anything — published packages are the supported
route. Keep the clone for reading protocol docs.

---

## Phase 0 — Tailscale plumbing (5 min, do first)

1. **Pixel**: install/enable Tailscale (it's already a known node, just offline).
   Then the Android gotcha people miss: **Android VPNs are per-app by default**.
   In the Tailscale app set it to cover *all apps*, or explicitly add Termux —
   otherwise Termux gets no `100.64/10` route and every `unbien` dial times out
   with a useless error.
2. **Mac**: confirm the phone can reach it once the phone is online:
   ```bash
   tailscale ping pixel-8-pro          # from the Mac
   # from Termux: ping -c3 100.64.0.2
   ```
3. **ACLs**: default policy allows everything, so probably nothing to do. If you
   have a custom ACL file, make sure a rule allows `pixel-8-pro` →
   `100.64.0.2:3000`.
4. **Pick the relay URL** and use it *everywhere*, verbatim:
   ```
   http://mybox.my-tailnet.ts.net:3000
   ```
   MagicDNS name beats the IP (survives tailnet-IP reassignment). Fallback if
   MagicDNS resolution of your own name misbehaves locally:
   `http://100.64.0.2:3000`. Note from `unbien-cli/README.md`: a relay
   listening on several addresses is still **one** relay with one identity and
   one pairing registry — mixing the two URLs later is harmless, and pairing
   records your device key, not the URL.
5. **Keep the Mac reachable.** It's a laptop: `sleep 0` on AC (good), but a
   closed lid still clamshell-sleeps, and `sleep 1` on battery. If you want it
   reachable with the lid shut on a desk:
   ```bash
   sudo pmset -c disablesleep 1     # tradeoff: heat in a bag; revert with `pmset -c disablesleep 0`
   ```
   Honest caveat: a laptop is a flaky always-on hub. If you want real always-on,
   move the relay + launcher to `m3` later and just point both clients at it.

---

## Phase 1 — Relay on mybox (10–20 min, mostly Rust compile)

`cargo` isn't on PATH here, so wire rustup's shims up first:

```bash
export PATH="/opt/homebrew/opt/rustup/bin:$PATH"   # brew's rustup is keg-only
cargo install un-bien-relay                        # binary → ~/.cargo/bin/unbien-relay
```

Skip `brew install georgeharker/un-bien/unbien-relay` for now: the tap formula
(`HomebrewFormula/unbien-relay.rb`) is pinned to crate **0.7.3** while this repo's
relay is **0.8.9** and the extension you'll install is **0.25.9**. Skew is
probably tolerated (the relay README claims 0.3+ handles old extension errors)
but it's an avoidable variable. If you prefer `brew services` for the
keep-alive, do it as a second step once a cargo-built relay is proven.

**Harden the bind before you install the service.** Default is `0.0.0.0` = every
interface, which on a laptop means every Wi-Fi network you join. The relay
supports an explicit bind (`relay/src/main.rs:86`, names resolved once at
startup):

```bash
export UNBIEN_RELAY_BIND="mybox.my-tailnet.ts.net,localhost"
export UNBIEN_STATE_DIR="$HOME/.local/state/un-bien"
export RUST_LOG=info
```

Test in the foreground first:

```bash
~/.cargo/bin/unbien-relay
# in another shell:
curl -s http://127.0.0.1:3000/health
curl -s http://100.64.0.2:3000/health
lsof -nP -iTCP:3000 -sTCP:LISTEN    # must show 127.0.0.1 + the tailnet IP, NOT 0.0.0.0
```

Then make it a login service — the extension's installer does the plist for you,
**and it snapshots your current shell env into the unit**, which is exactly why
you export the three variables *before* running it:

```bash
# inside a pi session on this Mac:
/unbien install relay
# verify what got baked in:
plutil -p ~/Library/LaunchAgents/com.georgeharker.unbien.relay.plist
curl -s http://100.64.0.2:3000/health
```

Two macOS caveats worth knowing now rather than debugging at 23:00:
`~/Library/LaunchAgents` means **runs while you're logged in** — logging out
kills it, and it doesn't start before login. For a personal workstation that's
usually fine; for a true headless box you'd want a LaunchDaemon (or `m3`).

State to back up: `~/.local/state/un-bien/mesh.db` (+ `pairing.db` if present)
and `relay.log`. Stop the service before copying DBs.

---

## Phase 2 — Extension on the Mac (2 min)

```bash
pi install npm:@geohar/un-bien
```

Restart any open pi terminals (this session included — the extension loads into
every pi process from now on, and it adds mesh tools plus `/unbien`). Then in a
terminal in a directory you actually want to work in:

```text
/unbien set-relay http://mybox.my-tailnet.ts.net:3000
/unbien            # first-run wizard: agent name, session, relay on this terminal
```

Identity: the machine's long-term Ed25519 key goes in the **macOS Keychain** via
`@napi-rs/keyring` (`extension/src/pairing/storage.ts`). A Keychain lock is
handled by retries + fail-loud rather than silently minting a new identity —
that's deliberate (there was a "phantom identity" incident behind it), so if you
ever see an identity error, fix the Keychain rather than deleting state.

Verify: `/unbien` status line should show `🟢 relay` (or `🟡 relay waiting for
pairing` until Phase 4).

---

## Phase 3 — Launcher, so the phone can start sessions (5 min)

Skip if you're happy always starting `pi` yourself on the Mac first. tmux is
already installed, so the default backend works.

```bash
npm install -g @geohar/un-bien      # puts `unbien-admin` on PATH
unbien-admin install launcher       # LaunchAgent, pins the node binary + PATH
```

Remote launch is opt-in per directory (`<cwd>/.pi/un-bien/config.json` →
`allow_remote_launch: true`) or machine-wide:

```bash
python3 - <<'EOF'
import json, pathlib
p = pathlib.Path.home()/".pi/extensions/un-bien.json"
d = json.loads(p.read_text()) if p.exists() else {}
d.setdefault("defaults", {})["allow_remote_launch"] = True
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text(json.dumps(d, indent=2) + "\n")
EOF
```

Launched Pi windows live in one shared `un-bien` tmux session — you can watch
them with `tmux attach -t un-bien`. Maintenance note from `docs/install.md`:
the unit pins `process.execPath` and snapshots `PATH`/`UNBIEN_*` at install
time, so **re-run `unbien-admin install launcher` after a node upgrade or any
config/env change**.

---

## Phase 4 — Pair the Pixel (10 min)

### On the phone

```bash
pkg update
pkg install nodejs            # node ≥20 required; Termux ships a recent one
npm install -g --ignore-scripts @geohar/unbien-cli
unbien --version
```

Native-module risk is low and understood: the only hard native dep in the tree
is `@napi-rs/keyring`, which publishes **no Android prebuild** and has no
install script — npm skips the platform-mismatched optional deps, the binding
fails to load at runtime, and the code falls back to a file identity
(`_nativeBindingUnavailable()` → `identity.storage: "file"`). The CLI's *own*
device key is file-based regardless:
`~/.local/state/un-bien/proxy-identity.json` (0600, mode-forced). pi's own deps
(`pi-tui`, `quickjs-wasi`, `photon-node`) are JS/WASM, so nothing needs
node-gyp. **This path is not covered by upstream tests** — if npm does fail,
fall back to Phase 4-B.

Keep Termux alive and reachable:

```bash
pkg install termux-api
termux-wake-lock                       # else Android reaps it mid-turn
```
plus Settings → Apps → Termux → Battery: unrestricted. Run `unbien` inside
Termux's own tmux so an app switch doesn't drop the socket.

### Pair it

On the Mac, in the pi session you want to drive (`/unbien pair` prints a QR **and
the copy-paste URI** — `extension/src/commands/pairing.ts:129`, "camera-less
devices"):

```text
/unbien pair
```

AirDrop/clip the `unbien://pair?t=…&epk=…&n=…&rm=…` string to the phone. The
invite deliberately carries **no relay URL**, so pass it explicitly:

```bash
UNBIEN_RELAY=http://mybox.my-tailnet.ts.net:3000 unbien pair '<pasted-uri>'
unbien                 # session picker → attach
```

The handshake is awaited: `pair_request` → `pair_ok`/`pair_error`, token is
single-use and short-lived, nothing is persisted on refusal. Reading failures:
`unknown_peer` = not paired; `[sessions] none open` = paired, but no live pi
rooms (start one, or use `create-session`).

Driving from the phone:

```bash
unbien --list                                   # sessions on every paired machine
unbien connect --session-name mytask            # attach by name
unbien create-session --dir ~/dev/foo --name fix-login   # needs Phase 3 launcher
```

### 4-B. Fallback: SSH, CLI on the Mac

`sshd` is currently off (nothing on :22). Enable System Settings → General →
Sharing → Remote Login (or check whether your Tailscale client supports
`tailscale set --ssh=true` — the GUI app variant varies; verify rather than
assume, and prefer plain key auth + `tailscale lockdown`). Then from Termux:

```bash
ssh -o ProxyCommand=none mybox   # over the tailnet
unbien pair '<uri>' && unbien    # CLI on the Mac, talking to localhost relay
```

You lose per-device revocation (the phone's trust = your SSH key) and gain a
terminal-multiplexing layer. Screen width over SSH is fine; do it in landscape.

---

## Phase 5 — Verify (run all of these once)

| # | Check | Expected |
| --- | --- | --- |
| 1 | `curl -s http://127.0.0.1:3000/health` from the Mac | 200 / OK |
| 2 | `lsof -nP -iTCP:3000 -sTCP:LISTEN` | `127.0.0.1` + tailnet IP only, **not** `*:3000` |
| 3 | `curl -s http://mybox.my-tailnet.ts.net:3000/health` **from Termux** | OK → tailnet + ACLs + bind all proven from the phone side |
| 4 | `/unbien` in a pi session | `🟢 relay`, `📱 <shortid>` once the phone connects |
| 5 | `unbien --list` on the phone | that session listed |
| 6 | attach, send a prompt, watch a tool run | live transcript + tool card, `approve/deny` prompt appears |
| 7 | kill all local pi, then `unbien create-session --dir …` | new Pi in `tmux ls` → `un-bien`, attaches from the phone |
| 8 | reboot the Mac, stay logged in | relay + launcher come back, phone reconnects with no re-pairing |
| 9 | `/unbien revoke <shortid>`, then `unbien` on the phone | refused (`unknown_peer`) — revocation actually works |

---

## Phase 6 — Day-2 operations

- **Logs**: `~/.local/state/un-bien/relay.log`, `…/launcher.log`.
- **Devices**: `/unbien devices`, `/unbien revoke <shortid>` (or `unbien-admin
  devices|revoke`). Phone and CLI pair as separate owner devices, so losing one
  doesn't imply re-pairing the other.
- **Upgrades**: `pi update` for pi; `pi install npm:@geohar/un-bien` re-run for
  the extension; `cargo install un-bien-relay` for the relay; then re-run
  `/unbien install relay|launcher` so the env snapshot and binary path stay
  fresh. Upgrade the CLI on the phone with `npm install -g --ignore-scripts
  @geohar/unbien-cli@latest`.
- **Backups**: `mesh.db` + `pairing.db` (stop the relay first). Losing them just
  means clients re-publish membership at the next mutation — pairing on the
  phone, however, lives in the machine's state too, so expect to re-pair.
- **Never** forward 3000 to the internet. If you ever must, put TLS in front
  (Caddy `reverse_proxy localhost:3000`) and switch both clients to `https://`.

---

## Risks and honest caveats

| Risk | Severity | Mitigation |
| --- | --- | --- |
| No Android app — the polished UI doesn't exist for your phone | Blocker, by design | Path A (CLI) now, Path C (iPad) for the real UX |
| Android per-app VPN: Termux not routed through Tailscale | High, silent | Tailscale "all apps", or add Termux; prove with check #3 |
| Termux + native modules untested upstream | Medium | `--ignore-scripts`; keyring prebuilds are skipped by design and the code has a file-identity fallback; if it breaks → Path B |
| MacBook sleeps / lid closes → phone can't reach anything | High | AC power, `pmset -c disablesleep 1`, or move relay+launcher to `m3` |
| LaunchAgent dies on logout, absent before first login | Medium | stay logged in; or LaunchDaemon/`m3` |
| Default bind `0.0.0.0` exposes 3000 on every Wi-Fi network | Medium | `UNBIEN_RELAY_BIND` lockdown (Phase 1) |
| Brew tap relay 0.7.3 vs extension 0.25.9 / crate 0.8.9 | Low-Med | cargo-install the current crate; treat brew as a later packaging choice |
| Phone TUI on a small screen: long transcripts get cramped | Low | landscape, larger font, tmux scrollback; the app (iPad) is better for reading |
| Relay sees routed plaintext in principle | Accepted | It's your process, your box, your tailnet — that's the documented model |

## Rollback

```bash
unbien-admin uninstall all          # removes relay + launcher services
pi remove npm:@geohar/un-bien       # out of pi's settings
rm -rf ~/.local/state/un-bien       # machine identity + pairing (phone will need re-pairing)
```
On the phone: `npm uninstall -g @geohar/unbien-cli` and delete
`~/.local/state/un-bien/proxy-identity.json` in Termux.

## Time budget

~45 min to check #6, if Tailscale on the Pixel comes up cleanly. The Rust
compile (10–20 min) is the longest single item and can run in the background
while you set up the phone.
