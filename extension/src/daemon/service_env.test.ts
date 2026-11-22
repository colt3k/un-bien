import { afterEach, describe, expect, test } from "vitest"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_SERVICE_ENV,
  globalInstallCommand,
  packageManager,
  resolveServiceRuntime,
  serviceEnv,
  serviceEnvNames,
  globalPackageRoot,
  resolvePackageManager,
  packageManagerConfigured,
} from "./service_env.js"
import { _foreignBinOwner, unlinkCliBinaries } from "./install.js"

describe("service env", () => {
  test("defaults to the XDG and bun variables, plus UNBIEN_SERVICE_ENV", () => {
    expect(serviceEnvNames({}, {})).toEqual([...DEFAULT_SERVICE_ENV])
    expect(
      serviceEnvNames({}, { UNBIEN_SERVICE_ENV: "FOO, BAR ,FOO" }),
    ).toEqual([...DEFAULT_SERVICE_ENV, "FOO", "BAR"])
  })

  test("service.env replaces the default; invalid and template-set names are dropped", () => {
    expect(
      serviceEnvNames(
        { service: { env: ["ONLY", "PATH", "HOME", "UNBIEN_X", "bad-name"] } },
        {},
      ),
    ).toEqual(["ONLY"])
  })

  test("copies UNBIEN_* and the configured names that are set", () => {
    const env = {
      UNBIEN_RELAY_BIND: "x:3000",
      XDG_CONFIG_HOME: "/h/.config",
      BUN_INSTALL: "",
      OTHER: "no",
    }
    expect(serviceEnv({}, env)).toEqual({
      UNBIEN_RELAY_BIND: "x:3000",
      XDG_CONFIG_HOME: "/h/.config",
    })
  })
})

describe("service runtime", () => {
  const dir = mkdtempSync(join(tmpdir(), "svc-rt-"))
  const bun = join(dir, "bun")
  writeFileSync(bun, "#!/bin/sh\n")
  chmodSync(bun, 0o755)

  test("absent ⇒ the installing runtime", () => {
    expect(resolveServiceRuntime({}, { execPath: "/usr/bin/node" })).toBe(
      "/usr/bin/node",
    )
  })

  test("a name is resolved on PATH to an absolute path", () => {
    expect(
      resolveServiceRuntime(
        { service: { runtime: "bun" } },
        { path: `/nowhere:${dir}` },
      ),
    ).toBe(bun)
  })

  test("an absolute path is used as is; a missing runtime fails the install", () => {
    expect(resolveServiceRuntime({ service: { runtime: bun } })).toBe(bun)
    expect(() =>
      resolveServiceRuntime(
        { service: { runtime: "no-such-runtime" } },
        { path: dir },
      ),
    ).toThrow(/not found on PATH/)
    expect(() =>
      resolveServiceRuntime({ service: { runtime: join(dir, "gone") } }),
    ).toThrow(/does not exist/)
  })
})

describe("package manager", () => {
  test("defaults to npm; bun and pnpm use add -g", () => {
    expect(packageManager({}, null)).toBe("npm")
    expect(packageManager({ package_manager: "bun" }, null)).toBe("bun")
    expect(globalInstallCommand("npm", "@geohar/x", null).display).toBe(
      "npm install -g @geohar/x",
    )
    expect(globalInstallCommand("bun", "@geohar/x", null)).toMatchObject({
      cmd: "bun",
      args: ["add", "-g", "@geohar/x"],
    })
    expect(globalInstallCommand("pnpm", "@geohar/x", null).args).toEqual([
      "add",
      "-g",
      "@geohar/x",
    ])
  })

  test("un-bien.json wins; else pi's npmCommand; else npm", () => {
    const wrapped = ["bun-as-npm", "--", "bun"]
    expect(resolvePackageManager({ package_manager: "pnpm" }, wrapped)).toEqual(
      { pm: "pnpm", source: "config" },
    )
    expect(resolvePackageManager({}, wrapped)).toEqual({
      pm: "bun",
      source: "pi",
    })
    expect(resolvePackageManager({}, null)).toEqual({
      pm: "npm",
      source: "default",
    })
    // an ambiguous wrapper is not a choice
    expect(resolvePackageManager({}, ["wrap", "npm", "bun"])).toEqual({
      pm: "npm",
      source: "default",
    })
    expect(packageManagerConfigured({}, wrapped)).toBe(true)
    expect(packageManagerConfigured({}, null)).toBe(false)
  })

  test("pi's wrapper is kept when it names the same manager, dropped otherwise", () => {
    const wrapped = ["bun-as-npm", "--", "bun"]
    expect(globalInstallCommand("bun", "@geohar/x", wrapped)).toMatchObject({
      cmd: "bun-as-npm",
      args: ["--", "bun", "add", "-g", "@geohar/x"],
    })
    expect(globalInstallCommand("pnpm", "@geohar/x", wrapped)).toMatchObject({
      cmd: "pnpm",
      args: ["add", "-g", "@geohar/x"],
    })
  })
})

describe("unbien-admin link: which existing bins are kept", () => {
  const saved = process.env["PI_CODING_AGENT_DIR"]
  afterEach(() => {
    if (saved === undefined) delete process.env["PI_CODING_AGENT_DIR"]
    else process.env["PI_CODING_AGENT_DIR"] = saved
  })

  function layout() {
    const home = mkdtempSync(join(tmpdir(), "svc-link-"))
    const agent = join(home, "agent")
    const bunCopy = join(home, "bun", "un-bien", "dist", "index.js")
    const piCopy = join(agent, "npm", "un-bien", "dist", "index.js")
    for (const f of [bunCopy, piCopy]) {
      mkdirSync(join(f, ".."), { recursive: true })
      writeFileSync(f, "")
    }
    process.env["PI_CODING_AGENT_DIR"] = agent
    return { home, bunCopy, piCopy, link: join(home, "unbien-admin") }
  }

  test("a package manager's link or shim is kept", () => {
    const { home, bunCopy, link } = layout()
    symlinkSync(bunCopy, link)
    expect(_foreignBinOwner(link, home)).toBe(bunCopy)
    const shim = join(home, "shim")
    writeFileSync(shim, "")
    expect(_foreignBinOwner(shim, home)).toBe(shim)
  })

  test("a missing path, a broken link, and a link into the Pi agent dir are replaced", () => {
    const { home, piCopy, link } = layout()
    expect(_foreignBinOwner(link, home)).toBeNull()
    symlinkSync(piCopy, link)
    expect(_foreignBinOwner(link, home)).toBeNull()
    const broken = join(home, "broken")
    symlinkSync(join(home, "gone"), broken)
    expect(_foreignBinOwner(broken, home)).toBeNull()
  })
})

describe("package manager global tree", () => {
  test("only an explicit package_manager counts as configured", () => {
    expect(packageManagerConfigured({}, null)).toBe(false)
    expect(packageManagerConfigured({ package_manager: "bun" }, null)).toBe(
      true,
    )
  })
  test("bun's global dir comes from bun (bunfig globalDir), else BUN_INSTALL", () => {
    const told = () => "/g/custom node_modules (12 installed)"
    expect(globalPackageRoot("bun", {}, told)).toBe("/g/custom/node_modules")
    expect(globalPackageRoot("bun", { BUN_INSTALL: "/b" }, () => null)).toBe(
      "/b/install/global/node_modules",
    )
  })
})

describe("unbien-admin unlink", () => {
  test("keeps a package manager's link", () => {
    const home = mkdtempSync(join(tmpdir(), "svc-unlink-"))
    const global = join(home, "bun", "index.js")
    mkdirSync(join(global, ".."), { recursive: true })
    writeFileSync(global, "")
    mkdirSync(join(home, ".local", "bin"), { recursive: true })
    const bin = join(home, ".local", "bin", "unbien-admin")
    symlinkSync(global, bin)
    const r = unlinkCliBinaries(home)
    expect(r.removed[0]?.existed).toBe(false)
    expect(_foreignBinOwner(bin, home)).toBe(global)
  })
})
