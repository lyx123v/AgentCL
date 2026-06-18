// @x-code-cli/core — Hook 注册表
//
// 这是一个驻留内存的映射：事件名 → 有序的 `RegisteredHook` 列表。
// 它会在 CLI 启动时通过 [[buildHookRegistry]] 构建一次，并由 HookBus
// 在整个会话期间持有。这里遵循与插件流水线其余部分相同的字节稳定性约束：
// hook 不应该在 turn 之间偷偷变化（如果 hook 列表变了，应通过
// `/plugin refresh` + systemPromptCache 失效来处理，即便 hook 自身
// 不会直接出现在 prompt 中——统一规则可以避免出现特例分支）。
import type { HookConfig, HookEventName, RegisteredHook } from './types.js'

export class HookRegistry {
  private byEvent: Map<HookEventName, RegisteredHook[]>

  constructor(hooks: ReadonlyArray<RegisteredHook> = []) {
    this.byEvent = new Map()
    for (const h of hooks) {
      const list = this.byEvent.get(h.event) ?? []
      list.push(h)
      this.byEvent.set(h.event, list)
    }
  }

  /** 取出绑定到某个事件上的 hook，顺序与注册顺序一致。 */
  get(event: HookEventName): readonly RegisteredHook[] {
    return this.byEvent.get(event) ?? []
  }

  /** 供 bus 使用的轻量判断：当没有 hook 监听时，可以跳过事件载荷构建。每个 emit 调用点都在热点路径上，因此这一步要尽量便宜。 */
  has(event: HookEventName): boolean {
    return (this.byEvent.get(event)?.length ?? 0) > 0
  }

  /** 返回所有已注册的 hook。`/plugin doctor` 会用它列出当前生效的 hook 以及它们分别来自哪个插件。 */
  list(): readonly RegisteredHook[] {
    const all: RegisteredHook[] = []
    for (const arr of this.byEvent.values()) all.push(...arr)
    return all
  }
}

/** 基于每个插件的 hook 配置构建注册表。输入数组的遍历顺序会决定 emit 时的执行顺序，因此调用方（integration.ts）需要保证传进来的插件顺序稳定。 */
export function buildHookRegistry(
  pluginHooks: ReadonlyArray<{ pluginId: string; pluginDir: string; config: HookConfig }>,
): HookRegistry {
  const all: RegisteredHook[] = []
  for (const { pluginId, pluginDir, config } of pluginHooks) {
    for (const eventName of Object.keys(config) as HookEventName[]) {
      const entries = config[eventName]
      if (!entries) continue
      for (const entry of entries) {
        all.push({ pluginId, pluginDir, event: eventName, entry })
      }
    }
  }
  return new HookRegistry(all)
}

export function emptyHookRegistry(): HookRegistry {
  return new HookRegistry([])
}
