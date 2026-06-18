// @x-code-cli/core — MCP 配置的 Zod 校验 schema
//
// 负责校验 ~/.x-code/config.json 以及项目级 .x-code/config.json 中的
// `mcpServers` 字段。一个 schema 同时覆盖 stdio 和 streamable-http 两种服务；
// 区分方式依赖字段存在性：
//   - `command` 存在 => stdio
//   - `url` 存在 => http
// 如果二者都没有，或者二者同时存在，就会在真正启动前被拒绝。
import { z } from 'zod'

import type { McpServerConfig } from './types.js'

/** 同时覆盖两种传输方式的宽松 schema。
 *  这里不用 z.union，而是先定义一个平面对象，再用 superRefine 做交叉校验，
 *  这样能更清楚地表达“`command` 和 `url` 必须二选一”的规则，
 *  也能给出比 “Invalid input” 更可读的报错。 */
const serverSchema = z
  .object({
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    url: z.string().url().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    timeout: z.number().int().positive().optional(),
    enabled: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    const hasCommand = typeof v.command === 'string'
    const hasUrl = typeof v.url === 'string'
    if (hasCommand && hasUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'mcpServers 条目同时包含 `command` 和 `url`，二者只能保留一个',
      })
    }
    if (!hasCommand && !hasUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'mcpServers 条目必须设置 `command`（stdio）或 `url`（http）中的一个',
      })
    }
    // 交叉字段校验：stdio 下不应出现 HTTP 字段，反之亦然。
    // 严格来说多余字段在运行时可以忽略，但提前报错能更早发现拼写或配置方向错误。
    if (hasCommand && typeof v.headers !== 'undefined') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '`headers` 仅适用于 HTTP 服务' })
    }
    if (hasUrl && (v.args || v.env || v.cwd)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '`args`/`env`/`cwd` 仅适用于 stdio 服务' })
    }
  })

export const mcpServersSchema = z.record(z.string().min(1), serverSchema)

/** 校验单个服务配置。
 *  如果校验失败，会抛出带上下文的错误信息，明确指出是哪一个服务名出错。 */
export function parseServerConfig(name: string, raw: unknown): McpServerConfig {
  const result = serverSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues.map((i) => i.message).join('; ')
    throw new Error(`mcpServers.${name}: ${issues}`)
  }
  return result.data as McpServerConfig
}

/** 校验整个 `mcpServers` 代码块。
 *  返回部分成功结果：能通过校验的条目会进入 `servers`，
 *  失败条目会记录在 `errors` 中，供 loader 把这些服务标记为 failed，
 *  而不是让整份配置直接中断。 */
export function parseServersBlock(raw: unknown): {
  servers: Record<string, McpServerConfig>
  errors: Array<{ name: string; message: string }>
} {
  const servers: Record<string, McpServerConfig> = {}
  const errors: Array<{ name: string; message: string }> = []

  if (raw === undefined || raw === null) return { servers, errors }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({ name: '(root)', message: 'mcpServers 必须是对象' })
    return { servers, errors }
  }

  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    try {
      servers[name] = parseServerConfig(name, entry)
    } catch (err) {
      errors.push({ name, message: err instanceof Error ? err.message : String(err) })
    }
  }

  return { servers, errors }
}
