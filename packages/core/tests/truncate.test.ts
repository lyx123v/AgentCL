// tools/truncate.ts 的测试
import { describe, expect, it } from 'vitest'

import { MAX_TOOL_RESULT_BYTES, MAX_TOOL_RESULT_LINES, truncateToolResult } from '../src/tools/truncate.js'

describe('truncateToolResult', () => {
  describe('未超预算时直接透传', () => {
    it('短 ASCII 字符串会原样返回', () => {
      expect(truncateToolResult('hello world')).toBe('hello world')
    })

    it('刚好达到字节上限的 ASCII 会原样返回', () => {
      const exact = 'x'.repeat(MAX_TOOL_RESULT_BYTES)
      expect(truncateToolResult(exact)).toBe(exact)
    })

    it('刚好达到行数上限时会原样返回', () => {
      const lines = Array.from({ length: MAX_TOOL_RESULT_LINES }, (_, i) => `第 ${i} 行`).join('\n')
      expect(truncateToolResult(lines)).toBe(lines)
    })
  })

  describe('按字节预算截断', () => {
    it('超出字节预算的 ASCII 会被截断', () => {
      const long = 'x'.repeat(MAX_TOOL_RESULT_BYTES + 5000)
      const out = truncateToolResult(long)
      expect(out.length).toBeLessThan(long.length)
      expect(out).toMatch(/truncated/)
    })

    it('head-tail 模式会同时保留开头和结尾', () => {
      const long = 'A'.repeat(100) + 'M'.repeat(MAX_TOOL_RESULT_BYTES) + 'Z'.repeat(100)
      const out = truncateToolResult(long, { direction: 'head-tail' })
      expect(out.startsWith('AAAA')).toBe(true)
      expect(out.endsWith('ZZZZ')).toBe(true)
    })

    it('head 模式只保留开头', () => {
      const long = 'A'.repeat(100) + 'Z'.repeat(MAX_TOOL_RESULT_BYTES)
      const out = truncateToolResult(long, { direction: 'head', maxBytes: 1000 })
      expect(out.startsWith('AAAA')).toBe(true)
      expect(out.length).toBeLessThan(long.length)
    })

    it('tail 模式只保留结尾', () => {
      const long = 'A'.repeat(MAX_TOOL_RESULT_BYTES) + 'Z'.repeat(100)
      const out = truncateToolResult(long, { direction: 'tail', maxBytes: 1000 })
      expect(out.endsWith('ZZZZ')).toBe(true)
      expect(out.length).toBeLessThan(long.length)
    })

    it('会把非 ASCII 的中日韩内容截断到字节预算内', () => {
      // 2 万个中日韩字符大约是 60 kB UTF-8，超过默认 50 kB 上限。
      const cjk = '你好世界'.repeat(5000)
      const out = truncateToolResult(cjk)
      expect(Buffer.byteLength(out, 'utf-8')).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES + 500)
    })
  })

  describe('按行数预算截断', () => {
    it('超过行数上限时会被截断', () => {
      const lines = Array.from({ length: MAX_TOOL_RESULT_LINES + 500 }, (_, i) => `第-${i}-行`).join('\n')
      const out = truncateToolResult(lines)
      expect(out.split('\n').length).toBeLessThan(lines.split('\n').length)
      expect(out).toMatch(/lines/)
    })

    it('head-tail 模式会同时保留文件头和文件尾', () => {
      const lines = Array.from({ length: MAX_TOOL_RESULT_LINES + 500 }, (_, i) => `第-${i}-行`).join('\n')
      const out = truncateToolResult(lines, { direction: 'head-tail' })
      expect(out).toContain('第-0-行')
      expect(out).toContain('第-' + (MAX_TOOL_RESULT_LINES + 499) + '-行')
    })

    it('head 模式会丢弃尾部内容', () => {
      const lines = Array.from({ length: 5000 }, (_, i) => `第-${i}-行`).join('\n')
      const out = truncateToolResult(lines, { direction: 'head', maxLines: 100 })
      expect(out).toContain('第-0-行')
      expect(out).not.toContain('第-4999-行')
    })
  })

  describe('标记格式', () => {
    it('按行截断的标记会提到行数', () => {
      const lines = Array.from({ length: MAX_TOOL_RESULT_LINES + 10 }, (_, i) => `第${i}项`).join('\n')
      const out = truncateToolResult(lines)
      expect(out).toMatch(/\d+ lines/)
    })

    it('仅按字节截断的标记不会提到行数', () => {
      const long = 'x'.repeat(MAX_TOOL_RESULT_BYTES + 1000)
      const out = truncateToolResult(long)
      expect(out).not.toMatch(/lines/)
    })
  })
})
