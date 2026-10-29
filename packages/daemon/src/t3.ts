// Drives T3 Code through its built-in MCP endpoint (the same tools T3 hands to
// its own agents). Auth is T3's MCP OAuth flow: PKCE + loopback redirect, and
// the user approves "Full access" once in the browser (token lasts ~30 days).

import { createHash, randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { execFile, spawn } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { readJson, type DaemonConfig } from "./config.js"

const execFileAsync = promisify(execFile)

export class T3AuthError extends Error {}

export async function t3Origin(config: DaemonConfig): Promise<string> {
  if (config.t3.origin) return config.t3.origin.replace(/\/+$/, "")
  const runtime = await readJson<{ origin?: string; host?: string; port?: number }>(config.t3.runtimeFile)
  if (runtime?.origin) return runtime.origin
  if (runtime?.port) return `http://${runtime.host ?? "127.0.0.1"}:${runtime.port}`
  throw new Error(`T3 server not found (no ${config.t3.runtimeFile}). Is T3 Code running?`)
}

// ---------- OAuth login ----------

const b64url = (buf: Buffer) => buf.toString("base64url")

export async function login(config: DaemonConfig, log: (msg: string) => void): Promise<{ accessToken: string; clientId: string; expiresAt?: number }> {
  const origin = await t3Origin(config)
  const meta = (await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json()) as {
    authorization_endpoint: string
    token_endpoint: string
    registration_endpoint: string
  }

  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash("sha256").update(verifier).digest())
  const state = b64url(randomBytes(16))

  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port
  const redirectUri = `http://127.0.0.1:${port}/callback`

  try {
    const reg = await fetch(meta.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "handoff-daemon",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    })
    if (!reg.ok) throw new Error(`client registration failed: ${reg.status} ${await reg.text()}`)
    const { client_id: clientId } = (await reg.json()) as { client_id: string }

    const authUrl = new URL(meta.authorization_endpoint)
    authUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      scope: "orchestration:read orchestration:operate",
      resource: `${origin}/mcp`,
    }).toString()

    log(`Opening T3 approval page. Choose "Full access" so handoff threads can run unattended.`)
    log(`If prompted for a pairing code, create one with: t3 auth pairing create`)
    log(`URL: ${authUrl}`)
    spawn("open", [authUrl.toString()], { stdio: "ignore", detached: true }).unref()

    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for approval")), 10 * 60 * 1000)
      server.on("request", (req, res) => {
        const url = new URL(req.url ?? "/", redirectUri)
        if (url.pathname !== "/callback") return void res.writeHead(404).end()
        const error = url.searchParams.get("error")
        const got = url.searchParams.get("code")
        const ok = !error && got && url.searchParams.get("state") === state
        res.writeHead(ok ? 200 : 400, { "content-type": "text/plain" })
        res.end(ok ? "handoff-daemon is connected to T3. You can close this tab." : `Login failed: ${error ?? "bad state"}`)
        clearTimeout(timer)
        if (ok) resolve(got!)
        else reject(new Error(`authorization failed: ${error ?? "state mismatch"}`))
      })
    })

    const tokenRes = await fetch(meta.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
        resource: `${origin}/mcp`,
      }),
    })
    if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`)
    const token = (await tokenRes.json()) as { access_token: string; expires_in?: number }
    return {
      accessToken: token.access_token,
      clientId,
      ...(token.expires_in ? { expiresAt: Date.now() + token.expires_in * 1000 } : {}),
    }
  } finally {
    server.close()
  }
}

// ---------- MCP client ----------

export interface T3Project {
  id: string
  title: string
  workspaceRoot: string | null
}

/** Thread and run statuses that mean work is still in progress. */
export const ACTIVE_STATUSES = ["preparing", "queued", "starting", "running", "waiting"]

export interface T3Thread {
  threadId: string
  projectId: string
  title: string
  status: string
  branch: string | null
  worktreePath: string | null
  pendingRequestCount: number
  latestRunId: string | null
  providerInstanceId?: string | null
  model?: string | null
}

export interface T3Item {
  position: number
  itemId: string
  runId: string | null
  type: string
  text: string | null
  textTruncated: boolean
  nextTextOffset: number | null
}

export interface T3WaitResult {
  threadId: string
  runId: string | null
  status: string
  timedOut: boolean
}

export class T3 {
  private client: Client | null = null

  constructor(private readonly config: DaemonConfig) {}

  private async connect(): Promise<Client> {
    if (this.client) return this.client
    if (!this.config.t3.accessToken) throw new T3AuthError("not logged in to T3; run: handoff-daemon login")
    const origin = await t3Origin(this.config)
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${this.config.t3.accessToken}` } },
    })
    const client = new Client({ name: "handoff-daemon", version: "0.1.0" })
    try {
      await client.connect(transport)
    } catch (err) {
      if (/401|unauthori[sz]ed/i.test(String(err))) throw new T3AuthError("T3 rejected the token; run: handoff-daemon login")
      throw err
    }
    this.client = client
    return client
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => {})
    this.client = null
  }

  async call<T>(name: string, args: Record<string, unknown>, attempt = 0): Promise<T> {
    let result: Awaited<ReturnType<Client["callTool"]>>
    try {
      const client = await this.connect()
      result = await client.callTool({ name, arguments: args }, undefined, { timeout: 15 * 60 * 1000 })
    } catch (err) {
      if (err instanceof T3AuthError) throw err
      // T3 restarted (new port or dropped session): reconnect once.
      await this.close()
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
        return this.call<T>(name, args, attempt + 1)
      }
      throw err
    }
    const content = (result.content ?? []) as Array<{ type: string; text?: string }>
    const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("")
    if (result.isError) throw new Error(`${name} failed: ${text}`)
    if (result.structuredContent) return result.structuredContent as T
    try {
      return JSON.parse(text) as T
    } catch {
      return text as T
    }
  }

  async findProjectByRoot(root: string): Promise<T3Project | undefined> {
    let cursor: number | null = null
    do {
      const page: { projects: T3Project[]; nextCursor: number | null } = await this.call("t3_project_list", {
        limit: 100,
        ...(cursor != null ? { cursor } : {}),
      })
      const hit = page.projects.find((p) => p.workspaceRoot === root)
      if (hit) return hit
      cursor = page.nextCursor
    } while (cursor != null)
    return undefined
  }

  async ensureProject(root: string, title: string): Promise<T3Project> {
    const existing = await this.findProjectByRoot(root)
    if (existing) return existing
    let created: { project?: T3Project; projectId?: string; id?: string }
    try {
      created = await this.call("t3_project_create", { title, workspaceRoot: root })
    } catch (err) {
      // Clients approved below full access can't create projects over MCP; the local CLI can.
      if (!/capability_denied/.test(String(err))) throw err
      await execFileAsync(join(homedir(), ".t3", "bin", "t3"), ["project", "add", root, "--title", title])
      created = {}
    }
    const project = await this.findProjectByRoot(root)
    if (project) return project
    const id = created.project?.id ?? created.projectId ?? created.id
    if (!id) throw new Error(`t3_project_create returned no project: ${JSON.stringify(created)}`)
    return { id, title, workspaceRoot: root }
  }

  async findThreadByTitle(projectId: string, titleContains: string): Promise<T3Thread | undefined> {
    const res = await this.call<{ threads: T3Thread[] }>("t3_thread_list", { projectId, titleContains, limit: 5 })
    return res.threads?.[0]
  }

  async launch(args: Record<string, unknown>): Promise<string> {
    const res = await this.call<{ threadId?: string; thread?: { threadId: string } }>("t3_thread_launch", args)
    const id = res.threadId ?? res.thread?.threadId
    if (!id) throw new Error(`t3_thread_launch returned no threadId: ${JSON.stringify(res)}`)
    return id
  }

  /**
   * Delegated subagents (at any depth) of a thread that are still working. A
   * lead agent that delegates asynchronously ends its run while they work, and
   * T3 starts a new run when each one reports back.
   */
  async activeSubagents(projectId: string, threadId: string): Promise<Array<{ threadId: string; title: string; status: string }>> {
    const all: Array<{ threadId: string; title: string; status: string; parentThreadId: string | null }> = []
    let cursor: number | null = null
    do {
      const page: { threads: typeof all; nextCursor: number | null } = await this.call("t3_thread_list", {
        projectId,
        includeSubagents: true,
        limit: 100,
        ...(cursor !== null ? { cursor } : {}),
      })
      all.push(...page.threads)
      cursor = page.nextCursor
    } while (cursor !== null)
    const descendants = new Set([threadId])
    for (let grew = true; grew; ) {
      grew = false
      for (const t of all) {
        if (t.parentThreadId && descendants.has(t.parentThreadId) && !descendants.has(t.threadId)) {
          descendants.add(t.threadId)
          grew = true
        }
      }
    }
    return all.filter((t) => t.threadId !== threadId && descendants.has(t.threadId) && ACTIVE_STATUSES.includes(t.status))
  }

  async wait(threadId: string, timeoutMs: number): Promise<T3WaitResult> {
    return this.call("t3_thread_wait", { threadId, timeoutMs })
  }

  async thread(threadId: string): Promise<T3Thread> {
    const res = await this.call<{ thread: T3Thread }>("t3_thread_read", { threadId, limit: 1, maxCharsPerItem: 1 })
    return res.thread
  }

  /**
   * Status of the last run that actually started. A wake-up queued while the lead
   * was still busy (e.g. a subagent's completion notice) can be cancelled before
   * it starts; that says nothing about how the work went.
   */
  async finalRunStatus(threadId: string): Promise<string> {
    const res = await this.call<{ thread: T3Thread; recentRuns?: Array<{ status: string; startedAt: string | null }> }>("t3_thread_read", {
      threadId,
      limit: 1,
      maxCharsPerItem: 1,
      runLimit: 10,
    })
    return res.recentRuns?.find((r) => r.startedAt)?.status ?? res.thread.status
  }

  /** Final assistant message of the latest run, fully reassembled. */
  /** The newest user message in a thread (e.g. what the user typed in T3), shortened. */
  async lastUserMessage(threadId: string, maxChars = 2000): Promise<string> {
    let after: number | null = null
    let last: T3Item | undefined
    for (;;) {
      const page: { items: T3Item[]; nextPosition: number | null; hasMore: boolean } = await this.call("t3_thread_read", {
        threadId,
        view: "messages",
        limit: 100,
        maxCharsPerItem: maxChars,
        ...(after != null ? { afterPosition: after } : {}),
      })
      for (const item of page.items) if (item.type === "user_message") last = item
      if (!page.hasMore || page.nextPosition == null) break
      after = page.nextPosition
    }
    return (last?.text ?? "").trim()
  }

  async finalAssistantText(threadId: string): Promise<string> {
    let after: number | null = null
    let last: T3Item | undefined
    let latestRun: string | null = null
    for (;;) {
      const page: { thread: T3Thread; items: T3Item[]; nextPosition: number | null; hasMore: boolean } = await this.call(
        "t3_thread_read",
        { threadId, view: "messages", limit: 100, maxCharsPerItem: 50_000, ...(after != null ? { afterPosition: after } : {}) },
      )
      latestRun = page.thread.latestRunId
      for (const item of page.items) if (item.type === "assistant_message") last = item
      if (!page.hasMore || page.nextPosition == null) break
      after = page.nextPosition
    }
    if (!last) return ""
    if (latestRun && last.runId && last.runId !== latestRun) {
      // The last run produced no assistant message; still return the latest one we have.
    }
    let text = last.text ?? ""
    let offset = last.textTruncated ? last.nextTextOffset : null
    while (offset != null) {
      const res: { items: T3Item[] } = await this.call("t3_thread_read", {
        threadId,
        itemId: last.itemId,
        textOffset: offset,
        maxCharsPerItem: 50_000,
      })
      const item = res.items[0]
      if (!item) break
      text += item.text ?? ""
      offset = item.textTruncated ? item.nextTextOffset : null
    }
    return text
  }

  /**
   * Pending questions. T3 merged t3_pending_request_list/_read/_respond into one t3_pending_request tool;
   * use it, falling back to the old names on an older T3.
   */
  private async pendingRequest<T>(action: "list" | "read" | "respond", args: Record<string, unknown>): Promise<T> {
    if (this.splitPendingTools !== true) {
      try {
        const res = await this.call<T>("t3_pending_request", { action, ...args })
        this.splitPendingTools = false
        return res
      } catch (err) {
        if (this.splitPendingTools === false || !isUnknownTool(err)) throw err
        this.splitPendingTools = true
      }
    }
    return this.call<T>(`t3_pending_request_${action}`, args)
  }

  /** Whether this T3 only has the older per-action pending-request tools (undefined: not known yet). */
  private splitPendingTools: boolean | undefined

  async pendingRequests(threadId: string): Promise<string[]> {
    return (await this.pendingRequest<{ requestIds?: string[] }>("list", { threadId })).requestIds ?? []
  }

  async readPendingRequest(threadId: string, requestId: string): Promise<unknown> {
    return this.pendingRequest("read", { threadId, requestId })
  }

  async respond(threadId: string, requestId: string, answers: Record<string, unknown>): Promise<void> {
    await this.pendingRequest("respond", { threadId, requestId, answers })
  }

  /** Switch a thread's model for its next run. */
  async configure(threadId: string, modelSelection: Record<string, unknown>): Promise<void> {
    await this.call("t3_thread_configure", { threadId, modelSelection })
  }

  /** Send a message to a thread: starts it if idle, otherwise queues behind the current turn. */
  async send(threadId: string, message: string, clientRequestId: string): Promise<void> {
    await this.call("t3_thread_send", { threadId, message, mode: "auto", clientRequestId })
  }

  async interrupt(threadId: string, reason: string, clientRequestId: string): Promise<void> {
    await this.call("t3_thread_interrupt", { threadId, reason, clientRequestId })
  }
}

/** MCP's "tool not found" (T3 renamed or removed a tool). */
export function isUnknownTool(err: unknown): boolean {
  return /tool .* not found|unknown tool|-32602/i.test((err as Error)?.message ?? "")
}
