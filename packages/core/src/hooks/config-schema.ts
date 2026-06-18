// @x-code-cli/core — hooks.json 的 zod 校验模式
//
// 无论 `HookConfig` 来自磁盘上的 hooks.json，还是来自内联 manifest 对象，
// 都使用同一套校验规则。这样两条路径的失败模式保持一致，插件作者不会
// 因为配置来源不同而遇到不同的报错。
//
// `matcher` 中的错误正则不是 schema 错误——强迫作者在 zod 严格模式下
// 先验证正则会很不方便。总线会在事件触发时捕获 RegExp 构造错误，并
// 降级为“匹配所有工具”（同时记录日志，便于排查）。
import { z } from 'zod'

import type { HookConfig } from './types.js'

const hookEntrySchema = z.object({
  matcher: z.string().optional(),
  command: z.string().min(1),
  // 平台专属覆盖命令。它们都是可选的；某个平台缺失时会回退到 `command`。
  // 我们刻意不强制要求这些字段至少设置一个，因为基础命令本来就是必填项。
  commandWindows: z.string().min(1).optional(),
  commandDarwin: z.string().min(1).optional(),
  commandLinux: z.string().min(1).optional(),
  timeout: z.number().int().positive().max(30_000).optional(),
  description: z.string().optional(),
  failurePolicy: z.enum(['allow', 'block']).optional(),
})

export const hookConfigSchema = z
  .object({
    SessionStart: z.array(hookEntrySchema).optional(),
    UserPromptSubmit: z.array(hookEntrySchema).optional(),
    PreToolUse: z.array(hookEntrySchema).optional(),
    PostToolUse: z.array(hookEntrySchema).optional(),
    PreCompact: z.array(hookEntrySchema).optional(),
    PostCompact: z.array(hookEntrySchema).optional(),
    SubagentStart: z.array(hookEntrySchema).optional(),
    SubagentStop: z.array(hookEntrySchema).optional(),
    TurnComplete: z.array(hookEntrySchema).optional(),
    SessionEnd: z.array(hookEntrySchema).optional(),
  })
  // 为了向前兼容（未来新增事件名），未知键会被容忍。
  .passthrough()

export class HookConfigParseError extends Error {
  constructor(
    message: string,
    public readonly sourceLabel: string,
  ) {
    super(message)
    this.name = 'HookConfigParseError'
  }
}

/** 校验一个已经完成解析的对象形式。它既用于内联 manifest 配置，也用于 hooks.json 在 JSON.parse 之后的内容。 */
export function parseHookConfig(raw: unknown, sourceLabel: string): HookConfig {
  const result = hookConfigSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '根节点'}: ${i.message}`).join('; ')
    throw new HookConfigParseError(`hooks 配置无效：${issues}`, sourceLabel)
  }
  // 在类型边界剥离未来可能出现的未知键。passthrough 会把它们保留在
  // 运行时对象上，但我们的 HookConfig 类型只认识这十种事件。
  const known: HookConfig = {}
  for (const k of [
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
  ] as const) {
    const arr = (result.data as Record<string, unknown>)[k]
    if (Array.isArray(arr)) known[k] = arr as HookConfig[typeof k]
  }
  return known
}
