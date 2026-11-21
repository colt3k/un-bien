import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { _resetLegacyConfigCheckForTest, loadConfig, saveConfig } from "./config.js"

// The global config moved from ~/.pi/extensions/un-bien.json (versions before
// 0.25.17, with PI_CODING_AGENT_DIR unset) to pi's agent dir,
// ~/.pi/agent/extensions/un-bien.json.
const SAVED = { HOME: process.env["HOME"], PI: process.env["PI_CODING_AGENT_DIR"] }
let home = ""
const legacy = () => join(home, ".pi", "extensions", "un-bien.json")
const current = () => join(home, ".pi", "agent", "extensions", "un-bien.json")

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "unbien-cfg-migrate-"))
  process.env["HOME"] = home
  delete process.env["PI_CODING_AGENT_DIR"]
  _resetLegacyConfigCheckForTest()
})

afterEach(() => {
  for (const [k, v] of [["HOME", SAVED.HOME], ["PI_CODING_AGENT_DIR", SAVED.PI]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  _resetLegacyConfigCheckForTest()
})

function writeLegacy(config: object): void {
  mkdirSync(join(home, ".pi", "extensions"), { recursive: true })
  writeFileSync(legacy(), JSON.stringify(config))
}

describe("global config migration", () => {
  test("an old config is moved to pi's agent dir and still read", () => {
    writeLegacy({ relay: "http://old.example:3000" })
    expect(loadConfig().relay).toBe("http://old.example:3000")
    expect(JSON.parse(readFileSync(current(), "utf8")).relay).toBe("http://old.example:3000")
  })

  test("the old path becomes a symlink to the new file, so older versions share it", () => {
    writeLegacy({ relay: "http://old.example:3000" })
    loadConfig()
    expect(lstatSync(legacy()).isSymbolicLink()).toBe(true)
    expect(readlinkSync(legacy())).toBe(current())
    saveConfig({ relay: "http://new.example:3000" })
    // An older version reading the old path sees the change.
    expect(JSON.parse(readFileSync(legacy(), "utf8")).relay).toBe("http://new.example:3000")
  })

  test("an existing new config is never overwritten", () => {
    writeLegacy({ relay: "http://old.example:3000" })
    mkdirSync(join(home, ".pi", "agent", "extensions"), { recursive: true })
    writeFileSync(current(), JSON.stringify({ relay: "http://new.example:3000" }))
    expect(loadConfig().relay).toBe("http://new.example:3000")
    expect(lstatSync(legacy()).isSymbolicLink()).toBe(false)
  })

  test("with PI_CODING_AGENT_DIR set nothing moves (that path was always used)", () => {
    writeLegacy({ relay: "http://old.example:3000" })
    process.env["PI_CODING_AGENT_DIR"] = join(home, "agent")
    expect(loadConfig().relay).toBeUndefined()
    expect(existsSync(current())).toBe(false)
    expect(lstatSync(legacy()).isSymbolicLink()).toBe(false)
  })

  test("no old config: nothing is created", () => {
    expect(loadConfig()).toEqual({})
    expect(existsSync(current())).toBe(false)
  })
})
