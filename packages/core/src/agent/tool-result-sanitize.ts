// @x-code-cli/core — 截断 ModelMessage 数组中的 tool-result 内容
//
// AI SDK 自动执行的工具（readFile / grep / glob / listDir / webFetch /
// webSearch）会把结果作为 tool-result part 放进 `response.messages`。
// `tool-execution.ts` 里的手动工具路径会统一经过 `truncateToolResult`，
// 但自动执行结果不会走那条路径，因此会以原始完整尺寸落到 `state.messages`。
// 这个模块会遍历一次已完成流产生的消息，并在它们被持久化进对话状态之前，
// 原地套用与手动路径相同的“按工具区分的截断策略”。
//
// 策略按工具区分：
//   - shell / edit / writeFile：手动路径里已经截断过了
//   - readFile：head-tail（保留文件头部和尾部）
//   - grep / glob / listDir：只保留头部（字典序本身有意义；当前部已经有代表性后，
//     尾部基本不再提供额外信号）
//   - webFetch：head-tail（网页顶部和底部常有导航噪音，但正文往往在中间；
//     即便如此，head-tail 仍优于只保留头部，因为它能保住尾部锚点）
//   - default：head-tail
import type { ModelMessage } from 'ai'

import { truncateToolResult } from '../tools/truncate.js'
import type { TruncateOptions } from '../tools/truncate.js'

const PER_TOOL_POLICY: Record<string, TruncateOptions> = {
  readFile: { direction: 'head-tail' },
  grep: { direction: 'head', maxLines: 500 },
  glob: { direction: 'head', maxLines: 500 },
  listDir: { direction: 'head', maxLines: 500 },
  webFetch: { direction: 'head-tail' },
  webSearch: { direction: 'head-tail' },
  shell: { direction: 'head' },
}

/** 根据工具名选出对应的截断策略。 */
function policyFor(toolName: string | undefined): TruncateOptions {
  if (!toolName) return { direction: 'head-tail' }
  return PER_TOOL_POLICY[toolName] ?? { direction: 'head-tail' }
}

/** 这是 AI SDK tool-result part 在线路上的近似结构。
 *  我们只修改自己明确认识的那部分字段，其余内容保持原样。 */
type ToolResultLike = {
  type: 'tool-result'
  toolName?: string
  output?: {
    type?: 'text' | 'content' | string
    value?: unknown
  }
}

/**
 * 遍历 `messages`，双向修复 tool_call ↔ tool_result 的配对关系。
 * provider 对这点要求非常严格：
 *   - every assistant tool_call to have a paired tool_result
 *   - every tool_result to be preceded by an assistant tool_call with
 *     the matching toolCallId
 * 任一方向的孤儿记录都会污染下一次 API 请求，导致出现类似
 * "tool must be a response to a preceding message with tool_calls"
 * (or the converse) error.
 *
 * 孤儿出现的方式主要有两类：
 *   - 正向孤儿（tool_call 没有结果）：模型偶尔会生成不合法的工具输入，
 *     例如 todoWrite 缺少必填字段。SDK 校验失败后会发出 tool-error 事件，
 *     并且有时不会把配对的 tool-result 写进 response.messages，
 *     所以这里需要我们补一条合成错误结果。
 *   - 反向孤儿（tool_result 没有对应 tool_call）：当模型工具输入校验失败时，
 *     SDK 可能在中途发出 `tool-error`，并把对应 tool_call 从
 *     response.messages 里排除；但我们的 `processToolCalls` 仍可能消费
 *     `result.toolCalls` Promise 并执行工具，最终把 tool_result 推进
 *     state.messages。这里需要把这种孤儿结果删掉。
 *
 * 该函数会原地修改 `messages`，并且具备幂等性，重复运行不会继续变化。
 */
export function repairOrphanToolCalls(messages: ModelMessage[]): void {
  // 先收集 assistant 消息里出现过的全部 tool_call_id。
  const expected = new Set<string>()
  const toolNameById = new Map<string, string>()
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content as Array<{ type?: string; toolCallId?: string; toolName?: string }>) {
      if (part?.type === 'tool-call' && typeof part.toolCallId === 'string') {
        expected.add(part.toolCallId)
        if (typeof part.toolName === 'string') toolNameById.set(part.toolCallId, part.toolName)
      }
    }
  }

  // 删除那些 toolCallId 从未在 assistant tool_call 中出现过的
  // tool-result part（反向孤儿）。如果整条 tool 消息全是孤儿，就删整条；
  // 如果只是部分 part 是孤儿，就原地过滤。
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg || msg.role !== 'tool') continue
    if (!Array.isArray(msg.content)) continue
    const parts = msg.content as Array<{ type?: string; toolCallId?: string }>
    const kept = parts.filter((part) => {
      if (part?.type !== 'tool-result') return true
      if (typeof part.toolCallId !== 'string') return true
      return expected.has(part.toolCallId)
    })
    if (kept.length === 0) {
      // 直接 splice 掉整条 tool 消息后，可能让两条 assistant 消息相邻。
      // 常见结构本来是 assistant tool_calls → tool results →
      // assistant continuation。Anthropic 对 user/assistant 交替要求很严，
      // 虽然 @ai-sdk/anthropic 目前会帮我们合并连续同角色消息，
      // 但不能让 sanitizer 的正确性依赖下游 SDK 的实现细节。
      // 因此当前后两侧都是 assistant 时，我们改成塞一个 user 文本占位，
      // 保住边界；否则直接删除就是安全的。
      const prev = messages[i - 1]
      const next = messages[i + 1]
      if (prev?.role === 'assistant' && next?.role === 'assistant') {
        messages[i] = {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '[Stale tool result discarded — no matching tool_call in history.]',
            },
          ],
        } as ModelMessage
      } else {
        messages.splice(i, 1)
      }
    } else if (kept.length !== parts.length) {
      // AI SDK 的窄联合类型在类型层面不接受我们这里这种“局部 part 结构”，
      // 但运行时上面已经完成收窄，因此这里做结构性断言是安全的。
      ;(msg as { content: unknown }).content = kept
    }
  }

  // 再收集一遍那些已经被 tool-result 覆盖的 tool_call_id
  // （这里统计的是经过反向孤儿清理之后的结果）。
  const fulfilled = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== 'tool') continue
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content as Array<{ type?: string; toolCallId?: string }>) {
      if (part?.type === 'tool-result' && typeof part.toolCallId === 'string') {
        fulfilled.add(part.toolCallId)
      }
    }
  }

  // 为正向孤儿补一条合成结果，同时保持整体顺序。
  // 正向孤儿总是追加在末尾，因为它们本来就没有真实结果，
  // 在这里只是为下一次 API 请求补上合法占位。
  // 所有孤儿 part 会合并进 ONE 条 tool 消息，而不是每个 id 单独推一条：
  // Anthropic 转换器今天虽然会合并连续同角色消息，但 Google 不会，
  // OpenAI-compatible 还会按 tool_call_id 分拆，因此直接产出一条
  // 单独 tool ModelMessage 在所有 provider 上都更稳。
  const orphanParts: Array<{
    type: 'tool-result'
    toolCallId: string
    toolName: string
    output: { type: 'text'; value: string }
  }> = []
  for (const id of expected) {
    if (fulfilled.has(id)) continue
    const name = toolNameById.get(id) ?? 'unknown'
    orphanParts.push({
      type: 'tool-result',
      toolCallId: id,
      toolName: name,
      output: {
        type: 'text',
        value:
          'Error: Tool input failed validation (likely missing required fields). The assistant should retry with the correct schema.',
      },
    })
  }
  if (orphanParts.length > 0) {
    // 纵深防御：如果别的代码路径已经在尾部留下了一条 tool 消息
    // （例如 processToolCalls 推入了我们上面没处理到的真实结果），
    // 就把孤儿 part 合并进去，避免再额外生成一条相邻 tool 消息。
    const tail = messages[messages.length - 1]
    if (tail && tail.role === 'tool' && Array.isArray(tail.content)) {
      ;(tail.content as unknown[]).push(...(orphanParts as unknown[]))
    } else {
      messages.push({
        role: 'tool',
        content: orphanParts as never,
      } as ModelMessage)
    }
  }
}

/**
 * 原地遍历 `messages`，截断所有过大的 tool-result part。
 * 只会修改 `output.value` 字段，其余消息结构完全保持 provider 原始返回值。
 */
export function truncateToolResultsInMessages(messages: ModelMessage[]): void {
  for (const msg of messages) {
    if (msg.role !== 'tool') continue
    if (!Array.isArray(msg.content)) continue

    for (const part of msg.content as unknown as ToolResultLike[]) {
      if (part?.type !== 'tool-result') continue
      const output = part.output
      if (!output) continue

      // 纯文本输出：`{ type: 'text', value: string }`
      if (output.type === 'text' && typeof output.value === 'string') {
        const truncated = truncateToolResult(output.value, policyFor(part.toolName))
        if (truncated.length !== output.value.length) {
          output.value = truncated
        }
        continue
      }

      // 富内容输出：`{ type: 'content', value: Array<{ type: string, text?: string, ... }> }`
      // 这里只会改 text 项；image-data / file-data / file-url
      // 这类二进制载荷由 provider-compat 层在别处处理。
      if (output.type === 'content' && Array.isArray(output.value)) {
        const entries = output.value as Array<{ type?: string; text?: string }>
        for (const entry of entries) {
          if (entry?.type === 'text' && typeof entry.text === 'string') {
            const truncated = truncateToolResult(entry.text, policyFor(part.toolName))
            if (truncated.length !== entry.text.length) {
              entry.text = truncated
            }
          }
        }
      }
    }
  }
}
