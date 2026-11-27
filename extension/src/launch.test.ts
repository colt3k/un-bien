import { describe, expect, test } from "vitest"
import {
  _buildTmuxLaunchArgs,
  launchSession,
  _buildHerdrWorkspaceArgs,
  _buildHerdrAgentStartArgs,
  _herdrPaneIdFromCreate,
  _expandTilde,
  _paneProbe,
  PANE_PROBE_MARK,
} from "./launch.js"

describe("launch backends — tmux/herdr argv + tilde expansion", () => {
  test("remote launch: first pi creates the shared tmux session (new-session, safe array)", () => {
    expect(
      _buildTmuxLaunchArgs(
        "un-bien",
        "pi-foo",
        "/tmp/work",
        false,
        "My Session",
      ),
    ).toEqual([
      "new-session",
      "-d",
      "-s",
      "un-bien",
      "-n",
      "pi-foo",
      "-c",
      "/tmp/work",
      "--",
      "pi",
      "-n",
      "My Session",
    ])
  })

  test("remote launch: no name → bare `pi` argv (path-derived name as before)", () => {
    expect(
      _buildTmuxLaunchArgs("un-bien", "pi-foo", "/tmp/work", false, undefined),
    ).toEqual([
      "new-session",
      "-d",
      "-s",
      "un-bien",
      "-n",
      "pi-foo",
      "-c",
      "/tmp/work",
      "--",
      "pi",
    ])
  })

  test("remote launch: blank name → no -n (treated as unset)", () => {
    expect(
      _buildTmuxLaunchArgs("un-bien", "pi-foo", "/tmp/work", false, "   "),
    ).toEqual(_buildTmuxLaunchArgs("un-bien", "pi-foo", "/tmp/work", false))
  })

  test("remote launch: later pis add a WINDOW to the shared session (new-window, no keystrokes)", () => {
    expect(
      _buildTmuxLaunchArgs(
        "un-bien",
        "pi-foo",
        "/tmp/work",
        true,
        "My Session",
      ),
    ).toEqual([
      "new-window",
      "-t",
      "un-bien:",
      "-n",
      "pi-foo",
      "-c",
      "/tmp/work",
      "--",
      "pi",
      "-n",
      "My Session",
    ])
  })

  test("remote launch: the tmux target names the SESSION, never a same-named window", () => {
    // Live failure, and the reason this is pinned. The shared session is
    // `un-bien`; launching in a folder named `un-bien` makes a WINDOW named
    // `un-bien`. tmux resolves a bare `-t un-bien` to that window, asks for a
    // new window at its (occupied) index, and every later launch dies with
    // "create window failed: index 2 in use". Reproduced on tmux 3.8; the
    // trailing colon is what keeps the target a session.
    const argv = _buildTmuxLaunchArgs(
      "un-bien",
      "un-bien",
      "/tmp/un-bien",
      true,
    )
    expect(argv.slice(0, 4)).toEqual(["new-window", "-t", "un-bien:", "-n"])
    // The session-CREATE branch needs no colon: -s already names a session.
    expect(_buildTmuxLaunchArgs("un-bien", "w", "/tmp/w", false)[3]).toBe(
      "un-bien",
    )
  })

  test("remote launch: herdr workspace-create argv is a safe array, cwd + label", () => {
    // No --json flag: herdr >=0.9.1 removed it and outputs JSON by default
    // (older builds rejected it outright with "unknown option: --json").
    expect(_buildHerdrWorkspaceArgs("pi-foo", "/tmp/work")).toEqual([
      "workspace",
      "create",
      "--cwd",
      "/tmp/work",
      "--label",
      "pi-foo",
      "--no-focus",
    ])
  })

  test("remote launch: herdr agent-start execs pi (canonical kind), not keystrokes", () => {
    expect(_buildHerdrAgentStartArgs("pi-foo", "pane-42")).toEqual([
      "agent",
      "start",
      "pi-foo",
      "--kind",
      "pi",
      "--pane",
      "pane-42",
    ])
    // No extra argv -> no bare `--` (herdr docs: args AFTER `--` pass through;
    // a trailing empty `--` is unnecessary).
    expect(_buildHerdrAgentStartArgs("pi-foo", "pane-42")).not.toContain("--")
  })

  test("remote launch: herdr agent-start passes resume argv after `--` (tmux parity)", () => {
    const argv = _buildHerdrAgentStartArgs("pi-foo", "pane-42", [
      "--session",
      "01a0128d",
    ])
    const idx = argv.indexOf("--")
    expect(idx).toBeGreaterThan(argv.indexOf("--pane"))
    expect(argv.slice(idx + 1)).toEqual(["--session", "01a0128d"])
  })

  test("remote launch: herdr pane id is parsed from `workspace create --json`", () => {
    const out = JSON.stringify({
      result: {
        workspace: { workspace_id: "ws-1" },
        tab: { tab_id: "tab-1" },
        root_pane: { pane_id: "pane-42" },
      },
    })
    expect(_herdrPaneIdFromCreate(out)).toBe("pane-42")
    // Malformed / missing pane id → null (caller aborts, never keystroke-injects).
    expect(_herdrPaneIdFromCreate("not json")).toBeNull()
    expect(_herdrPaneIdFromCreate(JSON.stringify({ result: {} }))).toBeNull()
  })

  test("remote launch: ~/ cwd expands to an absolute home path (Node fs won't)", () => {
    const expanded = _expandTilde("~/proj")
    expect(expanded.startsWith("~")).toBe(false)
    expect(expanded.startsWith("/")).toBe(true)
    expect(expanded.endsWith("/proj")).toBe(true)
    // absolute + relative paths pass through untouched
    expect(_expandTilde("/abs/path")).toBe("/abs/path")
    expect(_expandTilde("relative")).toBe("relative")
  })
})

describe("launch backends — resume passthrough", () => {
  test("tmux argv appends --session <target>", () => {
    const argv = _buildTmuxLaunchArgs(
      "un-bien",
      "win",
      "/tmp/proj",
      true,
      "my session",
      "01a0128d-dc23",
    )
    expect(argv).toContain("--session")
    expect(argv[argv.indexOf("--session") + 1]).toBe("01a0128d-dc23")
    expect(argv.indexOf("--session")).toBeGreaterThan(argv.indexOf("-n"))
  })

  test("no resume target -> no --session in argv", () => {
    const argv = _buildTmuxLaunchArgs("un-bien", "win", "/tmp/proj", false)
    expect(argv).not.toContain("--session")
  })

  test("herdr + resume is NOT refused (argv passthrough supported)", async () => {
    // herdr `agent start -- <args>` passes trailing args to pi unchanged, so
    // herdr resumes exactly like tmux. A NONEXISTENT cwd proves the old
    // resume-gate is gone: validation now reaches the cwd check (error there)
    // instead of the resume refusal firing first — with zero launch side
    // effects on machines that DO have herdr installed.
    const result = await launchSession({
      cwd: "/tmp/herdr-argv-passthrough-does-not-exist",
      resume: "01a0128d",
    })
    expect(result).toMatchObject({ ok: false, code: "cwd_missing" })
    expect(result.message).not.toMatch(/resume/i)
  })
})

describe("pane probe parsing — the early-exit watcher's only evidence", () => {
  // The watcher decides from this whether pi is alive. Reading stdout POSITION-
  // ally (the first token) broke on any machine whose login shell prints
  // something: a dead pane's `1` arrived on the second line, behind a banner,
  // and the dead pane was classified as alive — a crashed launch was reported to
  // the app as a success, and its window was left with a dead pane nobody reaped.
  const probe = (dead: string, status = "0") =>
    `${PANE_PROBE_MARK} ${dead} ${status}`

  test("a live pane", () => {
    expect(_paneProbe(`${probe("0")}\n`)).toEqual({ dead: false, status: "0" })
  })

  test("a dead pane with its exit status", () => {
    expect(_paneProbe(`${probe("1", "143")}\n`)).toEqual({
      dead: true,
      status: "143",
    })
  })

  test("a login-shell banner before the answer does not move the answer", () => {
    // Measured live: `~/.bashrc` echoes a startup timer, so stdout really looked
    // like this for a pane that had already exited.
    const stdout = `4 milliseconds\n${probe("1", "0")}\n`
    expect(_paneProbe(stdout)).toEqual({ dead: true, status: "0" })
  })

  test("no answer at all is 'could not read', never 'alive'", () => {
    expect(_paneProbe("6 milliseconds\n")).toBeNull()
    expect(_paneProbe("")).toBeNull()
  })

  test("a similar line is not mistaken for the answer", () => {
    expect(
      _paneProbe(`0 milliseconds\n${PANE_PROBE_MARK} not-a-digit\n`),
    ).toBeNull()
  })
})
