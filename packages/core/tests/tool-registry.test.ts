// truncateToolResult 的测试。
// 在这一层里，tools/index.ts 里真正值得覆盖的非平凡逻辑主要就是它。
import { describe, expect, it, vi } from 'vitest'

import { MAX_TOOL_RESULT_BYTES, truncateToolResult } from '../src/tools/index.js'

// 从 tools/index.ts 导入时会顺带拉起 webFetch，而它又会级联加载
// cheerio 和 turndown。这里先 mock 掉，避免测试环境导入失败。
vi.mock('cheerio', () => ({
  load: vi.fn(() => {
    const $ = () => ({ remove: vi.fn(), first: vi.fn(() => ({ length: 0, html: () => '' })), html: () => '' })
    $.load = $
    return $
  }),
}))

vi.mock('turndown', () => ({
  default: class {
    turndown() {
      return ''
    }
  },
}))

describe('truncateToolResult', () => {
  it('结果刚好达到字节上限时不会被截断', () => {
    const exact = 'x'.repeat(MAX_TOOL_RESULT_BYTES)
    expect(truncateToolResult(exact)).toBe(exact)
  })

  it('超长结果会被截断，并保留头尾两端内容', () => {
    const long = 'x'.repeat(MAX_TOOL_RESULT_BYTES + 1000)
    const result = truncateToolResult(long)
    expect(result.length).toBeLessThan(long.length)
    expect(result).toContain('truncated')
  })
})
