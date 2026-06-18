// @x-code-cli/core — 流式结果辅助工具
import type { ModelMessage } from 'ai'

/** 我们实际会从 streamText() 结果中用到的最小结构，
 *  这样可以避免把复杂泛型一路向外传播。 */
export interface StreamResult {
  /** 完整的流式事件序列。 */
  fullStream: AsyncIterable<{
    /** 当前流片段类型。 */
    type: string
    /** 文本片段内容。 */
    text?: string
    /** 工具名。 */
    toolName?: string
    /** 工具输入。 */
    input?: unknown
    /** 工具输出。 */
    output?: unknown
    /** 工具调用 id。 */
    toolCallId?: string
    /** 当 `type === 'error'` 时，这里承载 SDK 包装后的 provider 错误。
     *  SDK 在请求失败时并不会直接从 fullStream 迭代器抛出异常，
     *  而是会把这个错误块塞进流里，然后关闭流（见 stream-text.ts:1910）。
     *  我们的 streamChunksToUI 会重新抛出它，交给外层 try/catch 分类处理。 */
    error?: unknown
  }>
  /** 最终响应消息。 */
  response: Promise<{ messages: ModelMessage[] }>
  /** token 用量信息。 */
  usage: Promise<
    | {
        inputTokens?: number
        outputTokens?: number
        /** AI SDK v6 会在这里统一归一化 provider 的缓存字段。
         *  cacheReadTokens 是 inputTokens 的子集，不能重复计数；
         *  cacheWriteTokens 则对应 Anthropic 计费里的 cache_creation_input_tokens。 */
        inputTokenDetails?: {
          cacheReadTokens?: number
          cacheWriteTokens?: number
        }
      }
    | undefined
  >
  /** 生成结束原因。 */
  finishReason: Promise<string>
  /** 解析出的工具调用列表。 */
  toolCalls: Promise<
    Array<{
      /** 工具名。 */
      toolName: string
      /** 工具调用 id。 */
      toolCallId: string
      /** 工具输入参数。 */
      input: Record<string, unknown>
    }>
  >
}

/**
 * 静默消费 StreamResult 上所有尚未 settle 的 Promise，避免流出错后
 * 出现 unhandled rejection。AI SDK 内部的 flush() 在没有任何 step
 * 成功完成时，会把这些 Promise 以 NoOutputGeneratedError 形式 reject；
 * 如果不主动 drain，Node.js 会把整段错误堆栈直接打到 stderr。
 */
export function drainStreamResult(result: StreamResult): void {
  const noop = () => {}
  Promise.resolve(result.response).catch(noop)
  Promise.resolve(result.finishReason).catch(noop)
  Promise.resolve(result.usage).catch(noop)
  Promise.resolve(result.toolCalls).catch(noop)
}
