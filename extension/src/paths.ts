import { homedir } from "node:os"
import { join } from "node:path"
import { migrateLegacyStateOnce } from "./state_migration.js"

/**
 * Absolute root for un-bien on-disk STATE: `sessions/`, `skills/`, the
 * paired-identity/`peers.json` store, the daemon registries (`daemons.json`,
 * `cron.json`), the cron/audit logs, the supervisor socket, and the cwd lock
 * dir. Every state path in the codebase derives from this one resolver so a
 * relocated install can never split its state across two roots.
 *
 * The GLOBAL config is the one exception — it follows the coding-agent dir via
 * `unbienConfigHome()` (below) as `extensions/un-bien.json`, not this resolver
 * (design 01M1CB6Q: the config/state split).
 *
 * Precedence (resolved at CALL time so tests — and a relocated deployment —
 * can override via env without re-importing):
 *
 *   1. `UNBIEN_STATE_DIR` — an ABSOLUTE override of the state dir itself. This
 *      is the knob to reach for when relocating state.
 *   2. `UNBIEN_DIR`      — legacy absolute override, same semantics, lower
 *      precedence (kept because test suites use it).
 *   3. `UNBIEN_HOME`     — legacy stand-in `$HOME`; state lives at
 *      `<UNBIEN_HOME>/.pi/un-bien` (kept because test suites use it).
 *   4. `${XDG_STATE_HOME:-~/.local/state}/un-bien` — the XDG-style default.
 *      `XDG_STATE_HOME` unset (conventionally so on macOS) falls back to
 *      `$HOME/.local/state`.
 *
 * The resolver itself is pure — it returns a path and never touches the
 * filesystem. Writers create the root with mkdir -p on first use; the
 * one-time legacy migration (see `state_migration.ts`) is the first writer.
 */
export function resolveUnbienStateRoot(): string {
  const stateDir = process.env["UNBIEN_STATE_DIR"]
  if (stateDir && stateDir.length > 0) return stateDir
  const dir = process.env["UNBIEN_DIR"]
  if (dir && dir.length > 0) return dir
  const home = process.env["UNBIEN_HOME"]
  if (home && home.length > 0) return join(home, ".pi", "un-bien")
  const xdg = process.env["XDG_STATE_HOME"]
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "state")
  return join(base, "un-bien")
}

/**
 * The state root, with the one-time legacy-state migration hooked in. Same
 * name/signature as ever (many callers); see `resolveUnbienStateRoot()` for
 * the precedence order. The migration hook is cheap after the first call and
 * is skipped entirely under vitest, so tests can call this freely.
 */
export function unbienStateHome(): string {
  const root = resolveUnbienStateRoot()
  migrateLegacyStateOnce()
  return root
}

/**
 * pi's agent dir, resolved as pi resolves it (getAgentDir in pi's config.ts):
 * `PI_CODING_AGENT_DIR` when set and non-empty, a leading `~` expanded, else
 * `~/.pi/agent`.
 */
export function piAgentDir(): string {
  const dir = process.env["PI_CODING_AGENT_DIR"]
  if (!dir) return join(homedir(), ".pi", "agent")
  if (dir === "~") return homedir()
  if (dir.startsWith("~/")) return join(homedir(), dir.slice(2))
  return dir
}

/**
 * Root for un-bien's global config specifically — the machine-wide relay URL,
 * the `defaults` block, and the `debug` prefs. un-bien's config is a pi
 * extension config, beside pi's own settings: `<agent dir>/extensions/
 * un-bien.json`, the agent dir being pi's (`piAgentDir`). This resolver returns
 * the `extensions` dir; `config.ts` appends `un-bien.json`.
 *
 * State (sessions, daemon registries, cwd locks, identity) is unaffected — only
 * the global config follows the agent dir.
 */
export function unbienConfigHome(): string {
  return join(piAgentDir(), "extensions")
}

/**
 * Where versions before 0.25.17 kept the global config when
 * `PI_CODING_AGENT_DIR` was unset: `~/.pi/extensions`, not pi's default agent
 * dir (`~/.pi/agent`). Read only to migrate it (config.ts
 * migrateLegacyConfig); null when `PI_CODING_AGENT_DIR` is set, as those
 * versions then already used `<PI_CODING_AGENT_DIR>/extensions`.
 */
export function legacyUnbienConfigHome(): string | null {
  return process.env["PI_CODING_AGENT_DIR"] ? null : join(homedir(), ".pi", "extensions")
}
