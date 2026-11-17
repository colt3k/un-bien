/**
 * Global package installs (`unbien-cli`, `un-bien-launcher`) through the
 * package manager pi is configured to use.
 *
 * pi's `npmCommand` setting (settings.json, `string[]`) names the command pi
 * runs for npm package installs — `["bun"]`, `["pnpm"]`, or a wrapper like
 * `["mise", "exec", "--", "bun"]`. Global installs follow the same setting so
 * the whole installation lives under one package manager; with it unset we
 * use npm, as before.
 *
 * Manager detection mirrors pi's own `getPackageManagerName`
 * (core/package-manager.ts) so un-bien and pi never disagree about which
 * manager a given `npmCommand` means: the command after the last `--`, else
 * the command itself if it's npm/pnpm/bun, else the single npm/pnpm/bun
 * among the wrapper's args.
 *
 * Only the GLOBAL setting is read: these are user-wide installs, so a
 * project's `.pi/settings.json` doesn't get a say (and reading it would need
 * project trust).
 */

import { execFile } from "node:child_process"
import { basename } from "node:path"
import { promisify } from "node:util"
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent"

const execFileAsync = promisify(execFile)

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
  npmCommand: readonly string[] | undefined,
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
  const wrapped = [...new Set(args.map(normalize).filter((a) => SUPPORTED.has(a)))]
  if (wrapped.length > 1) {
    throw new Error(`Ambiguous npmCommand package managers: ${wrapped.join(", ")}`)
  }
  return (wrapped[0] as PackageManagerName | undefined) ?? "npm"
}

/** Global-install argv for `spec`, keeping any wrapper prefix from
 *  `npmCommand` (`["mise","exec","--","bun"]` → `mise exec -- bun add -g …`). */
export function globalInstallCommand(
  spec: string,
  npmCommand: readonly string[] | undefined,
  platform: NodeJS.Platform = process.platform,
): GlobalInstallCommand {
  const manager = packageManagerName(npmCommand)
  const verbArgs = manager === "npm" ? ["install", "-g", spec] : ["add", "-g", spec]

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
  return { manager, command, args, display: [normalize(command), ...args].join(" ") }
}

/** pi's global `npmCommand`, or undefined when unset or unreadable (pi not
 *  installed alongside a CLI-mode install, malformed settings) — callers then
 *  fall back to npm. */
export function readPiNpmCommand(): string[] | undefined {
  try {
    return SettingsManager.create(process.cwd(), getAgentDir(), {
      projectTrusted: false,
    }).getNpmCommand()
  } catch {
    return undefined
  }
}

/** Where a manager links global bins, for the "not on PATH" hint. */
export function globalBinHint(manager: PackageManagerName): string {
  switch (manager) {
    case "bun":
      return "bun's global bin dir (`bun pm bin -g`)"
    case "pnpm":
      return "pnpm's global bin dir (`pnpm bin -g`)"
    default:
      return "the npm global bin dir"
  }
}

/** Run a global install of `spec` with pi's package manager, streaming
 *  output lines to `push`. Returns the resolved command (for follow-up
 *  messages). Throws with the manager's stderr on failure. */
export async function runGlobalInstall(
  spec: string,
  push: (line: string) => void,
  opts?: { npmCommand?: readonly string[]; note?: string },
): Promise<GlobalInstallCommand> {
  const npmCommand = opts && "npmCommand" in opts ? opts.npmCommand : readPiNpmCommand()
  const cmd = globalInstallCommand(spec, npmCommand)
  push(`${cmd.display}${opts?.note ?? ""} …`)

  const { stdout, stderr } = await execFileAsync(cmd.command, cmd.args, {
    timeout: 5 * 60_000,
    maxBuffer: 4 * 1024 * 1024,
  }).catch((err) => {
    const detail =
      (err as { stderr?: string; message?: string }).stderr ??
      (err as { message?: string }).message ??
      String(err)
    const hint =
      cmd.manager === "npm"
        ? "  If npm isn't found, install Node from https://nodejs.org and retry."
        : `  If ${cmd.manager} isn't found, install it or change pi's npmCommand setting.`
    throw new Error(`${cmd.display} failed: ${detail}\n${hint}`)
  })
  for (const line of `${stdout}\n${stderr}`.split("\n")) {
    if (line.trim()) push(line.trim())
  }
  return cmd
}
