// @x-code-cli/core — 轻量消息压缩（不调用 LLM）
//
// 主压缩路径（compression.ts 里的 `compressMessages`）会额外发起一次
// `generateText` 请求来总结旧轮次；如果上下文膨胀主要来自某个很明确的来源，
// 比如 loop guard 已经标记过的重复工具调用失败，这样做就有些浪费。
//
// 这个模块会先跑一遍廉价的 O(n) 扫描，删除那些可以安全丢弃而不损失有效信息
// 的消息：
//   - 结果是 `[loop-guard]` 提示的 tool-call + tool-result 配对消息
//   - 较旧的大型 tool-result 文本，替换成简短 stub
//
// 调用方应在进入 LLM 总结前先跑这里，让总结器处理的是信号更密集的剩余内容。
import type { ModelMessage } from 'ai'

/** 命中后应直接删除的 tool-result 文本前缀。 */
const LOOP_GUARD_SENTINEL = '[loop-guard]'

type ToolResultPartLike = {
  type?: string
  toolCallId?: string
  output?: { type?: string; value?: unknown }
}

/** 判断当前 tool-result part 是否属于可直接丢弃的 loop-guard 结果。 */
function isToolResultDropTarget(part: ToolResultPartLike): boolean {
  if (part?.type !== 'tool-result') return false
  const output = part.output
  if (!output) return false
  if (output.type === 'text' && typeof output.value === 'string') {
    return output.value.startsWith(LOOP_GUARD_SENTINEL)
  }
  return false
}

/** 判断一条消息里是否包含可丢弃的 loop-guard tool-result。 */
function hasDropTargetResult(msg: ModelMessage): boolean {
  if (msg.role !== 'tool') return false
  const parts = msg.content as unknown as ToolResultPartLike[]
  if (!Array.isArray(parts)) return false
  return parts.some(isToolResultDropTarget)
}

/** 从 assistant 消息中移除指定 toolCallId 集合对应的 tool-call part。
 *  如果无需改动则原样返回；如果全部 part 都被删光，则返回 null。 */
function stripToolCallParts(msg: ModelMessage, idsToRemove: Set<string>): ModelMessage | null {
  if (msg.role !== 'assistant') return msg
  const content = msg.content as unknown as Array<{ type?: string; toolCallId?: string }>
  if (!Array.isArray(content)) return msg

  let changed = false
  const filtered = content.filter((part) => {
    if (part?.type === 'tool-call' && typeof part.toolCallId === 'string' && idsToRemove.has(part.toolCallId)) {
      changed = true
      return false
    }
    return true
  })

  if (!changed) return msg
  if (filtered.length === 0) return null
  return { ...msg, content: filtered } as ModelMessage
}

/** 收集那些 tool-result 为 loop-guard 提示的 toolCallId。 */
function collectLoopGuardedIds(messages: ModelMessage[]): Set<string> {
  const ids = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== 'tool') continue
    const parts = msg.content as unknown as ToolResultPartLike[]
    if (!Array.isArray(parts)) continue
    for (const part of parts) {
      if (isToolResultDropTarget(part) && typeof part.toolCallId === 'string') {
        ids.add(part.toolCallId)
      }
    }
  }
  return ids
}

export interface LightCompactResult {
  /** 轻量压缩后的消息数组。 */
  messages: ModelMessage[]
  /** 被删除的消息数量。
   *  若为 0，调用方通常还会继续走 LLM 总结路径。 */
  dropped: number
}

/** 删除消息数组中由 loop-guard 标记的 tool-call / tool-result 配对消息。
 *  其他内容保持不变，且不会修改传入数组。 */
export function lightCompactMessages(messages: ModelMessage[]): LightCompactResult {
  const idsToRemove = collectLoopGuardedIds(messages)
  if (idsToRemove.size === 0) return { messages, dropped: 0 }

  const out: ModelMessage[] = []
  let dropped = 0
  for (const msg of messages) {
    if (hasDropTargetResult(msg)) {
      dropped++
      continue
    }
    const stripped = stripToolCallParts(msg, idsToRemove)
    if (stripped == null) {
      dropped++
      continue
    }
    out.push(stripped)
  }
  return { messages: out, dropped }
}

// ── 智能截断旧工具结果 ──
//
// 这是位于上方 loop-guard 清理器与 compression.ts 中昂贵 LLM 总结之间的
// 中间层。它会把较旧且很大的 tool_result 内容替换成简短 stub，在保留“做过什么”
// 这类关键信息的同时回收大部分 token。
//
// 目标是在不重写整体消息结构的前提下延后完整压缩，因为完整压缩会让整个 prompt
// cache 失效。

/** 这些工具的结果要么承载决策信息，要么本来就很短，永不截断。 */
const NEVER_TRUNCATE_TOOLS = new Set([
  'edit',
  'writeFile',
  'task',
  'activateSkill',
  'todoWrite',
  'askUser',
  'enterPlanMode',
  'exitPlanMode',
])

/** 仅当文本长度超过该阈值时才进行截断。 */
const MIN_TRUNCATABLE_CHARS = 500

/** 最近这几条消息视为“受保护区”，不做截断。 */
const KEEP_RECENT_MESSAGES = 10

/** stub 中保留的原始输出预览行数。 */
const PREVIEW_LINES = 3

/** 为被截断的工具输出构建一段简短说明文本。 */
function buildStub(toolName: string | undefined, value: string): string {
  const lineCount = value.split('\n').length
  const preview = value.split('\n').slice(0, PREVIEW_LINES).join('\n')
  const name = toolName ?? 'unknown'
  return (
    `[已截断：${name} 输出，共 ${lineCount} 行、${value.length} 个字符。` +
    `为节省上下文，主体内容已移除；如需完整结果，请重新执行该工具。]\n` +
    preview
  )
}

export interface TruncateOldToolResultsResult {
  /** 处理后的消息数组。 */
  messages: ModelMessage[]
  /** 被截断的 tool-result 数量。 */
  truncatedCount: number
  /** 估算节省的字符数。 */
  charsSaved: number
}

/** 把较旧且体积大的 tool_result 替换成紧凑 stub。
 *  为了效率会原地修改消息数组，并返回统计信息供调用方决定是否继续做完整压缩。 */
export function truncateOldToolResults(messages: ModelMessage[]): TruncateOldToolResultsResult {
  const protectedStart = Math.max(0, messages.length - KEEP_RECENT_MESSAGES)
  let truncatedCount = 0
  let charsSaved = 0

  for (let i = 0; i < protectedStart; i++) {
    const msg = messages[i]
    if (!msg || msg.role !== 'tool') continue
    if (!Array.isArray(msg.content)) continue

    for (const part of msg.content as unknown as ToolResultPartLike[]) {
      if (part?.type !== 'tool-result') continue
      const output = part.output
      if (!output) continue

      const toolName = (part as { toolName?: string }).toolName
      if (toolName && NEVER_TRUNCATE_TOOLS.has(toolName)) continue

      if (output.type === 'text' && typeof output.value === 'string') {
        if (output.value.length < MIN_TRUNCATABLE_CHARS) continue
        if (output.value.startsWith('[Truncated:')) continue
        const original = output.value
        output.value = buildStub(toolName, original)
        charsSaved += original.length - (output.value as string).length
        truncatedCount++
      }
    }
  }

  return { messages, truncatedCount, charsSaved }
}
