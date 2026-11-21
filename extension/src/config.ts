import fs from "node:fs"
import path from "node:path"
import { legacyUnbienConfigHome, unbienConfigHome } from "./paths.js"

// Resolved at call time via `unbienConfigHome()` — the global config is a pi
// extension config at `<agent dir>/extensions/un-bien.json`, the agent dir
// being pi's (PI_CODING_AGENT_DIR, else ~/.pi/agent). See paths.ts.
const CONFIG_NAME = "un-bien.json"
const configDir = (): string => unbienConfigHome()
const configFile = (): string => {
  migrateLegacyConfig()
  return path.join(unbienConfigHome(), CONFIG_NAME)
}

let legacyChecked = false

/**
 * Move a config from where versions before 0.25.17 kept it with
 * PI_CODING_AGENT_DIR unset (~/.pi/extensions/un-bien.json) to pi's agent dir
 * (~/.pi/agent/extensions/un-bien.json). Runs once per process, before the
 * first read or write, and only when the new file does not exist yet.
 *
 * The old path is then replaced by a symlink to the new file, so an older
 * un-bien (or relay) still running on this machine reads and writes the same
 * settings. Where a symlink cannot be made, the old file is left as it was (a
 * copy). Best-effort: on any failure the old file is read instead, so no
 * settings are lost.
 */
export function migrateLegacyConfig(): void {
  if (legacyChecked) return
  legacyChecked = true
  const legacyDir = legacyUnbienConfigHome()
  if (!legacyDir) return
  const legacy = path.join(legacyDir, CONFIG_NAME)
  const target = path.join(unbienConfigHome(), CONFIG_NAME)
  if (legacy === target || fs.existsSync(target)) return
  try {
    if (!fs.lstatSync(legacy).isFile()) return
  } catch {
    return // no legacy config
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(legacy, target, fs.constants.COPYFILE_EXCL)
  } catch (err) {
    console.error(`[un-bien] could not move ${legacy} to ${target}: ${String(err)}; still reading the old file`)
    return
  }
  try {
    const link = `${legacy}.link-${process.pid}`
    fs.symlinkSync(target, link)
    fs.renameSync(link, legacy)
  } catch {
    /* no symlinks here: the old file stays as a copy */
  }
  console.error(`[un-bien] global config moved to ${target} (pi's agent dir)`)
}

/** The config file to read: the current one, or the legacy one when the
 *  migration could not copy it (see migrateLegacyConfig). */
const readableConfigFile = (): string => {
  const current = configFile()
  if (fs.existsSync(current)) return current
  const legacyDir = legacyUnbienConfigHome()
  const legacy = legacyDir ? path.join(legacyDir, CONFIG_NAME) : null
  return legacy && fs.existsSync(legacy) ? legacy : current
}

/** Test-only: let migrateLegacyConfig run again. */
export function _resetLegacyConfigCheckForTest(): void {
  legacyChecked = false
}

export type UnBienConfig = {
  relay?: string
  /**
   * Debug prefs. Fields here gate the file-based diagnostic logs (see
   * `session/debug_log.ts` and `panel_bridge.ts`). Read from config — NOT env —
   * because the extension usually runs detached and doesn't inherit a shell's env, so
   * a persisted config field is the only reliable enable switch. Absent/false by
   * default: no logging.
   */
  debug?: {
    envelope?: boolean
    panels?: boolean
    /** Launcher daemon operational log (`<state>/launcher.log`): per-frame
     *  chatter, session_launch gates, connect lifecycle. Default false —
     *  with the pref off, only the service unit's stdout redirect (startup /
     *  shutdown / fatal, undated) reaches the file. Separate from
     *  `envelope` so enabling the launcher log doesn't drag in extension
     *  envelope debugging. Read once at first log line; restart the daemon
     *  to pick up a flip. */
    launcher?: boolean
    /** Relay log level (`relay.log`): when true (and RUST_LOG is unset),
     *  the relay upgrades its tracing filter from the default ERROR-only to
     *  INFO — mesh storage, listens, peer/room lifecycle. Read by the relay
     *  process itself from this same config file at startup; restart the
     *  relay to pick up a flip. */
    relay?: boolean
  }
  /**
   * Machine-wide fallback defaults for a session's LOCAL config (the per-cwd
   * `.pi/un-bien/config.json`). A field here applies to every cwd that does
   * not set it via the inline `UNBIEN_DIRECT_CONFIG` env or its own file, so
   * you can pin `auto_start_relay` once — beside `relay` — instead of dropping a
   * file into every repo. See `session/local_config.ts`. Absent by default, so
   * omitting it preserves the historical per-cwd-only behaviour exactly.
   */
  defaults?: {
    auto_start_relay?: boolean
    allow_remote_launch?: boolean
    allow_remote_terminate?: boolean
  }
  /**
   * Machine-identity storage. `storage` selects the PRIMARY backend for this
   * Pi's long-term Ed25519 seed — `"keychain"` (OS-secured, the default) or
   * `"file"` (a 0600 seed file, the SSH-private-key model: cat-able, portable,
   * works headless). `path` overrides the file-backend location (default
   * `~/.local/state/un-bien/identity.json`). The unselected backend is still READ (to
   * recover an existing identity) but never written; the resolver mints only on
   * a genuine first run. See `pairing/storage.ts`. Absent ⇒ keychain default.
   */
  identity?: { storage?: "keychain" | "file"; path?: string }
  /**
   * Remote-launch backend selection (pick-one). Which session backend a
   * honored `session_launch` uses on THIS machine: `tmux` (default) or `herdr`
   * — both PTY-hosted / reattachable. `rpc` is a fast-follow, not yet a choice
   * here. This picks the mechanism machine-wide; whether remote launch is
   * enabled at all stays the per-cwd `allow_remote_launch` LocalConfig flag.
   * See `session_launch` handling in index.ts. Absent ⇒ tmux.
   *
   * `tmux_session` names the ONE shared tmux session that launched pis become
   * WINDOWS of (a window per pi, via clean `new-window`; single `tmux attach`
   * point). Absent ⇒ `"un-bien"`.
   */
  /**
   * `dirs` = the remote-launch directory ALLOW-LIST (design 01M211VW9):
   * `"*"` (or absent — the default) allows any cwd; a named list restricts
   * launch to those dirs (or nested paths). Consulted FRESH per launch request
   * (loadConfig reads the file each call), so edits take effect without a
   * restart. Whether launch is enabled at all is still the per-cwd
   * `allow_remote_launch` flag; `dirs` narrows WHERE within that.
   */
  launch?: {
    backend?: "tmux" | "herdr" | "rex"
    /** The backend to use when `backend` is UNAVAILABLE (binary missing, or
     *  Rex's server unreachable): never after a launch was attempted, so a
     *  session is never started twice. Absent / "none" ⇒ report the failure. */
    fallback?: "tmux" | "herdr" | "rex" | "none"
    tmux_session?: string
    /** Rex: the `rex` binary (default: PATH, then the Rex app bundle). */
    rex_bin?: string
    /** Rex: the server endpoint (default: the local server's socket under
     *  ~/Library/Application Support/rex). The launcher never starts one. */
    rex_server?: string
    /** Rex: the label of the session launched pis go into (default
     *  "un-bien"): an existing session with that label, else one created. */
    rex_session?: string
    dirs?: "*" | string[]
    /** The shell remote launches run through (a LOGIN shell, so the user's
     *  PATH/env load — launchd daemons otherwise spawn pi devoid of the
     *  user's environment). Absent ⇒ $SHELL ⇒ the OS login shell ⇒ zsh. */
    shell?: string
    /** Extra args for the launch shell (before the -c command): e.g.
     *  ["-l", "-i"] to also load interactive rc files. Default ["-l"]. */
    shell_args?: string[]
  }
  /**
   * The launcher service (launchd / systemd / Task Scheduler) that
   * `/unbien install` / `unbien-admin install` renders. Read at install time;
   * re-run the install to apply a change.
   *  - `runtime`: what runs the launcher: `"node"`, `"bun"`, or an absolute
   *    path. A name is resolved on PATH when installing. Absent ⇒ the runtime
   *    running the install (process.execPath).
   *  - `env`: names of variables copied from the installing environment into
   *    the service, in addition to `UNBIEN_*` (always copied) and HOME / PATH /
   *    PI_CODING_AGENT_DIR / PI_CODING_AGENT_SESSION_DIR. Only variables that
   *    are set are written. Absent ⇒ `DEFAULT_SERVICE_ENV` (the XDG base-dir
   *    variables and bun's install dirs). `UNBIEN_SERVICE_ENV` (comma
   *    separated) adds more.
   */
  service?: { runtime?: string; env?: string[] }
  /**
   * The package manager un-bien's global installs use: `npm`
   * (`npm install -g`), `bun` (`bun add -g`) or `pnpm` (`pnpm add -g`).
   * Absent ⇒ the one pi's global `npmCommand` names (its wrapper kept, e.g.
   * `bun-as-npm -- bun add -g`), else npm. With either set, `/unbien install`
   * runs from that package manager's global copy (see service_env.ts).
   */
  package_manager?: "npm" | "bun" | "pnpm"
  /**
   * Subagent surfacing. When `rooms` is true, a
   * Pi SUBAGENT is surfaced to the paired app as its OWN session — a distinct
   * relay room (under this machine's identity) that nests under its parent via
   * `room_meta.parent`. Read-only (view-only) for now. Absent/false ⇒ subagents
   * stay hidden from the app (historical behaviour). See `subagent_rooms.ts`.
   */
  subagents?: { rooms?: boolean }

  /** Cross-session mesh messaging. When `tools` is true (the default), the
   *  agent-mesh tools (`agent_send`, `list_peers`, `whoami`,
   *  `mesh_get_message`, `mesh_list_messages`, `mesh_wait_message`) are
   *  registered for the LLM to call — agents on the same broker (same
   *  machine) or across the relay (same owner) can message each other.
   *  Absent/false ⇒ the tools are NOT registered; the broker + relay still
   *  work for the paired app, but the model can't send/list/wait messages.
   *  See `docs/cross-session-comms.md` + `session/tools.ts`. */
  mesh?: {
    tools?: boolean
    /** Per-machine participation in relay FEDERATION (cross-relay peers).
     *  Distinct from `tools`: tools on + federation off = local/same-relay
     *  mesh only. The relay's `federation.enabled` gate remains the master
     *  opt-in; this is the per-machine refusal switch. Default true. */
    federation?: boolean
  }
}

export function loadConfig(): UnBienConfig {
  try {
    const raw = fs.readFileSync(readableConfigFile(), "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object") return {}
    return parsed as UnBienConfig
  } catch {
    return {}
  }
}

export function saveConfig(patch: Partial<UnBienConfig>): void {
  fs.mkdirSync(configDir(), { recursive: true })
  const current = loadConfig()
  const next = { ...current, ...patch }
  fs.writeFileSync(configFile(), JSON.stringify(next, null, 2))
}

export type RelayResolution =
  { url: string; source: "env" | "config" } | { url: null; source: "unset" }

/**
 * Resolves the effective relay URL in **canonical http(s):// form**.
 *
 * Precedence:
 *   1. `UNBIEN_RELAY` env var (ops/CI escape hatch)
 *   2. `relay` field in the global config
 *      (`<agent dir>/extensions/un-bien.json`, set via
 *      `/unbien set-relay`)
 *
 * There is NO built-in default. When neither is set, `url` is null and
 * `source` is `"unset"` — callers MUST refuse to connect and prompt the user
 * to configure a relay (un-bien ships pointing at nobody's infrastructure).
 *
 * Any ws(s):// values found (legacy configs or env overrides) are coerced
 * to http(s):// defensively — the canonical form across the codebase is
 * http(s)://, and the transport layer converts to ws(s):// at WS-open time.
 */
export function resolveRelayUrl(): RelayResolution {
  const env = process.env["UNBIEN_RELAY"]
  if (env && env.length > 0) return { url: toHttpUrl(env), source: "env" }
  const cfg = loadConfig()
  if (cfg.relay && cfg.relay.length > 0)
    return { url: toHttpUrl(cfg.relay), source: "config" }
  return { url: null, source: "unset" }
}

/**
 * Strict validator for **user-provided** relay URLs (via `/unbien
 * set-relay` or `/unbien relay url`).
 *
 * Only accepts `http://` and `https://`. `ws://`/`wss://` are deliberately
 * **rejected** — the canonical form stored in config is http(s):// and the
 * extension converts to ws(s):// internally when opening the WebSocket.
 * Forcing a single scheme at the user boundary avoids two-form drift.
 */
export function isValidRelayUrl(url: string): boolean {
  if (!url) return false
  const lower = url.toLowerCase()
  if (!lower.startsWith("http://") && !lower.startsWith("https://"))
    return false
  try {
    new URL(url)
    return true
  } catch {
    return false
  }
}

/**
 * Returns true if the URL uses ws:// or wss:// scheme — for emitting a
 * targeted error message when the user pastes a WebSocket URL by mistake.
 */
export function isWebSocketScheme(url: string): boolean {
  const lower = url.toLowerCase()
  return lower.startsWith("ws://") || lower.startsWith("wss://")
}

/**
 * Converts an http(s):// URL to the corresponding ws(s):// form. Used by
 * the transport layer right before opening the WebSocket — config storage
 * and the mesh HTTP client both stay on http(s)://.
 *
 *   https://host  → wss://host
 *   http://host   → ws://host
 *   ws(s)://host  → pass-through (defensive — env overrides or legacy
 *                   configs may still carry ws(s)://)
 */
export function toWebSocketUrl(url: string): string {
  const lower = url.toLowerCase()
  if (lower.startsWith("https://"))
    return "wss://" + url.slice("https://".length)
  if (lower.startsWith("http://")) return "ws://" + url.slice("http://".length)
  return url
}

/**
 * Inverse of `toWebSocketUrl`. Used by `resolveRelayUrl` to coerce any
 * ws(s):// values back to canonical http(s):// before returning them to
 * the rest of the codebase.
 */
export function toHttpUrl(url: string): string {
  const lower = url.toLowerCase()
  if (lower.startsWith("wss://")) return "https://" + url.slice("wss://".length)
  if (lower.startsWith("ws://")) return "http://" + url.slice("ws://".length)
  return url
}
