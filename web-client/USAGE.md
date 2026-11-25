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
open `http://<your-host>.my-tailnet.ts.net:5173`. Pairing crypto is Ed25519 from
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
   Then either press **scan QR** and point the phone at the terminal, or copy the
   pairing **code** it prints (`unbien://pair?t=…&epk=…&n=…&rm=…`) and paste it.
   Give the device a name (e.g. `pixel-8-pro`) first if you want one. **pair** is
   only needed for the paste: a scan that finds a pairing code pairs straight
   away, because that code expires 60 seconds after it was printed.
   The line under the code box is the verdict: _pairing…_ → green (paired, or
   already paired) or red (refused, with the machine's reason). It is in the sheet
   on purpose — while the sheet is open nothing outside it can be painted above
   the modal `<dialog>`, which is where the header and the toast live.
   Once at least one machine is paired the section **starts folded**, labelled
   **paired** (**3 paired** if there are three): an empty code box sitting above a
   list of machines you already own reads like a step still owed. The heading is the
   toggle (a real `<h2><button aria-expanded>` — a heading inside `<summary>` is
   dropped by JAWS and TalkBack), and the fold is decided as the sheet opens, never
   during a pairing attempt, so a verdict cannot be collapsed half-read. The hidden
   fields use `hidden="until-found"`, so they stay reachable to find-in-page.
3. **Machines** — the paired machine appears as a card; each room (session) it
   advertises has an **attach** button. Attaching walks `get_entries` (paged, ending
   on the empty page) and renders the transcript, then keeps up live.

Things worth knowing, because they explain the failures you'll otherwise chase:

- **Codes are single-use** and **expire 60 seconds** after `/unbien pair` prints
  them (`TOKEN_TTL_MS` in `extension/src/pairing/qr.ts`). A code pasted from a
  terminal five minutes later is dead. This is the usual cause of a red verdict.
- **Scanning takes a photo; it is not a live viewfinder.** **scan QR** opens the
  phone's camera through a file input, takes one shot, decodes it, and pairs. That
  is deliberate: the camera API (`getUserMedia`) is blocked on a non-`https`
  origin, and this client normally runs on `http://<host>:5173` — see _Pairing by
  QR scan_ in `README.md`, and _https_ below if you want the real viewfinder. Get the whole code in frame: the terminal's QR is small, and
  _no QR code recognised_ is nearly always distance or blur rather than a bad
  code. A **screenshot of the terminal pasted into the code box** goes through the
  same decoder, which is the easier door when the phone cannot focus on a monitor.
- **The form remembers the last scan.** Under the code box you'll see e.g. `last
scan: image/jpeg 2051 KB → 3024x4032 → no QR code found (3 passes, 410 ms)`. If a
  scan does nothing, that line is the diagnosis — it says what the camera actually
  handed over and whether the decoder ran. `… — the photo never came back to the
page` means the browser unloaded the page while the camera was open (iOS does
  this); `image/heic` means the browser was handed a format it cannot decode
  (`Settings → Camera → Formats → Most Compatible` fixes it).
- **https is one command, on a tailnet box.** `scripts/https.sh on` puts
  `tailscale serve` in front of both ends: the client at
  `https://<node>.<tailnet>.ts.net` and the relay at `wss://…:3443`. The
  certificate is Tailscale's own, so no device shows a warning and there is no CA
  to install on the phone. The client notices: an `https` page defaults the relay
  box to `:3443` instead of `:3000`, because an `https` page cannot open a plain
  `ws://` socket at all. `scripts/https.sh status` prints both URLs; `off` removes
  them. `scripts/https.sh mkcert` is the fallback when you are off the tailnet —
  it works, but every other device has to be made to trust the CA, which on iOS
  means a profile install plus the Certificate Trust Settings toggle.
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
- **📎** attaches an image (up to four per message). The OS picker offers photos
  AND the camera from one tap — there is no `capture` attribute on the input, and
  no `getUserMedia`, because a camera stream needs a secure context and this page
  is routinely plain http on a tailnet host (`src/qr-scan.ts` keeps the full
  argument). The copy is resized in the browser before it is sent: longest side
  1568px, under 1.5 MB of base64. That is not a browser limitation — the bytes
  land in pi's session log and come back to every device on every reload, so the
  size is paid for again for the life of the session. A file already small enough
  goes across untouched (which is also what keeps a GIF animated).
  - A message can be **images only** — no text needed.
  - A **slash command cannot carry an image**: the machine runs the command and
    the photo would be dropped, so the client refuses and says so.
  - HEIC (an iPhone camera set to High Efficiency) is refused at the picker with
    the setting to change; png / jpg / webp / gif are what the machine accepts.
- **⏱** queues the message as a follow-up for after the current turn. It carries
  attachments too — and an image send always rides pi's `prompt` verb with
  `streamingBehavior`, never the bare `steer`/`follow_up` commands, because
  `prompt` is the one whose handler hands image blocks to the agent.
- **■** (appears during a turn) aborts it.
- **Asks / panels**: when pi asks a question (`select`, `confirm`), it renders as an
  overlay; answering sends the response and clears it. Plan/panel state renders in the
  panel strip.
- **Hide thinking** (drawer) toggles reasoning rows. Note the asymmetry: pi does not
  replay thinking blocks, so a thinking row exists only for a viewer that was
  watching while it streamed — a client that arrives cold never sees it.
- **detach** on the room card you are in. The card of the room this device is
  following is marked **open** and its button says **detach** instead of
  **attach**: it stops this device reading the room, clears the transcript, and
  stops the next reload going back to it. Nothing changes on the machine — the
  session keeps running, its other viewers keep their view, and **attach** puts
  you straight back in. (Before this, `attach` was the only control on the card,
  so the only way out of a session was into another one.)
- **A refresh keeps the page.** The reload re-opens the room you were in AND puts
  you back on the row you were reading, with the history you had pulled in
  ("load earlier rows" included) — not at the newest row. It restores by row, not
  by pixel offset, so a session that grew while the tab was closed still lands
  you where you stopped. If that row is gone (the session restarted, a branch
  changed), it falls back to the newest rows and says so in the entry count.
  `?fresh=1` skips the resume altogether — see §9.
- **Restart/resync**: if the machine restarts, the relay re-announces the room and the
  client re-attaches and re-syncs — keeping your place in the transcript, same as a
  reload. Same after a relay restart (reconnect,
  re-subscribe, re-attach, pin still valid).
- **unpair** on a machine card drops the local identity — **also** revoke the pairing
  on the machine with `/unbien revoke`. **forget** on a relay card drops that relay.

### Starting a session where none is running (remote launch)

A paired machine's card carries **new conversation** when the machine has a launcher
control room — the daemon, not a pi session (`is_daemon` cap). It opens a form in place
of the transcript (a control room has no transcript, and a composer pointed at it would
be a dead input): **folder** plus an optional **name**, then **launch** sends
`ub.session_launch` to that room, and the daemon spawns a pi window through tmux/herdr/Rex.

**The folder list comes from the machine.** Opening the panel asks
`ub.session_launch_dirs`, and the daemon answers `session_launch_dirs_result`: each
`launch.dirs` root, absolute, with its **immediate** child folders (never deeper — that
is the machine's decision, and a device that could walk the tree could read a home
directory). The panel paints them as **rows you can see and tap**: one per allow-listed
root, labelled with the WHOLE path (sorted by full path ignoring case — `myai` alone
would not tell you which root it came from), each saying how many folders sit inside it,
and one tap on a root both chooses it and opens what is inside it. A root that is
allow-listed but not on the machine stays on the list, dimmed, with the reason, because
it cannot be launched into.

**One control, not two.** The folder field is a plain text box: a row fills it, and you
can still edit what is in it. Typing does not open a second dropdown — it **filters these
rows** (substring of the full path, ignoring case), keeping each match's root above it as
a header that says how much of the root the filter kept. There is no `list=` attribute and
no `datalist` element on the field: the same 168 paths in two controls meant one popup
landing on top of the list that was already showing them, and the dropdown was the part
phones get wrong anyway (iOS Safari's datalist support is partial; Chrome on Android will
not open one for an empty field — that was the original bug: the paths were present and
invisible at the same time). `dirRows` in `src/launch-dirs.ts` is the row model, and
`test/launch-dirs.test.ts` pins both halves: the panel carries a list element, and the
field carries no dropdown.

Groups are closed by default — this machine's real allow-list is 7 roots and 161 folders,
which is neither scannable nor scrollable on a phone. `~` in the config is expanded
machine-side; the device never guesses, and a typed path is always accepted even when no
row matches it (the list is a convenience, not a whitelist — a filter that matches nothing
says so in words rather than going blank). Typing or pasting a path that IS one of the
offered folders marks its row and opens its group.
Picking a folder sets the path **and moves the name to its last component**
(`/Users/you/x/a/b/c` → `c`) — picking a different folder means a different project,
so the name follows. A name you typed yourself is never replaced; only the client's own
previous suggestion is. Pressing Enter names the session the same way.
What the answer is not, it says out loud: `wildcard` (`launch.dirs: "*"` — type anything),
`locked` (`launch.dirs: []` — nothing can launch), `allow_remote_launch` off, a root that
isn't on the machine right now, or an older daemon that never answers (then the form keeps
working with a typed path).

Four things about that room are worth knowing, because all four look like a client bug:

- **The control room is a room like any other.** `rooms_check` lists it — measured on a
  live relay: `ExampleRoom1`, name `my-mac.local`, cwd `/Users/you`, caps
  `["remote_launch", "is_daemon", "session_resume"]` — sitting next to the pi session's
  room.
  It is aged by `MISSING_GRACE` like a session, so when the daemon dies its card (and the
  launch button) goes away after a couple of refreshes — that is the signal working, not
  the client forgetting. The launcher log ends and `launchctl print gui/$UID/com.georgeharker.unbien.launcher`
  shows `last exit code = 78: EX_CONFIG`: the classic cause is a **stale absolute node path**
  baked into the LaunchAgent after a Homebrew node bump. `unbien-admin install` re-snapshots
  node and PATH; the daemon then re-announces and the button is back.
- **A refresh puts the form back, folder and all.** With the panel open, the page
  you are on is that control room, so it is what a reload reopens — the heading,
  the folder path and the name you had typed (`unbien.web.launchDraft.v1`). The
  folder is worth keeping precisely because the machine cannot supply it: it is the
  one field you type by hand on a phone keyboard. Reopening the panel on purpose
  also refills it — and the folder list re-filters to whatever is in the field, so
  a restored path arrives with its group open (or with "no folder listed by this
  machine matches what is in the field — it still launches if the folder exists
  there" when it is outside the allow-list, which is not an error). A resumed form
  does not steal focus; the keyboard only appears when you asked to type.
  **close** puts back the page the launcher was opened on top of: reading a
  session, tapping _new conversation_, then closing the panel leaves that session
  as the page a reload returns to — scroll position included. Going to the
  launcher and coming back is not abandoning the session; **detach** is the
  control that says stop, and it clears both. If nothing was underneath, closing
  is a plain exit and the subtitle says "not attached".
- **Refreshing during a launch does not cancel it, and no longer loses it.**
  Pressing _launch_ sends a request id that the machine echoes back twice: in its
  answer, and in the room it starts (`launchReq`). The id is stored, so the ask
  outlives the tab. Reload mid-launch and the client either opens the session that
  appeared ("that launch finished while the page was closed — opening it") or says
  it is still waiting ("still waiting for <machine> to start <folder>"). The
  record goes away when the room is in hand, when the machine refuses, when the
  machine is unpaired, and after 10 minutes of silence — long because a cold start
  on a loaded machine is exactly when you reload, and an exact id match cannot be
  mistaken for another device's session. **close** on the panel does NOT cancel
  it: the request is with the machine, so the room still opens itself when it
  lands, and a reload after the close still recognises it. **detach** does.
- **`refresh` twice can print "relay did not answer the session listing".** The relay keeps
  the last `rooms` response per connection and SUPPRESSES an identical repeat
  (`rooms_suppressed` metric), so the second identical listing never arrives and
  `listRooms` times out. Nothing is wrong — the last known list stands. The client now only
  says this when the machine's card is already empty.

The client targets the **`is_daemon`** room specifically. A pi in a folder with
`allow_remote_launch` advertises `remote_launch` too (and answers `session_launch`), but its
room is a chat: grabbing it would hide the transcript the user is reading and take away its
attach button.

The machine answers with `session_launch_result`; a refusal is printed under the form
with the setting that owns it (`launch.dirs` allow-list, `allow_remote_launch`, a folder
that does not exist, a missing backend). Success is confirmed twice: the result frame, then
the launched session's announce, whose `launchReq` echoes the request id — that match is
what auto-opens the new chat. Verified end to end 2026-11-21 against a real daemon:
`/Users/you/Desktop` → `permission_denied` + the allow-list hint; `~/dev/myai` →
pi in a tmux window named `web-smoke`, browser attached to it a second later.

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

| Symptom                                                       | Likely cause                                                                                                                                                                                                                                                |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pairing refused: …`                                          | code already used, or you are on a different relay than when it was minted                                                                                                                                                                                  |
| red line: `Token was not issued by this Pi` / `token expired` | the code is spent or older than 60s — run `/unbien pair` again                                                                                                                                                                                              |
| green line: `already paired … re-confirmed`, no new card      | this browser already holds that pairing — press **attach** on a room                                                                                                                                                                                        |
| Header stuck at `not connected`                               | relay URL typo/scheme, relay not up, or port 3000 in use by another relay                                                                                                                                                                                   |
| Client refuses the socket, mentions "a different relay"       | relay key changed since you paired — the TOFU pin, working as designed                                                                                                                                                                                      |
| Page full-reloads on a phone                                  | you are on `dev`, not `preview`                                                                                                                                                                                                                             |
| **new conversation** shows no folders                         | the panel shows what the machine answers: `wildcard`/`locked`/remote-launch-off is said in the hint under the list, an old launcher daemon does not answer at all (type the path), and the folders are painted as ROWS — there is no dropdown to be missing |
| Transcript stops mid-turn but the machine kept going          | you are attached to a different room, or the machine re-announced and the re-attach is mid-walk                                                                                                                                                             |
| `__unbienDump` returns a tiny count                           | you were never attached — attach first, the tee only records while connected                                                                                                                                                                                |
| Port 5173 busy                                                | `strictPort: true`: the server refuses to pick another port, kill the other instance                                                                                                                                                                        |

This is a **spike**: no offline story, no push notifications, one file per concern, and
the dev-server exposure above is not a deployment. A real one wants TLS, a static host,
and `wss://`.
