import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  compareFolders,
  dirChoices,
  dirsHint,
  launchNameFor,
  nextAutoName,
  parseLaunchDirs,
  sortedRoots,
} from "../src/launch-dirs.js"

// A machine's answer, shaped exactly as `session_launch_dirs_result` carries it
// (extension/src/launch_request.ts `launchDirsResultEnvelope`).
const answer = {
  type: "session_launch_dirs_result",
  in_reply_to: "req-1",
  ok: true,
  wildcard: false,
  locked: false,
  remote_launch: true,
  roots: [
    {
      path: "/Users/gfcollin/dev/myai",
      name: "myai",
      exists: true,
      truncated: false,
      children: [
        {
          path: "/Users/gfcollin/dev/myai/scrape-examples",
          name: "scrape-examples",
        },
        { path: "/Users/gfcollin/dev/myai/dotfiles", name: "dotfiles" },
      ],
    },
    {
      path: "/Volumes/gone",
      name: "gone",
      exists: false,
      truncated: false,
      children: [],
    },
  ],
}

describe("parseLaunchDirs", () => {
  it("reads the frame the machine sends", () => {
    const parsed = parseLaunchDirs(answer)
    expect(parsed).not.toBeNull()
    expect(parsed?.ok).toBe(true)
    expect(parsed?.roots.map((r) => r.path)).toEqual([
      "/Users/gfcollin/dev/myai",
      "/Volumes/gone",
    ])
    expect(parsed?.roots[0]?.children).toHaveLength(2)
  })

  it("returns null for a frame that is not the dirs answer", () => {
    expect(
      parseLaunchDirs({ type: "session_launch_result", ok: true }),
    ).toBeNull()
  })

  it("survives a machine that answers with junk", () => {
    // Ships separately from the machine: a future/older daemon may answer with
    // anything. That must leave the form usable, not throw.
    const parsed = parseLaunchDirs({
      type: "session_launch_dirs_result",
      ok: true,
      roots: [
        null,
        7,
        { name: "no path" },
        { path: "/ok", children: ["x", { path: "/ok/a" }] },
      ],
    })
    expect(parsed?.roots.map((r) => r.path)).toEqual(["/ok"])
    expect(parsed?.roots[0]?.children.map((c) => c.path)).toEqual(["/ok/a"])
    expect(parsed?.wildcard).toBe(false)
  })
})

describe("dirChoices", () => {
  it("offers the roots and one level below, skipping folders that are gone", () => {
    const parsed = parseLaunchDirs(answer)!
    expect(dirChoices(parsed).map((c) => c.path)).toEqual([
      "/Users/gfcollin/dev/myai",
      "/Users/gfcollin/dev/myai/dotfiles",
      "/Users/gfcollin/dev/myai/scrape-examples",
    ])
  })
})

describe("sortedRoots", () => {
  it("orders roots and children ignoring case", () => {
    // What the user sees: a hand-written allow-list that reads
    // `dev, GoLang, AndroidStudioProjects` must not be shown in that order.
    const parsed = parseLaunchDirs({
      type: "session_launch_dirs_result",
      in_reply_to: "r",
      ok: true,
      roots: [
        {
          path: "/Users/gfcollin/dev",
          name: "dev",
          exists: true,
          truncated: false,
          children: [],
        },
        {
          path: "/Users/gfcollin/GoLang",
          name: "GoLang",
          exists: true,
          truncated: false,
          children: [
            { path: "/Users/gfcollin/GoLang/zed", name: "zed" },
            { path: "/Users/gfcollin/GoLang/Alpha", name: "Alpha" },
            { path: "/Users/gfcollin/GoLang/beta", name: "beta" },
          ],
        },
        {
          path: "/Users/gfcollin/AndroidStudioProjects",
          name: "AndroidStudioProjects",
          exists: true,
          truncated: false,
          children: [],
        },
      ],
    })!
    expect(sortedRoots(parsed).map((r) => r.name)).toEqual([
      "AndroidStudioProjects",
      "dev",
      "GoLang",
    ])
    const go = sortedRoots(parsed).find((r) => r.name === "GoLang")
    expect(go?.children.map((c) => c.name)).toEqual(["Alpha", "beta", "zed"])
  })

  it("orders by FULL path, not by the last component", () => {
    // The decision this pins: allow-list roots sit at different depths, and
    // sorting by the leaf would file `.../src/zeta` under Z in a tree that
    // started under G. Path order keeps a family together.
    const parsed = parseLaunchDirs({
      type: "session_launch_dirs_result",
      in_reply_to: "r",
      ok: true,
      roots: [
        {
          path: "/Users/gfcollin/workdev/zeta",
          name: "zeta",
          exists: true,
          truncated: false,
          children: [],
        },
        {
          path: "/Users/gfcollin/dev/nongo",
          name: "nongo",
          exists: true,
          truncated: false,
          children: [],
        },
        {
          path: "/Users/gfcollin/GoLang/Beta",
          name: "Beta",
          exists: true,
          truncated: false,
          children: [],
        },
        {
          path: "/Users/gfcollin/dev/aaa",
          name: "aaa",
          exists: true,
          truncated: false,
          children: [],
        },
      ],
    })!
    expect(sortedRoots(parsed).map((r) => r.path)).toEqual([
      "/Users/gfcollin/dev/aaa",
      "/Users/gfcollin/dev/nongo",
      "/Users/gfcollin/GoLang/Beta",
      "/Users/gfcollin/workdev/zeta",
    ])
  })

  it("breaks case-only ties the same way every time", () => {
    // `apple` vs `Apple` are EQUAL to a base-sensitivity collator, and `sort` is
    // stable — so without a tiebreak the pair keeps readdir order and the list
    // shuffles between requests. Upper-case first, deterministically.
    const folded = ["apple", "Apple", "banana"].sort(compareFolders)
    expect(folded).toEqual(["Apple", "apple", "banana"])
    expect([...folded].sort(compareFolders)).toEqual(folded)
  })
})

describe("nextAutoName", () => {
  it("follows a different folder, so the name matches what is chosen", () => {
    // Picking `beta` after `alpha` must rename the session: our own suggestion is
    // always safe to replace.
    expect(nextAutoName("/x/beta", "alpha", "alpha")).toBe("beta")
    expect(nextAutoName("/x/beta/", "alpha", "alpha")).toBe("beta")
    expect(nextAutoName("/x/beta", "", "")).toBe("beta")
  })

  it("never replaces a name the user typed", () => {
    expect(nextAutoName("/x/beta", "my-thing", "alpha")).toBeNull()
  })

  it("leaves the field alone when the folder names nothing", () => {
    expect(nextAutoName("~", "my-thing", "alpha")).toBeNull()
    expect(nextAutoName("~", "", "")).toBeNull()
  })
})

describe("launchNameFor", () => {
  it("takes the last component of the chosen folder", () => {
    expect(launchNameFor("/Users/gfcollin/x/a/b/c")).toBe("c")
    expect(launchNameFor("/Users/gfcollin/dev/myai")).toBe("myai")
    expect(launchNameFor("~/dev/myai")).toBe("myai")
  })

  it("ignores a trailing slash, which is typing noise", () => {
    expect(launchNameFor("/Users/gfcollin/dev/myai/")).toBe("myai")
    expect(launchNameFor("/Users/gfcollin/dev/myai///")).toBe("myai")
  })

  it("names nothing when the last component is not a name", () => {
    // Empty means "leave the field alone" — a pre-filled `~` would become the
    // session's title, which is worse than no title.
    expect(launchNameFor("~")).toBe("")
    expect(launchNameFor("/")).toBe("")
    expect(launchNameFor("   ")).toBe("")
    expect(launchNameFor("/Users/gfcollin/")).toBe("gfcollin")
  })
})

describe("dirsHint", () => {
  it("stays quiet when the list is simply short", () => {
    const parsed = parseLaunchDirs({
      ...answer,
      roots: [answer.roots[0]],
    })!
    expect(dirsHint(parsed)).toBe("")
  })

  it("says the three states that look like a broken picker", () => {
    expect(
      dirsHint(parseLaunchDirs({ ...answer, wildcard: true, roots: [] })!),
    ).toContain("ANY folder")
    expect(
      dirsHint(parseLaunchDirs({ ...answer, locked: true, roots: [] })!),
    ).toContain("launch.dirs is empty")
    expect(
      dirsHint(parseLaunchDirs({ ...answer, remote_launch: false })!),
    ).toContain("turned off")
  })

  it("names a missing root and a truncated one", () => {
    const parsed = parseLaunchDirs({
      ...answer,
      roots: [{ ...answer.roots[0], truncated: true }, answer.roots[1]],
    })!
    const hint = dirsHint(parsed)
    expect(hint).toContain("1 allow-listed folder not on the machine")
    expect(hint).toContain("listed only part-way")
  })

  it("tells an unpaired browser to pair again", () => {
    const parsed = parseLaunchDirs({
      type: "session_launch_dirs_result",
      in_reply_to: "r",
      ok: false,
      code: "unknown_peer",
    })!
    expect(dirsHint(parsed)).toContain("no longer paired")
  })
})

// This client and the machine ship separately, so the frame names and field
// names are checked against the extension's own source: a renamed field there
// would otherwise show up here as a picker that silently offers nothing.
function extensionSource(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../extension/src/${rel}`, import.meta.url)),
    "utf8",
  )
}

describe("wire parity with the extension", () => {
  it("the machine sends the request type this client asks for", () => {
    const asked = extensionSource("launcher/launcher.ts")
    const answeredByPi = extensionSource("routing.ts")
    expect(asked).toContain('"session_launch_dirs"')
    expect(answeredByPi).toContain('"session_launch_dirs"')
  })

  it("the reply declares every field this parser reads", () => {
    const envelope = extensionSource("session/rpc_envelope.ts")
    const variant =
      envelope.split('type: "session_launch_dirs_result"')[1]?.split("}")[0] ??
      ""
    expect(
      variant.length,
      "could not read session_launch_dirs_result from rpc_envelope.ts",
    ).toBeGreaterThan(20)
    for (const field of [
      "in_reply_to",
      "ok",
      "wildcard",
      "locked",
      "remote_launch",
      "roots",
      "code",
    ])
      expect(variant).toContain(field)
  })

  it("the enumeration is one level deep, machine-side", () => {
    const launch = extensionSource("launch.ts")
    expect(launch).toContain("export function launchDirOptions")
    expect(launch).toContain("LAUNCH_DIRS_CHILD_LIMIT")
    // Depth is the machine's decision, not ours: say so in the source we read.
    expect(launch).toContain("ONE")
  })
})
