// @x-code-cli/core — OAuthClientProvider 的具体实现
//
// 这个类把 MCP SDK 的授权流程接到我们的持久化与 CLI 交互体验上：
//
//   - tokens()                 — 从 McpTokenStorage 读取 token
//   - saveTokens()             — 把 token 写回 McpTokenStorage
//   - clientInformation()      — 从 McpTokenStorage 读取客户端注册信息
//   - saveClientInformation()  — 写回 McpTokenStorage
//   - codeVerifier() / save    — 仅保存在进程内存里，PKCE verifier 每次授权单独使用
//   - redirectUrl              — 指向刚启动的本地回调服务地址
//   - redirectToAuthorization  — 在用户默认浏览器中打开授权 URL
//
// 每个服务一个 provider 实例，由 loader.ts 中的工厂按需创建。
//
// 关于外部浏览器启动：
// 我们直接用 `node:child_process` 调平台默认打开器：
//   - Windows: `start` 同类机制
//   - macOS: `open`
//   - Linux: `xdg-open` / `gio open` 等候选
// 不额外引入 npm 包，保持依赖面更小。
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'

import { spawn } from 'node:child_process'

import { debugLog } from '../../utils.js'
import { type RunningCallbackServer, startCallbackServer } from './callback-server.js'
import { McpTokenStorage } from './token-storage.js'

const CLIENT_METADATA_BASE: Omit<OAuthClientMetadata, 'redirect_uris'> = {
  client_name: 'X-Code CLI',
  client_uri: 'https://github.com/woai3c/x-code-cli',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
}

export interface CreateProviderOptions {
  /** MCP 服务名，用作 token 存储键 */
  serverName: string
  /** MCP 服务 URL，用于和持久化信息关联 */
  serverUrl: string
  /** token 与客户端信息的持久化存储 */
  storage: McpTokenStorage
  /** 即将打开浏览器前触发的回调，可用于在 CLI 中提示用户 */
  onOpenBrowser?: (url: string) => void
}

/** 具体的 OAuth provider 实现。
 *  它绑定了持久化状态和一个按需启动的本地回调服务，
 *  并会在同一个服务的多次 connect / refresh 之间复用。 */
export class McpOAuthProvider implements OAuthClientProvider {
  /** 当前正在运行的回调服务。
   *  保留这个句柄是为了让授权失败后的再次尝试能够复用同一端口，
   *  而不是继续起新的监听器。 */
  private callbackServer: RunningCallbackServer | null = null
  /** 当前授权流程的 PKCE verifier，只保存在内存中。 */
  private memoryCodeVerifier: string | null = null
  /** 等待中的授权结果 promise，由 `waitForAuthCode()` 消费。 */
  private pendingCode: Promise<{ code: string; state?: string }> | null = null
  /** 当前是否允许 `redirectToAuthorization` 真正打开浏览器。
   *  默认关闭，避免 CLI 启动时因为某个 HTTP MCP 服务缺 token 就突然弹浏览器。 */
  private interactive = false

  constructor(private readonly opts: CreateProviderOptions) {}

  /** 由调用方切换当前 provider 是否处于交互授权模式。 */
  setInteractive(value: boolean): void {
    this.interactive = value
  }

  /** 预先启动回调服务，确保真实 loopback 端口已经可用，
   *  这样 `redirectUrl` 和 `clientMetadata.redirect_uris` 在 SDK 发起
   *  动态客户端注册前就是最终值。 */
  async prepareForAuth(): Promise<void> {
    this.interactive = true
    await this.ensureCallbackServer()
  }

  // ── OAuthClientProvider ────────────────────────────────────────────────

  get redirectUrl(): string {
    // SDK 会在 `redirectToAuthorization` 之前就读取 redirectUrl，
    // 例如首次 connect 且本地还没有 token 时。
    // 因此这里不能抛错，只能先给一个 loopback 占位地址。
    return this.callbackServer?.url ?? 'http://127.0.0.1/callback'
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      ...CLIENT_METADATA_BASE,
      // 回调服务启动后这里会换成真实地址；
      // 在那之前，SDK 可能先拿这个对象做动态注册，所以先给占位值。
      redirect_uris: [this.callbackServer?.url ?? 'http://127.0.0.1/callback'],
    }
  }

  /** 读取持久化的 OAuth 客户端注册信息。 */
  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const stored = await this.opts.storage.get(this.opts.serverName)
    return stored?.clientInformation
  }

  /** 持久化 OAuth 客户端注册信息。 */
  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await this.opts.storage.setClientInformation(this.opts.serverName, this.opts.serverUrl, info)
  }

  /** 读取当前保存的 OAuth token。 */
  async tokens(): Promise<OAuthTokens | undefined> {
    const stored = await this.opts.storage.get(this.opts.serverName)
    return stored?.tokens
  }

  /** 持久化最新 OAuth token。 */
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.opts.storage.setTokens(this.opts.serverName, this.opts.serverUrl, tokens)
  }

  /** 保存本轮授权流程的 PKCE verifier。 */
  saveCodeVerifier(codeVerifier: string): void {
    this.memoryCodeVerifier = codeVerifier
  }

  /** 读取当前授权流程中的 PKCE verifier。 */
  codeVerifier(): string {
    if (!this.memoryCodeVerifier) {
      throw new Error('当前没有可用的 PKCE verifier，说明授权流程尚未开始')
    }
    return this.memoryCodeVerifier
  }

  /** 把用户跳转到授权页面。
   *  在非交互模式下这是空操作，只让 SDK 后续抛 UnauthorizedError，
   *  从而把服务标记为 `needs_auth`。 */
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // 被动模式：CLI 启动时如果没有 token，不应擅自弹浏览器。
    if (!this.interactive) {
      return
    }

    // 真正要打开浏览器前再确保回调服务存在，并把真实回调地址
    // 写回授权 URL 中的 redirect_uri 参数。
    await this.ensureCallbackServer()
    authorizationUrl.searchParams.set('redirect_uri', this.callbackServer!.url)

    this.opts.onOpenBrowser?.(authorizationUrl.toString())
    await openInBrowser(authorizationUrl.toString())

    // 保存等待中的回调 promise，供调用方后续等待。
    this.pendingCode = this.callbackServer!.waitForCallback()
  }

  // ── 提供给 /mcp auth 处理器使用的辅助方法 ───────────────────────────────

  /** 等待授权服务器回跳，并返回授权码。
   *  返回后调用方会继续调用 `transport.finishAuth(code)`。 */
  async waitForAuthCode(): Promise<{ code: string; state?: string }> {
    if (!this.pendingCode) {
      throw new Error('授权流程尚未开始：redirectToAuthorization 从未被调用')
    }
    try {
      return await this.pendingCode
    } finally {
      this.pendingCode = null
      this.callbackServer?.close()
      this.callbackServer = null
    }
  }

  /** 取消并丢弃当前正在进行的授权流程。 */
  cancel(): void {
    this.callbackServer?.close()
    this.callbackServer = null
    this.pendingCode = null
    this.memoryCodeVerifier = null
  }

  // ── 内部实现 ───────────────────────────────────────────────────────────

  /** 确保本地回调服务已启动。 */
  private async ensureCallbackServer(): Promise<void> {
    if (this.callbackServer) return
    this.callbackServer = await startCallbackServer()
  }
}

/** 尽力用系统默认浏览器打开指定 URL。
 *  采用 detached 子进程，避免 CLI 被浏览器进程阻塞。 */
async function openInBrowser(url: string): Promise<void> {
  try {
    if (process.platform === 'win32') {
      // 这里刻意不用 `cmd /c start`。
      // cmd.exe 会把 `&` 当成命令分隔符，OAuth URL 中非常常见的 query 参数
      // 会因此被截断。`rundll32 url.dll,FileProtocolHandler <url>` 则不会。
      spawnDetached('rundll32', ['url.dll,FileProtocolHandler', url])
      return
    }
    if (process.platform === 'darwin') {
      spawnDetached('open', [url])
      return
    }

    // Linux / *BSD：没有一个命令能覆盖所有发行版与桌面环境。
    // 因此按候选顺序逐个尝试，哪个能用就停在哪个。
    const candidates: Array<[string, string[]]> = [
      ['xdg-open', [url]],
      ['gio', ['open', url]],
      ['wslview', [url]],
      ['kde-open', [url]],
      ['gnome-open', [url]],
    ]
    for (const [cmd, args] of candidates) {
      if (await trySpawnOpener(cmd, args)) return
    }
    debugLog('mcp.browser-open-no-opener', '没有找到可用的 URL 打开器，用户需要手动复制链接')
  } catch (err) {
    debugLog('mcp.browser-open-threw', String(err))
  }
}

/** 启动一个 detached 子进程后立刻放手。
 *  主要用于 Windows / macOS 上“命令已知可靠”的场景。 */
function spawnDetached(cmd: string, args: string[]): void {
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
  child.unref()
  child.on('error', (err) => debugLog('mcp.browser-open-failed', String(err)))
}

/** 尝试启动一个 Linux 平台上的 URL 打开器候选命令。
 *  若命令存在且退出成功，或在短暂观察窗口后仍存活，则视为成功。 */
function trySpawnOpener(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (ok: boolean) => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    } catch {
      settle(false)
      return
    }
    child.on('error', () => settle(false))
    child.on('exit', (code) => {
      if (code === 0) {
        child.unref()
        settle(true)
      } else {
        settle(false)
      }
    })
    // 某些打开器会先 fork 再短暂存活；500ms 内仍未退出，基本可以视为已成功交接。
    setTimeout(() => {
      if (!settled) {
        child.unref()
        settle(true)
      }
    }, 500)
  })
}

/** 提供给 loader.ts 使用的 OAuth provider 工厂。
 *  对 stdio 服务不会使用该工厂；只有 HTTP 服务会需要它。 */
export function createOAuthProviderFactory(
  storage: McpTokenStorage,
  onOpenBrowser?: (serverName: string, url: string) => void,
) {
  return (serverName: string, serverUrl: string): McpOAuthProvider => {
    return new McpOAuthProvider({
      serverName,
      serverUrl,
      storage,
      onOpenBrowser: onOpenBrowser ? (url) => onOpenBrowser(serverName, url) : undefined,
    })
  }
}
