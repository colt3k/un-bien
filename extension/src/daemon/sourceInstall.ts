/**
 * Installing un-bien's own packages from THIS checkout rather than the registry.
 *
 * `install launcher|cli|all`, and the delegation in housekeeping.ts, fetch from
 * the npm registry: `@geohar/un-bien`, `@geohar/un-bien-launcher`,
 * `@geohar/unbien-cli`. For someone who installed un-bien from npm that is
 * right. For someone running from a clone it is wrong: the checkout is the
 * source of truth and the registry copy is a different build — silently older,
 * and in the extension's case the copy an install DELEGATES to, which is how a
 * service ends up running code nobody is editing (observed live: a launcher
 * daemon running a months-old global build while the checkout was loaded).
 *
 * So when the running copy sits inside a workspace checkout, install the
 * sibling package directory (`npm install -g /abs/path/launcher`) instead of the
 * registry spec. npm links a local-path global install instead of copying it
 * (npm 11 does), so the installed command then tracks the checkout's `dist/`;
 * where a manager copies rather than links, what lands is still this checkout's
 * build. Either way nothing about the install depends on the registry.
 *
 * Config — `install_from_source` in un-bien.json:
 *   "auto" (default) only inside a workspace checkout, and only for packages
 *                    that are already BUILT (their `dist/` exists)
 *   "always"         same detection; an unbuilt package is reported rather
 *                    than silently downgraded to the registry copy
 *   "never"          registry specs — exactly the previous behaviour
 *
 * Registry DEPENDENCIES (ws, @noble/*, vite, pi's own host packages) are a
 * separate matter and always come from the registry; this is only about the
 * packages this repo ships.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export type InstallFromSource = "auto" | "always" | "never"

/** What each package this repo ships is published as, and where it lives.
 *  Directory names come from pnpm-workspace.yaml. */
export const SOURCE_PACKAGES: Readonly<Record<string, string>> = {
  "@geohar/un-bien": "extension",
  "@geohar/un-bien-launcher": "launcher",
  "@geohar/unbien-cli": "unbien-cli",
}

export interface LocalPackage {
  /** Absolute path of the package directory to install. */
  path: string
  version: string | null
}

export interface SourceDecision {
  /** The checkout's package to install, or null to fall back to the registry. */
  source: LocalPackage | null
  /** Why — shown to the user, so a fallback is never silent. */
  reason: string
}

type Exists = (p: string) => boolean
type Read = (p: string) => string

/**
 * The workspace root containing `startDir`, or null. Detected by walking up for
 * `pnpm-workspace.yaml` — the file that defines this repo's packages, and the
 * thing that is absent from a published-install tree.
 */
export function workspaceRootFor(
  startDir: string,
  exists: Exists = existsSync,
): string | null {
  let dir = resolve(startDir)
  for (;;) {
    if (exists(join(dir, "pnpm-workspace.yaml"))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * The checkout's directory for `pkgName`, when it is usable: it must be in the
 * workspace, its package.json must actually name `pkgName`, and it must be
 * built (a directory install ships whatever is on disk — `files`/`dist`
 * included — so an unbuilt package would install a command that cannot run).
 *
 * The workspace is the closest level above `here` that CONTAINS the package,
 * not the closest `pnpm-workspace.yaml`: this repo has one inside `extension/`
 * as well (it carries allowBuilds/overrides), and stopping there searches
 * `extension/launcher`, finds nothing, and silently installs the registry
 * build. Found by probing the built output, not by reading the code.
 */
export function localPackageFor(opts: {
  /** Published name of the package, e.g. `@geohar/un-bien-launcher`. */
  pkgName: string
  mode: InstallFromSource
  /** A path inside the running copy — a file URL or directory. */
  here: string
  /** Extra file that must exist inside the package (e.g. `dist/index.js`). */
  requireFile?: string
  exists?: Exists
  readFile?: Read
}): SourceDecision {
  const exists = opts.exists ?? existsSync
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"))
  const dirName = SOURCE_PACKAGES[opts.pkgName]

  if (opts.mode === "never") {
    return { source: null, reason: "install_from_source: never" }
  }
  if (!dirName) {
    return {
      source: null,
      reason: `${opts.pkgName} is not shipped by this repo`,
    }
  }

  let dir = resolve(opts.here)
  let sawWorkspace = false
  let nearMiss: string | null = null
  for (;;) {
    if (exists(join(dir, "pnpm-workspace.yaml"))) {
      sawWorkspace = true
      const pkgDir = resolve(join(dir, dirName))
      const manifest = join(pkgDir, "package.json")
      if (exists(manifest)) {
        let name: string | null = null
        let version: string | null = null
        try {
          const pkg = JSON.parse(readFile(manifest)) as {
            name?: string
            version?: string
          }
          name = typeof pkg.name === "string" ? pkg.name : null
          version = typeof pkg.version === "string" ? pkg.version : null
        } catch {
          nearMiss ??= `${manifest} does not parse`
        }
        if (name === opts.pkgName) {
          // Found the package. Only now does the build check apply: a directory
          // install ships what is on disk, so no dist/ means an installed
          // command that cannot run — worse than the published build.
          const unbuilt = opts.requireFile
            ? !exists(join(pkgDir, opts.requireFile))
            : !exists(join(pkgDir, "dist"))
          if (unbuilt) {
            const needed = opts.requireFile ?? "dist/"
            return {
              source: null,
              reason:
                `${dirName}/ is in this checkout but has no ${needed} — ` +
                `build it (pnpm build) or the installed command would not run`,
            }
          }
          return {
            source: { path: pkgDir, version },
            reason: `from this checkout: ${pkgDir}`,
          }
        }
        nearMiss ??= `${manifest} names ${name ?? "(no name)"}, not ${opts.pkgName}`
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  if (nearMiss) return { source: null, reason: nearMiss }
  return {
    source: null,
    reason: sawWorkspace
      ? `no workspace checkout above this copy contains ${dirName}/ naming ${opts.pkgName}`
      : opts.mode === "always"
        ? "install_from_source: always, but this is not a workspace checkout (no pnpm-workspace.yaml above it)"
        : "not a workspace checkout — installing the published package",
  }
}

/** The spec to install: this checkout's directory when the decision says so,
 *  otherwise the registry spec. A fallback is LOGGED — an unexplained downgrade
 *  to a published build is the bug this module exists to prevent. */
export function chooseInstallSpec(opts: {
  pkgName: string
  registrySpec: string
  mode: InstallFromSource
  requireFile?: string
  here?: string
  exists?: Exists
  onLog?: (line: string) => void
}): { spec: string; fromSource: boolean; reason: string } {
  const decision = localPackageFor({
    pkgName: opts.pkgName,
    mode: opts.mode,
    here: opts.here ?? fileURLToPath(import.meta.url),
    requireFile: opts.requireFile,
    exists: opts.exists,
  })
  if (!decision.source && opts.mode !== "never") {
    opts.onLog?.(`${opts.pkgName}: ${decision.reason}`)
  }
  return {
    spec: decision.source?.path ?? opts.registrySpec,
    fromSource: decision.source !== null,
    reason: decision.reason,
  }
}

/** Whether `launcherScript` (the copy this code would run) IS the package
 *  manager's global copy of the extension. Lexical prefix matching is not
 *  enough: a from-source install LINKS the global entry into the checkout, so
 *  the two paths differ lexically while naming one set of files — and a copy
 *  that is itself the global copy must not delegate to a "global copy". */
export function isGlobalCopy(
  globalRoot: string,
  pkgName: string,
  launcherScript: string,
): boolean {
  const own = join(globalRoot, pkgName, "dist", "bin", "launcher.js")
  if (launcherScript.startsWith(join(globalRoot, pkgName) + "/")) return true
  return sameFile(launcherScript, own, realpathSync)
}

/** Resolve the config value, defaulting to auto. Kept separate so callers do
 *  not each invent their own default. */
export function installFromSourceMode(
  value: InstallFromSource | undefined,
): InstallFromSource {
  return value === "always" || value === "never" ? value : "auto"
}

/** Whether `a` and `b` name the same file after symlinks. A from-source global
 *  install links the package into the global tree, so the global path and the
 *  checkout path differ lexically while pointing at one set of files. */
export function sameFile(
  a: string,
  b: string,
  realpath: (p: string) => string,
): boolean {
  if (!isAbsolute(a) || !isAbsolute(b)) return false
  if (a === b) return true
  try {
    return realpath(a) === realpath(b)
  } catch {
    return false
  }
}
