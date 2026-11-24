# Install

For anyone who cloned **this** repo and wants the setup it is written for: the
browser client driving a pi session on this machine, over a relay you host, with
everything built from this checkout.

```
browser / phone ──► relay (:3000) ──► launcher ──► pi session
```

Three pieces run, and all three come from this checkout: the **relay** (an OS
service), the **launcher** daemon (starts sessions on this machine), and the
**browser client**. Pairing is what connects your phone to them.

---

## Prerequisites

- **Node 20+** (`node --version`) and **pi** installed.
- **Rust** (`cargo`) — the setup compiles the relay from `relay/`.
- **tmux** — without it pairing and watching work, but launching a *new* session
  from the phone will not.
- **pnpm** is nice to have; the script falls back to `corepack` or `npx` with the
  version pinned in `package.json`, so the lockfile never churns.
- **Tailscale is optional.** The phone can reach this machine by LAN address —
  a `<machine>.local` name works, and `allowedHosts` already includes `.local`
  because mDNS names are not IPs. A mesh VPN only buys you access from outside
  your network.

Run the setup from a **normal login shell**, not a sparse one: the service units
embed the `node` and `PATH` of the shell that installs them.

On **Linux**, the services are `systemd --user` units, which need a real user
session. For an always-on box, turn on lingering first
(`sudo loginctl enable-linger $(id -un)`); the setup checks this and tells you.

---

## Run it

```sh
./scripts/setup-from-clone.sh
```

Five steps, each of which checks before it writes — running it twice is a no-op,
not a duplicate:

1. `pnpm install` across the workspace.
2. Build `extension/dist`, `launcher/dist`, `web-client/dist`.
3. `pi install ./extension` — **this checkout becomes the package pi loads.**
4. Relay: `cargo build --release`, copied to `~/.cargo/bin/unbien-relay`, then
   registered as a service — `~/Library/LaunchAgents/com.georgeharker.unbien.relay.plist`
   on macOS, `~/.config/systemd/user/unbien-relay.service` on Linux. The unit
   points at that copy, never at `relay/target/`.
5. Launcher daemon: `node extension/dist/index.js install launcher`, which runs
   this checkout's `dist/` — one build, so pi and the daemon can never drift
   apart.

Then it serves the built client on **`http://localhost:4173`**.

```sh
./scripts/setup-from-clone.sh --dev        # Vite on :5173 instead (laptop only)
./scripts/setup-from-clone.sh --no-run     # set up, don't serve
./scripts/setup-from-clone.sh --dry-run    # print the plan, change nothing
./scripts/setup-from-clone.sh doctor       # read-only state report, safe any time
```

Use the served `:4173` build on a phone, not `--dev`: the dev server's HMR socket
drops on a network blip and full-reloads the page, which looks exactly like
losing the session.

Two things the script will not do:

- **Pair a device.** `/unbien pair` prints a single-use code inside a pi session;
  a script printing that code is a script deciding who gets a device.
- **Choose your relay URL or launch directories.** Only you know which folders
  the phone may start sessions in.

If `doctor` reports a copy of the extension installed outside this checkout,
remove it (`npm uninstall -g @geohar/un-bien`). The install commands delegate to
a global copy, so the services would run that instead — a silent downgrade to
whatever version is sitting in the global prefix.

---

## Pair the phone

1. Open the client — `http://localhost:4173` here, or
   `http://<machine>.local:4173` / your tailnet name from the phone.
2. In a pi session **on this machine**: `/unbien pair` → a single-use code and QR.
3. In the client's **Pair a machine** drawer: paste the code (or scan the QR),
   relay URL `http://<this-machine>:3000`, name the device, tap Pair.
4. Sessions and machines appear in the group. Tap a session to attach.

The code is single-use and short-lived — re-run `/unbien pair` if it expires.
Do not port-forward `:3000` to the internet; the relay sees routed plaintext.
Pairing over plain `http` on a LAN is fine (Ed25519 does not need a secure
context).

---

## Which folders the phone may start sessions in

`~/.pi/agent/extensions/un-bien.json`:

```json
{
  "relay": "http://<this-machine>:3000",
  "defaults": { "allow_remote_launch": true },
  "launch": { "dirs": ["/Users/you/dev/myapps"] }
}
```

`dirs` is an allow-list (nested paths count) and it is **consulted fresh per
launch request** — the file is re-read each time, so edits apply without
restarting pi. Absent or `"*"` means **any folder is launchable**, which is the
default; narrow it rather than relying on nothing being set. Whether launch is
enabled at all is the per-folder `allow_remote_launch` flag — `dirs` narrows
where within that.

---

## Prove it works

```sh
curl -s localhost:3000/health            # relay up
pi list                                  # extension resolves into this checkout
./scripts/relay-service.sh status        # which relay binary the service runs
./scripts/setup-from-clone.sh doctor     # ports, relay, URLs, what is missing
```

---

## Day to day

```sh
web-client/scripts/start.sh preview      # serve the built client (:4173)
web-client/scripts/start.sh dev          # Vite with HMR (:5173)
web-client/scripts/start.sh doctor       # ports + relay + URLs
./scripts/relay-service.sh status        # service state and version
```

Logs live in `~/.local/state/un-bien/` — `relay.log`, `launcher.log`; on Linux
also `journalctl --user -u unbien-relay.service`.

**Update:** `git pull && ./scripts/setup-from-clone.sh`. It rebuilds and repoints
the services at the new build — the relay binary in `~/.cargo/bin` is replaced,
and the previous service unit is kept as a `.bak-*` copy beside the new one.

**Who is paired:** `./scripts/revoke-peer.sh audit` lists every device that can
see this machine's rooms, with the evidence for whether each key can ever connect
again. Revoking is a real security action, so it gates on that rather than on how
old the row looks.

---

## Reading further

| Want | Read |
| --- | --- |
| What each setup step is for, fixing a step by hand | [`docs/from-clone.md`](docs/from-clone.md) |
| Using the client day to day | [`web-client/USAGE.md`](web-client/USAGE.md) |
| Every config key and environment variable | [`docs/env-vars.md`](docs/env-vars.md) |
| Pairing, privacy and the trust model | [`docs/privacy.md`](docs/privacy.md) |
| A second machine's relay (federation) | [`docs/relay-peering.md`](docs/relay-peering.md) |
