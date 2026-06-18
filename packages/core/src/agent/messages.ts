// @x-code-cli/core — 消息类型与辅助函数
import type { FilePart, ImagePart, ModelMessage, TextPart } from 'ai'

/** 用户消息可接受的内容类型。
 *  简单输入可直接用字符串，带附件时使用 parts 数组。 */
export type UserContent = string | Array<TextPart | ImagePart | FilePart>

/** 创建一条用户消息。 */
export function userMessage(content: UserContent): ModelMessage {
  return { role: 'user', content }
}

/** 创建一条工具结果消息。 */
export function toolResultMessage(toolCallId: string, toolName: string, result: string): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId,
        toolName,
        output: { type: 'text', value: result },
      },
    ],
  }
}

/** 生成工具返回给模型的标准错误字符串。
 *  注意这里必须保留 `"Error: "` 前缀，因为它既被 UI 用来标红，
 *  也被模型当作失败标记来学习。 */
export function toolErrorString(message: string): string {
  return `Error: ${message}`
}

/** 把任意异常值包装成标准工具错误字符串。 */
export function toolErrorFromUnknown(err: unknown): string {
  return toolErrorString(err instanceof Error ? err.message : String(err))
}

/** 判断一段结果文本是否带有标准工具错误前缀。 */
export function isToolErrorString(value: string): boolean {
  return value.startsWith('Error:')
}
