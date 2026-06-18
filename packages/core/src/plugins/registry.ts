// @x-code-cli/core — 插件注册表
//
// 它会在 CLI 启动时由 [[loader]].loadAllPlugins() 构建一次，然后在整个会话期间
// 保持对象实例稳定。注册表会保存所有成功加载的插件，包括启用和禁用的，
// 这样 `/plugin list` 可以同时展示两者；另外也会保留所有加载错误，
// 供 `/plugin doctor` 输出诊断信息。
//
// 热重载模型与 SkillRegistry 类似：`/plugin refresh` 会原地重建内部状态，
// 以保持 `options.pluginRegistry` 等被捕获引用继续有效；随后 CLI 还会使
// `systemPromptCache` 失效。因为插件可能向 system prompt 注入 skills /
// agents / commands，所以 CLAUDE.md 中关于字节稳定性的约束依然成立。
import type { LoadedPlugin, PluginLoadError } from './types.js'

/** 两次注册表快照之间的变化摘要。
 *  `/plugin refresh` 会用它来渲染 “新增 / 移除 / 变化” 风格的提示信息。 */
export interface PluginReloadSummary {
  added: string[] // 新增的插件 id 列表
  removed: string[] // 被移除的插件 id 列表
  changed: string[] // 内容或状态发生变化的插件 id 列表
  unchanged: string[] // 与上一次相比无变化的插件 id 列表
}

export class PluginRegistry {
  private byId: Map<string, LoadedPlugin>
  private errors: PluginLoadError[]

  constructor(plugins: LoadedPlugin[], errors: PluginLoadError[] = []) {
    this.byId = new Map()
    for (const p of plugins) this.byId.set(p.id, p)
    this.errors = [...errors]
  }

  /** 按 id 获取“已启用”的插件。
   *  禁用插件不会从这里返回；如果需要读取其禁用状态，请改用 [[getEntry]]。 */
  get(id: string): LoadedPlugin | undefined {
    const p = this.byId.get(id)
    if (!p || !p.enabled) return undefined
    return p
  }

  /** 按 id 获取插件，包含被禁用的插件。 */
  getEntry(id: string): LoadedPlugin | undefined {
    return this.byId.get(id)
  }

  /** 返回所有已启用插件，也就是 agent loop 实际可见的插件集合。 */
  list(): LoadedPlugin[] {
    return [...this.byId.values()].filter((p) => p.enabled)
  }

  /** 返回所有已加载插件，包含禁用项。 */
  listAll(): LoadedPlugin[] {
    return [...this.byId.values()]
  }

  /** 返回所有已启用插件的 id。 */
  ids(): string[] {
    return this.list().map((p) => p.id)
  }

  /** 返回加载过程中收集到的非致命错误，供 `/plugin doctor` 展示。 */
  loadErrors(): readonly PluginLoadError[] {
    return this.errors
  }

  /** 用一份新的加载结果替换内存中的插件列表。
   *  该方法用于 `/plugin refresh`，并保持 PluginRegistry 实例本身不变，
   *  以确保所有缓存引用继续有效。返回值是差异摘要，调用方可据此渲染
   *  “新增 / 移除 / 变化 / 未变化” 提示。 */
  reload(plugins: LoadedPlugin[], errors: PluginLoadError[] = []): PluginReloadSummary {
    const previous = this.byId
    const next = new Map<string, LoadedPlugin>()
    for (const p of plugins) next.set(p.id, p)

    const summary: PluginReloadSummary = { added: [], removed: [], changed: [], unchanged: [] }
    for (const [id, plugin] of next) {
      const prev = previous.get(id)
      if (!prev) {
        summary.added.push(id)
      } else if (
        prev.manifest.version !== plugin.manifest.version ||
        prev.rootDir !== plugin.rootDir ||
        prev.enabled !== plugin.enabled ||
        prev.scope !== plugin.scope
      ) {
        summary.changed.push(id)
      } else {
        summary.unchanged.push(id)
      }
    }
    for (const id of previous.keys()) {
      if (!next.has(id)) summary.removed.push(id)
    }

    this.byId = next
    this.errors = [...errors]
    return summary
  }
}

/** 返回一个空插件注册表。
 *  用于插件加载被禁用（如 `--no-plugins`）或当前没有安装任何插件的场景，
 *  比在下游到处写空值判断更简单。 */
export function emptyPluginRegistry(): PluginRegistry {
  return new PluginRegistry([], [])
}
