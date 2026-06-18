// @x-code-cli/core — 子代理注册表
//
// 启动时构建一次；当触发 /plugin refresh 时，可以通过
// reloadSubAgentRegistry 热重载。内置 agent 同步加载；
// 磁盘上的自定义 agent 异步加载。同名自定义 agent 会覆盖内置 agent
//（project > user > built-in）。
import { builtInAgents } from './built-in.js'
import { type LoadCustomAgentsOptions, loadCustomAgents } from './loader.js'
import type { SubAgentDefinition } from './types.js'

/** reload 返回的差异摘要，用于 /plugin refresh 的提示信息。 */
export interface SubAgentReloadSummary {
  added: string[] // 新增的子代理名称
  removed: string[] // 被移除的子代理名称
  changed: string[] // 内容发生变化的子代理名称
  unchanged: string[] // 保持不变的子代理名称
}

export class SubAgentRegistry {
  private agents: Map<string, SubAgentDefinition>

  /** 根据传入定义列表构建内存中的子代理映射。 */
  constructor(agents: SubAgentDefinition[]) {
    this.agents = new Map()
    for (const a of agents) {
      this.agents.set(a.name, a)
    }
  }

  /** 按名称获取单个子代理定义。 */
  get(name: string): SubAgentDefinition | undefined {
    return this.agents.get(name)
  }

  /** 以数组形式返回当前所有子代理定义。 */
  list(): SubAgentDefinition[] {
    return [...this.agents.values()]
  }

  /** 返回当前注册的全部子代理名称。 */
  names(): string[] {
    return [...this.agents.keys()]
  }

  /** 用新加载的结果替换内存中的子代理列表。
   *  主要用于 /plugin refresh，同时保持同一个 SubAgentRegistry
   *  对象实例不变，这样所有已捕获的 `options.subAgentRegistry`
   *  引用仍然有效。 */
  reload(agents: SubAgentDefinition[]): SubAgentReloadSummary {
    const previous = this.agents
    const next = new Map<string, SubAgentDefinition>()
    for (const a of agents) next.set(a.name, a)
    const summary: SubAgentReloadSummary = { added: [], removed: [], changed: [], unchanged: [] }
    for (const [name, agent] of next) {
      const prev = previous.get(name)
      if (!prev) summary.added.push(name)
      else if (prev.prompt !== agent.prompt || prev.source !== agent.source || prev.pluginId !== agent.pluginId)
        summary.changed.push(name)
      else summary.unchanged.push(name)
    }
    for (const name of previous.keys()) {
      if (!next.has(name)) summary.removed.push(name)
    }
    this.agents = next
    return summary
  }
}

/** 构建完整注册表：先内置，后自定义（后者会覆盖前者）。 */
export async function createSubAgentRegistry(opts: LoadCustomAgentsOptions = {}): Promise<SubAgentRegistry> {
  const custom = await loadCustomAgents(opts)
  // 加载顺序：built-in → custom。Map 插入同名键会覆盖，因此 custom 优先。
  return new SubAgentRegistry([...builtInAgents, ...custom])
}

/** 重新扫描并原地重建内存中的子代理列表。
 *  磁盘扫描规则与启动时一致；调用方传入的 opts
 *  （尤其是插件贡献的 extraDirs）会继续沿用。
 *  返回值是 /plugin refresh 提示所需的差异摘要。 */
export async function reloadSubAgentRegistry(
  registry: SubAgentRegistry,
  opts: LoadCustomAgentsOptions = {},
): Promise<SubAgentReloadSummary> {
  const custom = await loadCustomAgents(opts)
  return registry.reload([...builtInAgents, ...custom])
}

/** 仅包含内置子代理的同步注册表，用于测试或跳过磁盘扫描的场景。 */
export function createBuiltInRegistry(): SubAgentRegistry {
  return new SubAgentRegistry(builtInAgents)
}
