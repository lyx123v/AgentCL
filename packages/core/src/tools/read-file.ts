// @x-code-cli/core — readFile 工具
//
// 文本文件会以“带行号的字符串”形式返回（这是代理更熟悉的格式）。
// 二进制文件（图片、PDF）则返回 AI SDK 的 `content` 工具结果，让支持
// 内联媒体的 provider 收到正确的 `image-data` / `file-data` 片段，而不是
// 把 base64 生硬塞进一段文本里。
//
// 这个工具本身不会根据 provider 能力分支处理，否则工具层就会和当前模型
// 强耦合。相反，所有二进制结果都会先按 content parts 形式输出，再由
// provider 兼容层在必要时剥离它们（回退成 OCR 文本），以适配不支持
// 媒体输入的 provider。
import fs from 'node:fs/promises'
import path from 'node:path'

import { tool } from 'ai'

import { z } from 'zod'

import { classifyFile } from '../agent/file-ingest.js'
import { mediaTypeFor } from '../utils/media-type.js'
import { formatToolError } from '../utils/tool-errors.js'
import { reportProgress } from './progress.js'

/** 无 offset/limit 时，readFile 默认最多返回的行数。
 *  这里与 Claude Code 的 MAX_LINES_TO_READ 对齐。经验上，2000 行足够覆盖
 *  “先整体扫一遍文件”的常见场景；再大的文件通常都会先配合 grep 缩小范围。
 *  这个值最初是 500，但观察后发现它会让“完整阅读一个模块”这种合理需求
 *  产生过多往返调用。 */
const LARGE_FILE_LINE_THRESHOLD = 2000

/** 单次工具结果的字节上限。
 *  这个限制与 file-ingest.ts 里 `@` 附件摄取上限、以及 Claude Code Read
 *  工具的默认 token 预算思路保持一致。它同时作用于默认读取和显式
 *  offset/limit 读取，避免模型在超大文件上请求极大 limit 时把整份内容灌进
 *  上下文，导致下一轮直接触发 context_length_exceeded。 */
const MAX_READ_BYTES = 256 * 1024

/** 读取文本文件并按行号格式化输出，同时在超长时附带后续读取指引。 */
async function readTextResult(filePath: string, offset?: number, limit?: number): Promise<string> {
  const content = await fs.readFile(filePath, 'utf-8')
  const lines = content.split('\n')
  const totalLines = lines.length

  const userSpecifiedRange = offset != null || limit != null

  // 先判断调用方希望看的范围；“默认只看开头”与“命中字节上限”要区分开，
  // 这样结尾提示才能准确告诉模型是“只展示前 N 行”还是“被字节上限截断”。
  let start: number
  let end: number
  let isHeadTruncation = false
  if (userSpecifiedRange) {
    start = (offset ?? 1) - 1
    end = limit ? start + limit : lines.length
  } else if (totalLines > LARGE_FILE_LINE_THRESHOLD) {
    start = 0
    end = LARGE_FILE_LINE_THRESHOLD
    isHeadTruncation = true
  } else {
    start = 0
    end = lines.length
  }
  const sliced = lines.slice(start, end)

  // 逐行构造带行号的输出，只要再追加一行会超过 MAX_READ_BYTES 就停止。
  // 这里必须按 UTF-8 字节数计算，不能只看 line.length，否则中文等宽字符
  // 内容会低估真实传输体积。
  const formatted: string[] = []
  let bytes = 0
  for (let i = 0; i < sliced.length; i++) {
    const numbered = `${start + i + 1}\t${sliced[i]}`
    const addedBytes = Buffer.byteLength(numbered, 'utf-8') + (formatted.length > 0 ? 1 : 0)
    if (bytes + addedBytes > MAX_READ_BYTES && formatted.length > 0) break
    formatted.push(numbered)
    bytes += addedBytes
  }
  const includedLines = formatted.length
  const body = formatted.join('\n')

  // 结尾提示沿用 Claude Code 同类信息的思路：直接告诉模型下一次该怎么调，
  // 让它能自恢复，而不是重复失败调用。
  if (isHeadTruncation) {
    const note = includedLines < sliced.length ? `（并额外受 ${MAX_READ_BYTES / 1024} KB 限制）` : ''
    return (
      body +
      `\n\n[readFile：当前仅显示前 ${includedLines}/${totalLines} 行${note}。` +
      `如需查看其他范围，请再次调用 readFile 并传入 offset/limit，或使用 grep 查找特定符号。` +
      `如果要分析超大文件的整体内容，可以考虑通过 task 工具委派给子代理，` +
      `每个子代理会在独立上下文中读取，并只返回摘要。]`
    )
  }
  if (includedLines < sliced.length) {
    const nextOffset = start + includedLines + 1
    return (
      body +
      `\n\n[readFile：输出已受 ${MAX_READ_BYTES / 1024} KB 限制；` +
      `本次返回了请求范围中的 ${includedLines}/${sliced.length} 行（第 ${start + 1}-${start + includedLines} 行）。` +
      `如需下一段内容，请再次调用 readFile 并传入 offset=${nextOffset}，或进一步缩小范围。]`
    )
  }
  return body
}

export const readFile = tool({
  description: `读取本地文件系统中的文件。默认可以认为这个工具能读取当前机器上的所有文件。

用法说明：
- filePath 必须是绝对路径，不能是相对路径。
- 你可以按需传入 offset 和 limit（尤其适合长文件），但通常建议先整体读取一遍。
- 返回结果会附带从 1 开始的行号。
- 这个工具可以读取图片（PNG、JPG 等）和 PDF，内容会以内联形式提供。
- 这个工具只能读取文件，不能读取目录。若要查看目录，请使用 listDir 或 shell 配合 ls。
- 如果文件路径是用户提供的，可以默认它是有效路径。`,
  inputSchema: z.object({
    filePath: z.string().describe('文件的绝对路径'),
    offset: z.number().optional().describe('起始行号（从 1 开始，仅文本文件生效）'),
    limit: z.number().optional().describe('最多读取多少行（仅文本文件生效）'),
  }),
  execute: async ({ filePath, offset, limit }, { toolCallId }) => {
    try {
      reportProgress(toolCallId, `正在读取 ${filePath}`)
      const kind = await classifyFile(filePath).catch(() => 'text' as const)

      if (kind === 'image') {
        const buffer = await fs.readFile(filePath)
        // 这里返回 content 形态的工具结果，后续是否保留图片给模型使用，
        // 由 provider 兼容层决定：支持多模态时保留图片，不支持时换成 OCR
        // 文本。我们同时附带 `image-data` 和一个文件路径文本锚点，保证模型
        // 始终有可引用的文字信息。
        return {
          type: 'content',
          value: [
            { type: 'text', text: `已加载图片：${filePath}` },
            {
              type: 'image-data',
              data: buffer.toString('base64'),
              mediaType: mediaTypeFor(filePath),
            },
          ],
        }
      }

      if (kind === 'pdf') {
        const buffer = await fs.readFile(filePath)
        return {
          type: 'content',
          value: [
            { type: 'text', text: `已加载 PDF：${filePath}` },
            {
              type: 'file-data',
              data: buffer.toString('base64'),
              mediaType: 'application/pdf',
              filename: path.basename(filePath),
            },
          ],
        }
      }

      // 文本 / Office / 未知类型 → 一律按文本读取。
      // Office 文件通常会在用户通过 @path 附件上传时，由 buildUserContent
      // 预处理。如果模型仍主动对 .docx 调用 readFile，这里会退回 UTF-8
      // 文本读取，结果大概率是乱码。后续当然可以专门接 Office 解析，但这个
      // 路径很少见，当前保持简单更合适。
      return await readTextResult(filePath, offset, limit)
    } catch (err) {
      return formatToolError('读取文件', err)
    }
  },
})
