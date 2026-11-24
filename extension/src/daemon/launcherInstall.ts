/**
 * Launcher package install — `npm install -g @geohar/un-bien-launcher`, or
 * `npm install -g <this checkout>/launcher` when running from a checkout.
 *
 * The launcher daemon's wrapper is its own npm package, separate from the
 * extension — and nothing else ever updated it (observed live: the daemon
 * ran 0.20.54 across five ext releases because no install path touched the
 * package). `/unbien install launcher` (and `all`) installs/UPGRADES it
 * globally so the daemon runs current code, mirroring the CLI install.
 *
 * Which build lands matters as much as landing one: see sourceInstall.ts. From
 * a workspace checkout the sibling `launcher/` is installed, so the global tree
 * and the checkout are the same code; from a published install the registry
 * package is, as before.
 *
 * Idempotent: npm install -g over an existing install upgrades to latest.
 * We verify the bin afterwards via `unbien-launcher --version` and report
 * what landed.
 */

import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { promisify } from "node:util"
import { loadConfig } from "../config.js"
import {
  globalBinPath,
  globalInstallCommand,
  globalPackageRoot,
  packageManager,
} from "./service_env.js"
import { chooseInstallSpec, installFromSourceMode } from "./sourceInstall.js"

const execFileAsync = promisify(execFile)

/** The published launcher package (see un-bien-launcher/package.json `name`). */
export const LAUNCHER_PACKAGE = "@geohar/un-bien-launcher"

export interface LauncherInstallResult {
  version: string | null
  log: string[]
}

/** Channel: a DEV extension installs the CLI from the `dev` npm tag rather
 *  than the stable `latest` — so the whole installation rides one channel.
 *  Detect dev by the running extension's own package version (a "-dev"
 *  pre-release suffix). */
export function extIsDevChannel(): boolean {
  try {
    const here = fileURLToPath(import.meta.url)
    // dist/daemon/cliInstall.js → ../../.. = the extension package root
    // (three levels, matching _readExtensionVersion's resolution)
    const pkg = JSON.parse(
      readFileSync(join(here, "..", "..", "..", "package.json"), "utf8"),
    ) as { version?: string }
    return typeof pkg.version === "string" && pkg.version.includes("-dev")
  } catch {
    return false
  }
}

export async function installLauncherPackage(
  onLog?: (line: string) => void,
  opts?: { dev?: boolean },
): Promise<LauncherInstallResult> {
  const dev = opts?.dev ?? extIsDevChannel()
  const log: string[] = []
  const push = (l: string) => {
    log.push(l)
    onLog?.(l)
  }
  // This checkout when there is one, the registry otherwise (the reason is
  // logged when it falls back — never silently).
  const spec = chooseInstallSpec({
    pkgName: LAUNCHER_PACKAGE,
    registrySpec: dev ? `${LAUNCHER_PACKAGE}@dev` : LAUNCHER_PACKAGE,
    mode: installFromSourceMode(loadConfig().install_from_source),
    requireFile: "dist/index.js",
    onLog: push,
  }).spec

  // The configured package manager (`package_manager`: npm, bun or pnpm).
  const pm = packageManager(loadConfig())
  const install = globalInstallCommand(pm, spec)
  push(
    `${install.display}${dev ? "  (dev channel — matches this dev extension)" : ""} …`,
  )

  const { stdout, stderr } = await execFileAsync(install.cmd, install.args, {
    timeout: 5 * 60_000,
    maxBuffer: 4 * 1024 * 1024,
  }).catch((err) => {
    const detail =
      (err as { stderr?: string; message?: string }).stderr ??
      (err as { message?: string }).message ??
      String(err)
    throw new Error(
      `${install.display} failed: ${detail}\n` +
        `  If ${pm} isn't found, install it or set package_manager in un-bien.json.`,
    )
  })
  for (const line of `${stdout}\n${stderr}`.split("\n")) {
    if (line.trim()) push(line.trim())
  }

  // Verify: `unbien-launcher --version` (win32: npm writes unbien.cmd shims).
  let version: string | null = null
  try {
    // From the package manager's own bin dir: a different copy earlier on
    // PATH (e.g. an older npm install) would otherwise answer.
    const bin = globalBinPath(pm, "unbien-launcher")
    const { stdout: vOut } = await execFileAsync(bin, ["--version"], {
      timeout: 15_000,
    })
    version = vOut.trim() || null
    // Unambiguous channel report: the spec requested + the landed version
    // (a -dev suffix on the landed version CONFIRMS the dev channel took).
    const channel = dev
      ? "dev channel (@geohar/un-bien-launcher@dev)"
      : "stable (latest)"
    const landed =
      version && version.includes("-dev")
        ? "dev"
        : version && !version.includes("-dev")
          ? "stable"
          : "unknown"
    push(
      `verified: unbien-launcher ${version ?? "?"} — ${landed} channel` +
        (dev && landed !== "dev"
          ? " ⚠️ requested DEV but the landed binary is NOT a dev build — check npm"
          : "") +
        ` (requested: ${channel})`,
    )
  } catch {
    push(
      "⚠ installed, but `unbien-launcher --version` failed — the global bin dir of " +
        `${pm} ` +
        "may not be on $PATH. Open a new terminal and run `unbien-launcher --version`.",
    )
  }

  return { version, log }
}

/** The running extension's own version, or null when unreadable. */
export function extVersion(): string | null {
  try {
    const here = fileURLToPath(import.meta.url)
    const pkg = JSON.parse(
      readFileSync(join(here, "..", "..", "..", "package.json"), "utf8"),
    ) as { version?: string }
    return typeof pkg.version === "string" ? pkg.version : null
  } catch {
    return null
  }
}

/** The published extension package (it carries the launcher daemon's
 *  entry, dist/bin/launcher.js, and the unbien-admin bin). */
export const EXTENSION_PACKAGE = "@geohar/un-bien"

export interface ExtensionGlobalInstall {
  /** The launcher entry in the package manager's global copy. */
  launcherScript: string
  version: string | null
  log: string[]
}

/** Install this extension's own version globally with the configured
 *  package manager, and return the launcher entry in that copy, for a
 *  service that must not run pi's copy of the extension: pi's copy moves on
 *  every extension update and only resolves its host packages inside pi.
 *  The package manager also links unbien-admin. */
export async function installExtensionGlobally(
  onLog?: (line: string) => void,
): Promise<ExtensionGlobalInstall> {
  const log: string[] = []
  const push = (l: string) => {
    log.push(l)
    onLog?.(l)
  }
  const pm = packageManager(loadConfig())
  const version = extVersion()
  const chosen = chooseInstallSpec({
    pkgName: EXTENSION_PACKAGE,
    registrySpec: version
      ? `${EXTENSION_PACKAGE}@${version}`
      : EXTENSION_PACKAGE,
    mode: installFromSourceMode(loadConfig().install_from_source),
    requireFile: "dist/bin/launcher.js",
    onLog: push,
  })
  const install = globalInstallCommand(pm, chosen.spec)
  push(`${install.display} …`)
  const { stdout, stderr } = await execFileAsync(install.cmd, install.args, {
    timeout: 5 * 60_000,
    maxBuffer: 4 * 1024 * 1024,
  }).catch((err) => {
    const detail =
      (err as { stderr?: string; message?: string }).stderr ??
      (err as { message?: string }).message ??
      String(err)
    throw new Error(`${install.display} failed: ${detail}`)
  })
  for (const line of `${stdout}\n${stderr}`.split("\n")) {
    if (line.trim()) push(line.trim())
  }
  if (chosen.fromSource) {
    // Installed from a directory: the global entry is this checkout (npm links
    // it), so the launcher entry is the checkout's — no global-root guess.
    const launcherScript = join(chosen.spec, "dist", "bin", "launcher.js")
    if (!existsSync(launcherScript)) {
      throw new Error(`installed, but ${launcherScript} is missing`)
    }
    push(`launcher entry: ${launcherScript} (this checkout)`)
    return { launcherScript, version, log }
  }
  const root = globalPackageRoot(pm)
  if (!root) throw new Error(`could not find ${pm}'s global package directory`)
  const launcherScript = join(
    root,
    EXTENSION_PACKAGE,
    "dist",
    "bin",
    "launcher.js",
  )
  if (!existsSync(launcherScript)) {
    throw new Error(`installed, but ${launcherScript} is missing`)
  }
  push(`launcher entry: ${launcherScript}`)
  return { launcherScript, version, log }
}
