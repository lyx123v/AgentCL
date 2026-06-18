// @x-code-cli/core — Hooks 子系统类型定义
//
// hook 本质上是插件注册到某个代理生命周期事件上的 shell 命令。CLI
// 会把事件载荷作为一行 JSON 通过 stdin 发给 hook；hook 也可以在
// stdout 回一行 JSON 的 `HookDecision`，以影响代理下一步行为
// （allow / deny / modify args / 注入 context）。
//
// 为什么选择 shell 命令而不是程序化 SDK：对插件作者来说门槛最低，
// 形式上也与用户在 Claude Code 中已经熟悉的模式一致，同时还能把
// 暴露面维持得很小（插件代码不会在我们的进程内执行）。完整理由可见
// [[plugin-marketplace-design]] §8。
//
// 为什么是十个事件：它已经足以覆盖高价值的生命周期集成点
// （上下文注入、工具闸门、子代理审计、压缩过程埋点、完成通知），
// 同时不会把所有将来可能重构的内部接缝都暴露出去。后续新增事件很便宜；
// 删除事件则属于破坏性变更。PreCompact / PostCompact 与
// SubagentStart / SubagentStop 是第二轮加入的，用来对齐 Claude/Codex
// 的形状——想记录每次子代理调用、或想在压缩清理上下文前持久化状态的
// 插件，在此之前没有可挂接的位置。

export type HookEventName =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PreCompact'
  | 'PostCompact'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'TurnComplete'
  | 'SessionEnd'

/** 会产出代理可执行决策的事件子集。其他事件都属于即发即弃：hook 可以执行副作用（日志、通知等），但代理会忽略它们的 stdout。 */
export type DecisionEvent = 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse'

/** hooks.json 中的单个 hook 条目。 */
export interface HookConfigEntry {
  /** 可选的工具名匹配正则。只对 PreToolUse / PostToolUse 有意义，其他事件会忽略它；缺失时表示“匹配所有工具”。 */
  matcher?: string
  /** 当前平台在未命中平台专属覆盖命令时要执行的 shell 命令。支持 `${pluginDir}` / `${pluginDataDir}` / `${cwd}` / `${homedir}` / `${env:NAME}` / `${sep}` 变量展开（见 [[variables]]）。即便设置了平台覆盖命令，这个字段也依然必填，用来避免插件作者不小心发布一个“只支持单一操作系统”的插件。 */
  command: string
  /** Windows 平台专属覆盖命令；设置后会在 win32 上替代 `command`。 */
  commandWindows?: string
  /** macOS 平台专属覆盖命令；设置后会在 darwin 上替代 `command`。 */
  commandDarwin?: string
  /** Linux 平台专属覆盖命令；设置后会在 linux 上替代 `command`。 */
  commandLinux?: string
  /** 单个 hook 的超时时间，单位毫秒（默认 5000，最大 30000）。 */
  timeout?: number
  /** hook 的描述信息，供人类阅读。 */
  description?: string
  /** 当 hook 非零退出或崩溃时的处理策略：`allow`（默认）表示记录警告并当作允许；`block` 表示按拒绝处理（只对决策事件有意义）。默认选择宽松策略，是为了避免损坏的 hook 把 agent loop 永久卡住。 */
  failurePolicy?: 'allow' | 'block'
}

/** 完整的 hooks.json 结构。每个事件名都映射到一个有序条目数组，较早的条目先执行；对于决策事件，`deny` 会短路后续条目。 */
export type HookConfig = Partial<Record<HookEventName, HookConfigEntry[]>>

/** 附着在每个事件载荷上的会话级上下文。 */
export interface SessionContext {
  /** 当前工作目录。 */
  cwd: string
  /** 当前使用的模型标识。 */
  modelId: string
  /** 可选的会话标识；当 CLI 分配了 session id 时会透传给 hook，方便它们关联多次事件。 */
  sessionId?: string
}

/** 所有事件载荷形状组成的可辨识联合。`name` 字段同时承担判别标签的作用。CLI 会构建这些对象并交给 [[HookBus.emit]]，executor 再把它们序列化成 JSON 写入 stdin。 */
export type HookEvent =
  | { name: 'SessionStart'; session: SessionContext }
  | { name: 'UserPromptSubmit'; session: SessionContext; prompt: string }
  | {
      name: 'PreToolUse'
      session: SessionContext
      tool: { name: string; args: unknown; callId: string }
    }
  | {
      name: 'PostToolUse'
      session: SessionContext
      tool: { name: string; args: unknown; callId: string; output: string; isError: boolean }
    }
  | {
      name: 'PreCompact'
      session: SessionContext
      /** 即将执行压缩的原因，方便 hook 决定是否要先做状态检查点或直接跳过。 */
      trigger: 'proactive' | 'reactive'
      /** 压缩前的大致消息数量。 */
      messageCount: number
      /** 压缩前的大致 token 数量估算。 */
      tokenEstimate: number
    }
  | {
      name: 'PostCompact'
      session: SessionContext
      trigger: 'proactive' | 'reactive'
      /** 压缩后的消息数量；与 PreCompact 的 messageCount 做差后，可得出回收了多少上下文。 */
      messageCount: number
      /** 如果走的是轻量压缩路径（没有写入 LLM 摘要），这里会是空字符串。 */
      summary: string
    }
  | {
      name: 'SubagentStart'
      session: SessionContext
      agent: {
        /** 子代理的注册名称，例如 `code-reviewer`。 */
        name: string
        /** 父代理提供的一行任务描述。 */
        description: string
        /** 父代理发给子代理的完整 prompt。 */
        prompt: string
      }
    }
  | {
      name: 'SubagentStop'
      session: SessionContext
      agent: {
        name: string
        description: string
      }
      /** 子代理运行的实际耗时（墙钟时间）。 */
      durationMs: number
      /** 子代理的结束方式。`aborted` 同时包含按 Esc 取消，以及达到单代理 maxTurns 上限但未完成收尾的情况。 */
      outcome: 'completed' | 'aborted' | 'failed'
      tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens: number }
    }
  | {
      name: 'TurnComplete'
      session: SessionContext
      turn: number
      tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens: number }
    }
  | { name: 'SessionEnd'; session: SessionContext }

/** hook 可以通过 stdout JSON 请求代理执行的动作。 */
export type HookDecision =
  | { decision: 'allow'; context?: string }
  | { decision: 'deny'; reason?: string }
  | { decision: 'modify'; args?: unknown; output?: string; context?: string }

/** 已经准备好执行的 hook。它会与所属插件的身份信息和根目录配对，便于变量展开解析 `${pluginDir}`。对象由 [[buildHookRegistry]] 在启动时构建，并在整个会话中保持不变。 */
export interface RegisteredHook {
  /** 所属插件的唯一标识。 */
  pluginId: string
  /** 插件根目录的绝对路径，会通过 `${pluginDir}` 注入到 hook 命令中。 */
  pluginDir: string
  /** 该 hook 绑定到的事件名。 */
  event: HookEventName
  /** hook 的具体配置条目。 */
  entry: HookConfigEntry
}
