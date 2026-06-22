// @x-code-cli/core — MCP 注册表
//
// 它会在 CLI 启动时由 `loadMcpServers` 构建一次，此后整个会话基本保持稳定，
// 但不再是完全不可变对象。当前存在两个会修改内部状态的入口：
//
//   - `restartAll(newConfigs?)`（供 `/mcp refresh` 使用）：
//     断开并重连所有服务，可选地换成刚从磁盘读取的新配置，这样新增的服务无需重启 CLI。
//   - `authenticateServer(name, hooks)`（供 `/mcp auth <name>` 使用）：
//     对单个 HTTP 服务重新走一遍 OAuth 流程，然后重新连接。
//
// 这两个方法都会原地修改注册表内部的 Map，这样 `AgentOptions` 里保存的
// `options.mcpRegistry` 引用始终有效，agent loop 和工具执行层都不用重新接线。
// 调用方在之后需要主动清空 `state.systemPromptCache`：因为工具集合已经变了，
// 而 OpenAI 兼容提供商的前缀缓存依赖 system prompt 的字节稳定性
// （见 CLAUDE.md 中的约束说明），必须手动失效。App.tsx 里的 `/mcp`
// slash command 处理器就是通过 `useAgent` 上的 `invalidateSystemPromptCache()`
// 来做这件事的。
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'

import { debugLog } from '../utils.js'
import { McpClient } from './client.js'
import { UnsafeEnvError, assertSafeEnv } from './env-safety.js'
import { EnvExpansionError, expandEnvDeep } from './expand-env.js'
import { buildCallableName } from './name-mangling.js'
import {
  type McpCallResult,
  type McpResourceEntry,
  type McpServerConfig,
  type McpServerStatus,
  type McpToolEntry,
  isHttpConfig,
  isStdioConfig,
} from './types.js'

/** 为单个 HTTP 服务构造 OAuth provider。
 *  stdio 服务返回 `undefined`；如果 CLI 层没有接好 OAuth 所需能力
 *  （例如没有配置 token 存储），HTTP 服务这里也会返回 `undefined`。 */
export type OAuthProviderFactory = (serverName: string, serverUrl: string) => OAuthClientProvider | undefined

export interface AuthBrowserOpenInfo {
  url: string // SDK 准备跳转到的授权地址
}

export interface RegisteredServer {
  name: string // 服务名
  client: McpClient // 对应的 MCP 客户端实例
  status: McpServerStatus // 当前运行状态
  /** 当状态为 `failed` 时，保存最近一次 stderr 尾部内容（仅 stdio 服务）。
   *  `/mcp list` 会用它向用户展示服务失败原因。 */
  stderrTail?: string // 最近的标准错误输出尾部
}

/** `/mcp auth` 处理器传入的钩子，用于在不依赖 CLI UI 层的前提下对外汇报进度。 */
export interface AuthHooks {
  onBrowserOpen?: (url: string) => void // 即将打开浏览器前触发，参数是 SDK 准备跳转到的授权地址
}

/** `restartAll` 实际变更内容的摘要，供 `/mcp refresh` 输出使用。 */
export interface RestartSummary {
  added: string[] // 重启后新增、重启前不存在的服务名
  removed: string[] // 被移除的服务名，即旧配置里有、新配置里没有
  changed: string[] // 前后都存在，但配置内容发生变化的服务名
  unchanged: string[] // 前后都存在，且配置未变化的服务名
}

export class McpRegistry {
  /** callableName → entry。
   *  callableName 是面向模型的 `<server>__<tool>` 形式；
   *  命名冲突会在插入时解决。 */
  private readonly entries = new Map<string, McpToolEntry>()
  /** uri → entry。
   *  按规范 URI 应当唯一；如果两个服务真的暴露同一个 URI，
   *  我们保留第一个并给出告警（由 loader 负责处理）。 */
  private readonly resources = new Map<string, McpResourceEntry>()
  private readonly servers = new Map<string, RegisteredServer>()
  /** 每个服务最近一次加载的配置。
   *  这是 `restartServer`（按原配置重连）以及 `restartAll`
   *  （在传入新配置时做差异比较）的事实来源。 */
  private readonly configs = new Map<string, McpServerConfig>()
  /** 按服务构造 OAuth provider 的工厂。
   *  可选；为 `undefined` 时，需要鉴权的 HTTP 服务只会表现为 `needs_auth`，
   *  `/mcp auth` 也无法驱动它们完成登录。 */
  private oauthFactory: OAuthProviderFactory | undefined

  /** 使用初始的服务、工具、资源和配置快照构建 MCP 注册表。 */
  constructor(input: {
    servers: RegisteredServer[]
    tools: McpToolEntry[]
    resources: McpResourceEntry[]
    /** 启动时每个服务对应的配置。
     *  `restartServer` / `authenticateServer` 依赖它知道该如何重建连接。 */
    configs?: Map<string, McpServerConfig>
    /** 从 CLI 透传进来的 OAuth provider 工厂。 */
    oauthFactory?: OAuthProviderFactory
  }) {
    for (const s of input.servers) this.servers.set(s.name, s)
    for (const t of input.tools) this.entries.set(t.callableName, t)
    for (const r of input.resources) this.resources.set(r.uri, r)
    if (input.configs) for (const [k, v] of input.configs) this.configs.set(k, v)
    this.oauthFactory = input.oauthFactory
  }

  // ── 工具视图 ───────────────────────────────────────────────────────────

  /** 返回当前全部面向模型的工具快照，遍历顺序稳定。
   *  供 `buildTools`（agent loop）和 `buildSystemPrompt` 使用。 */
  list(): McpToolEntry[] {
    return [...this.entries.values()]
  }

  /** 按模型可见的 callableName 读取单个工具条目。 */
  get(callableName: string): McpToolEntry | undefined {
    return this.entries.get(callableName)
  }

  // ── 资源视图 ───────────────────────────────────────────────────────────

  /** 返回当前已登记的所有 MCP 资源。 */
  listResources(): McpResourceEntry[] {
    return [...this.resources.values()]
  }

  /** 根据资源 URI 找到拥有它的服务客户端，供资源读取工具分发请求。
   *  未知 URI 返回 `undefined`。 */
  resourceServer(uri: string): McpClient | undefined {
    const r = this.resources.get(uri)
    if (!r) return undefined
    return this.servers.get(r.serverName)?.client
  }

  // ── 服务视图（供 `/mcp list` / 状态展示使用） ─────────────────────────

  /** 返回所有服务的当前状态快照。 */
  serverStatus(): Array<{ name: string; status: McpServerStatus; stderrTail?: string }> {
    return [...this.servers.values()].map((s) => ({
      name: s.name,
      status: s.status,
      stderrTail: s.stderrTail,
    }))
  }

  /** 按服务名获取注册中的服务实例。 */
  getServer(serverName: string): RegisteredServer | undefined {
    return this.servers.get(serverName)
  }

  /** 按服务名获取最近一次加载的配置。 */
  getConfig(serverName: string): McpServerConfig | undefined {
    return this.configs.get(serverName)
  }

  // ── 调度 ───────────────────────────────────────────────────────────────

  /** 通过面向模型的 callableName 调用 MCP 工具。
   *  会先查工具条目，再定位所属服务，最后转发给 SDK 客户端。 */
  async callTool(callableName: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult> {
    const entry = this.entries.get(callableName)
    if (!entry) throw new Error(`未找到 MCP 工具：${callableName}`)
    const server = this.servers.get(entry.serverName)
    if (!server) throw new Error(`MCP 服务已不存在：${entry.serverName}`)
    return server.client.callTool(entry.rawName, args, signal)
  }

  // ── 生命周期 ───────────────────────────────────────────────────────────

  /** 尽量优雅地断开所有服务。
   *  采用 best-effort 策略：某一个服务关闭失败，不影响其他服务继续关闭。
   *  这个方法会在 CLI 退出钩子中调用，也会被 `restartAll` 在重建前内部调用。 */
  async shutdown(): Promise<void> {
    const tasks: Promise<void>[] = []
    for (const s of this.servers.values()) {
      tasks.push(
        s.client.close().catch(() => {
          // client.safeClose 里已经记过日志，这里没有额外可处理的信息。
        }),
      )
    }
    await Promise.allSettled(tasks)
  }

  // ── 重启 / 刷新 ────────────────────────────────────────────────────────

  /** 使用当前配置原地重连单个服务。
   *  它会被 `authenticateServer` 在拿到新 token 后使用，也对外暴露给只想刷新
   *  单个服务、而不想全量 refresh 的调用方。
   *
   *  旧连接对应的工具和资源条目会先被移除，再替换成新连接重新枚举到的结果。
   *  如果服务的 `tools/list` 输出变了，工具名也可能跟着变化。
   *  调用方在方法返回后必须手动失效 agent 的 systemPromptCache。 */
  async restartServer(name: string, opts: { driveOAuth?: AuthHooks } = {}): Promise<RegisteredServer> {
    const config = this.configs.get(name)
    if (!config) {
      throw new Error(`未注册名为 "${name}" 的 MCP 服务`)
    }
    // 在创建替代连接前先关闭旧客户端（如果存在）。
    // 对 stdio 服务来说，这一步会杀掉旧子进程，避免遗留僵尸进程。
    // 关闭失败不是致命错误：即便老连接坏到无法正常关闭，也应该继续尝试替换。
    const existing = this.servers.get(name)
    if (existing) {
      try {
        await existing.client.close()
      } catch (err) {
        debugLog('mcp.restart-close-failed', `${name}: ${String(err)}`)
      }
    }

    // 先移除这个服务原有的工具和资源。
    // 必须在新连接建立前做，这样即使重连中途部分失败，状态也会保持一致：
    // 要么这个服务当前什么都没有，要么是全新的结果，不会出现“半旧半新”的混合状态。
    this.removeServerEntries(name)

    const result = await connectOneServer(name, config, this.oauthFactory, opts.driveOAuth)
    this.installServer(result)
    return result.server
  }

  /** 断开全部服务，并基于 `newConfigs`（未传时则沿用当前配置）重新构建注册表。
   *  返回一个差异摘要，便于 UI 告诉用户到底发生了哪些变化。
   *
   *  这个方法用于 `/mcp refresh`：外部重新读取用户级与项目级配置文件，
   *  把合并后的配置表传进来，这里负责做新增 / 删除 / 重连。
   *  即使某个服务的配置字节内容没变，也仍然会重连一次，这对用户来说更新更直观，
   *  也比逐个深度 diff 嵌套字段更简单。 */
  async restartAll(newConfigs?: Map<string, McpServerConfig>): Promise<RestartSummary> {
    const oldNames = new Set(this.configs.keys())
    const newNames = new Set((newConfigs ?? this.configs).keys())

    const summary: RestartSummary = {
      added: [...newNames].filter((n) => !oldNames.has(n)),
      removed: [...oldNames].filter((n) => !newNames.has(n)),
      changed: [],
      unchanged: [],
    }

    if (newConfigs) {
      for (const name of newNames) {
        if (!oldNames.has(name)) continue
        const before = JSON.stringify(this.configs.get(name))
        const after = JSON.stringify(newConfigs.get(name))
        if (before !== after) summary.changed.push(name)
        else summary.unchanged.push(name)
      }
    } else {
      summary.unchanged = [...newNames]
    }

    // 先整体拆掉，再整体重连。
    // 相比“每个服务各自 close+connect”，这种 close-all 再 connect-all
    // 的方式更可预期：同一个服务不会同时存在两个客户端，
    // stdio 子进程也能确保在替代者启动前先退出。
    await this.shutdown()

    // 重置内部状态。OAuth 工厂保留下来，因为它来自 CLI 进程本身，
    // 不绑定于某一个具体配置对象。
    this.servers.clear()
    this.entries.clear()
    this.resources.clear()
    this.configs.clear()
    const effective = newConfigs ?? new Map<string, McpServerConfig>()
    for (const [k, v] of effective) this.configs.set(k, v)

    // 并行重连，策略与首次启动一致。
    // 单个服务失败只会记录成 `status: failed`，不会中断整个刷新流程。
    const tasks = [...effective.entries()].map(async ([name, config]) => {
      try {
        return await connectOneServer(name, config, this.oauthFactory)
      } catch (err) {
        debugLog('mcp.restartAll-connect-failed', `${name}: ${String(err)}`)
        return null
      }
    })
    const results = await Promise.all(tasks)

    // 按服务名排序，保证工具插入顺序稳定，与 loader.ts 首次启动时的行为保持一致。
    const installable = results
      .filter((r): r is ConnectResult => r !== null)
      .sort((a, b) => a.server.name.localeCompare(b.server.name))
    for (const r of installable) this.installServer(r)

    return summary
  }

  /** 为单个 HTTP 服务重新走一遍 OAuth 流程，然后重连。
   *  供 `/mcp auth <name>` 使用。
   *
   *  前置条件：调用方应当先通过 token 存储的 `clear()` 清掉该服务旧的 token，
   *  否则一个“还存在但已过期”的 token 可能让重授权流程被短路，继续复用坏状态。
   *
   *  返回鉴权完成后的服务状态。
   *  如果目标服务是 stdio（无需 OAuth）、未配置 OAuth 工厂，或用户中途关闭浏览器标签页 /
   *  回调超时，则会抛错。 */
  async authenticateServer(name: string, hooks: AuthHooks = {}): Promise<RegisteredServer> {
    const config = this.configs.get(name)
    if (!config) throw new Error(`未注册名为 "${name}" 的 MCP 服务`)
    if (!isHttpConfig(config)) {
      throw new Error(`MCP 服务 "${name}" 是 stdio 类型，OAuth 仅适用于 HTTP 服务`)
    }
    if (!this.oauthFactory) {
      throw new Error('尚未配置 OAuth，请在 loader 中提供 token 存储后再使用 /mcp auth')
    }

    return this.restartServer(name, { driveOAuth: hooks })
  }

  /** 整体替换 OAuth 工厂。
   *  这主要用于少数场景：例如 CLI 在注册表构建后才懒加载 token 存储 /
   *  onBrowserOpen 相关接线，或者测试环境需要动态替换它。 */
  setOAuthFactory(factory: OAuthProviderFactory | undefined): void {
    this.oauthFactory = factory
  }

  // ── 内部实现 ───────────────────────────────────────────────────────────

  /** 移除某个服务名下的全部工具和资源条目。幂等。 */
  private removeServerEntries(name: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.serverName === name) this.entries.delete(key)
    }
    for (const [key, res] of this.resources) {
      if (res.serverName === name) this.resources.delete(key)
    }
  }

  /** 将新的 ConnectResult 安装进各类映射表。
   *  调用方需要先自行移除同名服务此前的旧条目。 */
  private installServer(r: ConnectResult): void {
    this.servers.set(r.server.name, r.server)
    const taken = new Set(this.entries.keys())
    for (const t of r.tools) {
      const callable = buildCallableName(r.server.name, t.name, taken)
      taken.add(callable)
      this.entries.set(callable, {
        callableName: callable,
        rawName: t.name,
        serverName: r.server.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema,
      })
    }
    for (const res of r.resources) this.resources.set(res.uri, res)
  }
}

/** 创建一个空注册表。
 *  用于 MCP 被整体关闭时（例如配置里没有 mcpServers，或信任弹窗被拒绝），
 *  这样下游代码就不需要到处做 null 判断。 */
export function emptyRegistry(): McpRegistry {
  return new McpRegistry({ servers: [], tools: [], resources: [] })
}

// ── 连接辅助函数（与 loader.ts 的首次启动流程共享） ────────────────────

/** 单个服务一次“连接 + 枚举”操作的结果。
 *  首次启动（`loadMcpServers`）和注册表的重启路径都会复用它，
 *  从而保证连接结果的结构始终一致。 */
export interface ConnectResult {
  server: RegisteredServer // 连接后的服务实例与状态
  tools: ReadonlyArray<{ name: string; description?: string; inputSchema: Record<string, unknown> }> // 服务枚举到的工具列表
  resources: ReadonlyArray<McpResourceEntry> // 服务枚举到的资源
}

/** 为单个服务创建客户端、执行连接握手，并返回枚举到的能力结果。
 *  当传入 `driveOAuth` 时，如果遇到 UnauthorizedError，会主动进入完整的
 *  浏览器 OAuth 流程；不传时则只把状态标记成 `needs_auth`，等待用户手动执行
 *  `/mcp auth`。 */
export async function connectOneServer(
  name: string,
  rawConfig: McpServerConfig,
  oauthFactory: OAuthProviderFactory | undefined,
  driveOAuth?: AuthHooks,
): Promise<ConnectResult> {
  // 尊重 `enabled: false`：保留注册信息，但跳过真正的连接动作。
  if (rawConfig.enabled === false) {
    const client = new McpClient(name, rawConfig)
    return {
      server: { name, client, status: { kind: 'disabled' } },
      tools: [],
      resources: [],
    }
  }

  // 在创建客户端前先展开 `${VAR}` 引用。
  // 然后对 stdio 配置执行环境变量安全校验，这里是所有 env 来源
  // （CLI 参数、mcp.json、插件 manifest）都会经过的唯一闸口，
  // 因此只要在这里拒绝危险 key，就能统一覆盖所有入口。
  // 威胁模型见 env-safety.ts。
  let expanded: McpServerConfig
  try {
    expanded = expandEnvDeep(rawConfig)
    if (isStdioConfig(expanded)) assertSafeEnv(expanded.env)
  } catch (err) {
    const msg =
      err instanceof EnvExpansionError || err instanceof UnsafeEnvError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err)
    const client = new McpClient(name, rawConfig)
    return {
      server: { name, client, status: { kind: 'failed', error: msg } },
      tools: [],
      resources: [],
    }
  }

  const authProvider = oauthFactory && isHttpConfig(expanded) ? oauthFactory(name, expanded.url) : undefined
  const client = new McpClient(name, expanded, authProvider)

  try {
    const info = driveOAuth ? await client.connectWithOAuth(driveOAuth) : await client.connect()
    return {
      server: {
        name,
        client,
        status: { kind: 'connected', toolCount: info.toolCount, resourceCount: info.resourceCount },
      },
      tools: client.tools(),
      resources: client.resources(),
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const needsAuth = /unauth|401|UnauthorizedError/i.test(msg) && isHttpConfig(expanded)
    const status: RegisteredServer['status'] = needsAuth ? { kind: 'needs_auth' } : { kind: 'failed', error: msg }
    return {
      server: { name, client, status, stderrTail: client.stderr() || undefined },
      tools: [],
      resources: [],
    }
  }
}
