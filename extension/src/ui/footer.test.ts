import { describe, expect, test, vi } from "vitest"
import { updateFooter, type FooterContext, type FooterState } from "./footer.js"

// The mock still offers setTitle (pi's ui has it) to prove the footer
// never calls it.
function makeMockCtx(): {
  ui: FooterContext["ui"] & { setTitle(title: string): void }
} & {
  statusCalls: Array<{ key: string; value: string | undefined }>
  titleCalls: string[]
} {
  const statusCalls: Array<{ key: string; value: string | undefined }> = []
  const titleCalls: string[] = []
  return {
    ui: {
      setStatus: vi
        .fn()
        .mockImplementation((key: string, value: string | undefined) => {
          statusCalls.push({ key, value })
        }),
      setTitle: vi.fn().mockImplementation((title: string) => {
        titleCalls.push(title)
      }),
    },
    statusCalls,
    titleCalls,
  }
}

describe("updateFooter — footer slots ('local' rendering)", () => {
  test("session slot shows 'local' when joined to the mesh", () => {
    const ctx = makeMockCtx()
    const state: FooterState = {
      session: "local",
      peerCount: 3,
      relayOn: false,
    }
    updateFooter(ctx, state)
    const sessionSlot = ctx.statusCalls.find((c) => c.key === "un-bien:session")
    expect(sessionSlot?.value).toBe("📡 local (3)")
  })

  test("session slot cleared when not joined", () => {
    const ctx = makeMockCtx()
    updateFooter(ctx, { relayOn: false })
    const sessionSlot = ctx.statusCalls.find((c) => c.key === "un-bien:session")
    expect(sessionSlot?.value).toBeUndefined()
  })

  test("singular peer count keeps numeric form (no pluralization in footer)", () => {
    const ctx = makeMockCtx()
    updateFooter(ctx, { session: "local", peerCount: 1, relayOn: false })
    const sessionSlot = ctx.statusCalls.find((c) => c.key === "un-bien:session")
    expect(sessionSlot?.value).toBe("📡 local (1)")
  })
})

describe("updateFooter — terminal title", () => {
  test("leaves the terminal title to pi", () => {
    const ctx = makeMockCtx()
    updateFooter(ctx, { session: "local", peerCount: 2, relayOn: true })
    updateFooter(ctx, { session: "local", peerCount: 1, relayOn: false })
    expect(ctx.titleCalls).toEqual([])
  })
})
