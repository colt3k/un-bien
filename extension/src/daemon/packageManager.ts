/**
 * Which package manager pi is configured to use, from its `npmCommand`
 * setting, and the global-install argv built from it.
 *
 * pi's `npmCommand` (global settings.json, `string[]`) names the command pi
 * runs for npm package installs: `["bun"]`, `["pnpm"]`, or a wrapper like
 * `["bun-as-npm", "--", "bun"]` / `["mise", "exec", "--", "bun"]`. un-bien's
 * own global installs follow it (unless un-bien.json sets `package_manager`,
 * see service_env.ts), so the whole installation lives under one package
 * manager.
 *
 * Detection mirrors pi's `getPackageManagerName` (core/package-manager.ts)
 * so un-bien and pi never disagree about which manager a given `npmCommand`
 * means: the command after the last `--`, else the command itself if it's
 * npm/pnpm/bun, else the single npm/pnpm/bun among the wrapper's args.
 *
 * Only the GLOBAL setting is read: these are user-wide installs, so a
 * project's `.pi/settings.json` doesn't get a say. It is read from the file
 * directly, not through pi's SettingsManager: `unbien-admin` also runs
 * outside pi, where pi's packages may not resolve.
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"

export type PackageManagerName = "npm" | "pnpm" | "bun"

const SUPPORTED: ReadonlySet<string> = new Set(["npm", "pnpm", "bun"])

export interface GlobalInstallCommand {
  /** Which manager the command resolves to (`npm` for unknown wrappers). */
  manager: PackageManagerName
  command: string
  args: string[]
  /** Human-readable form for log lines. */
  display: string
}

const normalize = (cmd: string): string =>
  basename(cmd).replace(/\.(cmd|exe)$/i, "")

/** Which package manager an `npmCommand` means — pi's resolution. Unknown
 *  commands (a custom wrapper script naming no manager) are treated as npm,
 *  since pi sends them npm-style arguments too. */
export function packageManagerName(
  npmCommand: readonly string[] | undefined | null,
): PackageManagerName {
  if (!npmCommand || npmCommand.length === 0) return "npm"
  const [command, ...args] = npmCommand
  const direct = normalize(command ?? "")
  const sep = args.lastIndexOf("--")
  if (sep >= 0) {
    const wrapped = args[sep + 1]
    const name = wrapped ? normalize(wrapped) : direct
    return SUPPORTED.has(name) ? (name as PackageManagerName) : "npm"
  }
  if (SUPPORTED.has(direct)) return direct as PackageManagerName
  const wrapped = [
    ...new Set(args.map(normalize).filter((a) => SUPPORTED.has(a))),
  ]
  if (wrapped.length > 1) {
    throw new Error(
      `Ambiguous npmCommand package managers: ${wrapped.join(", ")}`,
    )
  }
  return (wrapped[0] as PackageManagerName | undefined) ?? "npm"
}

/** Global-install argv for `spec`, keeping any wrapper prefix from
 *  `npmCommand` (`["mise","exec","--","bun"]` → `mise exec -- bun add -g …`). */
export function globalInstallCommand(
  spec: string,
  npmCommand: readonly string[] | undefined | null,
  platform: NodeJS.Platform = process.platform,
): GlobalInstallCommand {
  const manager = packageManagerName(npmCommand)
  const verbArgs =
    manager === "npm" ? ["install", "-g", spec] : ["add", "-g", spec]

  let command: string
  let prefix: string[]
  if (npmCommand && npmCommand.length > 0 && npmCommand[0]?.trim()) {
    ;[command, ...prefix] = npmCommand as [string, ...string[]]
  } else {
    // No setting: plain npm. win32 needs the .cmd shim for execFile.
    command = platform === "win32" ? "npm.cmd" : "npm"
    prefix = []
  }
  const args = [...prefix, ...verbArgs]
  return {
    manager,
    command,
    args,
    display: [normalize(command), ...args].join(" "),
  }
}

/** pi's global agent dir: `PI_CODING_AGENT_DIR`, else `~/.pi/agent`. */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env["PI_CODING_AGENT_DIR"]
  return dir && dir.length > 0 ? dir : join(homedir(), ".pi", "agent")
}

/** pi's global `npmCommand`, or undefined when unset or unreadable. */
export function readPiNpmCommand(
  env: NodeJS.ProcessEnv = process.env,
): string[] | undefined {
  try {
    const raw = JSON.parse(
      readFileSync(join(piAgentDir(env), "settings.json"), "utf8"),
    ) as {
      npmCommand?: unknown
    }
    const cmd = raw.npmCommand
    return Array.isArray(cmd) &&
      cmd.length > 0 &&
      cmd.every((c) => typeof c === "string")
      ? (cmd as string[])
      : undefined
  } catch {
    return undefined
  }
}
