/**
 * packageManager — which manager a pi `npmCommand` means, and the global
 * install argv built from it. Detection must match pi's own
 * getPackageManagerName so un-bien and pi agree on the manager.
 */
import { describe, expect, it } from "vitest"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  globalInstallCommand,
  piAgentDir,
  readPiNpmCommand,
  packageManagerName,
} from "./packageManager.js"

describe("packageManagerName (pi's resolution)", () => {
  it("unset / empty → npm", () => {
    expect(packageManagerName(undefined)).toBe("npm")
    expect(packageManagerName([])).toBe("npm")
  })

  it("direct command", () => {
    expect(packageManagerName(["npm"])).toBe("npm")
    expect(packageManagerName(["bun"])).toBe("bun")
    expect(packageManagerName(["pnpm"])).toBe("pnpm")
    expect(packageManagerName(["/opt/homebrew/bin/bun"])).toBe("bun")
    // .cmd/.exe stripped (win32 shims). Backslash paths only split on win32,
    // where node's basename is the win32 one — same as pi.
    expect(packageManagerName(["pnpm.cmd"])).toBe("pnpm")
    expect(packageManagerName(["bun.exe"])).toBe("bun")
  })

  it("command after the last `--` wins", () => {
    expect(packageManagerName(["mise", "exec", "--", "bun"])).toBe("bun")
    expect(packageManagerName(["wrap", "npm", "--", "pnpm"])).toBe("pnpm")
  })

  it("wrapper naming one manager in its args", () => {
    expect(packageManagerName(["mise", "exec", "bun"])).toBe("bun")
  })

  it("wrapper naming two managers is ambiguous", () => {
    expect(() => packageManagerName(["wrap", "npm", "bun"])).toThrow(
      /Ambiguous/,
    )
  })

  it("unknown wrapper → npm (pi sends it npm-style args)", () => {
    expect(packageManagerName(["my-npm-shim"])).toBe("npm")
    expect(packageManagerName(["wrap", "--", "yarn"])).toBe("npm")
  })
})

describe("globalInstallCommand", () => {
  const spec = "@geohar/unbien-cli"

  it("unset → npm install -g (npm.cmd on win32)", () => {
    expect(globalInstallCommand(spec, undefined, "darwin")).toMatchObject({
      manager: "npm",
      command: "npm",
      args: ["install", "-g", spec],
      display: `npm install -g ${spec}`,
    })
    expect(globalInstallCommand(spec, undefined, "win32").command).toBe(
      "npm.cmd",
    )
  })

  it("bun / pnpm → add -g", () => {
    expect(globalInstallCommand(spec, ["bun"])).toMatchObject({
      manager: "bun",
      command: "bun",
      args: ["add", "-g", spec],
    })
    expect(globalInstallCommand(spec, ["pnpm"]).args).toEqual([
      "add",
      "-g",
      spec,
    ])
  })

  it("keeps a wrapper prefix and the configured command verbatim", () => {
    expect(
      globalInstallCommand(spec, ["mise", "exec", "--", "bun"]),
    ).toMatchObject({
      manager: "bun",
      command: "mise",
      args: ["exec", "--", "bun", "add", "-g", spec],
      display: `mise exec -- bun add -g ${spec}`,
    })
    expect(globalInstallCommand(spec, ["/opt/homebrew/bin/bun"]).command).toBe(
      "/opt/homebrew/bin/bun",
    )
  })

  it("explicit npm keeps npm args", () => {
    expect(globalInstallCommand(spec, ["npm"]).args).toEqual([
      "install",
      "-g",
      spec,
    ])
  })

  it("blank first entry falls back to npm", () => {
    expect(globalInstallCommand(spec, [" "], "darwin")).toMatchObject({
      command: "npm",
      args: ["install", "-g", spec],
    })
  })
})

describe("readPiNpmCommand", () => {
  it("reads the global settings.json under PI_CODING_AGENT_DIR", () => {
    const dir = mkdtempSync(join(tmpdir(), "pm-settings-"))
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ npmCommand: ["bun-as-npm", "--", "bun"] }),
    )
    expect(piAgentDir({ PI_CODING_AGENT_DIR: dir })).toBe(dir)
    expect(readPiNpmCommand({ PI_CODING_AGENT_DIR: dir })).toEqual([
      "bun-as-npm",
      "--",
      "bun",
    ])
  })
  it("unset, malformed or missing settings read as unset", () => {
    const dir = mkdtempSync(join(tmpdir(), "pm-settings-"))
    expect(readPiNpmCommand({ PI_CODING_AGENT_DIR: dir })).toBeUndefined()
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ npmCommand: "bun" }),
    )
    expect(readPiNpmCommand({ PI_CODING_AGENT_DIR: dir })).toBeUndefined()
    writeFileSync(join(dir, "settings.json"), "{ not json")
    expect(readPiNpmCommand({ PI_CODING_AGENT_DIR: dir })).toBeUndefined()
  })
})
