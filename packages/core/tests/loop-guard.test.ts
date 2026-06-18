// agent/loop-guard.ts 的测试
import { describe, expect, it } from 'vitest'

import {
  HARD_LOOP_THRESHOLD,
  SOFT_LOOP_THRESHOLD,
  checkForLoop,
  hashToolCall,
  recordToolCall,
} from '../src/agent/loop-guard.js'
import { createLoopState } from '../src/agent/loop-state.js'

describe('hashToolCall', () => {
  it('相同输入即使 key 顺序不同也会产生相同哈希', () => {
    const a = hashToolCall('shell', { command: 'ls', timeout: 5000 })
    const b = hashToolCall('shell', { timeout: 5000, command: 'ls' })
    expect(a).toBe(b)
  })

  it('不同工具名会产生不同哈希', () => {
    const a = hashToolCall('shell', { command: 'ls' })
    const b = hashToolCall('grep', { command: 'ls' })
    expect(a).not.toBe(b)
  })

  it('不同输入会产生不同哈希', () => {
    const a = hashToolCall('shell', { command: 'ls' })
    const b = hashToolCall('shell', { command: 'pwd' })
    expect(a).not.toBe(b)
  })

  it('哈希值是 16 位十六进制字符串', () => {
    const h = hashToolCall('shell', { command: 'ls' })
    expect(h).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('checkForLoop', () => {
  it('全新状态会返回 ok', () => {
    const state = createLoopState()
    const result = checkForLoop(state, 'shell', { command: 'ls' }, 'tc1')
    expect(result.kind).toBe('ok')
  })

  it('历史调用次数低于软阈值时返回 ok', () => {
    const state = createLoopState()
    for (let i = 0; i < SOFT_LOOP_THRESHOLD - 2; i++) {
      recordToolCall(state, 'shell', { command: 'ls' })
    }
    const result = checkForLoop(state, 'shell', { command: 'ls' }, 'tc-new')
    expect(result.kind).toBe('ok')
  })

  it('达到 SOFT_LOOP_THRESHOLD 时返回 soft-block', () => {
    const state = createLoopState()
    for (let i = 0; i < SOFT_LOOP_THRESHOLD - 1; i++) {
      recordToolCall(state, 'shell', { command: 'ls' })
    }
    const result = checkForLoop(state, 'shell', { command: 'ls' }, 'tc-new')
    expect(result.kind).toBe('soft-block')
    if (result.kind === 'soft-block') {
      expect(result.message).toContain('shell')
      expect(result.toolCallId).toBe('tc-new')
    }
  })

  it('达到 HARD_LOOP_THRESHOLD 时返回 hard-block', () => {
    const state = createLoopState()
    for (let i = 0; i < HARD_LOOP_THRESHOLD - 1; i++) {
      recordToolCall(state, 'shell', { command: 'ls' })
    }
    const result = checkForLoop(state, 'shell', { command: 'ls' }, 'tc-new')
    expect(result.kind).toBe('hard-block')
    if (result.kind === 'hard-block') {
      expect(result.message).toContain('重复调用')
    }
  })

  it('不同输入会重置重复计数', () => {
    const state = createLoopState()
    for (let i = 0; i < SOFT_LOOP_THRESHOLD - 1; i++) {
      recordToolCall(state, 'shell', { command: 'ls' })
    }
    // 中间插入不同输入的调用后，不应继续累加到新的相同调用上。
    recordToolCall(state, 'shell', { command: 'pwd' })
    const result = checkForLoop(state, 'shell', { command: 'pwd' }, 'tc-new')
    // 之前只有 1 次 `pwd` 调用，因此应返回 ok。
    expect(result.kind).toBe('ok')
  })

  it('不同工具名不会参与重复计数', () => {
    const state = createLoopState()
    for (let i = 0; i < SOFT_LOOP_THRESHOLD - 1; i++) {
      recordToolCall(state, 'shell', { command: 'ls' })
    }
    // 不同工具的调用不应触发守卫。
    const result = checkForLoop(state, 'grep', { pattern: 'foo' }, 'tc-new')
    expect(result.kind).toBe('ok')
  })
})

describe('recordToolCall', () => {
  it('会追加到 recentToolCalls', () => {
    const state = createLoopState()
    recordToolCall(state, 'shell', { command: 'ls' })
    expect(state.recentToolCalls).toHaveLength(1)
    expect(state.recentToolCalls[0].toolName).toBe('shell')
  })

  it('会把历史长度限制在窗口大小的 2 倍内', () => {
    const state = createLoopState()
    for (let i = 0; i < 50; i++) {
      recordToolCall(state, 'shell', { command: `cmd-${i}` })
    }
    expect(state.recentToolCalls.length).toBeLessThanOrEqual(16) // LOOP_WINDOW_SIZE * 2
  })
})
