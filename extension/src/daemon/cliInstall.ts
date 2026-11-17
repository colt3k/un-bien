/**
 * CLI package install — `npm install -g @geohar/unbien-cli`, or the
 * equivalent for the package manager in pi's `npmCommand` setting (see
 * packageManager.ts).
 *
 * The terminal client (`unbien`) is its own npm package, separate from the
 * extension. `/unbien install cli` (and `all`) installs it globally so the
 * user gets the `unbien` bin on $PATH.
 *
 * Idempotent: a global install over an existing one upgrades to latest.
 * We verify the bin afterwards via `unbien --version` and report what landed.
 */

import { execFile } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { promisify } from "node:util"
import { globalBinHint, runGlobalInstall } from "./packageManager.js"

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

  const { manager } = await runGlobalInstall(spec, push, {
    note: dev ? "  (dev channel — matches this dev extension)" : "",
  })

  // Verify: `unbien --version` (win32: npm writes unbien.cmd shims).
  let version: string | null = null
  try {
    const bin = process.platform === "win32" ? "unbien.cmd" : "unbien"
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
          ? ` ⚠️ requested DEV but the landed binary is NOT a dev build — check ${manager}`
          : "") +
        ` (requested: ${channel})`,
    )
  } catch {
    push(
      `⚠ installed, but \`unbien --version\` failed — ${globalBinHint(manager)} ` +
        "may not be on $PATH. Open a new terminal and run `unbien --version`.",
    )
  }

  return { version, log }
}
