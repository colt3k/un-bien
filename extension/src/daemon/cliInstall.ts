/**
 * CLI package install — `npm install -g @geohar/unbien-cli`.
 *
 * The terminal client (`unbien`) is its own npm package, separate from the
 * extension. `/unbien install cli` (and `all`) installs it globally so the
 * user gets the `unbien` bin on $PATH.
 *
 * Idempotent: npm install -g over an existing install upgrades to latest.
 * We verify the bin afterwards via `unbien --version` and report what landed.
 */

import { execFile } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { promisify } from "node:util"
import { loadConfig } from "../config.js"
import { globalBinPath, globalInstallCommand, packageManager } from "./service_env.js"

const execFileAsync = promisify(execFile)

/** The published CLI package (see unbien-cli/package.json `name`). */
export const CLI_PACKAGE = "@geohar/unbien-cli"

export interface CliInstallResult {
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

export async function installCliPackage(
  onLog?: (line: string) => void,
  opts?: { dev?: boolean },
): Promise<CliInstallResult> {
  const dev = opts?.dev ?? extIsDevChannel()
  const spec = dev ? `${CLI_PACKAGE}@dev` : CLI_PACKAGE
  const log: string[] = []
  const push = (l: string) => {
    log.push(l)
    onLog?.(l)
  }

  // The configured package manager (`package_manager`: npm, bun or pnpm).
  const pm = packageManager(loadConfig())
  const install = globalInstallCommand(pm, spec)
  push(`${install.display}${dev ? "  (dev channel — matches this dev extension)" : ""} …`)

  const { stdout, stderr } = await execFileAsync(
    install.cmd,
    install.args,
    { timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024 },
  ).catch((err) => {
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

  // Verify: `unbien --version` (win32: npm writes unbien.cmd shims).
  let version: string | null = null
  try {
    // From the package manager's own bin dir: a different copy earlier on
    // PATH (e.g. an older npm install) would otherwise answer.
    const bin = globalBinPath(pm, "unbien")
    const { stdout: vOut } = await execFileAsync(bin, ["--version"], {
      timeout: 15_000,
    })
    version = vOut.trim() || null
    // Unambiguous channel report: the spec requested + the landed version
    // (a -dev suffix on the landed version CONFIRMS the dev channel took).
    const channel = dev
      ? "dev channel (@geohar/unbien-cli@dev)"
      : "stable (latest)"
    const landed =
      version && version.includes("-dev")
        ? "dev"
        : version && !version.includes("-dev")
          ? "stable"
          : "unknown"
    push(
      `verified: unbien ${version ?? "?"} — ${landed} channel` +
        (dev && landed !== "dev"
          ? " ⚠️ requested DEV but the landed binary is NOT a dev build — check npm"
          : "") +
        ` (requested: ${channel})`,
    )
  } catch {
    push(
      "⚠ installed, but `unbien --version` failed — the global bin dir of " + `${pm} ` +
        "may not be on $PATH. Open a new terminal and run `unbien --version`.",
    )
  }

  return { version, log }
}
