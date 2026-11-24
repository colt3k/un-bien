# Running this fork from a clone

For anyone who cloned **this** repo and wants the setup it is written for: the
browser client (`web-client/`) driving a pi session, over a relay you host, with
everything built from this checkout rather than installed from npm or crates.io.

If you just want the published package, read [`install.md`](install.md) instead —
`pi install npm:@geohar/un-bien` plus a `cargo install un-bien-relay` relay. That
path is simpler, and it will **not** contain anything in this fork.

---

## The short version

```sh
scripts/setup-from-clone.sh             # everything below, then serve the client
```

It runs the five steps in §2–§5 (workspace install → build → register this
checkout with Pi → relay as an OS service → launcher daemon) and then starts the
browser client on `:4173`. Options: `--dev` (Vite on `:5173` instead), `--no-run`
(stop before serving), `--skip-relay` / `--skip-launcher` / `--skip-pi` /
`--skip-deps` / `--skip-build`, `--dry-run` (print the plan, change nothing).

Two things it will not do for you:

- **Pairing.** `/unbien pair` prints a single-use code inside a Pi session. A
  script that prints it is a script deciding who gets a device.
- **Your relay URL and `launch.dirs`.** They live in
  `~/.pi/agent/extensions/un-bien.json`, and only you know which folders the
  phone is allowed to start sessions in.

Read-only state report, safe to run any time:

```sh
scripts/setup-from-clone.sh doctor
```

The rest of this page is what each step is for, and what to do when a step needs
fixing by hand.

---

## 0. What runs, and where each piece comes from

```
browser ──► relay (:3000, launchd/systemd) ──► launcher (launchd/systemd) ──► pi session
            built from relay/, run from           runs extension/dist/bin/       loads
            ~/.cargo/bin                          launcher.js from THIS clone    extension/dist
                                                                                  from THIS clone
```

| Piece | In the clone? | How it gets running |
| --- | --- | --- |
| pi extension (`extension/`) | yes (source; `dist/` is gitignored) | `pi install ./extension` — **per machine, see §3** |
| relay (`relay/`) | yes (source) | `scripts/relay-service.sh install` → binary in `~/.cargo/bin` |
| launcher daemon | yes | `/unbien install launcher` — runs from this clone, see §5 |
| `unbien` / `unbien-admin` CLIs | yes | `unbien-admin` is symlinked by the extension to this clone's `extension/dist/index.js` |
| browser client (`web-client/`) | yes | `web-client/scripts/start.sh` |
| pairing state, relay DBs, logs | **no** | created per machine under `~/.local/state/un-bien` |
| which extension pi loads | **no** | `~/.pi/agent/settings.json`; cannot be committed (`.gitignore` ignores `.pi/`) |

Two consequences worth knowing up front:

- **Nothing tells pi to load this checkout automatically.** §3 is a step you run
  once per machine, and if you skip it pi loads the *published* `@geohar/un-bien`
  from npm and your fork's behaviour silently isn't there.
- **`dist/` is gitignored everywhere.** A clone with no build still passes
  `pi install` and still appears in `pi list` — it just contributes zero
  extensions, because the manifest points at `./dist`. Build before you load.

---

## 1. Prerequisites

`scripts/setup-from-clone.sh` checks all of this and tells you what is missing.

| Need | Why | Check |
| --- | --- | --- |
| Node 20+ | everything | `node --version` |
| pnpm `11.13.1` | the lockfile; other versions churn it | `pnpm --version`, or `corepack enable` |
| Rust (`cargo`) | the relay is Rust | `cargo --version`; the setup script also looks in `~/.cargo/bin` and `~/.rustup/toolchains/*/bin`, because a non-login shell has no rustup shims. Or use `cargo install un-bien-relay` / `brew install ./HomebrewFormula/unbien-relay.rb` instead |
| `tmux` | the remote-launch backend (`launch.backend`) | `tmux -V` |
| Tailscale (optional) | reaching the relay + client from a phone off-LAN | `tailscale status` |

No `jq` needed — the client script parses `tailscale status --json` with node,
which is already required.

---

## 2. Install and build (once)

```sh
pnpm install --frozen-lockfile
pnpm build                       # extension, launcher, unbien-cli
pnpm -C web-client build         # only needed for `preview` (start.sh does this for you)
```

---

## 3. Load the fork into pi

```sh
cd /path/to/this/clone
pi install ./extension           # writes a user-scope entry into ~/.pi/agent/settings.json
pi list                          # should show .../extension resolved to an absolute path
```

A project-scope declaration (`.pi/settings.json`) would be the committable way to
do this, and it is deliberately not available here: `.gitignore` ignores `.pi/`
because that directory also holds runtime state. So this is a per-machine step.

Do **not** run `pi install npm:@geohar/un-bien` afterwards. That re-adds the
registry package, and an unpinned `npm:` entry is updated from the registry on
`pi update --extensions` — which will replace your checkout's behaviour with
upstream's.

Pi identifies npm packages by name and local ones by resolved path, so an `npm:`
entry and a path entry are treated as separate packages and both appear in
`pi list`. You end up with two copies of the extension loaded — same tools,
registered twice. Keep exactly one entry.

---

## 4. The relay, as an OS service

```sh
scripts/relay-service.sh install          # builds nothing; copies relay/target/release/…
scripts/relay-service.sh install --build  # cargo build --release first
scripts/relay-service.sh status           # what runs, from where, and the hazards
scripts/relay-service.sh unit             # PRINT the launchd plist / systemd unit it would write
curl -s localhost:3000/health             # OK
```

launchd on macOS, `systemctl --user` on Linux — one script, and `--backend systemd|launchd`
if you ever need to force it.

Why the binary goes to `~/.cargo/bin/unbien-relay`: that is where the extension's
`findRelayBinary()` looks (`$PATH`, then `~/.cargo/bin`). Put it anywhere else and
`/unbien install relay` won't see it, decides the relay is missing, and
`cargo install`s the published crate over your build.

Why **not** run it out of `relay/target/`: that path is build output. `cargo clean`
empties it and moving the clone invalidates the absolute path the service manager
resolves on every restart — the running process survives only until something
restarts it. `scripts/relay-service.sh repoint` is the one-command repair after a
move, and `status` prints a warning when the unit's `ExecStart` (or plist
`ProgramArguments[0]`) is missing or sits inside the repo.

On macOS the unit is written with `RunAtLoad=false` +
`KeepAlive={Crashed, SuccessfulExit:false}`: launchd supervises and restarts a
crash, but a deliberate stop stays stopped, and nothing starts it at login until a
pi session (`/unbien pair`, `auto_start_relay`) asks for it.
`install --from-template` switches to always-on-at-login.

On Linux the script renders `~/.config/systemd/user/unbien-relay.service` from the
same repo template and runs `systemctl --user daemon-reload && enable --now`. Two
Linux-specific things to know:

- **Lingering.** A systemd *user* service only runs while the user has a session,
  so on a headless hub it is down from boot until you log in, and down again at
  every logout. Turn it on once: `sudo loginctl enable-linger "$USER"`. `install`
  says so when lingering is off, and `status` prints its state.
- **Logs go to the journal**, not `~/.local/state/un-bien/relay.log` (that path is
  a launchd `StandardOutPath` thing):
  `journalctl --user -u unbien-relay.service -n 50`.

---

## 5. The launcher daemon and the CLIs

```sh
# in a pi session
/unbien install launcher
```

`findLauncherScript()` resolves the entry from the extension's own `dist/`
(`dist/daemon/install.js` → `dist/bin/launcher.js`), and `findRemotePiScript()`
does the same for `~/.local/bin/unbien-admin`. So with the extension loaded from
this clone (step 3), both land on the clone path — one build, no version drift
between what pi loads and what the daemon runs. The unit embeds the `node` and
`PATH` of the shell that ran the install, so run it from a normal shell, not from
a sparse one.

That command also fetches the standalone `@geohar/un-bien-launcher` package from
the registry, so it needs network. The unit is written **before** that fetch, so
a failed fetch does not mean an uninstalled daemon — the check that matters is
which file the unit runs, and `scripts/setup-from-clone.sh doctor` reads it off
disk:

```text
   unit   runs: /Users/YOU/dev/un-bien/extension/dist/bin/launcher.js
   ok   entry file exists
   ok   launchd has it loaded
```

If that path is somewhere other than this clone, the daemon is running a
different build than Pi loaded — rebuild here and re-run the install step.

Which cuts the other way on a machine that already has a launcher service from
some other install: running the install step from this clone **moves** that
service onto the clone. That is the point for a from-source setup, but it is a
change to a running service, and the clone has to stay at that path (or the unit
re-generated after a move).

This is the tradeoff, stated: the launcher now depends on this checkout existing
at this path with its `node_modules` and a current `dist`. After moving the clone,
re-run `/unbien install launcher` and rebuild (`pnpm build`). The relay, by
contrast, deliberately lives outside the clone (§4).

One switch decides *which copy* the service runs. If a package manager is
configured — `package_manager` in `~/.pi/agent/extensions/un-bien.json`, or pi's
`npmCommand` setting — then `/unbien install` delegates to that manager's **global**
copy of the extension, and the unit points at that copy, not at this checkout.
With neither set (the default), the install runs from the copy pi loaded — this
clone — which is what you want here. Check with:

```sh
python3 -c "import json;print(json.load(open('$HOME/.pi/agent/extensions/un-bien.json')).get('package_manager','(unset)'))"
python3 -c "import json;print(json.load(open('$HOME/.pi/agent/settings.json')).get('npmCommand','(unset)'))"
```

`unbien` (the separate `@geohar/unbien-cli` package) is not installed by that
command. `npm i -g ./unbien-cli` from the clone if you want the CLI from source.

### The one way this goes wrong silently

The installer **delegates**. `_delegateToGlobalCopy` in `housekeeping.ts`: if a
package manager is resolvable, `install <target>` first ensures the extension is
installed globally, then runs **that copy's** `unbien-admin <verb> <target>`. A
global copy resolves the launcher entry from its own `dist/`, so the unit points
at the global copy.

From a checkout that is now the same thing as pointing at the checkout: with
`install_from_source` at its default (`auto`), the global install IS this
checkout — the package manager links `<checkout>/extension` into its global
tree, so delegation lands on the code you are editing. It also means `unbien`
and `unbien-launcher` come from `unbien-cli/` and `launcher/` rather than from
the registry.

What still bites is an **older, registry-installed copy** sitting there from
before: it is a copy, not a link, so it wins, and the service runs a build
nobody is editing. Check with:

```sh
npm ls -g @geohar/un-bien
ls ~/.pi/agent/npm/node_modules/@geohar/ 2>/dev/null
```

If either finds `un-bien` and you want the clone to be the source of truth,
remove it: `npm uninstall -g @geohar/un-bien`. That is not a hypothetical — on
the machine this fork is developed on, a leftover global build (older than the
development branch by several days of fixes) was what the launcher daemon was
actually running, because every install had been delegating to it.
`scripts/setup-from-clone.sh doctor` reports these copies. Set
`install_from_source: "never"` if you would rather always take the published
packages.

Two smaller footguns in the same area:

- `unbien-admin install` with **no target means `all`** (launcher + cli + relay),
  not "show help". Type the target.
- `install launcher` also runs `npm install -g @geohar/un-bien-launcher` from the
  registry (the standalone package, its own version line). The daemon does not
  run it — the unit runs this checkout — but if you want that command from source
  too: `npm i -g ./launcher`.

---

## 6. The browser client

```sh
web-client/scripts/start.sh doctor    # node, pnpm, deps, ports, relay, and the URLs to type
web-client/scripts/start.sh           # dev server on :5173
web-client/scripts/start.sh preview   # build + serve dist/ on :4173 — use this on a phone
web-client/scripts/start.sh stop
web-client/scripts/start.sh relay status|up|down
```

`start.sh` derives the repo root from its own location, finds pnpm (or corepack,
or `npx pnpm@<pinned>`), and prints the URLs to type — tailnet name if there is
one, tailnet or LAN address otherwise — plus the relay URL for the drawer.

### Reaching it from a phone: a mesh VPN is optional

Both of these work, and neither is required. Pick by where the phone is:

| Same network | What you type | Notes |
| --- | --- | --- |
| Same LAN | `http://192.168.1.86:5173` | Vite allows any **IP** host header unconditionally — no configuration needed. `start.sh` prints this address when there is no tailnet. |
| Same LAN, by name | `http://<mac-name>.local:5173` | mDNS names are not IPs, so they need to be in `allowedHosts` — `.local` is there for that reason. |
| Anywhere, mesh VPN | `http://<node>.<your-tailnet>.ts.net:5173` | The relay and the client are both reached by the tailnet address. |

Verified against a running preview server (Vite 7.3.8), with `allowedHosts:
[".ts.net", ".local", "localhost"]`:

```text
localhost:4173            -> 200
192.168.1.86:4173         -> 200   (LAN address, allowed because it is an IP)
my-mac.local    -> 200   (.local — only after that entry was added)
somehost.example.com      -> 403   (still refused — the check is not disabled)
```

`allowedHosts` is a list, not `true`, on purpose: that check is Vite's protection
against DNS rebinding against a dev server that is bound to `0.0.0.0`. Widen it
only if you have a reason.

What you give up by skipping the VPN: access from outside your network. Pairing
and every crypto step are unaffected — the wire is signed and fail-closed, and
`http` on a LAN is not a barrier to pairing (see the `crypto.randomUUID` note in
[`../web-client/README.md`](../web-client/README.md)). What is true either way is
that the relay sees routed plaintext, so do not port-forward `:3000` to the
internet; if you need remote access, that is what the mesh VPN in
[`install.md`](install.md) is for.

Use `preview`, not `dev`, on a phone: the dev server's HMR socket drops on a
network blip or a backgrounded tab and full-reloads the page, which looks exactly
like losing the session.

Then pair: `/unbien pair` in the pi session prints a single-use code; the drawer
takes that code and the relay URL (`http://<your-node>:3000`). Full walkthrough,
including troubleshooting: [`../web-client/USAGE.md`](../web-client/USAGE.md).

---

## 7. Prove it works

```sh
pi list                                            # extension resolved into this clone
curl -s localhost:3000/health                      # relay up
web-client/scripts/start.sh doctor                 # ports + relay + URLs
./scripts/relay-service.sh status                  # which binary the service runs, and its version
```

In the browser: the relay box fills in, `pair` succeeds on plain `http` (Ed25519
works without a secure context), and the transcript appears. If `pair` does
nothing at all, check the console for `crypto.randomUUID` — that API is
`undefined` on a non-secure origin, and that specific failure is why
`web-client/src/framing.ts` looks the way it does.

---

## 8. Machine-local state a clone does not bring

Set these yourself; none of them are (or should be) committed:

- `~/.pi/agent/settings.json` — the `packages` entry pointing at this checkout.
- `~/.pi/agent/extensions/un-bien.json` — `relay` URL, `launch.dirs` (the folders
  the phone may launch sessions in), `launch.backend`, `defaults.*`.
- `~/.local/state/un-bien/` — `pairing.db`, `mesh.db`, `identity.json`, logs.
- `~/Library/LaunchAgents/com.georgeharker.unbien.{relay,launcher}.plist` —
  generated by the steps above.

And a privacy note if you fork this publicly: the docs in this tree name the
author's tailnet host, tailnet name, tailnet IP, and a live room id. They are not
credentials (pairing is fail-closed with signed allow-lists), but they are
reachable identifiers — replace them with placeholders in your fork.
