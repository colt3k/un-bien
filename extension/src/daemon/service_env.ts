/**
 * service_env.ts — what the launcher service runs on, which environment it
 * gets, and which package manager un-bien's own global installs use. All read
 * from the global config (`service`, `package_manager`) at install time.
 *
 * A service unit is a snapshot: launchd / systemd start the daemon with only
 * what the unit names, so anything the daemon (and the pis it launches) needs
 * from the user's shell has to be written into it. The runtime is pinned to
 * an absolute path for the same reason.
 */
import { existsSync } from "node:fs"
import { delimiter, isAbsolute, join } from "node:path"
import type { UnBienConfig } from "../config.js"

/** Copied into the service unless `service.env` says otherwise: the XDG
 *  base-dir variables (tools that read config/data dirs from them, e.g.
 *  bun's bunfig) and bun's install locations. */
export const DEFAULT_SERVICE_ENV: readonly string[] = [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "BUN_INSTALL",
  "BUN_INSTALL_CACHE_DIR",
]

/** Variables every unit already sets itself (templates / UNBIEN_* rendering),
 *  never copied a second time. */
const SET_BY_TEMPLATE = new Set(["HOME", "PATH", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"])

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The names to copy: `service.env` (or the default) plus
 *  `UNBIEN_SERVICE_ENV`, deduplicated, valid names only. */
export function serviceEnvNames(
  config: UnBienConfig,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const configured = Array.isArray(config.service?.env) ? config.service.env : DEFAULT_SERVICE_ENV
  const extra = (env["UNBIEN_SERVICE_ENV"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  return [...new Set([...configured, ...extra])].filter(
    (name) => ENV_NAME.test(name) && !SET_BY_TEMPLATE.has(name) && !name.startsWith("UNBIEN_"),
  )
}

/** Every variable the service gets from the installing environment:
 *  `UNBIEN_*`, plus the configured names that are set. */
export function serviceEnv(
  config: UnBienConfig,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith("UNBIEN_") && v !== undefined) out[k] = v
  }
  for (const name of serviceEnvNames(config, env)) {
    const v = env[name]
    if (v !== undefined && v !== "") out[name] = v
  }
  return out
}

/** Find `name` on `path` (the first executable-looking hit). */
export function whichOnPath(name: string, path: string = process.env["PATH"] ?? ""): string | null {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""]
  for (const dir of path.split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/** The absolute runtime binary the launcher service runs on: `service.runtime`
 *  (a name resolved on PATH, or an absolute path), else the runtime running
 *  the install. Throws when the configured runtime cannot be found, so the
 *  install fails instead of writing a unit that cannot start. */
export function resolveServiceRuntime(
  config: UnBienConfig,
  opts: { execPath?: string; path?: string } = {},
): string {
  const configured = config.service?.runtime?.trim()
  if (!configured) return opts.execPath ?? process.execPath
  if (isAbsolute(configured)) {
    if (!existsSync(configured)) throw new Error(`service.runtime ${configured} does not exist`)
    return configured
  }
  const found = whichOnPath(configured, opts.path)
  if (!found) throw new Error(`service.runtime "${configured}" was not found on PATH`)
  return found
}

export type PackageManager = "npm" | "bun" | "pnpm"

/** The configured package manager for un-bien's own global installs. */
export function packageManager(config: UnBienConfig): PackageManager {
  const pm = config.package_manager
  return pm === "bun" || pm === "pnpm" ? pm : "npm"
}

/** The global-install command for `spec` under `pm`. */
export function globalInstallCommand(
  pm: PackageManager,
  spec: string,
): { cmd: string; args: string[]; display: string } {
  const win = process.platform === "win32"
  const args = pm === "npm" ? ["install", "-g", spec] : ["add", "-g", spec]
  const cmd = pm === "bun" ? "bun" : win ? `${pm}.cmd` : pm
  return { cmd, args, display: `${pm} ${args.join(" ")}` }
}
