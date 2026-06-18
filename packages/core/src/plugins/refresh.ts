// @x-code-cli/core — 插件热重载协调器
//
// `/plugin refresh` 会进入这里。它的职责是重新从磁盘扫描已安装插件，
// 并在不重启 xc 的前提下，把新的插件状态传播到所有下游注册表。
//
// 之所以单独拆成一个模块，而不是挂在 PluginRegistry 上，是因为：
// “重载插件注册表本身”只是一行代码，真正复杂的是把新的插件贡献同步进
// agent loop 在启动时捕获的五类子注册表（skill / sub-agent / command /
// hook / mcp）。这些引用都必须保持稳定，因此每个注册表都提供原地重载
// 方法，而不是直接返回新实例。
//
// 当调用方传入 mcpRegistry + askUser 时，这里还会负责重启 MCP 服务器
// （project 级服务器的信任门控需要 askUser）。插件贡献的 MCP servers
// 会和用户级、项目级配置合并，然后统一走 `McpRegistry.restartAll(...)`，
// 与 `/mcp refresh` 使用同一条路径。如果调用方没有传 mcpRegistry，
// 就保留旧行为，只刷新 skill / agent / command / hook。
import { reloadSubAgentRegistry } from '../agent/sub-agents/registry.js'
import type { SubAgentRegistry, SubAgentReloadSummary } from '../agent/sub-agents/registry.js'
import { reloadCommandRegistry } from '../commands/registry.js'
import type { CommandRegistry, CommandReloadSummary } from '../commands/registry.js'
import type { HookBus } from '../hooks/bus.js'
import type { HookRegistry } from '../hooks/registry.js'
import { type LoadOptions, loadMergedConfigsFromDisk } from '../mcp/loader.js'
import type { McpRegistry, RestartSummary } from '../mcp/registry.js'
import { reloadSkillRegistry } from '../skills/registry.js'
import type { SkillRegistry, SkillReloadSummary } from '../skills/registry.js'
import { buildPluginIntegration } from './integration.js'
import { loadAllPlugins } from './loader.js'
import type { PluginRegistry, PluginReloadSummary } from './registry.js'

export interface PluginRefreshMcpConfigError {
  name: string // 发生解析错误的 MCP server 名称
  message: string // 具体错误信息
}

export interface PluginRefreshSummary {
  plugins: PluginReloadSummary // 插件层面的差异摘要，是 `/plugin refresh` 输出中的主信息
  skills?: SkillReloadSummary // skill 子注册表的刷新摘要；调用方未接入时为空
  subAgents?: SubAgentReloadSummary // sub-agent 子注册表的刷新摘要；调用方未接入时为空
  commands?: CommandReloadSummary // command 子注册表的刷新摘要；调用方未接入时为空
  hookCount: number // 刷新后注册的 hook 总数；hooks 没有稳定 id，因此只统计数量
  mcp?: RestartSummary // MCP 重启摘要；只有传入 mcpRegistry 时才会有
  mcpProjectSkipped?: boolean // 合并 MCP 配置时是否跳过了某些 project 级 server，供 UI 提示用户
  mcpConfigErrors?: PluginRefreshMcpConfigError[] // MCP 配置解析错误列表；不会中断刷新，但会提示哪些 server 被忽略
}

export interface PluginRefreshTargets {
  pluginRegistry: PluginRegistry // 要被原地更新的插件注册表
  skillRegistry?: SkillRegistry // 需要同步新插件贡献的 skill 注册表
  subAgentRegistry?: SubAgentRegistry // 需要同步新插件贡献的 sub-agent 注册表
  commandRegistry?: CommandRegistry // 需要同步新插件贡献的 command 注册表
  hookBus?: HookBus // 需要替换 hook 注册表的 hook 总线
  mcpRegistry?: McpRegistry // 需要按合并后配置重启的 MCP 注册表；传入时会一并刷新插件贡献的 server
  askUser?: LoadOptions['askUser'] // 与 mcpRegistry 搭配使用的用户确认回调，用于 project 级 server 的信任门控
  cwd?: string // 工作目录，默认是 process.cwd()；测试时可覆写
}

/** 重新扫描已安装插件，并把新状态折叠进所有已接入的注册表。
 *  调用方仍需在此之后主动使 systemPromptCache 失效，因为缓存引用位于更上层的
 *  agent options 中，这里拿不到。 */
export async function refreshPluginContributions(targets: PluginRefreshTargets): Promise<PluginRefreshSummary> {
  const cwd = targets.cwd ?? process.cwd()

  // 1. 从磁盘重新扫描插件。loadAllPlugins 会先构建一份自己的临时注册表，
  //    这里再把插件列表和加载错误抽出来，通过 reload() 喂回调用方持有的长生命周期注册表。
  const load = await loadAllPlugins({ cwd })

  // 2. 替换调用方里的插件注册表，并拿到主摘要差异。
  const pluginsSummary = targets.pluginRegistry.reload(load.registry.listAll(), [...load.registry.loadErrors()])

  // 3. 基于新的插件集合，重新计算下游集成产物：
  //    skills 目录、agents 目录、commands 目录、mcp servers、hook registry。
  const integration = await buildPluginIntegration(load)

  // 4. 把结果折叠进调用方接入的各个子注册表。
  const out: PluginRefreshSummary = { plugins: pluginsSummary, hookCount: 0 }

  if (targets.skillRegistry) {
    out.skills = await reloadSkillRegistry(targets.skillRegistry, { extraDirs: integration.skillsDirs })
  }
  if (targets.subAgentRegistry) {
    out.subAgents = await reloadSubAgentRegistry(targets.subAgentRegistry, { extraDirs: integration.agentsDirs })
  }
  if (targets.commandRegistry) {
    out.commands = await reloadCommandRegistry(targets.commandRegistry, { extraDirs: integration.commandsDirs })
  }
  if (targets.hookBus) {
    targets.hookBus.replaceRegistry(integration.hookRegistry)
    // 通过累加新注册表中各事件的条目数得到 hook 总量。
    // 这里只用于面向用户的提示，没必要为了精确 diff 再引入复杂度。
    out.hookCount = countHooks(integration.hookRegistry)
  }

  // 5. MCP 重启：仅当同时提供 mcpRegistry 与 askUser 时执行。
  //    它会重新读取用户级与项目级配置，并合并最新的插件 extraServers，
  //    然后把整套 MCP 连接全部拆掉再重建。与 /mcp refresh 走同一路径。
  //    这样带有 MCP server 的插件在安装后只需执行一次 /plugin refresh 即可生效。
  if (targets.mcpRegistry && targets.askUser) {
    const merged = await loadMergedConfigsFromDisk({
      cwd,
      askUser: targets.askUser,
      extraServers: integration.mcpServers,
    })
    out.mcpProjectSkipped = merged.projectSkipped
    out.mcpConfigErrors = merged.configErrors
    out.mcp = await targets.mcpRegistry.restartAll(merged.configs)
  }

  return out
}

/** 统计当前 hook 注册表中一共注册了多少个 hook。 */
function countHooks(registry: HookRegistry): number {
  // HookRegistry 暴露的是 get(eventName) → array，因此这里遍历已知事件名。
  // 这些名字与 types.ts 中有重复，但如果直接引入会产生循环依赖，所以保留一份小型硬编码列表。
  const eventNames = [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'PreCompact',
    'PostCompact',
    'SubagentStart',
    'SubagentStop',
    'TurnComplete',
    'SessionEnd',
  ] as const
  let n = 0
  for (const e of eventNames) n += registry.get(e).length
  return n
}
