// @x-code-cli/core — webSearch 工具（优先 Tavily，回退 Brave）
import { tool } from 'ai'

import { z } from 'zod'

import { formatToolError } from '../utils/tool-errors.js'
import { reportProgress } from './progress.js'
import { getShellProvider } from './shell-provider.js'

const YEAR = new Date().getFullYear()
const BRAVE_TIMEOUT_MS = 15_000

interface SearchResult {
  title: string // 搜索结果标题
  url: string // 搜索结果链接
  content: string // 搜索结果摘要
}

/** 使用 Tavily 执行网络搜索。 */
async function searchWithTavily(query: string, maxResults: number): Promise<SearchResult[]> {
  const { tavily } = await import('@tavily/core')
  const client = tavily({ apiKey: process.env.TAVILY_API_KEY! })
  const response = await client.search(query, { maxResults })
  return response.results.map((r: SearchResult) => ({ title: r.title, url: r.url, content: r.content }))
}

/** 使用 Brave Search API 执行网络搜索。 */
async function searchWithBrave(query: string, maxResults: number): Promise<SearchResult[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search')
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(Math.min(maxResults, 20)))

  const res = await fetch(url, {
    headers: {
      'X-Subscription-Token': process.env.BRAVE_API_KEY!,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(BRAVE_TIMEOUT_MS),
  })

  if (!res.ok) {
    throw new Error(`Brave API 返回了 HTTP ${res.status} ${res.statusText}`)
  }

  const data = (await res.json()) as {
    web?: { results?: Array<{ title: string; url: string; description: string }> }
  }
  return (data.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, content: r.description }))
}

/** 构造缺少 WebSearch API key 时返回给模型的提示文本。 */
function buildMissingKeyError(): string {
  const { type } = getShellProvider()
  let setupBlock: string

  if (type === 'powershell') {
    setupBlock = [
      '  # 当前会话：',
      '  $env:TAVILY_API_KEY = "tvly-xxx"',
      '  $env:BRAVE_API_KEY  = "BSA-xxx"',
      '  # 持久生效（新的 shell 会话）：',
      '  [Environment]::SetEnvironmentVariable("TAVILY_API_KEY","tvly-xxx","User")',
      '  [Environment]::SetEnvironmentVariable("BRAVE_API_KEY", "BSA-xxx", "User")',
    ].join('\n')
  } else {
    const rc = type === 'zsh' ? '~/.zshrc' : '~/.bashrc'
    setupBlock = [
      '  # 当前会话：',
      '  export TAVILY_API_KEY="tvly-xxx"',
      '  export BRAVE_API_KEY="BSA-xxx"',
      '  # 持久生效（新的 shell 会话）：',
      `  echo 'export TAVILY_API_KEY="tvly-xxx"' >> ${rc}`,
      `  echo 'export BRAVE_API_KEY="BSA-xxx"' >> ${rc}`,
    ].join('\n')
  }

  return [
    '错误：WebSearch 需要 API key。下面有两个免费可用方案（任选其一即可）：',
    '',
    '  1. Tavily：每月 1000 次搜索，推荐',
    '     注册地址：https://tavily.com → 在控制台复制 API key',
    '',
    '  2. Brave：通过 5 美元免费额度可用约 1000 次搜索（需要信用卡，超额会计费）',
    '     注册地址：https://api.search.brave.com → 创建 API key',
    '',
    `设置方式（${type}）：`,
    setupBlock,
    '',
    '设置完成后，请重启当前 shell 让环境变量生效。',
  ].join('\n')
}

/** 把搜索结果整理成便于模型消费的 Markdown 文本。 */
function formatResults(results: SearchResult[]): string {
  if (results.length === 0) return '没有找到结果。'
  return results.map((r) => `### ${r.title}\n${r.url}\n${r.content}`).join('\n\n')
}

export const webSearch = tool({
  description:
    `在网络上搜索信息。适合查文档、查报错，或查当前时效性信息。` +
    `当前年份是 ${YEAR}，当用户询问最近/最新/当前信息时，请主动把年份带进查询里` +
    `（例如优先搜索 "React 19 release notes ${YEAR}"，而不是 "React latest release notes"）。`,
  inputSchema: z.object({
    query: z.string().describe('搜索关键词'),
    maxResults: z.number().optional().describe('最多返回多少条结果（默认 5）'),
  }),
  execute: async ({ query, maxResults }, { toolCallId }) => {
    const n = maxResults ?? 5
    const hasTavily = !!process.env.TAVILY_API_KEY
    const hasBrave = !!process.env.BRAVE_API_KEY

    if (!hasTavily && !hasBrave) return buildMissingKeyError()

    reportProgress(toolCallId, `正在搜索：${query}`)
    try {
      const results = hasTavily ? await searchWithTavily(query, n) : await searchWithBrave(query, n)
      return formatResults(results)
    } catch (err) {
      return formatToolError(`执行搜索（${hasTavily ? 'Tavily' : 'Brave'}）`, err)
    }
  },
})
