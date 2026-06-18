// @x-code-cli/core — 面向不同 provider 的兼容性修正
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { ModelMessage } from 'ai'

import { capabilitiesOf } from '../providers/capabilities.js'
import { ocrImage } from './file-ingest.js'

/**
 * 确保所有 assistant 消息都带有 reasoning content part。
 *
 * DeepSeek V4 在 thinking 模式下要求工具调用链中的每条 assistant 消息都带
 * `reasoning_content` 字段。这里会在缺失时自动补一个空 reasoning part。
 */
export function ensureReasoningContentParts(messages: ModelMessage[], modelId: string): void {
  if (!modelId.includes('deepseek-v4')) return

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue

    const content = msg.content
    if (!Array.isArray(content)) continue

    const hasReasoning = (content as Array<{ type: string }>).some((p) => p.type === 'reasoning')
    if (!hasReasoning) {
      ;(content as Array<{ type: string; text?: string }>).unshift({ type: 'reasoning', text: '' })
    }
  }
}

// ── 面向纯文本 provider 的图片 / PDF 降级处理 ───────────────────────────
//
// 如果当前 provider 不能接收 image/file part（例如某些 DeepSeek 或 custom
// 配置），这里会遍历下一轮即将发送的消息，把二进制内容改写成 provider
// 能接受的文本形式。
//
// 分两类处理：
//   - 用户消息：ImagePart / FilePart → 含 OCR 文本的 TextPart
//   - 工具结果消息：把 `image-data` 等二进制条目改写成文本条目
//
// OCR 通过本地 tesseract.js 完成，并按内容哈希做缓存，避免同一图片在多轮中反复识别。

type MaybeOutput = { type?: string; value?: unknown; filename?: string }

// 对 OCR 缓存做上限控制，避免长会话浏览大量不同图片时内存无限增长。
const OCR_CACHE_LIMIT = 50
const ocrCache = new Map<string, string>()

/** 从 OCR 缓存中读取并刷新最近使用顺序。 */
function ocrCacheGet(key: string): string | undefined {
  const hit = ocrCache.get(key)
  if (hit === undefined) return undefined
  // 命中后刷新到最近使用位置。
  ocrCache.delete(key)
  ocrCache.set(key, hit)
  return hit
}

/** 写入 OCR 缓存，并在超出上限时淘汰最旧条目。 */
function ocrCacheSet(key: string, value: string): void {
  if (ocrCache.has(key)) ocrCache.delete(key)
  ocrCache.set(key, value)
  if (ocrCache.size > OCR_CACHE_LIMIT) {
    const oldest = ocrCache.keys().next().value
    if (oldest !== undefined) ocrCache.delete(oldest)
  }
}

/** 把图片 Buffer 先落到临时文件，再复用 `ocrImage` 完成 OCR。 */
async function ocrBuffer(buffer: Buffer): Promise<string> {
  const key = `${buffer.length}:${buffer.subarray(0, 64).toString('base64')}`
  const cached = ocrCacheGet(key)
  if (cached != null) return cached

  // tesseract.js 理论上支持 Buffer，但某些版本存在边缘问题；
  // 先写入临时文件是更稳妥的做法。
  const tmp = path.join(os.tmpdir(), `xcc-ocr-${Date.now()}-${Math.random().toString(36).slice(2)}.png`)
  try {
    await fs.writeFile(tmp, buffer)
    const text = await ocrImage(tmp)
    ocrCacheSet(key, text)
    return text
  } finally {
    await fs.unlink(tmp).catch(() => {})
  }
}

/** 把 ImagePart 中可能出现的多种图片载体统一转换成 Buffer。 */
function imagePartToBuffer(part: { image: unknown; mediaType?: string }): Buffer | null {
  const img = part.image
  if (Buffer.isBuffer(img)) return img
  if (img instanceof Uint8Array) return Buffer.from(img)
  if (typeof img === 'string') {
    // 可能是 base64 字符串，也可能是 data URL；这里会去掉 data URL 前缀。
    const commaIdx = img.indexOf(',')
    const data = img.startsWith('data:') && commaIdx > 0 ? img.slice(commaIdx + 1) : img
    try {
      return Buffer.from(data, 'base64')
    } catch {
      return null
    }
  }
  return null
}

/** 原地剥离对当前 provider 不兼容的二进制内容。
 *  目标是保证下一次 `streamText` 不会因为图片或文件 part 而直接 400。 */
export async function downgradeBinaryPartsForProvider(messages: ModelMessage[], modelId: string): Promise<void> {
  const caps = capabilitiesOf(modelId)
  if (caps.image && caps.pdf) return

  for (const msg of messages) {
    // 用户消息：content 可能由 TextPart / ImagePart / FilePart 混合组成。
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const rewritten: typeof msg.content = []
      for (const part of msg.content) {
        if (part.type === 'image' && !caps.image) {
          const buffer = imagePartToBuffer(part as { image: unknown; mediaType?: string })
          const text = buffer ? await ocrBuffer(buffer) : '[image omitted]'
          rewritten.push({
            type: 'text',
            text: `[图片已替换为本地 OCR 文本：当前模型不支持原生看图，视觉内容本身不可见。]\n${text}`,
          })
          continue
        }
        if (part.type === 'file' && !caps.pdf) {
          rewritten.push({
            type: 'text',
            text: `[文件已省略：${(part as { filename?: string }).filename ?? 'unknown'}。当前模型不接受文件附件。]`,
          })
          continue
        }
        rewritten.push(part)
      }
      ;(msg as { content: typeof rewritten }).content = rewritten
      continue
    }

    // 工具结果消息：content 固定是 tool-result part 数组。
    if (msg.role === 'tool' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type !== 'tool-result') continue
        const output = (part as { output?: MaybeOutput }).output
        if (!output || output.type !== 'content' || !Array.isArray(output.value)) continue

        const rewritten: unknown[] = []
        for (const entry of output.value as Array<{
          type: string
          data?: string
          mediaType?: string
          text?: string
          filename?: string
        }>) {
          if (entry.type === 'image-data' && !caps.image) {
            const data = entry.data ?? ''
            let text = '[image omitted]'
            try {
              const buffer = Buffer.from(data, 'base64')
              text = await ocrBuffer(buffer)
            } catch {
              // 保留占位文本继续向下执行。
            }
            rewritten.push({
              type: 'text',
              text: `[图片已替换为本地 OCR 文本：当前模型不支持原生看图。]\n${text}`,
            })
            continue
          }
          if ((entry.type === 'file-data' || entry.type === 'file-url' || entry.type === 'file-id') && !caps.pdf) {
            rewritten.push({
              type: 'text',
              text: `[文件附件已省略（${entry.filename ?? entry.mediaType ?? 'binary'}）：当前模型不接受文件附件。]`,
            })
            continue
          }
          rewritten.push(entry)
        }
        ;(output as MaybeOutput).value = rewritten
      }
    }
  }
}
