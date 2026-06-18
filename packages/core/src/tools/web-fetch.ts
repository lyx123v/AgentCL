// @x-code-cli/core — webFetch 工具（HTTP 抓取 + HTML 转 Markdown，带 LRU 缓存与 Cloudflare 回退）
import * as cheerio from 'cheerio'
// @ts-expect-error turndown 没有类型定义
import TurndownService from 'turndown'

import { tool } from 'ai'

import { z } from 'zod'

import { LruCache } from '../utils/lru-cache.js'
import { formatToolError } from '../utils/tool-errors.js'
import { VERSION } from '../version.js'
import { reportProgress } from './progress.js'

const FETCH_TIMEOUT_MS = 15_000
// 返回给模型的 Markdown 上限。这里从 30 KB 提高到 100 KB，避免很多文档页
// 还没读完就被硬截断；同时它仍远低于模型的上下文预算，因此单次抓取不会把
// 上下文直接撑爆。这个限制是单次调用级别的，模型仍可通过更窄的 prompt 再抓一次。
const MAX_CONTENT_CHARS = 100_000
// turndown 转换前的原始 HTML 上限。10 MB 足以覆盖几乎所有真实文档页。
// 这个限制同时通过 content-length 头和流式 body 读取（见 readResponseBody）
// 两层执行，因此即便是 chunked 响应也不会失控。
const MAX_HTTP_BYTES = 10 * 1024 * 1024
const MAX_URL_LENGTH = 2000
const CACHE_TTL_MS = 15 * 60 * 1000
const CACHE_MAX_ENTRIES = 50

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
// 作为 Cloudflare 回退 UA 使用。很多激进规则会放行“坦诚表明自己是 CLI”
// 的请求，却拦截那些 TLS 指纹对不上、但假装浏览器的请求。
const FALLBACK_UA = `x-code-cli/${VERSION} (+https://github.com/woai3c/x-code-cli)`

const YEAR = new Date().getFullYear()

// ── SSRF 防护 ──
// 拒绝访问内网 / 私网地址。思路与 Claude Code 的 validateURL 接近：
// hostname 至少要有两个点分段（过滤 `localhost` 和裸主机名），不能带内嵌凭据，
// 仅允许 HTTP/HTTPS，且 IP 不得落在私网、链路本地或回环范围内。

const PRIVATE_IP_PATTERNS = [
  /^127\./, // 回环地址
  /^10\./, // 10.0.0.0/8
  /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12
  /^192\.168\./, // 192.168.0.0/16
  /^169\.254\./, // 链路本地地址（常见于 AWS/GCP 元数据）
  /^0\./, // 0.0.0.0/8
  /^::1$/, // IPv6 回环地址
  /^fd[0-9a-f]{2}:/i, // IPv6 唯一本地地址
  /^fe80:/i, // IPv6 链路本地地址
]

/** 判断 hostname 是否属于私有网络或本地地址。 */
function isPrivateHost(hostname: string): boolean {
  const lower = hostname.toLowerCase()
  if (lower === 'localhost' || lower.endsWith('.local') || lower.endsWith('.internal')) return true
  // URL 里如果直接写了 IP 字面量，IPv6 会带方括号，这里先去掉再判断。
  const bare = lower.startsWith('[') ? lower.slice(1, -1) : lower
  return PRIVATE_IP_PATTERNS.some((re) => re.test(bare))
}

/** 校验抓取 URL 是否安全合法。仅为测试目的对外导出。 */
export function validateFetchUrl(url: string): string | null {
  if (url.length > MAX_URL_LENGTH) return `URL 超过 ${MAX_URL_LENGTH} 个字符的长度限制`
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'URL 无效'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `不支持的协议：${parsed.protocol}（仅允许 http/https）`
  }
  if (parsed.username || parsed.password) return '不允许使用内嵌账号密码的 URL'
  const parts = parsed.hostname.split('.')
  if (parts.length < 2) return `主机名 "${parsed.hostname}" 不是公共域名（至少需要两个段）`
  if (isPrivateHost(parsed.hostname)) {
    return `出于安全原因，禁止抓取私有/内网地址 "${parsed.hostname}"`
  }
  return null
}

const fetchCache = new LruCache<string>({ maxEntries: CACHE_MAX_ENTRIES, ttlMs: CACHE_TTL_MS })

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
}) as { turndown: (html: string) => string }

/** 按指定 User-Agent 发起抓取请求。 */
async function doFetch(url: string, userAgent: string): Promise<Response> {
  return fetch(url, {
    headers: {
      'User-Agent': userAgent,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
}

/** 以流式方式读取响应体，并施加硬字节上限。
 *  用于防止 content-length 缺失或不可信的 chunked 响应打爆内存。 */
async function readResponseBody(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return response.text()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    totalBytes += value.byteLength
    if (totalBytes > maxBytes) {
      await reader.cancel()
      break
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(Math.min(totalBytes, maxBytes))
  let offset = 0
  for (const chunk of chunks) {
    const remaining = merged.byteLength - offset
    if (remaining <= 0) break
    const slice = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk
    merged.set(slice, offset)
    offset += slice.byteLength
  }
  return new TextDecoder().decode(merged)
}

/** 按工具约定格式组织输出，并在需要时附带抽取提示。 */
function formatOutput(url: string, markdown: string, prompt?: string): string {
  if (prompt) {
    return `# 来自 ${url} 的内容\n\n${markdown}\n\n---\n提取指令：${prompt}`
  }
  return markdown
}

export const webFetch = tool({
  description:
    `抓取网页并把内容提取成 Markdown，不需要 API key。` +
    `当你基于返回内容给用户总结时，请保留关键细节、具体示例、章节结构和数字，不要过度压缩。` +
    `结果会按 URL 缓存 15 分钟，因此重复读取同一页面几乎没有额外成本。` +
    `当前年份是 ${YEAR}，当用户询问最近/最新/当前信息时请主动利用这个时间背景。`,
  inputSchema: z.object({
    url: z.string().url().describe('要抓取的 URL'),
    prompt: z.string().optional().describe('希望从页面中提取什么信息'),
  }),
  execute: async ({ url, prompt }, { toolCallId }) => {
    try {
      const urlError = validateFetchUrl(url)
      if (urlError) return `错误：${urlError}`

      const cached = fetchCache.get(url)
      if (cached) {
        reportProgress(toolCallId, '正在使用缓存副本')
        return formatOutput(url, cached, prompt)
      }

      reportProgress(toolCallId, `正在抓取 ${url}`)
      let response = await doFetch(url, BROWSER_UA)

      // Cloudflare 机器人挑战回退：如果遇到 403 且带 cf-mitigated 头，
      // 就改用一个老实声明自己是 CLI 的 UA 重试。
      if (response.status === 403 && response.headers.get('cf-mitigated') !== null) {
        response = await doFetch(url, FALLBACK_UA)
      }

      if (!response.ok) {
        return `错误：HTTP ${response.status} ${response.statusText}`
      }

      // 如果 content-length 已经明确超限，就提前拒绝。
      const contentLength = Number(response.headers.get('content-length') ?? '0')
      if (contentLength > MAX_HTTP_BYTES) {
        const mb = Math.round(contentLength / 1024 / 1024)
        return `错误：内容过大（${mb} MB，限制为 ${MAX_HTTP_BYTES / 1024 / 1024} MB）`
      }

      const contentType = response.headers.get('content-type') ?? ''
      // 以硬字节上限流式读取，避免 chunked 响应在 content-length 缺失
      // 或不可信时造成内存失控。
      const body = await readResponseBody(response, MAX_HTTP_BYTES)

      if (contentType.includes('application/json')) {
        const json = body.slice(0, MAX_CONTENT_CHARS)
        fetchCache.set(url, json)
        return formatOutput(url, json, prompt)
      }

      const $ = cheerio.load(body)
      $('script, style, nav, footer, header, aside, .sidebar, .nav, .menu, .ads, .advertisement').remove()

      const mainContent = $('main, article, .content, .post, #content').first()
      const html = mainContent.length ? mainContent.html() : $('body').html()

      if (!html) return '错误：无法从页面中提取内容。'

      let markdown: string = turndown.turndown(html)
      if (markdown.length > MAX_CONTENT_CHARS) {
        markdown = markdown.slice(0, MAX_CONTENT_CHARS) + '\n\n... [内容已截断]'
      }

      fetchCache.set(url, markdown)
      return formatOutput(url, markdown, prompt)
    } catch (err) {
      return formatToolError('抓取 URL', err)
    }
  },
})
