// @x-code-cli/core — Hook 事件总线
//
// 这是构建在 [[HookRegistry]] 之上的轻量编排层。agent loop、工具执行、
// 压缩流程以及子代理运行器会在十个生命周期节点调用 `bus.emit(event)`；
// 总线会按 matcher 过滤 hook（仅 PreToolUse / PostToolUse 生效），执行它们，
// 然后返回聚合后的决策结果。
//
// 串行与并行：
//
//   决策类事件（UserPromptSubmit / PreToolUse / PostToolUse）串行执行。
//   一旦出现 `deny` 就会短路后续 hook，代理在第一个停止点就停下。
//   执行顺序就是注册顺序，因此插件作者能获得确定性的行为。
//
//   即发即弃类事件（SessionStart / PreCompact / PostCompact /
//   SubagentStart / SubagentStop / TurnComplete / SessionEnd）并行执行，
//   因为它们没有决策返回，也没有顺序依赖。
//
// 总线会捕获单个 hook 的错误并降级为 `allow`，避免某个损坏的 hook
// 阻塞整个循环。executor 已经处理了“非零退出 / 超时 → allow”，
// 这一层额外补上 matcher 正则出错时的保护。
import { debugLog } from '../utils.js'
import { type ExecuteHookOptions, executeHook } from './executor.js'
import { type HookRegistry, emptyHookRegistry } from './registry.js'
import type { HookDecision, HookEvent, RegisteredHook } from './types.js'

export interface EmitOptions extends ExecuteHookOptions {
  /** 是否强制并行执行。默认是决策事件串行、即发即弃事件并行，调用方几乎不会覆盖。 */
  parallel?: boolean
}

export class HookBus {
  // 这里保持可变，是为了让 /plugin refresh 可以替换成新的 registry，
  // 而不用要求调用方重新持有 bus 引用。后续新事件会看到新的 hooks；
  // 已经在执行中的 executeHook 仍会对旧 registry 收尾（这是有意为之，
  // 因为让 hook 自然跑完比协调中途停机更便宜）。
  constructor(private registry: HookRegistry) {}

  /** 判断某个事件当前是否有已注册的 hook。 */
  has(event: HookEvent['name']): boolean {
    return this.registry.has(event)
  }

  /** 替换内部 registry。/plugin refresh 重扫后会用它接入新增或删除的插件 hook。 */
  replaceRegistry(registry: HookRegistry): void {
    this.registry = registry
  }

  /** 发送事件。返回按执行顺序排列的每个 hook 决策；如果没有匹配到 hook，则返回空数组。调用方通常只会读取三个决策事件的结果，其他事件更多是等待其副作用执行完成。 */
  async emit(event: HookEvent, opts: EmitOptions = {}): Promise<HookDecision[]> {
    const hooks = this.registry.get(event.name)
    if (hooks.length === 0) return []

    const applicable = hooks.filter((h) => matches(h, event))
    if (applicable.length === 0) return []

    const isDecisionEvent =
      event.name === 'UserPromptSubmit' || event.name === 'PreToolUse' || event.name === 'PostToolUse'
    const parallel = opts.parallel ?? !isDecisionEvent

    if (parallel) {
      // 对即发即弃事件，我们依然会等待所有结果，以保持调用方
      // “await 即表示完成”的语义；只是这里不串行执行。
      // 单个 hook 失败不会让整批失败（executor 失败时会返回 `allow`）。
      const settled = await Promise.allSettled(applicable.map((h) => executeHook(h, event, opts)))
      const out: HookDecision[] = []
      for (const r of settled) {
        if (r.status === 'fulfilled') out.push(r.value)
        else {
          if (opts.signal?.aborted) throw r.reason
          debugLog('hooks.bus-error', `${event.name}: ${String(r.reason)}`)
          out.push({ decision: 'allow' })
        }
      }
      return out
    }

    // 串行模式下，第一个 `deny` 会阻止剩余 hook。多个 modify 的叠加
    // 由调用方在下一次 hook 输入中处理，这里只负责收集结果。
    const decisions: HookDecision[] = []
    for (const h of applicable) {
      try {
        const d = await executeHook(h, event, opts)
        decisions.push(d)
        if (d.decision === 'deny') break
      } catch (err) {
        if (opts.signal?.aborted) throw err
        debugLog('hooks.bus-error', `${h.pluginId} ${event.name}: ${String(err)}`)
        decisions.push({ decision: 'allow' })
      }
    }
    return decisions
  }
}

/** 创建一个没有任何已注册 hook 的 bus。CLI 在禁用插件（`--no-plugins`）时会传入它，这样 agent loop 的 emit 调用点就不需要做空值判断。 */
export function emptyHookBus(): HookBus {
  return new HookBus(emptyHookRegistry())
}

function matches(hook: RegisteredHook, event: HookEvent): boolean {
  if (event.name !== 'PreToolUse' && event.name !== 'PostToolUse') return true
  if (!hook.entry.matcher) return true
  try {
    return new RegExp(hook.entry.matcher).test(event.tool.name)
  } catch (err) {
    // 错误的正则不应该悄悄让 hook 失效，因此这里降级为
    // “匹配所有工具”，同时记录日志，方便定位坏掉的模式。
    debugLog('hooks.matcher-invalid', `${hook.pluginId}: ${String(err)}`)
    return true
  }
}

// ── agent loop 各个 emit 调用点会用到的决策聚合辅助函数 ──

/** 将一组 PreToolUse 决策折叠成一个最终效果。顺序很重要：`emit` 中遇到 `deny` 就会提前短路，所以这里一旦看到 `deny`，它就是最终结论。多个修改会层层叠加，其中最后一个带 `args` 的 `modify` 生效。 */
export interface PreToolEffect {
  /** 最终决策结果。 */
  decision: 'allow' | 'deny'
  /** 拒绝时附带的原因。 */
  reason?: string
  /** 修改后的参数；若为 undefined，则继续使用原始参数。 */
  args?: unknown
  /** 额外注入的上下文（PreToolUse 很少使用，保留它是为了接口对称）。 */
  context?: string
}

/** 聚合多个 PreToolUse 决策，得到工具执行前的最终效果。 */
export function aggregatePreToolUse(decisions: ReadonlyArray<HookDecision>): PreToolEffect {
  let args: unknown
  let context: string | undefined
  for (const d of decisions) {
    if (d.decision === 'deny') return { decision: 'deny', reason: d.reason }
    if (d.decision === 'modify') {
      if (d.args !== undefined) args = d.args
      if (d.context) context = d.context
    } else if (d.decision === 'allow' && d.context) {
      context = d.context
    }
  }
  return { decision: 'allow', args, context }
}

export interface PostToolEffect {
  /** 替换后的输出内容；若为 undefined，则保留原始输出。 */
  output?: string
  /** 额外注入的上下文。 */
  context?: string
}

/** 聚合多个 PostToolUse 决策，得到工具执行后的最终输出效果。 */
export function aggregatePostToolUse(decisions: ReadonlyArray<HookDecision>): PostToolEffect {
  let output: string | undefined
  let context: string | undefined
  for (const d of decisions) {
    if (d.decision === 'modify') {
      if (typeof d.output === 'string') output = d.output
      if (d.context) context = d.context
    } else if (d.decision === 'allow' && d.context) {
      context = d.context
    }
  }
  return { output, context }
}

export interface UserPromptEffect {
  /** 最终决策结果。 */
  decision: 'allow' | 'deny'
  /** 拒绝时附带的原因。 */
  reason?: string
  /** 来自所有 hook 的拼接上下文，可直接前置到用户消息前；如果没有 hook 注入内容，则为空字符串。 */
  context: string
}

/** 聚合多个 UserPromptSubmit 决策，得到用户消息提交前的最终效果。 */
export function aggregateUserPromptSubmit(decisions: ReadonlyArray<HookDecision>): UserPromptEffect {
  const contexts: string[] = []
  for (const d of decisions) {
    if (d.decision === 'deny') return { decision: 'deny', reason: d.reason, context: '' }
    // `allow` 和 `modify` 两个分支都可能带有 `context`；
    // 上面的收窄已经排除了 `deny`，因此这里是安全的。
    if (d.decision === 'allow' && d.context) contexts.push(d.context)
    else if (d.decision === 'modify' && d.context) contexts.push(d.context)
  }
  return { decision: 'allow', context: contexts.join('\n\n') }
}
