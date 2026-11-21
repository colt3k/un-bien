# Running and using the web client

Practical steps: what has to be running, how to pair, what the buttons do, and how
to capture a fixture. For _why_ the fold is shaped the way it is, read `README.md`
and `../DESIGN.md`.

Everything below was run against a real pi session on 2026-11-20.

---

## 0. What you are starting

The browser is a **client end**, not a viewer of files: it connects to an un-bien
**relay**, pairs with a **machine** (a pi session running the `@geohar/un-bien`
extension), and drives that session over the same wire the iOS/macOS app uses. One
pairing reaches every room (session) that machine advertises.

Three moving parts:

```
pi session + un-bien extension  ──►  relay (Rust, default :3000)  ◄──  browser
        (the machine)                        (broker)             (this folder)
```

## 1. Prerequisites

- **pi** with the un-bien extension installed and loaded (the machine side).
- **Node 20+** and **pnpm** — the version is pinned by the root `package.json`
  `packageManager` field (`pnpm@11.13.1` at time of writing); use that one so the
  lockfile doesn't churn.
- A **relay**. You do not normally start it yourself: `/unbien pair` in pi
  auto-bootstraps the services if they are down. Manual, if you want an isolated one:
  `relay/target/release/unbien-relay` with `UNBIEN_STATE_DIR` pointing somewhere
  throwaway. Default listen port is `3000` (`UNBIEN_RELAY` overrides the URL the
  extension advertises; see `../docs/env-vars.md`).

Install workspace deps **once, from the repo root**:

```sh
pnpm install --frozen-lockfile
```

## 2. Start it

### The short way

```sh
web-client/scripts/start.sh           # dev server, and it prints the URLs you need
web-client/scripts/start.sh doctor    # check node/pnpm/ports/relay, start nothing
web-client/scripts/start.sh preview   # build + serve dist/ — what a phone should use
web-client/scripts/start.sh stop      # stop only the servers THIS checkout started
web-client/scripts/start.sh relay status|up|down
```

`dev` and `preview` **bring the relay up if it is not answering** — that is the
"only when needed" trigger — and `relay down` takes it away. The relay is a launchd
job (`~/Library/LaunchAgents/com.georgeharker.unbien.relay.plist`) with
`RunAtLoad=false` and `KeepAlive={Crashed, SuccessfulExit=false}`: launchd supervises
it and restarts a crash, but a deliberate stop stays stopped and **nothing starts it
at login**. State lives in `~/.local/state/un-bien` (keypair, pairing DB) — never in
`/tmp`, and the keypair is what every client's relay pin is bound to, so don't delete
it. If you ever want it always-on instead, set `RunAtLoad` back to true or run
`/unbien install relay`, then `launchctl bootout` + `bootstrap` to apply.

Caveat worth knowing: pi's extension and the launcher are also relay clients. With the
relay down, `/unbien pair` says _"Pair requires the relay to be connected"_ and the
launcher retries silently every few seconds. Bring it up with
`start.sh relay up` (or just run `dev`).

The script resolves pnpm for you (it is often not on PATH — it falls back to
`corepack`, then to `npx pnpm@<the pinned version>`), refuses to double-start a
server, and prints the tailnet URL for the page **and** the relay URL to paste into
the drawer. It does not start a relay; if none is answering it says so, because that
is pi's job (`/unbien pair`).

### The long way (what the script runs)

```sh
pnpm -C web-client dev              # http://localhost:5173  (strictPort)
```

`--filter web-client` does **not** work here: pnpm filters match the package name
(`@geohar/un-bien-web`), so that form dies with "No projects matched the filters".

Vite binds every interface and allows `*.ts.net`, so a phone on your tailnet can
open `http://<your-host>.tail5f1ece.ts.net:5173`. Pairing crypto is Ed25519 from
`@noble`, not WebCrypto, so plain `http` does **not** lock you out of pairing — the
relay transport (`ws://` vs `wss://`) is the thing to think about, not the page.

One exception worth knowing, because it bit this client: `crypto.randomUUID` is a
**secure-context** API and is `undefined` on a plain-`http` origin (measured:
`isSecureContext false`, `randomUUID undefined`, `getRandomValues` fine). Every
request id therefore falls back to `crypto.getRandomValues` (`src/framing.ts`). A
`TypeError` from that getter used to reject inside `pairAwaited`, and an `await`
with no catch swallowed it: the pair button looked completely dead, with no error
anywhere, on exactly the phone URL this section tells you to open.

**On a phone, use `preview`, not `dev`:**

```sh
pnpm -C web-client build && pnpm -C web-client preview   # :4173
```

The dev server's HMR socket drops on a tailnet blip or a backgrounded tab and
full-reloads the page — which looks exactly like the client losing the session.

## 3. First run: relay, pair, attach

Open the drawer with **☰** (top left). Everything happens there.

1. **Relay** — the box is already filled in with **the host you opened the page
   on, at the relay's port** (`http://<your-host>:3000`): `start.sh` brings both up
   on the same box, so this is the right URL unless you split them. Press **connect**
   (or let the app do it on load), and the dot in the header is the relay's state.
   Once you connect, that URL is remembered — it wins over the guess on the next
   load. An `https` page defaults to `https://<host>:3000` (`wss://`), because a
   secure page cannot open an insecure `ws://` socket at all.
2. **Pair a machine** — in the pi session run:
   ```
   /unbien pair
   ```
   Copy the pairing **code** it prints (`unbien://pair?t=…&epk=…&n=…&rm=…`), give the
   device a name (e.g. `pixel-8-pro`), paste the code, press **pair**.
   The line under the code box is the verdict: _pairing…_ → green (paired, or
   already paired) or red (refused, with the machine's reason). It is in the sheet
   on purpose — while the sheet is open nothing outside it can be painted above
   the modal `<dialog>`, which is where the header and the toast live.
3. **Machines** — the paired machine appears as a card; each room (session) it
   advertises has an **attach** button. Attaching walks `get_entries` (paged, ending
   on the empty page) and renders the transcript, then keeps up live.

Things worth knowing, because they explain the failures you'll otherwise chase:

- **Codes are single-use** and **expire 60 seconds** after `/unbien pair` prints
  them (`TOKEN_TTL_MS` in `extension/src/pairing/qr.ts`). A code pasted from a
  terminal five minutes later is dead. This is the usual cause of a red verdict.
- **A device that is already paired stays paired.** The machine re-ACKs an owner it
  already trusts without spending a token (`relay_lifecycle.ts:1052`), so the verdict
  says _already paired … re-confirmed_ and no new card appears. That is a success, not
  a no-op: press **attach** on a room, don't hunt for another code.
- **A pairing is only valid on one relay** — the client says so if you try to use a
  code on the wrong relay URL.
- The browser keeps **its own long-lived identity** and a **TOFU pin** on the relay's
  key. If you replace the relay's `relay-keypair.json`, the client refuses the socket
  ("this URL is serving a different relay than the one you paired with") and sends no
  session traffic. That is the pin working, not a bug.
- Nothing is stored server side: clearing the site's storage in the browser logs this
  client out.

## 4. Driving a session

- **Composer** (bottom): type and press **send**. Idle → `prompt`. Mid-turn →
  **send** _steers_ the running turn.
- **⏱** queues the message as a follow-up for after the current turn.
- **■** (appears during a turn) aborts it.
- **Asks / panels**: when pi asks a question (`select`, `confirm`), it renders as an
  overlay; answering sends the response and clears it. Plan/panel state renders in the
  panel strip.
- **Hide thinking** (drawer) toggles reasoning rows. Note the asymmetry: pi does not
  replay thinking blocks, so a thinking row exists only for a viewer that was
  watching while it streamed — a client that arrives cold never sees it.
- **Restart/resync**: if the machine restarts, the relay re-announces the room and the
  client re-attaches and re-syncs. Same after a relay restart (reconnect,
  re-subscribe, re-attach, pin still valid).
- **unpair** on a machine card drops the local identity — **also** revoke the pairing
  on the machine with `/unbien revoke`. **forget** on a relay card drops that relay.

## 5. Watching a real session (what we actually do here)

Fastest useful loop: pair a laptop pi session from a second Chrome window, attach, and
run something in pi. What to look for, in order: user row → thinking (live only) →
assistant text → tool card `running → ok` → turn settled, all landing as **one row
each** (deltas coalesce onto the row the `message_end` finalizes).

Joining a turn **in flight** is a real test, and timing-dependent: a 1500-word answer
streams faster than it takes to open a tab, refresh the machine list and click attach
(~8 s). Open the second tab **before** the turn starts so attach costs ~2 s, or pick a
prompt with a long thinking phase — those stream for tens of seconds.

## 6. Capturing a conformance fixture

Append `capture=1` to the URL (e.g. `http://localhost:5173/?capture=1`). That turns on
a dev-only tee of **every inbound envelope** into `window.__unbienFrames`; it is off by
default and not sticky across a reload. Nothing in the app reads the buffer.

```js
__unbienDump("026-my-shape") // downloads JSONL, returns the frame COUNT
```

The count is the diagnostic: **3 frames means you were never attached**, not that the
turn failed. Then follow the newest scenario's `capture-steps.md` and
`contracts/conformance/scenarios/NNN-*/capture.py` to scrub and build. The dump is
**unscrubbed wire data** — pairing tokens and real conversation text — so it lives
only in `raw.jsonl` (gitignored), never in the repo.

## 7. Tests

```sh
pnpm -C web-client test        # 127 tests, incl. the 25-scenario conformance corpus
pnpm -C web-client typecheck
```

The corpus runs **both planes** per scenario (watched live frames, and cold arrival
from the walk) and asserts this fold against goldens minted by the Swift reference:

```sh
cd ../app && UNBIEN_CONFORMANCE_REGENERATE=1 swift test --filter ConformanceHarnessTests
```

**Run these yourself.** Actions are deliberately **disabled on this fork** — no CI job
runs here (`../.github/workflows/app-ci.yml` explains the decision), so a green local
suite is the only gate that exists.

## 8. Exercising it without a real pi

A scripted machine double speaks the real wire at the real relay (it is **not** a
second implementation of the extension; everything it emits was copied from
`../extension/src`):

```sh
relay/target/release/unbien-relay
node web-client/scripts/fake-machine.ts --turn-ms 8     # prints a pairing URI
```

To pull a real session's entries without the browser:

```sh
npx tsx web-client/scripts/dump-entries.ts \
  --relay http://<host>:3000 \
  --pair  'unbien://pair?t=…&epk=…&n=…&rm=…' \
  --out   /tmp/unbien-fixture.json
```

That output file **is your session** — prompts, tool output, paths. `/tmp`, never the repo.

## 9. When it does not work

| Symptom                                                       | Likely cause                                                                                    |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `pairing refused: …`                                          | code already used, or you are on a different relay than when it was minted                      |
| red line: `Token was not issued by this Pi` / `token expired` | the code is spent or older than 60s — run `/unbien pair` again                                  |
| green line: `already paired … re-confirmed`, no new card      | this browser already holds that pairing — press **attach** on a room                            |
| Header stuck at `not connected`                               | relay URL typo/scheme, relay not up, or port 3000 in use by another relay                       |
| Client refuses the socket, mentions "a different relay"       | relay key changed since you paired — the TOFU pin, working as designed                          |
| Page full-reloads on a phone                                  | you are on `dev`, not `preview`                                                                 |
| Transcript stops mid-turn but the machine kept going          | you are attached to a different room, or the machine re-announced and the re-attach is mid-walk |
| `__unbienDump` returns a tiny count                           | you were never attached — attach first, the tee only records while connected                    |
| Port 5173 busy                                                | `strictPort: true`: the server refuses to pick another port, kill the other instance            |

This is a **spike**: no offline story, no push notifications, one file per concern, and
the dev-server exposure above is not a deployment. A real one wants TLS, a static host,
and `wss://`.
