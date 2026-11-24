# Install

Short version of "clone it, run it, use it". The long, exhaustive reference is
[`docs/install.md`](docs/install.md); this fork's own path is
[`docs/from-clone.md`](docs/from-clone.md).

```
browser / phone ──► relay (:3000) ──► launcher ──► pi session
```

Three pieces run: a **relay** you host (an OS service), a **launcher** daemon
(starts sessions on this machine), and the **browser client**. Pairing is what
connects your phone to them.

---

## Prerequisites

- **Node 20+** (`node --version`) and **pi** installed.
- For the clone route: **Rust** (`rustc`) to build the relay, and **pnpm** if you
  have it — the script falls back to `corepack`/`npx` and the version pinned in
  `package.json`.
- Your phone on the same network. Tailscale makes this nicer but is **not
  required**: a LAN `.local` name works, and `allowedHosts` already includes
  `.local` because mDNS names are not IPs.

---

## A. Published packages — the simple route

```sh
cargo install un-bien-relay          # the relay
pi install npm:@geohar/un-bien       # the extension, into pi's extension dir
```

Then `unbien-relay`, and `/unbien pair` inside a pi session. Simple and stable —
but it is the upstream build, so **it will not contain anything in this fork**.

## B. This clone — what the fork is for

```sh
git clone <this repo> && cd <this repo>
./scripts/setup-from-clone.sh
```

One command, re-runnable (each step checks before it writes). It builds the
workspace, **registers this checkout as the pi package**, installs the relay as
a launchd/systemd user service, installs the launcher, then serves the built
client on **`http://localhost:4173`**.

```sh
./scripts/setup-from-clone.sh --dev        # Vite on :5173 instead (laptop only)
./scripts/setup-from-clone.sh --no-run     # set up, don't serve
./scripts/setup-from-clone.sh --dry-run    # print the plan, change nothing
./scripts/setup-from-clone.sh doctor       # read-only state report, safe any time
```

It deliberately does **not** pair a device (a script printing a single-use code
is a script deciding who gets a device), and it does not choose your relay URL
or your launch directories.

Use the served `:4173` build on a phone, not `--dev`: the dev server's HMR socket
drops on a network blip and full-reloads the page, which looks exactly like
losing the session.

---

## Start using it

1. Open the client — `http://localhost:4173` on this machine, or
   `http://<machine>.local:4173` / your tailnet name from the phone.
2. In a pi session on this machine: `/unbien pair` → a single-use code and QR.
3. In the client's **Pair a machine** drawer: paste that code (or scan the QR),
   put the relay URL as `http://<this-machine>:3000`, name the device, tap Pair.
4. The group fills in with sessions and machines. Tap a session to attach.

Do not port-forward `:3000` to the internet — the relay sees routed plaintext.
Pairing over plain `http` on a LAN works fine (Ed25519 does not need a secure
context).

---

## Which folders the phone may start sessions in

`~/.pi/agent/extensions/un-bien.json` — only you know this list, so nothing sets
it for you:

```json
{
  "relay": "http://<this-machine>:3000",
  "defaults": { "allow_remote_launch": true },
  "launch": { "dirs": ["/Users/you/dev/myapps"] }
}
```

`dirs` is an allow-list (nested paths count), and it is **consulted fresh per
launch request** — the file is re-read each time, so edits take effect without
restarting pi. Absent or `"*"` means any folder is allowed, which is the default:
narrow it here rather than relying on nothing being set. Whether launch is
enabled at all is the per-folder `allow_remote_launch` flag; `dirs` narrows
where within that.

---

## Prove it works

```sh
curl -s localhost:3000/health            # relay up
pi list                                  # extension resolves into this checkout
./scripts/relay-service.sh status        # which relay binary the service runs
./scripts/setup-from-clone.sh doctor     # ports, relay, URLs, what is missing
```

Logs: `~/.local/state/un-bien/relay.log` and `launcher.log`.

---

## Day two

- **Update:** `git pull && ./scripts/setup-from-clone.sh` — rebuilds and
  repoints the services at this checkout.
- **Who is paired:** `./scripts/revoke-peer.sh audit` — lists every device that
  can see this machine's rooms, with the evidence for whether each key can ever
  connect again. Revoking is a real security action, so it gates on that rather
  than on how old the row looks.
- **Cross-relay federation** (a second machine's relay):
  [`docs/relay-peering.md`](docs/relay-peering.md).

## Reading further

| Want | Read |
| --- | --- |
| Every flag, OS service, troubleshooting | [`docs/install.md`](docs/install.md) |
| Why each clone step exists, fixing a step by hand | [`docs/from-clone.md`](docs/from-clone.md) |
| Using the client day to day | [`web-client/USAGE.md`](web-client/USAGE.md) |
| Privacy, pairing and trust model | [`docs/privacy.md`](docs/privacy.md) |
