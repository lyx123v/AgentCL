// src/utils.ts:truncateForLog 的回归测试。
//
// 背景：旧实现先计算 `sliceLen = maxBytes - 64`，再用 `s.slice(0, sliceLen)`
// 截断字符串。这个过程按 UTF-16 码元计数，而不是按 UTF-8 字节计数，
// 所以遇到中日韩字符或 emoji 时，返回值经常会比 maxBytes 大出约 3 到 4 倍，
// 导致 MAX_LINE_BYTES 失效，让单条调试日志突破预算。
// 这个问题是在一次 §3d 测试巡检里被 `code-reviewer` 子代理指出的；
// 当前测试用于锁定“按字节精确截断”的实现。
import { describe, expect, it } from 'vitest'

import { truncateForLog } from '../src/utils.js'

describe('truncateForLog', () => {
  it('ASCII 输入未超过 maxBytes 时保持不变', () => {
    const s = 'hello world'
    expect(truncateForLog(s, 1024)).toBe(s)
  })

  it('中日韩文本在字节数未超限时保持不变', () => {
    // 10 个字符 * 3 字节 = 30 字节，小于 1024。
    const s = '中文测试一二三四五六'
    expect(truncateForLog(s, 1024)).toBe(s)
  })

  it('会把 ASCII 文本截断到 maxBytes 以内', () => {
    const s = 'a'.repeat(2000)
    const out = truncateForLog(s, 1024)
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(1024)
    expect(out).toMatch(/<\+\d+b truncated>$/)
  })

  it('截断中日韩文本时按字节而不是按 JS 字符索引处理', () => {
    // 1000 个“龙” * 每字符 3 字节 = 共 3000 UTF-8 字节。
    // 旧实现中：sliceLen = 1024 - 64 = 960，再执行 s.slice(0, 960)，
    // 返回的是 960 个字符，也就是 2880 字节，几乎是 maxBytes 预算的 3 倍。
    // 正确实现应该改为截断 UTF-8 buffer。
    const s = '龙'.repeat(1000)
    const out = truncateForLog(s, 1024)
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(1024)
    expect(out).toContain('truncated')
  })

  it('截断 emoji 输入时也不会超过 maxBytes', () => {
    // 🐉 在 UTF-8 中占 4 字节，在 UTF-16 中占 2 个码元（代理对）。
    // 旧的按字符切片逻辑在这两个维度上都会算错。
    const s = '🐉'.repeat(500) // ~2000 UTF-8 bytes
    const out = truncateForLog(s, 512)
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(512)
  })

  it('截断标记里报告的是丢弃的字节数，而不是字符数', () => {
    // 1000 个“龙” = 3000 字节；sliceLen = 960；dropped = 3000 - 960 = 2040。
    // 标记应反映字节数（后缀为 b），而不是旧实现曾打印过的字符数（c），
    // 因为这个函数的契约本来就是按字节计算。
    const s = '龙'.repeat(1000)
    const out = truncateForLog(s, 1024)
    const match = out.match(/<\+(\d+)b truncated>$/)
    expect(match).not.toBeNull()
    const droppedBytes = Number(match![1])
    // 理论值约为 3000 - 960 = 2040。这里留一点容差，
    // 因为 TextDecoder 可能会在边界处丢掉不完整码点。
    expect(droppedBytes).toBeGreaterThan(2000)
    expect(droppedBytes).toBeLessThan(2100)
  })
})
