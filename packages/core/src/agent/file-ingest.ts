// @x-code-cli/core — 文件附加到消息的处理流水线
//
// 当原始用户输入中通过 `@path` 或裸绝对路径引用文件时，
// 这里会把每个引用解析成 AI SDK 可接受的 content part：
//
//   文本 / 代码   → 带文件正文的 TextPart
//   PDF          → 带提取文本的 TextPart（本地提取，不浪费二进制 token）
//   docx/xlsx/pptx → 通过 officeparser / mammoth / xlsx 转成 TextPart
//   图片         → 多模态 provider 走 ImagePart；DeepSeek 等走 OCR 后的 TextPart
//
// 对 PDF，这里特意优先走本地文本提取，而不是直接作为 FilePart 发送；
// 这样一份 100 页的文本型 PDF 只会变成几 KB 的提示词，而不是成千上万
// 个由页面渲染产生的 token。
import fs from 'node:fs/promises'
import path from 'node:path'

import type { FilePart, ImagePart, TextPart } from 'ai'

import type { ProviderCapabilities } from '../providers/capabilities.js'
import { USER_XCODE_DIR } from '../utils.js'
import { mediaTypeFor } from '../utils/media-type.js'
import { captionImage, pickVisionProvider } from './vision-fallback.js'

/** tesseract.js 缓存语言模型权重的目录。
 *  不显式指定时，worker 会把文件写到 process.cwd()，导致每个项目都重复下载，
 *  还会把二进制文件污染到 git status 中。统一放到 `~/.x-code/tessdata/`
 *  后，只需下载一次，整台机器上的所有项目共享。 */
async function tesseractCacheDir(): Promise<string> {
  const dir = path.join(USER_XCODE_DIR, 'tessdata')
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/** 文件引用被解析后的内容片段类型。
 *  与 AI SDK 在用户消息 `content` 数组中接受的类型保持一致。 */
export type IngestedPart = TextPart | ImagePart | FilePart

export type FileKind = 'text' | 'image' | 'pdf' | 'office' | 'unknown'

/** 用户在输入中指向的文件，可以来自 `@file` 或裸绝对路径。 */
export interface FileReference {
  /** 用户原始输入中的引用文本，用于回显或 UI 展示。 */
  raw: string
  /** 解析后的绝对路径。 */
  absolutePath: string
}

/** 直接视为可内联文本的扩展名集合，仅做成员判断，顺序无意义。 */
const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.mdx',
  '.rst',
  '.log',
  '.csv',
  '.tsv',
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.env',
  '.cfg',
  '.conf',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.swift',
  '.c',
  '.h',
  '.cpp',
  '.cc',
  '.hpp',
  '.cs',
  '.php',
  '.pl',
  '.lua',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ps1',
  '.sql',
  '.graphql',
  '.gql',
  '.proto',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.vue',
  '.svelte',
  '.xml',
  '.svg',
  '.dockerfile',
  '.makefile',
  '.gitignore',
  '.editorconfig',
])

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])
const OFFICE_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp'])

/** 单个内联文件允许贡献给用户消息的最大字节数。
 *  超过后不再直接塞入正文，而是替换成一段提示信息。 */
export const MAX_INGEST_BYTES = 256 * 1024

/** 把字节数格式化成更易读的字符串。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

/** 当附件过大无法内联时，替换给人和模型看的提示文案。
 *  这里额外提示可用 sub-agent，以免整文件分析任务把父上下文迅速撑爆。 */
function tooLargeMessage(filePath: string, sizeBytes: number): string {
  return (
    `[文件 ${filePath} 过大，无法直接内联（当前 ${formatBytes(sizeBytes)}，上限 ${formatBytes(MAX_INGEST_BYTES)}）。` +
    `请使用 readFile 工具配合 offset/limit 读取局部内容，或使用 grep 搜索特定片段。` +
    `如果要做整文件分析（如总结、完整审查），更建议通过 task 工具委托给 sub-agent；` +
    `它会在隔离上下文中读取文件，只把结论返回给父上下文，从而保持主会话精简。]`
  )
}

/** 优先按扩展名识别文件类型；如果扩展名缺失或未知，再回退到魔数检测。 */
export async function classifyFile(filePath: string): Promise<FileKind> {
  const ext = path.extname(filePath).toLowerCase()
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (OFFICE_EXTENSIONS.has(ext)) return 'office'
  if (ext === '.pdf') return 'pdf'

  // 扩展名未知时，读取文件头做魔数检测。
  try {
    const { fileTypeFromFile } = await import('file-type')
    const detected = await fileTypeFromFile(filePath)
    if (!detected) return 'text' // 没有检测到签名时，保守按纯文本处理。
    if (detected.mime.startsWith('image/')) return 'image'
    if (detected.mime === 'application/pdf') return 'pdf'
    if (detected.mime.includes('officedocument') || detected.mime.includes('opendocument')) return 'office'
    if (detected.mime.startsWith('text/')) return 'text'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * 从用户输入中提取文件引用。
 * 支持两种形式：`@path` 与裸绝对路径，并按绝对路径去重。
 */
export function extractFileReferences(input: string): FileReference[] {
  const refs = new Map<string, FileReference>()

  // @path：一个 token，到空白结束。`@` 必须在行首或空白后，
  // 避免把 `@user@host` 这类邮箱样式文本误识别进去。
  const atRegex = /(?:^|\s)@((?:[A-Za-z]:[\\/]|[\\/])[^\s]+|[^\s@][^\s]*)/g
  for (const m of input.matchAll(atRegex)) {
    const raw = m[1] ?? ''
    if (!raw) continue
    const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(raw)
    refs.set(abs, { raw: `@${raw}`, absolutePath: abs })
  }

  // 裸绝对路径：要求包含路径分隔符和扩展名，避免把 `fs.readFile`
  // 这类代码片段误判为路径。
  const bareRegex = /(?:^|\s)((?:[A-Za-z]:[\\/]|\/)[^\s]*\.[A-Za-z0-9]{1,8})/g
  for (const m of input.matchAll(bareRegex)) {
    const raw = m[1] ?? ''
    if (!raw) continue
    const abs = path.normalize(raw)
    if (!refs.has(abs)) refs.set(abs, { raw, absolutePath: abs })
  }

  return [...refs.values()]
}

/** 以带行号的文本块形式读取文件。
 *  这样无论文件是预先内联，还是后续通过 readFile 获取，模型看到的格式都一致。 */
async function readTextFile(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath, 'utf-8')
  const lines = content.split('\n')
  return lines.map((line, i) => `${i + 1}\t${line}`).join('\n')
}

/** 从 PDF 中提取纯文本。
 *  使用 pdf-parse v2 的类式 API；失败时返回空字符串，由调用方决定是否回退到 OCR。 */
async function extractPdfText(filePath: string): Promise<string> {
  try {
    const { PDFParse } = await import('pdf-parse')
    const buffer = await fs.readFile(filePath)
    const parser = new PDFParse({ data: new Uint8Array(buffer) })
    try {
      const result = await parser.getText()
      return result.text ?? ''
    } finally {
      await parser.destroy().catch(() => {})
    }
  } catch {
    return ''
  }
}

/** 从 Office 文档中提取文本。
 *  `.docx` 走 mammoth，`.xlsx` 走 SheetJS，其余常见 Office 格式走 officeparser。 */
async function extractOfficeText(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase()
  try {
    if (ext === '.docx') {
      const mammoth = await import('mammoth')
      const result = await mammoth.extractRawText({ path: filePath })
      return result.value
    }
    if (ext === '.xlsx') {
      const XLSX = await import('xlsx')
      const wb = XLSX.readFile(filePath)
      const parts: string[] = []
      for (const sheetName of wb.SheetNames) {
        const sheet = wb.Sheets[sheetName]
        if (!sheet) continue
        parts.push(`--- 工作表：${sheetName} ---\n${XLSX.utils.sheet_to_csv(sheet)}`)
      }
      return parts.join('\n\n')
    }
    // `.pptx`、`.odt`、`.ods`、`.odp` 等格式统一交给 officeparser。
    const { OfficeParser } = await import('officeparser')
    const ast = await OfficeParser.parseOffice(filePath)
    return ast.toText()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return `[无法从 ${path.basename(filePath)} 中提取文本：${msg}]`
  }
}

/** 使用 tesseract.js 对图片做 OCR。
 *  首次调用会加载中英文语言包，适合作为不支持视觉输入的 provider 的降级方案。 */
export async function ocrImage(filePath: string): Promise<string> {
  try {
    const { createWorker } = await import('tesseract.js')
    const worker = await createWorker(['eng', 'chi_sim'], 1, {
      cachePath: await tesseractCacheDir(),
    })
    try {
      const { data } = await worker.recognize(filePath)
      return data.text ?? ''
    } finally {
      await worker.terminate()
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return `[OCR 失败：${msg}]`
  }
}

/** 先把 PDF 光栅化，再对每一页做 OCR。
 *  适用于扫描版 PDF，即 pdf-parse 几乎提取不到文本的场景。 */
async function ocrPdf(filePath: string): Promise<string> {
  try {
    const { PDFParse } = await import('pdf-parse')
    const buffer = await fs.readFile(filePath)
    const parser = new PDFParse({ data: new Uint8Array(buffer) })
    let screenshots: { pages: Array<{ pageNumber: number; data?: Uint8Array }> }
    try {
      screenshots = (await parser.getScreenshot({ scale: 2, imageBuffer: true })) as typeof screenshots
    } finally {
      await parser.destroy().catch(() => {})
    }

    const { createWorker } = await import('tesseract.js')
    const worker = await createWorker(['eng', 'chi_sim'], 1, {
      cachePath: await tesseractCacheDir(),
    })
    try {
      const out: string[] = []
      for (const page of screenshots.pages) {
        if (!page.data) continue
        const { data } = await worker.recognize(Buffer.from(page.data))
        out.push(`--- 第 ${page.pageNumber} 页 ---\n${data.text ?? ''}`)
      }
      return out.join('\n\n')
    } finally {
      await worker.terminate()
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return `[PDF OCR 失败：${msg}]`
  }
}

/**
 * 把单个文件引用解析成一个或多个 content part，并结合当前 provider 的多模态能力决定最终形式。
 */
export async function ingestFile(
  ref: FileReference,
  caps: ProviderCapabilities,
  onNotice?: (msg: string) => void,
): Promise<IngestedPart[]> {
  let kind: FileKind
  let stats: Awaited<ReturnType<typeof fs.stat>>
  try {
    stats = await fs.stat(ref.absolutePath)
    kind = await classifyFile(ref.absolutePath)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return [{ type: 'text', text: `[无法读取 ${ref.raw}：${msg}]` }]
  }

  if (kind === 'text' || kind === 'unknown') {
    // 对文本文件来说，磁盘字节数基本就是内联文本体积的上界，
    // 因此先检查大小，避免把超大文件读入内存后又丢掉。
    if (stats.size > MAX_INGEST_BYTES) {
      return [{ type: 'text', text: tooLargeMessage(ref.absolutePath, stats.size) }]
    }
    try {
      const body = await readTextFile(ref.absolutePath)
      return [{ type: 'text', text: `<<file path="${ref.absolutePath}">>\n${body}\n<</file>>` }]
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return [{ type: 'text', text: `[读取 ${ref.raw} 失败：${msg}]` }]
    }
  }

  if (kind === 'office') {
    const text = await extractOfficeText(ref.absolutePath)
    // Office 二进制通常比提取后的纯文本大很多，因此要在提取后再检查一次大小。
    const textBytes = Buffer.byteLength(text, 'utf-8')
    if (textBytes > MAX_INGEST_BYTES) {
      return [{ type: 'text', text: tooLargeMessage(ref.absolutePath, textBytes) }]
    }
    return [{ type: 'text', text: `<<file path="${ref.absolutePath}" kind="office">>\n${text}\n<</file>>` }]
  }

  if (kind === 'pdf') {
    const extracted = await extractPdfText(ref.absolutePath)
    // 经验规则：真正的文本型 PDF 至少能提取出几百个字符；
    // 扫描件通常只有空串或零碎乱码。
    if (extracted.trim().length > 200) {
      const textBytes = Buffer.byteLength(extracted, 'utf-8')
      if (textBytes > MAX_INGEST_BYTES) {
        return [{ type: 'text', text: tooLargeMessage(ref.absolutePath, textBytes) }]
      }
      return [{ type: 'text', text: `<<file path="${ref.absolutePath}" kind="pdf-text">>\n${extracted}\n<</file>>` }]
    }
    // 扫描版 / 图片型 PDF。
    if (caps.pdf) {
      try {
        const buffer = await fs.readFile(ref.absolutePath)
        return [{ type: 'file', data: buffer, mediaType: 'application/pdf', filename: path.basename(ref.absolutePath) }]
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return [{ type: 'text', text: `[附加 PDF ${ref.raw} 失败：${msg}]` }]
      }
    }
    // 当前模型不支持 PDF 输入时，对扫描版 PDF 在本地做 OCR。
    const ocr = await ocrPdf(ref.absolutePath)
    const ocrBytes = Buffer.byteLength(ocr, 'utf-8')
    if (ocrBytes > MAX_INGEST_BYTES) {
      return [{ type: 'text', text: tooLargeMessage(ref.absolutePath, ocrBytes) }]
    }
    return [
      {
        type: 'text',
        text: `<<file path="${ref.absolutePath}" kind="pdf-ocr">>\n${ocr}\n<</file>>\n[说明：当前模型不支持 PDF 输入，因此该 PDF 已在本地做 OCR；识别准确率有限。]`,
      },
    ]
  }

  // 图片。
  if (caps.image) {
    try {
      const buffer = await fs.readFile(ref.absolutePath)
      return [
        { type: 'text', text: `<<file path="${ref.absolutePath}" kind="image">>` },
        { type: 'image', image: buffer, mediaType: mediaTypeFor(ref.absolutePath) },
      ]
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return [{ type: 'text', text: `[附加图片 ${ref.raw} 失败：${msg}]` }]
    }
  }

  // 纯文本 provider（如 DeepSeek、自定义 provider）优先尝试视觉 sub-agent。
  // caption 同时覆盖文字与视觉内容，而 OCR 只能提取文字。
  const sub = pickVisionProvider()
  if (sub) {
    try {
      const caption = await captionImage(ref.absolutePath, sub)
      onNotice?.(`已通过 ${sub.modelId} 为图片生成描述`)
      return [
        {
          type: 'text',
          text: `<<file path="${ref.absolutePath}" kind="image-caption" via="${sub.modelId}">>\n${caption}\n<</file>>\n[说明：当前模型无法直接看图。上面的描述由 ${sub.label}（视觉 sub-agent）生成，而不是当前模型本身。若任务依赖复杂视觉理解，建议先用 /model 切换到支持视觉的模型后再继续追问。]`,
        },
      ]
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      onNotice?.(`视觉 sub-agent（${sub.label}）失败：${msg}，将回退到 OCR`)
      // 失败后继续回退到 OCR。
    }
  }

  // 没有可用视觉 sub-agent，或调用失败时，对图片执行 OCR。
  // 同时明确提示模型：这不是真正的图像理解，避免它误判颜色、布局等视觉信息。
  const ocr = await ocrImage(ref.absolutePath)
  return [
    {
      type: 'text',
      text: `<<file path="${ref.absolutePath}" kind="image-ocr">>\n${ocr}\n<</file>>\n[说明：当前模型不支持原生看图。这里只提供 OCR 文本，布局、图表、照片等视觉内容不可见。]`,
    },
  ]
}

/**
 * 组装用户消息的 content parts：先放原始文本，再依次追加每个文件解析出的内容片段。
 * 如果没有文件引用，则直接返回原始字符串，保持简单提示词走原有快速路径。
 */
export async function buildUserContent(
  text: string,
  caps: ProviderCapabilities,
  onNotice?: (msg: string) => void,
): Promise<string | Array<TextPart | ImagePart | FilePart>> {
  const refs = extractFileReferences(text)
  if (refs.length === 0) return text

  const parts: IngestedPart[] = [{ type: 'text', text }]
  for (const ref of refs) {
    const ingested = await ingestFile(ref, caps, onNotice)
    parts.push(...ingested)
  }
  return parts
}
