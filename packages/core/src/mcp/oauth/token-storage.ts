// @x-code-cli/core — 按服务保存 OAuth token 与客户端信息
//
// 存储文件：~/.x-code/mcp-auth.json
//
//   {
//     "sentry": {
//       "url": "https://mcp.sentry.dev",
//       "clientInformation": { client_id: "...", client_secret: "...", ... },
//       "tokens":            { access_token: "...", refresh_token: "...", expires_in: 3600, ... }
//     },
//     ...
//   }
//
// 权限策略：
//   - POSIX 下使用 0o600（仅所有者可读写）
//   - Windows 不看 mode bits，但文件位于当前用户目录中，访问控制交给系统 ACL
//   - 写入采用原子方式（tmp + rename），避免中途崩溃把已有 token 文件写坏
//
// 真正消费它的是 SDK 侧的 `OAuthClientProvider`（见 ../oauth/provider.ts），
// 这里仅负责最基础的持久化。
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'

import fs from 'node:fs/promises'
import path from 'node:path'

import { debugLog, userXcodeDir } from '../../utils.js'

/** 返回 OAuth 鉴权信息文件的绝对路径。 */
function authFile(): string {
  return path.join(userXcodeDir(), 'mcp-auth.json')
}

export interface StoredServerAuth {
  /** 服务 URL，用来识别“这个 token 是否仍属于当前配置指向的部署” */
  url: string
  /** 持久化保存的 OAuth 客户端注册信息 */
  clientInformation?: OAuthClientInformationMixed
  /** 持久化保存的 OAuth token 集合 */
  tokens?: OAuthTokens
  /** 最近一次拿到 token 的 UTC ISO 时间戳，用于结合 expires_in 计算绝对过期时间 */
  tokensIssuedAt?: string
}

type FileShape = Record<string, StoredServerAuth>

export class McpTokenStorage {
  /** 文件内容的内存缓存，首次读取后懒加载保存。 */
  private cache: FileShape | null = null

  /** 读取某个服务当前保存的 OAuth 信息。 */
  async get(serverName: string): Promise<StoredServerAuth | undefined> {
    await this.ensureLoaded()
    return this.cache![serverName]
  }

  /** 写入某个服务的客户端注册信息。 */
  async setClientInformation(serverName: string, url: string, info: OAuthClientInformationMixed): Promise<void> {
    await this.ensureLoaded()
    const entry = (this.cache![serverName] ??= { url })
    entry.url = url
    entry.clientInformation = info
    await this.flush()
  }

  /** 写入某个服务的 token，并记录签发时间。 */
  async setTokens(serverName: string, url: string, tokens: OAuthTokens): Promise<void> {
    await this.ensureLoaded()
    const entry = (this.cache![serverName] ??= { url })
    entry.url = url
    entry.tokens = tokens
    entry.tokensIssuedAt = new Date().toISOString()
    await this.flush()
  }

  /** 清除某个服务已保存的 OAuth 信息。 */
  async clear(serverName: string): Promise<void> {
    await this.ensureLoaded()
    if (this.cache![serverName]) {
      delete this.cache![serverName]
      await this.flush()
    }
  }

  /** 列出所有保存过鉴权信息的服务摘要。 */
  async listServers(): Promise<Array<{ name: string; url: string; hasTokens: boolean }>> {
    await this.ensureLoaded()
    return Object.entries(this.cache!).map(([name, entry]) => ({
      name,
      url: entry.url,
      hasTokens: !!entry.tokens,
    }))
  }

  // ── 辅助静态方法 ────────────────────────────────────────────────────────

  /** 根据 issuedAt + expires_in 推导绝对过期时间戳。
   *  若任一信息缺失，则返回 undefined。 */
  static expiresAt(stored: StoredServerAuth | undefined): number | undefined {
    const t = stored?.tokens
    if (!t) return undefined
    if (typeof t.expires_in !== 'number') return undefined
    const issued = stored.tokensIssuedAt ? Date.parse(stored.tokensIssuedAt) : NaN
    if (Number.isNaN(issued)) return undefined
    return issued + t.expires_in * 1000
  }

  /** 粗略判断 access token 是否仍然足够新鲜可用。
   *  若无法判断过期时间，则乐观返回 true，让真正的 401 来触发刷新。 */
  static isAccessTokenLikelyValid(stored: StoredServerAuth | undefined, skewMs = 60_000): boolean {
    if (!stored?.tokens?.access_token) return false
    const expiresAt = McpTokenStorage.expiresAt(stored)
    if (expiresAt === undefined) return true
    return Date.now() + skewMs < expiresAt
  }

  // ── 内部实现 ───────────────────────────────────────────────────────────

  /** 首次访问时把磁盘内容读入内存缓存。 */
  private async ensureLoaded(): Promise<void> {
    if (this.cache !== null) return
    this.cache = await readFile()
  }

  /** 把当前缓存原子写回磁盘。 */
  private async flush(): Promise<void> {
    if (!this.cache) return
    try {
      await fs.mkdir(userXcodeDir(), { recursive: true })
      const tmp = authFile() + '.tmp'
      await fs.writeFile(tmp, JSON.stringify(this.cache, null, 2) + '\n', {
        encoding: 'utf-8',
        mode: 0o600,
      })
      await fs.rename(tmp, authFile())
    } catch (err) {
      debugLog('mcp.token-write-failed', String(err))
    }
  }
}

/** 从磁盘读取鉴权文件；文件不存在或损坏时返回空对象。 */
async function readFile(): Promise<FileShape> {
  try {
    const raw = await fs.readFile(authFile(), 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as FileShape
    }
  } catch {
    // 文件缺失或损坏时，从空状态开始
  }
  return {}
}

/** 全局单例实例。
 *  CLI 启动时会复用这一份，并传给 loadMcpServers 以及 /mcp auth / logout 等流程。 */
let globalInstance: McpTokenStorage | null = null

/** 获取全局 token storage 单例。 */
export function getTokenStorage(): McpTokenStorage {
  if (!globalInstance) globalInstance = new McpTokenStorage()
  return globalInstance
}

/** 供测试替换单例实例，避免单测直接读写用户真实目录。 */
export function setTokenStorageForTesting(s: McpTokenStorage | null): void {
  globalInstance = s
}

export type { OAuthClientInformationFull, OAuthClientInformationMixed, OAuthTokens }
