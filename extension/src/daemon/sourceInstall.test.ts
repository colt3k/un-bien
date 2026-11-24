/**
 * sourceInstall — when an install should use this checkout's package directory
 * instead of the published one, and why not when it shouldn't. The failure mode
 * this guards is silent: a registry build, older than the checkout, landing in
 * the global tree that services (and the installer's own delegation) then run.
 */
import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SOURCE_PACKAGES,
  installFromSourceMode,
  isGlobalCopy,
  localPackageFor,
  sameFile,
  workspaceRootFor,
} from "./sourceInstall.js"

/** A throwaway workspace: root/pnpm-workspace.yaml + a built `launcher/`. */
function fixture(opts: { built?: boolean; name?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "unbien-src-"))
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - launcher\n")
  const pkgDir = join(root, "launcher")
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({
      name: opts.name ?? "@geohar/un-bien-launcher",
      version: "0.1.93",
    }),
  )
  if (opts.built !== false) {
    mkdirSync(join(pkgDir, "dist"), { recursive: true })
    writeFileSync(join(pkgDir, "dist", "index.js"), "// built\n")
  }
  // The caller's location: dist/daemon inside a workspace member.
  const here = join(root, "extension", "dist", "daemon")
  mkdirSync(here, { recursive: true })
  return { root, pkgDir, here }
}

describe("workspaceRootFor", () => {
  it("walks up to the dir holding pnpm-workspace.yaml", () => {
    const { root, here } = fixture()
    expect(workspaceRootFor(here)).toBe(root)
  })

  it("is null above a published install (no workspace file)", () => {
    const dir = mkdtempSync(join(tmpdir(), "unbien-nows-"))
    // Nothing named pnpm-workspace.yaml anywhere up to "/" — inject exists().
    expect(
      workspaceRootFor(dir, (p) => !p.endsWith("pnpm-workspace.yaml")),
    ).toBe(null)
  })
})

describe("localPackageFor", () => {
  it("never → the registry, whatever the tree looks like", () => {
    const { here } = fixture()
    const d = localPackageFor({
      pkgName: "@geohar/un-bien-launcher",
      mode: "never",
      here,
    })
    expect(d.source).toBeNull()
    expect(d.reason).toContain("never")
  })

  it("auto outside a checkout → the published package", () => {
    const dir = mkdtempSync(join(tmpdir(), "unbien-plain-"))
    const d = localPackageFor({
      pkgName: "@geohar/un-bien-launcher",
      mode: "auto",
      here: dir,
      exists: (p) => !p.endsWith("pnpm-workspace.yaml"),
    })
    expect(d.source).toBeNull()
    expect(d.reason).toContain("not a workspace checkout")
  })

  it("always outside a checkout says so (never silently falls back)", () => {
    const dir = mkdtempSync(join(tmpdir(), "unbien-always-"))
    const d = localPackageFor({
      pkgName: "@geohar/un-bien-launcher",
      mode: "always",
      here: dir,
      exists: (p) => !p.endsWith("pnpm-workspace.yaml"),
    })
    expect(d.source).toBeNull()
    expect(d.reason).toContain("install_from_source: always")
  })

  it("auto inside a checkout → the sibling dir, with its version", () => {
    const { pkgDir, here } = fixture()
    const d = localPackageFor({
      pkgName: "@geohar/un-bien-launcher",
      mode: "auto",
      here,
    })
    expect(d.source?.path).toBe(pkgDir)
    expect(d.source?.version).toBe("0.1.93")
    expect(d.reason).toContain("from this checkout")
  })

  it("a NESTED workspace file does not stop the walk", () => {
    // The real repo's shape: pnpm-workspace.yaml at the root AND inside
    // extension/ (allowBuilds/overrides). Stopping at the nearest marker looks
    // for extension/launcher, finds nothing, and installs the registry build.
    const root = mkdtempSync(join(tmpdir(), "unbien-nested-"))
    writeFileSync(
      join(root, "pnpm-workspace.yaml"),
      "packages:\n  - launcher\n",
    )
    const ext = join(root, "extension")
    mkdirSync(ext, { recursive: true })
    writeFileSync(
      join(ext, "pnpm-workspace.yaml"),
      "allowBuilds:\n  esbuild: true\n",
    )
    const here = join(ext, "dist", "daemon")
    mkdirSync(here, { recursive: true })
    const pkgDir = join(root, "launcher")
    mkdirSync(join(pkgDir, "dist"), { recursive: true })
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "@geohar/un-bien-launcher", version: "0.1.93" }),
    )
    writeFileSync(join(pkgDir, "dist", "index.js"), "// built\n")
    const d = localPackageFor({
      pkgName: "@geohar/un-bien-launcher",
      mode: "auto",
      here,
      requireFile: "dist/index.js",
    })
    expect(d.source?.path).toBe(pkgDir)
  })

  it("workspace markers without that package say so, precisely", () => {
    const root = mkdtempSync(join(tmpdir(), "unbien-nomember-"))
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - other\n")
    const here = join(root, "extension", "dist", "daemon")
    mkdirSync(here, { recursive: true })
    const d = localPackageFor({
      pkgName: "@geohar/un-bien-launcher",
      mode: "auto",
      here,
    })
    expect(d.source).toBeNull()
    expect(d.reason).toContain("contains launcher/ naming")
  })

  it("a wrong-named member below does not hide the right one above", () => {
    const base = mkdtempSync(join(tmpdir(), "unbien-twolevel-"))
    const inner = join(base, "inner")
    mkdirSync(inner, { recursive: true })
    writeFileSync(
      join(inner, "pnpm-workspace.yaml"),
      "packages:\n  - launcher\n",
    )
    mkdirSync(join(inner, "launcher"), { recursive: true })
    writeFileSync(
      join(inner, "launcher", "package.json"),
      JSON.stringify({ name: "unrelated-launcher" }),
    )
    const here = join(inner, "launcher", "dist")
    mkdirSync(here, { recursive: true })
    writeFileSync(
      join(base, "pnpm-workspace.yaml"),
      "packages:\n  - launcher\n",
    )
    mkdirSync(join(base, "launcher", "dist"), { recursive: true })
    writeFileSync(
      join(base, "launcher", "package.json"),
      JSON.stringify({ name: "@geohar/un-bien-launcher", version: "0.1.93" }),
    )
    writeFileSync(join(base, "launcher", "dist", "index.js"), "// built\n")
    const d = localPackageFor({
      pkgName: "@geohar/un-bien-launcher",
      mode: "auto",
      here,
      requireFile: "dist/index.js",
    })
    expect(d.source?.path).toBe(join(base, "launcher"))
  })

  it("an unbuilt package is NOT installed from source", () => {
    // Installing a directory ships what is on disk; with no dist/ the command
    // that lands cannot run, which is worse than the registry copy.
    const { here } = fixture({ built: false })
    const d = localPackageFor({
      pkgName: "@geohar/un-bien-launcher",
      mode: "auto",
      here,
    })
    expect(d.source).toBeNull()
    expect(d.reason).toContain("pnpm build")
  })

  it("requireFile pins the check to the entry that must exist", () => {
    const { root, here } = fixture()
    const pkg = join(root, "extension")
    mkdirSync(join(pkg, "dist"), { recursive: true }) // dist/ but no bin/
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "@geohar/un-bien", version: "0.25.19" }),
    )
    const d = localPackageFor({
      pkgName: "@geohar/un-bien",
      mode: "auto",
      here,
      requireFile: "dist/bin/launcher.js",
    })
    expect(d.source).toBeNull()
    expect(d.reason).toContain("dist/bin/launcher.js")
  })

  it("a directory whose manifest names a different package is refused", () => {
    const { here } = fixture({ name: "somebody-elses-launcher" })
    const d = localPackageFor({
      pkgName: "@geohar/un-bien-launcher",
      mode: "auto",
      here,
    })
    expect(d.source).toBeNull()
    expect(d.reason).toContain("somebody-elses-launcher")
  })

  it("a package this repo does not ship falls back to the registry", () => {
    const { here } = fixture()
    const d = localPackageFor({
      pkgName: "pi-web-access",
      mode: "always",
      here,
    })
    expect(d.source).toBeNull()
    expect(d.reason).toContain("not shipped")
  })
})

describe("SOURCE_PACKAGES", () => {
  it("covers the three packages un-bien installs globally", () => {
    expect(SOURCE_PACKAGES["@geohar/un-bien"]).toBe("extension")
    expect(SOURCE_PACKAGES["@geohar/un-bien-launcher"]).toBe("launcher")
    expect(SOURCE_PACKAGES["@geohar/unbien-cli"]).toBe("unbien-cli")
  })
})

describe("sameFile", () => {
  const real = (p: string) =>
    p.includes("global") ? p.replace("global", "src") : p

  it("links and copies are the same file once symlinks resolve", () => {
    expect(
      sameFile(
        "/src/launcher/dist/index.js",
        "/global/launcher/dist/index.js",
        real,
      ),
    ).toBe(true)
  })
  it("different files stay different", () => {
    expect(sameFile("/src/a/index.js", "/src/b/index.js", (p) => p)).toBe(false)
  })
  it("relative paths and stat failures are not the same file", () => {
    expect(sameFile("a/index.js", "a/index.js", (p) => p)).toBe(false)
    expect(
      sameFile("/a/index.js", "/b/index.js", () => {
        throw new Error("ENOENT")
      }),
    ).toBe(false)
  })
})

describe("isGlobalCopy", () => {
  it("a registry copy under the global root is the global copy", () => {
    const root = mkdtempSync(join(tmpdir(), "unbien-glr-"))
    const entry = join(root, "@geohar", "un-bien", "dist", "bin", "launcher.js")
    mkdirSync(join(entry, ".."), { recursive: true })
    writeFileSync(entry, "// built\n")
    expect(isGlobalCopy(root, "@geohar/un-bien", entry)).toBe(true)
  })

  it("a LINKED from-source global copy is the global copy too", () => {
    // `npm install -g <path>` links rather than copies, so the global entry and
    // the checkout differ lexically. Prefix matching alone says "different"
    // and the installer delegates to itself.
    const base = mkdtempSync(join(tmpdir(), "unbien-link-"))
    const checkout = join(base, "checkout", "extension")
    const entry = join(checkout, "dist", "bin", "launcher.js")
    mkdirSync(join(entry, ".."), { recursive: true })
    writeFileSync(entry, "// built\n")
    const globalRoot = join(base, "global", "node_modules")
    mkdirSync(join(globalRoot, "@geohar"), { recursive: true })
    symlinkSync(checkout, join(globalRoot, "@geohar", "un-bien"), "dir")
    expect(isGlobalCopy(globalRoot, "@geohar/un-bien", entry)).toBe(true)
  })

  it("an unrelated copy is not", () => {
    const base = mkdtempSync(join(tmpdir(), "unbien-unrel-"))
    const entry = join(base, "elsewhere", "dist", "bin", "launcher.js")
    mkdirSync(join(entry, ".."), { recursive: true })
    writeFileSync(entry, "// built\n")
    expect(isGlobalCopy(join(base, "global"), "@geohar/un-bien", entry)).toBe(
      false,
    )
  })
})

describe("installFromSourceMode", () => {
  it("defaults to auto, including for garbage values", () => {
    expect(installFromSourceMode(undefined)).toBe("auto")
    expect(installFromSourceMode("auto")).toBe("auto")
    expect(installFromSourceMode("always")).toBe("always")
    expect(installFromSourceMode("never")).toBe("never")
    expect(installFromSourceMode("yes please" as never)).toBe("auto")
  })
})
