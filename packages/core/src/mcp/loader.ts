// @x-code-cli/core — MCP 启动加载器
//
// 这是 CLI 入口在启动时调用的一次性编排逻辑：
//   - 读取用户级与项目级配置
//   - 对项目级配置应用信任门禁
//   - 展开环境变量
//   - 并行启动或连接所有启用的服务
//   - 构建后续可被 `/mcp refresh` 和 `/mcp auth` 继续复用的 registry
//
// 单个服务出错不会中断整个启动流程；
// 错误会被记录下来，并通过 `/mcp list` 告知用户发生了什么。
import fs from 'node:fs/promises'
import path from 'node:path'

import { getUserConfigPath } from '../config/index.js'
import { XCODE_DIR, debugLog } from '../utils.js'
import { parseServersBlock } from './config-schema.js'
import { buildCallableName as buildCallable } from './name-mangling.js'
import {
  type ConnectResult,
  McpRegistry,
  type OAuthProviderFactory,
  type RegisteredServer,
  connectOneServer,
  emptyRegistry,
} from './registry.js'
import { type TrustChoice, buildServerPreview, isProjectTrusted, promptForTrust, trustProject } from './trust.js'
import { type McpResourceEntry, type McpServerConfig, type McpToolEntry } from './types.js'

export type { OAuthProviderFactory }
export type { RegisteredServer, ConnectResult }
export type { McpResourceEntry, McpToolEntry }

export interface LoadOptions {
  /** 来自 ~/.x-code/config.json 的 mcpServers，默认视为可信。 */
  userServers: Record<string, McpServerConfig> | undefined
  /** 来自 <project>/.x-code/config.json 的 mcpServers，需要用户授权后才会启用。 */
  projectServers: Record<string, McpServerConfig> | undefined
  /** 启用插件贡献的 mcpServers。
   *  这部分默认视为可信，因为用户在安装插件时已经做过授权。
   *  它们和 userServers 处于同一信任等级，但若与 project 同名，仍由 project 覆盖。 */
  extraServers?: Record<string, McpServerConfig>
  /** 项目绝对路径，同时也作为 trust 记录的 key。 */
  projectPath: string
  /** 用于渲染 trust 对话框，签名与 `AgentCallbacks.onAskUser` 保持一致。 */
  askUser: (question: string, options: Array<{ label: string; description: string }>) => Promise<string>
  /** OAuth provider 工厂。可选；若不提供，则需要认证的 HTTP 服务会被标记为 `needs_auth`。 */
  oauthProviderFor?: OAuthProviderFactory
  /** 当 loader 决定退出进程时触发的回调，由 CLI 层接入自身的优雅退出逻辑。 */
  onExitRequested?: () => void
}

export interface LoadResult {
  /** 构建完成的 MCP 注册表 */
  registry: McpRegistry
  /** 在真正连接任何服务前收集到的配置或解析错误。 */
  configErrors: Array<{ name: string; message: string }>
  /** 若项目级 mcpServers 因用户拒绝信任而被跳过，则为 true。 */
  projectSkipped: boolean
}

/** 从标准磁盘路径读取配置并执行加载流程。
 *  这是给 CLI 入口使用的便捷封装，让上层不需要关心具体路径细节。 */
export async function loadMcpFromDisk(opts: {
  /** 当前工作目录，也就是项目路径 */
  cwd: string
  /** trust 对话框的交互回调 */
  askUser: LoadOptions['askUser']
  /** 可选 OAuth provider 工厂 */
  oauthProviderFor?: OAuthProviderFactory
  /** 可选退出请求回调 */
  onExitRequested?: () => void
  /** 插件贡献的 mcpServers，视为已获授权。 */
  extraServers?: Record<string, McpServerConfig>
}): Promise<LoadResult> {
  const userServers = await readMcpServersFromFile(getUserConfigPath())
  const projectServers = await readMcpServersFromFile(path.join(opts.cwd, XCODE_DIR, 'config.json'))
  return loadMcpServers({
    userServers,
    projectServers,
    extraServers: opts.extraServers,
    projectPath: opts.cwd,
    askUser: opts.askUser,
    oauthProviderFor: opts.oauthProviderFor,
    onExitRequested: opts.onExitRequested,
  })
}

/** 重新从磁盘读取配置并应用 trust 门禁，但不立即启动任何服务。
 *  `/mcp refresh` 会先拿到这里产出的合并结果，再交给
 *  `registry.restartAll(...)` 原地重启现有注册表。 */
export async function loadMergedConfigsFromDisk(opts: {
  /** 当前项目目录 */
  cwd: string
  /** trust 对话框的交互回调 */
  askUser: LoadOptions['askUser']
  /** 插件贡献的 mcpServers，刷新时也需要带上，避免热刷新时丢失。 */
  extraServers?: Record<string, McpServerConfig>
}): Promise<{
  configs: Map<string, McpServerConfig>
  configErrors: Array<{ name: string; message: string }>
  projectSkipped: boolean
}> {
  const userServers = await readMcpServersFromFile(getUserConfigPath())
  const projectServers = await readMcpServersFromFile(path.join(opts.cwd, XCODE_DIR, 'config.json'))

  const configErrors: Array<{ name: string; message: string }> = []
  let projectSkipped = false

  const userParsed = parseServersBlock(userServers)
  configErrors.push(...userParsed.errors.map((e) => ({ name: `user:${e.name}`, message: e.message })))
  const projectParsed = parseServersBlock(projectServers)
  configErrors.push(...projectParsed.errors.map((e) => ({ name: `project:${e.name}`, message: e.message })))

  let projectServersToUse = projectParsed.servers
  if (Object.keys(projectServersToUse).length > 0) {
    const trusted = await isProjectTrusted(opts.cwd)
    if (!trusted) {
      const choice = await askForTrust(
        {
          userServers,
          projectServers,
          projectPath: opts.cwd,
          askUser: opts.askUser,
        },
        projectServersToUse,
      )
      if (choice === 'exit') {
        // `/mcp refresh` 不会因为用户点了 exit 就直接把整个 CLI 退出，
        // 否则斜杠命令本身会显得过于激进；这里退化成 skip。
        projectServersToUse = {}
        projectSkipped = true
      } else if (choice === 'skip') {
        projectServersToUse = {}
        projectSkipped = true
      } else if (choice === 'trust') {
        await trustProject(opts.cwd).catch((err) => {
          debugLog('mcp.trust-write-failed', String(err))
        })
      }
    }
  }

  // 合并优先级：user → plugin → project。
  // 插件位于中间层，意味着项目级配置依然可以覆盖插件带来的同名服务。
  const merged = new Map<string, McpServerConfig>(
    Object.entries({ ...userParsed.servers, ...(opts.extraServers ?? {}), ...projectServersToUse }),
  )
  return { configs: merged, configErrors, projectSkipped }
}

/** 纯加载逻辑：不直接读磁盘，完全由调用方注入配置来源。
 *  这样更容易测试，也让 CLI 保持对配置来源的控制权。 */
export async function loadMcpServers(options: LoadOptions): Promise<LoadResult> {
  const configErrors: Array<{ name: string; message: string }> = []
  let projectSkipped = false

  // 先统一校验两份配置。parseServersBlock 可以直接处理 undefined，
  // 因此没有配置的场景也不会产生额外成本。
  const userParsed = parseServersBlock(options.userServers)
  configErrors.push(...userParsed.errors.map((e) => ({ name: `user:${e.name}`, message: e.message })))

  const projectParsed = parseServersBlock(options.projectServers)
  configErrors.push(...projectParsed.errors.map((e) => ({ name: `project:${e.name}`, message: e.message })))

  // 项目级 trust 门禁：如果项目根本没声明服务，就不提示。
  let projectServersToUse = projectParsed.servers
  const projectServerNames = Object.keys(projectServersToUse)
  if (projectServerNames.length > 0) {
    const trusted = await isProjectTrusted(options.projectPath)
    if (!trusted) {
      const choice = await askForTrust(options, projectServersToUse)
      if (choice === 'exit') {
        options.onExitRequested?.()
        return { registry: emptyRegistry(), configErrors, projectSkipped: true }
      }
      if (choice === 'skip') {
        projectServersToUse = {}
        projectSkipped = true
      }
      if (choice === 'trust') {
        await trustProject(options.projectPath).catch((err) => {
          debugLog('mcp.trust-write-failed', String(err))
        })
      }
    }
  }

  // 合并顺序：user → plugin → project。
  // project 最后覆盖，是为了让项目作者可以显式接管插件提供的同名服务。
  const merged: Record<string, McpServerConfig> = {
    ...userParsed.servers,
    ...(options.extraServers ?? {}),
    ...projectServersToUse,
  }

  // 三处来源都没有服务时，快速返回空 registry。
  if (Object.keys(merged).length === 0) {
    return {
      registry: new McpRegistry({ servers: [], tools: [], resources: [], oauthFactory: options.oauthProviderFor }),
      configErrors,
      projectSkipped,
    }
  }

  // 并行连接所有服务。每个任务本身都会自己兜底，
  // 防止单个服务超时把整个启动流程拖垮。
  const tasks = Object.entries(merged).map(async ([name, rawConfig]) => {
    return connectOneServer(name, rawConfig, options.oauthProviderFor)
  })
  const results = await Promise.all(tasks)

  // 组装 registry。为保证工具命名冲突处理稳定，先按服务名排序；
  // 否则顺序会受异步 connect 完成时间影响。
  results.sort((a, b) => a.server.name.localeCompare(b.server.name))

  const tools: McpToolEntry[] = []
  const resources: McpResourceEntry[] = []
  const taken = new Set<string>()

  for (const r of results) {
    for (const t of r.tools) {
      const callable = buildCallable(r.server.name, t.name, taken)
      taken.add(callable)
      tools.push({
        callableName: callable,
        rawName: t.name,
        serverName: r.server.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema,
      })
    }
    for (const res of r.resources) resources.push(res)
  }

  const configs = new Map<string, McpServerConfig>(Object.entries(merged))

  const registry = new McpRegistry({
    servers: results.map((r) => r.server),
    tools,
    resources,
    configs,
    oauthFactory: options.oauthProviderFor,
  })

  return { registry, configErrors, projectSkipped }
}

/** 统一拉起项目级 trust 对话框，并在异常时偏向安全地跳过项目配置。 */
async function askForTrust(
  options: LoadOptions,
  projectServers: Record<string, McpServerConfig>,
): Promise<TrustChoice> {
  const summaries = Object.entries(projectServers).map(([name, cfg]) => ({
    name,
    preview: buildServerPreview(cfg as { command?: string; args?: string[]; url?: string }),
  }))
  try {
    return await promptForTrust(options.projectPath, summaries, options.askUser)
  } catch (err) {
    // 如果提示框自身失败（比如没有 TTY），宁可保守地跳过项目配置。
    debugLog('mcp.trust-prompt-failed', String(err))
    return 'skip'
  }
}

/** 从 JSON 配置文件中只读取 `mcpServers` 字段。
 *  文件不存在、解析失败或字段不存在时统一返回 undefined，
 *  这些都表示“这里没有可用的 MCP 服务配置”，不应视为致命错误。 */
async function readMcpServersFromFile(filePath: string): Promise<Record<string, McpServerConfig> | undefined> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, McpServerConfig> }
    if (parsed && typeof parsed === 'object' && parsed.mcpServers) {
      return parsed.mcpServers
    }
    return undefined
  } catch (err) {
    debugLog('mcp.config-parse-failed', `${filePath}: ${String(err)}`)
    return undefined
  }
}
