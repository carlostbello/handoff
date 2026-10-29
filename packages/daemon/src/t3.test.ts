import { describe, expect, it } from "vitest"
import { T3, isUnknownTool } from "./t3.js"

/** A T3 client whose MCP calls go to `tools` instead of a real server. */
function fakeT3(tools: Record<string, (args: Record<string, unknown>) => unknown>) {
  const calls: string[] = []
  const t3 = new T3({} as never)
  const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    calls.push(name)
    const tool = tools[name]
    if (!tool) throw new Error(`MCP error -32602: Tool '${name}' not found`)
    return tool(args)
  }
  Object.assign(t3, { call })
  return { t3, calls }
}

describe("T3 pending questions", () => {
  it("uses the merged t3_pending_request tool", async () => {
    const { t3, calls } = fakeT3({ t3_pending_request: (a) => (a.action === "list" ? { requestIds: ["q1"] } : {}) })
    expect(await t3.pendingRequests("th")).toEqual(["q1"])
    expect(calls).toEqual(["t3_pending_request"])
  })

  it("falls back to the older per-action tools, and remembers", async () => {
    const { t3, calls } = fakeT3({ t3_pending_request_list: () => ({ requestIds: ["q2"] }), t3_pending_request_read: () => ({ q: 1 }) })
    expect(await t3.pendingRequests("th")).toEqual(["q2"])
    expect(await t3.readPendingRequest("th", "q2")).toEqual({ q: 1 })
    expect(calls).toEqual(["t3_pending_request", "t3_pending_request_list", "t3_pending_request_read"])
  })

  it("recognises MCP's unknown-tool error", () => {
    expect(isUnknownTool(new Error("MCP error -32602: Tool 't3_pending_request_list' not found"))).toBe(true)
    expect(isUnknownTool(new Error("timeout"))).toBe(false)
  })
})
