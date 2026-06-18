// @x-code-cli/core — 插件贡献与现有加载器的整合层
//
// 它接收 [[loader]].loadAllPlugins 的结果，并把插件贡献转换成现有
// skill / sub-agent / MCP 加载器能够直接消费的结构，因此 CLI 启动阶段
// 会形成这样的调用链：
//
//   const pluginLoad = await loadAllPlugins({ cwd })
//   const integration = await buildPluginIntegration(pluginLoad)
//   const skillRegistry  = await createSkillRegistry({  extraDirs: integration.skillsDirs })
//   const agentRegistry  = await createSubAgentRegistry({ extraDirs: integration.agentsDirs })
//   const mcpRegistry    = await loadMcpFromDisk({ ..., extraServers: integration.mcpServers })
//
// 这个模块负责另外几个加载器不负责的三件事：
//
//   1. 把插件 manifest 中的 `mcpServers`（可能是路径，也可能是内联对象）
//      解析成带类型的 `Record<string, McpServerConfig>`。
//      路径形式对应一个 `{ mcpServers: {...} }` 结构的 JSON 文件，
//      与 ~/.x-code/config.json 保持一致；内联形式则直接使用对象本身。
//
//   2. 检测插件之间的名称冲突。当前按服务名去重：遍历顺序里靠前的插件获胜，
//      后出现的同名项会被丢弃并记录告警。未来可以考虑给服务名加上
//      插件 id 命名空间。
//
//   3. 记录那些我们暂时还不支持完整消费的插件贡献。比如 `commands`
//      和 `hooks`，虽然当前系统已经能识别并登记它们，但某些能力的最终
//      消费时机仍由别处决定，因此这里需要集中沉淀诊断信息。
//
// 插件遍历顺序是确定性的，由 `loadAllPlugins` 返回的 `contributions` Map
// 迭代顺序驱动，而后者又反映 installed_plugins.json 与项目本地发现顺序。
// 因此在安装集不变的前提下，多次启动结果稳定一致。
import fs from 'node:fs/promises'

import { HookBus } from '../hooks/bus.js'
import { HookConfigParseError, parseHookConfig } from '../hooks/config-schema.js'
import { HookRegistry, buildHookRegistry } from '../hooks/registry.js'
import type { HookConfig } from '../hooks/types.js'
import { parseServersBlock } from '../mcp/config-schema.js'
import { isStdioConfig } from '../mcp/types.js'
import type { McpServerConfig } from '../mcp/types.js'
import { debugLog } from '../utils.js'
import { loadAllPlugins } from './loader.js'
import type { LoadResult, ResolvedContributions } from './loader.js'
import type { InlineMcpServers, LoadedPlugin } from './types.js'
import { getPluginUserConfigEnv } from './user-config.js'

export interface PluginIntegrationOutput {
  /** 需要额外纳入 skill 加载器扫描的目录列表，并附带所属插件 id。
   *  仅包含已启用插件。 */
  skillsDirs: Array<{ dir: string; pluginId: string }>
  /** 需要额外扫描的 sub-agent `.md` 目录列表。 */
  agentsDirs: Array<{ dir: string; pluginId: string }>
  /** 需要额外扫描的 slash command `*.md` 目录列表。
   *  每项都携带所属插件 rootDir，方便命令体在激活时替换
   *  `${CLAUDE_PLUGIN_ROOT}`。 */
  commandsDirs: Array<{ dir: string; pluginId: string; pluginRoot: string }>
  /** 所有已启用插件合并后的 `mcpServers` 配置。
   *  名称冲突采用“先到先得”，被丢弃者记录到 `mcpCollisions`。 */
  mcpServers: Record<string, McpServerConfig>
  /** 基于所有已启用插件 `hooks` 配置构建出的 HookRegistry。
   *  若没有插件声明 hooks，则为空注册表。可直接交给
   *  `new HookBus(...)` 接入 agent loop 的事件发射点。 */
  hookRegistry: HookRegistry
  /** 基于 `hookRegistry` 构建好的可直接使用的 HookBus。
   *  方便 CLI 启动时直接赋值：`AgentOptions.hookBus = integration.hookBus`。 */
  hookBus: HookBus
  /** 每个插件声明了哪些 hook 事件的摘要信息。
   *  供 `/plugin doctor` 和 `/plugin info` 界面使用。 */
  pluginHooks: Array<{ pluginId: string; events: string[] }>
  /** 因与更早插件发生同名冲突而被丢弃的 mcpServers 条目。
   *  结构为 `{ name, droppedFrom, keptFrom }`。 */
  mcpCollisions: Array<{ name: string; droppedFrom: string; keptFrom: string }>
  /** 各插件在 mcpServers 读取或解析阶段产生的错误。
   *  这类错误不会阻塞启动，而是交由 `/plugin doctor` 展示。 */
  mcpErrors: Array<{ pluginId: string; message: string }>
  /** 各插件在 hooks 读取或解析阶段产生的错误。 */
  hookErrors: Array<{ pluginId: string; message: string }>
}

/** 基于已加载插件结果，构建各子系统可直接消费的整合输出。 */
export async function buildPluginIntegration(load: LoadResult): Promise<PluginIntegrationOutput> {
  // Hook registry 放到最后统一构建，这样我们可以先沿途收集每个插件的
  // hooks 配置。毕竟插件 rootDir 只有在拿到 LoadedPlugin 后才知道。
  const hookInputs: Array<{ pluginId: string; pluginDir: string; config: HookConfig }> = []

  const out: PluginIntegrationOutput = {
    skillsDirs: [],
    agentsDirs: [],
    commandsDirs: [],
    mcpServers: {},
    hookRegistry: new HookRegistry(),
    hookBus: new HookBus(new HookRegistry()),
    pluginHooks: [],
    mcpCollisions: [],
    mcpErrors: [],
    hookErrors: [],
  }
  const mcpOwners = new Map<string, string>()

  for (const plugin of load.registry.list()) {
    const contrib = load.contributions.get(plugin.id)
    if (!contrib) continue

    if (contrib.skillsDir) out.skillsDirs.push({ dir: contrib.skillsDir, pluginId: plugin.id })
    if (contrib.agentsDir) out.agentsDirs.push({ dir: contrib.agentsDir, pluginId: plugin.id })
    if (contrib.commandsDir) {
      out.commandsDirs.push({ dir: contrib.commandsDir, pluginId: plugin.id, pluginRoot: plugin.rootDir })
    }

    if (contrib.hooks) {
      const config = await resolvePluginHooks(plugin, contrib.hooks, out)
      if (config) {
        hookInputs.push({ pluginId: plugin.id, pluginDir: plugin.rootDir, config })
        out.pluginHooks.push({ pluginId: plugin.id, events: Object.keys(config) })
      }
    }

    if (contrib.mcpServers) {
      const servers = await resolvePluginMcpServers(plugin, contrib.mcpServers, out)
      for (const [name, cfg] of Object.entries(servers)) {
        const prevOwner = mcpOwners.get(name)
        if (prevOwner !== undefined) {
          out.mcpCollisions.push({ name, droppedFrom: plugin.id, keptFrom: prevOwner })
          continue
        }
        out.mcpServers[name] = cfg
        mcpOwners.set(name, plugin.id)
      }
    }
  }

  out.hookRegistry = buildHookRegistry(hookInputs)
  out.hookBus = new HookBus(out.hookRegistry)
  return out
}

/** 解析单个插件的 hooks 贡献，并把非致命错误写入整合输出。 */
async function resolvePluginHooks(
  plugin: LoadedPlugin,
  contrib: NonNullable<ResolvedContributions['hooks']>,
  out: PluginIntegrationOutput,
): Promise<HookConfig | null> {
  let raw: unknown
  if (contrib.kind === 'inline') {
    raw = contrib.data
  } else {
    try {
      const text = await fs.readFile(contrib.path, 'utf-8')
      raw = JSON.parse(text)
    } catch (err) {
      out.hookErrors.push({
        pluginId: plugin.id,
        message: `读取 hooks 文件失败 ${contrib.path}：${err instanceof Error ? err.message : String(err)}`,
      })
      return null
    }
  }
  try {
    return parseHookConfig(raw, plugin.id)
  } catch (err) {
    out.hookErrors.push({
      pluginId: plugin.id,
      message: err instanceof HookConfigParseError ? err.message : String(err),
    })
    return null
  }
}

/** 从 `.mcp.json` 文件内容中提取 `name -> cfg` 这一层配置块。
 *  支持两种形状：
 *
 *    - 包装形式：`{ "mcpServers": { "name": cfg, ... } }`
 *    - 扁平形式：`{ "name": cfg, ... }`（没有包装键）
 *
 *  Claude Code 官方插件（例如 linear@anthropic-marketplace）
 *  常使用扁平形式；而包装形式与我们自己的 config.json 布局一致。
 *  识别规则是：只要解析后的对象里存在 `mcpServers` 这个键，就视为包装形式，
 *  并把对应值原样交给 schema 解析器，这样一旦结构错误也能得到清晰报错；
 *  否则就把整个对象当成扁平配置块。 */
export function extractMcpServersBlock(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const obj = parsed as Record<string, unknown>
  if ('mcpServers' in obj) return obj.mcpServers
  return obj
}

/** 解析单个插件的 mcpServers 贡献，并完成 userConfig 环境变量注入。 */
async function resolvePluginMcpServers(
  plugin: LoadedPlugin,
  contrib: NonNullable<ResolvedContributions['mcpServers']>,
  out: PluginIntegrationOutput,
): Promise<Record<string, McpServerConfig>> {
  let rawBlock: unknown
  if (contrib.kind === 'inline') {
    rawBlock = contrib.data as InlineMcpServers
  } else {
    try {
      const raw = await fs.readFile(contrib.path, 'utf-8')
      const parsed = JSON.parse(raw)
      rawBlock = extractMcpServersBlock(parsed)
    } catch (err) {
      out.mcpErrors.push({
        pluginId: plugin.id,
        message: `读取 mcpServers 文件失败 ${contrib.path}：${err instanceof Error ? err.message : String(err)}`,
      })
      return {}
    }
  }

  const { servers, errors } = parseServersBlock(rawBlock)
  for (const e of errors) {
    out.mcpErrors.push({ pluginId: plugin.id, message: `mcpServers.${e.name}: ${e.message}` })
  }

  // 把所属插件的 userConfig 值合并进每个服务的 env 映射。
  // 如果插件作者希望把 manifest 里声明的 userConfig 字段（例如 API Key）
  // 暴露给 MCP 进程，只需要像普通环境变量一样在 mcpServers 中引用它，
  // 或者干脆依赖子进程继承环境即可。已有的 server env 优先级更高，
  // 这样作者仍可按服务粒度覆盖某个 userConfig 值。
  try {
    const pluginEnv = await getPluginUserConfigEnv(plugin.id)
    if (Object.keys(pluginEnv).length > 0) {
      for (const name of Object.keys(servers)) {
        const cfg = servers[name]!
        // 只有 stdio 类型服务会拉起子进程并接受 env；
        // HTTP 服务是远端端点，合并环境变量没有意义。
        if (isStdioConfig(cfg)) {
          servers[name] = { ...cfg, env: { ...pluginEnv, ...(cfg.env ?? {}) } }
        }
      }
    }
  } catch (err) {
    out.mcpErrors.push({ pluginId: plugin.id, message: `合并 userConfig 环境变量失败：${String(err)}` })
  }

  return servers
}

/** 便捷方法：把非致命整合诊断信息写入 debug.log。
 *  这样 `/plugin doctor` 或临时排障时都能更方便地定位问题。
 *  CLI 启动流程会在 `buildPluginIntegration` 返回后调用它。 */
export function debugLogIntegrationDiagnostics(integration: PluginIntegrationOutput): void {
  for (const c of integration.commandsDirs) {
    debugLog('plugins.commands-loaded', `${c.pluginId} commands 目录：${c.dir}`)
  }
  for (const h of integration.pluginHooks) {
    debugLog('plugins.hooks-registered', `${h.pluginId} hooks：[${h.events.join(', ')}]`)
  }
  for (const e of integration.hookErrors) {
    debugLog('plugins.hook-error', `${e.pluginId}: ${e.message}`)
  }
  for (const c of integration.mcpCollisions) {
    debugLog('plugins.mcp-collision', `来自 ${c.droppedFrom} 的 mcpServer "${c.name}" 已丢弃（保留 ${c.keptFrom}）`)
  }
  for (const e of integration.mcpErrors) {
    debugLog('plugins.mcp-error', `${e.pluginId}: ${e.message}`)
  }
}

/** 重新从磁盘扫描插件，并只返回插件贡献出来的合并后 mcpServers。
 *  `/mcp refresh` 会用它把插件服务重新并入总配置，避免独立刷新 MCP 时
 *  把插件服务静默丢掉；`/plugin refresh` 也会通过 buildPluginIntegration
 *  间接依赖它。
 *
 *  这里固定返回 `{}` 而不是 `undefined`，这样调用方可以放心直接展开。
 *  如果扫描失败，则降级为 `{}` 并写 debug log，避免一次纯 MCP 刷新因为
 *  插件系统的小故障而整体失败。 */
export async function getPluginMcpServersFromDisk(cwd: string): Promise<Record<string, McpServerConfig>> {
  try {
    const load = await loadAllPlugins({ cwd })
    const integration = await buildPluginIntegration(load)
    return integration.mcpServers
  } catch (err) {
    debugLog('plugins.mcp-scan-failed', `getPluginMcpServersFromDisk 失败：${String(err)}`)
    return {}
  }
}

// 重新导出常用类型与方法，让典型的 CLI 启动接线只需从这里单点导入。
export type { LoadResult, ResolvedContributions } from './loader.js'
export { loadAllPlugins }
