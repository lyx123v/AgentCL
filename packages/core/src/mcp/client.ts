// @x-code-cli/core — 按服务维度封装的 MCP 客户端包装器
//
// 一个 McpClient 实例就对应一条服务器连接。这个类把 SDK 稍显别扭的
// 两段式初始化（`new Client(...)` + `new XxxTransport(...)` +
// `client.connect(transport)`）收拢成一个 `connect()` 方法，同时负责：
//   - 在 `close()` 时正确释放 transport
//   - 暴露注册表真正需要的窄接口：
//     listTools / callTool / listResources / readResource / close
//
// 关于 abortSignal 透传：
// 每个发往服务器的 RPC 方法都接受可选 AbortSignal，并通过
// `RequestOptions.signal` 继续传给 SDK。当用户在工具调用中途按 Esc 时，
// agent loop 的 signal 会中断 SDK 请求，只关闭这一轮 JSON-RPC future，
// 不会把底层连接杀掉，后续请求仍可复用同一条 transport。
import { type OAuthClientProvider, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

import { Stream } from 'node:stream'

import { debugLog } from '../utils.js'
import { VERSION } from '../version.js'
import { McpOAuthProvider } from './oauth/provider.js'
import {
  type McpCallResult,
  type McpResourceEntry,
  type McpServerConfig,
  isHttpConfig,
  isStdioConfig,
} from './types.js'

/** stderr 诊断信息最多保留多少行尾部内容。
 *  当 stdio 服务在启动时退出，或运行中途失败时，
 *  `/mcp list` 能看到最后几行 stderr，和只看到 “exit code 1”
 *  完全不是一个排障体验。 */
const STDERR_TAIL_LINES = 20

const CLIENT_INFO = { name: 'x-code-cli', version: VERSION }

/** 首次连接默认超时时间（毫秒）。
 *  允许通过配置里的 `timeout` 字段覆盖。30 秒已经算很宽松：
 *  社区常见的 stdio 服务通常 100 到 500ms 就能起来，
 *  这部分预算主要是留给冷缓存下的 npx 安装，而不是正常运行。 */
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000

export interface ConnectInfo {
  /** 当前服务暴露的工具数量 */
  toolCount: number
  /** 当前服务暴露的资源数量 */
  resourceCount: number
}

export class McpClient {
  /** SDK 客户端，只有连接成功后才存在。 */
  private client: Client | null = null
  /** SDK transport，由当前类持有，方便统一关闭。 */
  private transport: Transport | null = null
  /** stderr 滚动尾部缓存，仅 stdio 服务会使用。 */
  private stderrTail: string[] = []
  /** 最近一次连接得到的工具缓存，供注册表读取。 */
  private cachedTools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> = []
  /** 最近一次连接得到的资源缓存，供注册表读取。 */
  private cachedResources: McpResourceEntry[] = []

  constructor(
    public readonly serverName: string,
    private readonly config: McpServerConfig,
    /** 可选 OAuth 提供器，仅 HTTP 服务会使用；stdio 会忽略。 */
    private readonly authProvider?: OAuthClientProvider,
  ) {}

  /** 启动或连接服务，并完成 MCP initialize 握手。
   *  成功后会填充内部的工具与资源缓存；
   *  失败时会负责清理 transport，避免产生僵尸子进程，并把错误继续抛出。 */
  async connect(): Promise<ConnectInfo> {
    const timeout = this.config.timeout ?? DEFAULT_CONNECT_TIMEOUT_MS

    this.transport = this.buildTransport()
    this.client = new Client(CLIENT_INFO, { capabilities: {} })

    // SDK 的 connect() 会完成 initialize 往返，并在服务端确认后 resolve。
    // 这里额外包一层显式定时器，因为如果 stdio 子进程卡死
    // （比如 npx 卡在拉取 registry），否则不会自然报错，只会一直挂住。
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeout)
    try {
      await this.client.connect(this.transport, { signal: ctrl.signal })
    } catch (err) {
      // OAuth 流程中抛 UnauthorizedError 是预期行为：
      // SDK 已经调用过 redirectToAuthorization，接下来要求调用方在
      // 同一个 transport 上 finishAuth(code)。如果这里提前 teardown，
      // runOAuthDance 就拿不到原来的 transport，也无法完成交换。
      // 因此只有非 UnauthorizedError 时才主动 close，避免泄露子进程或 HTTP 连接。
      if (!isUnauthorizedError(err)) {
        await this.safeClose()
      }
      throw this.enrichError(err)
    } finally {
      clearTimeout(timer)
    }

    // 发现能力。工具和资源彼此独立，服务可以只提供其中一种；
    // 我们也容忍任一 listing 失败，例如部分服务在没有资源时会直接拒绝 listResources。
    try {
      const tools = await this.client.listTools()
      this.cachedTools = (tools.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? {},
      }))
    } catch (err) {
      debugLog('mcp.listTools-failed', `${this.serverName}: ${String(err)}`)
      this.cachedTools = []
    }

    try {
      const resources = await this.client.listResources()
      this.cachedResources = (resources.resources ?? []).map((r) => ({
        uri: r.uri,
        name: r.name ?? r.uri,
        description: r.description,
        mimeType: r.mimeType,
        serverName: this.serverName,
      }))
    } catch (err) {
      debugLog('mcp.listResources-failed', `${this.serverName}: ${String(err)}`)
      this.cachedResources = []
    }

    return {
      toolCount: this.cachedTools.length,
      resourceCount: this.cachedResources.length,
    }
  }

  /** 读取连接时发现的工具列表。
   *  该结果在连接生命周期内保持稳定；如需刷新，请创建新的 McpClient 并重新 connect()。 */
  tools(): ReadonlyArray<{ name: string; description?: string; inputSchema: Record<string, unknown> }> {
    return this.cachedTools
  }

  /** 读取连接时发现的资源列表。 */
  resources(): ReadonlyArray<McpResourceEntry> {
    return this.cachedResources
  }

  /** 以完整交互方式建立连接，并走完 OAuth 授权流程。
   *
   *  MCP SDK 的 StreamableHTTP transport 采用惰性授权：
   *  当没有已保存 token 时，首次 connect 会先调用
   *  `authProvider.redirectToAuthorization`，随后抛出 `UnauthorizedError`，
   *  因为 token 交换这一步必须等用户完成浏览器授权。
   *
   *  调用方需要等待回调落地，把授权码交给 `transport.finishAuth(code)`，
   *  然后再次 connect，此时 token 已持久化，连接才能成功。
   *
   *  我们把这一整套流程封装在这里，让 `/mcp auth` 只需声明
   *  “把 OAuth 跑完”，而不用了解 `finishAuth` 的细节。
   *  默认 `connect()` 路径会让 provider 处于被动态，
   *  只有这里才会显式切到交互模式，避免 CLI 启动时突然弹浏览器。 */
  async connectWithOAuth(hooks: { onBrowserOpen?: (url: string) => void } = {}): Promise<ConnectInfo> {
    if (!this.authProvider) {
      throw new Error(`MCP 服务 "${this.serverName}" 没有配置 OAuth provider`)
    }
    if (!(this.authProvider instanceof McpOAuthProvider)) {
      // 允许第三方 provider，但它们不会走我们自己的 waitForAuthCode 钩子，
      // 默认认为它们会自行完成授权流程。
      return this.connect()
    }

    const provider = this.authProvider

    // 先把回调服务启动起来，确保真实 loopback 端口会写进
    // `clientMetadata.redirect_uris` 和 `redirectUrl`，
    // 并且这一切发生在 SDK 构造动态注册请求之前。
    // 否则就会带着“没有端口的占位 URL”去注册，像 Sentry 这种
    // 不接受任意 loopback 端口的服务端就会把真实回调地址判成无效。
    await provider.prepareForAuth()

    // 把“即将打开浏览器”的通知透传给调用方，便于 /mcp auth
    // 在 CLI 滚动区输出自己的提示文案。这里临时 monkey-patch 一下方法，
    // 流程结束后会恢复原实现。
    const originalRedirect = provider.redirectToAuthorization.bind(provider)
    if (hooks.onBrowserOpen) {
      provider.redirectToAuthorization = async (url: URL) => {
        try {
          hooks.onBrowserOpen?.(url.toString())
        } catch {
          // 钩子失败不能影响 OAuth 主流程。
        }
        return originalRedirect(url)
      }
    }
    try {
      return await this.runOAuthDance()
    } finally {
      provider.setInteractive(false)
      if (hooks.onBrowserOpen) {
        provider.redirectToAuthorization = originalRedirect
      }
    }
  }

  /** 执行真正的两阶段 OAuth 连接流程：
   *  第一次 connect 负责触发浏览器跳转，
   *  用户授权后 finishAuth(code)，
   *  第二次 connect 才建立最终会话。 */
  private async runOAuthDance(): Promise<ConnectInfo> {
    const provider = this.authProvider as McpOAuthProvider

    // 第一次尝试通常会在打开浏览器后抛 UnauthorizedError。
    // 如果磁盘上已有有效 token，这里也可能直接成功。
    try {
      return await this.connect()
    } catch (err) {
      if (!isUnauthorizedError(err)) {
        provider.cancel()
        throw err
      }
    }

    // provider 已经在 SDK 内部调用过 redirectToAuthorization，
    // 现在只需要等回调回来，拿到 code 后完成 token 交换。
    const { code } = await provider.waitForAuthCode()
    const transport = this.transport
    if (!(transport instanceof StreamableHTTPClientTransport)) {
      throw new Error(`内部错误：OAuth 流程预期 "${this.serverName}" 使用 HTTP transport`)
    }
    await transport.finishAuth(code)

    // token 已保存。第一次 connect 在握手中途抛出后留下的是半开状态，
    // 这里要先彻底关掉再重建，避免 “already connected” 或状态泄漏问题。
    await this.safeClose()
    return this.connect()
  }

  /** 调用远端 MCP 工具，并将结果压平成当前项目使用的文本结构。 */
  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult> {
    if (!this.client) throw new Error(`MCP 服务 "${this.serverName}" 尚未连接`)
    const result = await this.client.callTool(
      { name, arguments: args as Record<string, unknown> | undefined },
      undefined,
      { signal },
    )
    return flattenCallResult(result)
  }

  /** 读取远端资源，并拼接为文本返回给上层。 */
  async readResource(uri: string, signal?: AbortSignal): Promise<{ text: string; mimeType?: string }> {
    if (!this.client) throw new Error(`MCP 服务 "${this.serverName}" 尚未连接`)
    const result = await this.client.readResource({ uri }, { signal })
    // 资源结果是内容块数组；这里把可显示文本拼起来，
    // 同时保留第一个 mimeType 供调用方参考。
    const parts: string[] = []
    let mimeType: string | undefined
    for (const c of result.contents ?? []) {
      mimeType ??= (c as { mimeType?: string }).mimeType
      const text = (c as { text?: string }).text
      if (typeof text === 'string') parts.push(text)
      else if ((c as { blob?: string }).blob !== undefined) {
        parts.push(`[已省略二进制内容，mimeType=${mimeType ?? 'unknown'}]`)
      }
    }
    return { text: parts.join('\n'), mimeType }
  }

  /** 读取当前缓存的 stderr 末尾若干行，用于诊断。HTTP 服务通常为空。 */
  stderr(): string {
    return this.stderrTail.join('\n')
  }

  /** 主动关闭底层客户端与 transport。 */
  async close(): Promise<void> {
    await this.safeClose()
  }

  // ── 内部实现 ───────────────────────────────────────────────────────────

  /** 根据配置构建对应 transport。 */
  private buildTransport(): Transport {
    if (isStdioConfig(this.config)) {
      const t = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args,
        env: this.config.env,
        cwd: this.config.cwd,
        // 把 stderr 接成管道，方便采集诊断信息。
        // 如果用默认 inherit，子进程输出会直接打乱 CLI 的 cell-buffer UI。
        stderr: 'pipe',
      })
      const stderr: Stream | null = t.stderr
      if (stderr) {
        stderr.on('data', (chunk: Buffer | string) => {
          const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
          for (const line of text.split(/\r?\n/)) {
            if (!line) continue
            this.stderrTail.push(line)
            if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift()
          }
        })
      }
      return t
    }

    if (isHttpConfig(this.config)) {
      return new StreamableHTTPClientTransport(new URL(this.config.url), {
        requestInit: this.config.headers ? { headers: this.config.headers } : undefined,
        authProvider: this.authProvider,
      })
    }

    // 上游 schema 校验理论上已经拦住这里，但仍保留防御式分支。
    throw new Error(`mcp 服务 "${this.serverName}"：无法识别的配置结构`)
  }

  /** 尽力关闭 client / transport，保证调用方不需要再处理关闭异常。 */
  private async safeClose(): Promise<void> {
    // SDK 的 Client.close() 也会顺带关闭 transport。
    // 优先走 client.close()，因为它会发送标准 shutdown；
    // 如果 client 还没建好，则退回 transport.close()。
    try {
      if (this.client) {
        await this.client.close()
      } else if (this.transport) {
        await this.transport.close()
      }
    } catch (err) {
      debugLog('mcp.close-error', `${this.serverName}: ${String(err)}`)
    } finally {
      this.client = null
      this.transport = null
    }
  }

  /** 给连接错误附加 stderr 尾部信息，
   *  让 `/mcp list` 展示的错误比 “Connection closed” 更有帮助。 */
  private enrichError(err: unknown): Error {
    const base = err instanceof Error ? err : new Error(String(err))
    if (this.stderrTail.length === 0) return base
    const tail = this.stderrTail.slice(-5).join(' | ')
    const enriched = new Error(`${base.message} — stderr: ${tail}`)
    enriched.stack = base.stack
    return enriched
  }
}

/** 尽量稳妥地识别 SDK 抛出的 UnauthorizedError。
 *  不完全依赖 instanceof，是因为在打包边界或 esm/cjs 重复依赖场景下，
 *  同名类实例可能跨边界失效。 */
function isUnauthorizedError(err: unknown): boolean {
  if (err instanceof UnauthorizedError) return true
  if (err instanceof Error) {
    if (err.name === 'UnauthorizedError') return true
    if (/unauthorized|401/i.test(err.message)) return true
  }
  return false
}

/** 把 MCP 工具调用结果中的内容块压平成单个文本结果。
 *  MCP 响应本质上是一组 `{ type: "text" | "image" | ... }` 内容块。
 *  当前 tool_result 只真正消费文本；图片/音频等内容只保留占位说明。 */
function flattenCallResult(result: unknown): McpCallResult {
  const r = result as { content?: Array<unknown>; isError?: boolean }
  const blocks = Array.isArray(r.content) ? r.content : []
  const parts: string[] = []
  for (const b of blocks) {
    const block = b as { type?: string; text?: string; data?: unknown; mimeType?: string }
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    } else if (block.type === 'image') {
      parts.push(`[已省略图片内容，mimeType=${block.mimeType ?? 'unknown'}]`)
    } else if (block.type === 'resource') {
      // 内嵌资源：优先输出其中的文本，否则输出资源 URI 提示。
      const nested = (block as { resource?: { text?: string; uri?: string } }).resource
      if (nested?.text) parts.push(nested.text)
      else if (nested?.uri) parts.push(`[资源：${nested.uri}]`)
    } else if (block.type) {
      parts.push(`[${block.type} 内容]`)
    }
  }
  return {
    text: parts.join('\n').trim() || '(空响应)',
    isError: r.isError === true,
  }
}
