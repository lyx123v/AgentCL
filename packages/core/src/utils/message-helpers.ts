import type { ModelMessage } from '../types/index.js'

interface ContentPartLike {
  type?: string // 内容分片的类型，例如 text / image / tool-call
  text?: string // 文本分片的正文内容
}

/** 从 `ModelMessage.content` 中提取纯文本内容。
 *  这里兼容两种结构：直接字符串，或带类型的分片数组；
 *  只会拼接 `text` 类型分片，图片、文件、tool-call 等内容走别的处理路径。 */
export function extractText(content: ModelMessage['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as ContentPartLike[])
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('')
}
