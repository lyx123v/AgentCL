// @x-code-cli/cli - ModelMessage → DisplayMessage 转换。
//
// 从 use-agent.ts 里拆出来，是为了让 hook 主体更专注于状态管理。
// 这个模块只负责 UI 层转换，完全不会碰 core 的 agent loop。
import type { DisplayMessage, DisplayToolCall, ModelMessage } from '@x-code-cli/core'
import { extractText } from '@x-code-cli/core'

type ContentPartLike = {
  type?: string
  text?: string
  toolCallId?: string
  toolName?: string
  input?: unknown
  output?: unknown
}

/** 从 tool-result 部分里取出字符串输出。
 *  AI SDK 会把工具输出归一成 `{ type: 'text' | 'error-text' | ..., value: string }`，
 *  但旧格式 / provider 特定格式也可能透传进来，所以这里做防御性转换。 */
function readToolOutput(part: ContentPartLike): { output: string; isError: boolean } {
  const out = part.output as { type?: string; value?: unknown } | string | undefined
  if (typeof out === 'string') return { output: out, isError: false }
  if (out && typeof out === 'object') {
    const isError = out.type === 'error-text' || out.type === 'error-json'
    const value = out.value
    if (typeof value === 'string') return { output: value, isError }
    if (value !== undefined) return { output: JSON.stringify(value), isError }
  }
  return { output: '', isError: false }
}

/** 把已加载的 ModelMessage[] 还原成 ChatInput 要渲染的 DisplayMessage[]。
 *  每条带 N 个 tool-call 的 assistant message 会拆成 N+1 条 DisplayMessage
 *  （如果有文本就先来一条纯文本，再按 tool-call 一条一条拆），
 *  这样就能原样保留 live agent flow 的渲染模式：
 *  同一轮里的多个并行 tool call 仍然会显示成独立的 `⎿` 行。
 *
 *  tool 消息本身不会单独变成 DisplayMessage；它们的输出会通过 `toolCallId`
 *  拼到对应的 tool-call DisplayMessage 上。 */
export function modelMessagesToDisplay(messages: ModelMessage[]): DisplayMessage[] {
  const toolResults = new Map<string, { output: string; isError: boolean }>()
  for (const msg of messages) {
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) continue
    for (const part of msg.content as ContentPartLike[]) {
      if (part?.type === 'tool-result' && typeof part.toolCallId === 'string') {
        toolResults.set(part.toolCallId, readToolOutput(part))
      }
    }
  }
  const out: DisplayMessage[] = []
  let counter = 0
  const baseTs = Date.now() - messages.length
  for (const msg of messages) {
    counter++
    if (msg.role === 'system' || msg.role === 'tool') continue
    const id = `hydrated-${counter}`
    const ts = baseTs + counter
    if (msg.role === 'user') {
      const text = extractText(msg.content)
      if (text) out.push({ id, role: 'user', content: text, timestamp: ts })
      continue
    }
    // assistant 消息
    const text = extractText(msg.content)
    if (text) out.push({ id: `${id}-text`, role: 'assistant', content: text, timestamp: ts })
    if (Array.isArray(msg.content)) {
      let tcIdx = 0
      for (const part of msg.content as ContentPartLike[]) {
        if (part?.type !== 'tool-call' || typeof part.toolCallId !== 'string') continue
        tcIdx++
        const result = toolResults.get(part.toolCallId)
        const tc: DisplayToolCall = {
          id: `${id}-tc-${tcIdx}`,
          toolName: part.toolName ?? 'unknown',
          input: (part.input as Record<string, unknown>) ?? {},
          output: result?.output,
          status: result ? (result.isError ? 'error' : 'completed') : 'pending',
        }
        out.push({
          id: `${id}-tcm-${tcIdx}`,
          role: 'assistant',
          content: '',
          toolCalls: [tc],
          timestamp: ts,
        })
      }
    }
  }
  return out
}

export function previewSubInput(input: Record<string, unknown>): string {
  const val =
    (input.filePath as string) ??
    (input.command as string) ??
    (input.pattern as string) ??
    (input.query as string) ??
    (input.dirPath as string) ??
    (input.path as string) ??
    ''
  return val.length > 80 ? val.slice(0, 77) + '...' : val
}
