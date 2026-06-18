// agent/compression.ts 的测试，重点覆盖压缩进度回调与 token 统计。
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { generateText } from 'ai'
import type { LanguageModel, ModelMessage } from 'ai'

import {
  KEEP_RECENT,
  checkAndCompressContext,
  compressMessages,
  handleContextTooLong,
} from '../src/agent/compression.js'
import { createLoopState } from '../src/agent/loop-state.js'
import type { AgentCallbacks } from '../src/types/index.js'

vi.mock('ai', async () => {
  const actual = await vi.importActual('ai')
  return { ...actual, generateText: vi.fn() }
})

vi.mock('../src/knowledge/session.js', () => ({
  generateSessionSummary: vi.fn().mockResolvedValue({ summary: 'session summary' }),
}))

vi.mock('../src/agent/session-store.js', () => ({
  markBoundaryAndReflush: vi.fn().mockResolvedValue(undefined),
}))

// ── 辅助函数 ──

// 生成默认回调集合，并允许测试按需覆写个别实现。
function makeCallbacks(overrides: Partial<AgentCallbacks> = {}): AgentCallbacks {
  return {
    onTextDelta: vi.fn(),
    onToolCall: vi.fn(),
    onToolProgress: vi.fn(),
    onToolResult: vi.fn(),
    onAskPermission: vi.fn().mockResolvedValue(true),
    onAskUser: vi.fn().mockResolvedValue('ok'),
    onPlanApprovalRequest: vi.fn().mockResolvedValue(true),
    onPlanModeChange: vi.fn(),
    onTodosUpdate: vi.fn(),
    onShellOutput: vi.fn(),
    onUsageUpdate: vi.fn(),
    onContextCompressed: vi.fn(),
    onCompressionProgress: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  }
}

const fakeModel = {} as LanguageModel

// 生成一批足够长的消息，用来触发压缩逻辑。
function padMessages(count: number): ModelMessage[] {
  const msgs: ModelMessage[] = []
  for (let i = 0; i < count; i++) {
    msgs.push(
      { role: 'user', content: `message ${i} ${'x'.repeat(500)}` },
      { role: 'assistant', content: `reply ${i} ${'y'.repeat(500)}` },
    )
  }
  return msgs
}

// ── compressMessages ──

describe('compressMessages', () => {
  beforeEach(() => vi.clearAllMocks())

  it('消息数少于 KEEP_RECENT 时会原样返回', async () => {
    const msgs: ModelMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]
    const result = await compressMessages(msgs, fakeModel)
    expect(result).toBe(msgs)
    expect(generateText).not.toHaveBeenCalled()
  })

  it('会调用 generateText，并返回摘要加最近消息', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: 'Summary of old conversation' } as any)
    const msgs = padMessages(KEEP_RECENT + 2)
    const result = await compressMessages(msgs, fakeModel)

    expect(generateText).toHaveBeenCalledOnce()
    expect(result[0].role).toBe('user')
    expect(result[0].content).toContain('[Previous conversation summary]')
    expect(result[0].content).toContain('Summary of old conversation')
    expect(result.length).toBeLessThan(msgs.length)
  })
})

// ── checkAndCompressContext（主动压缩） ──

describe('checkAndCompressContext', () => {
  beforeEach(() => vi.clearAllMocks())

  it('低于阈值时不做任何事', async () => {
    const state = createLoopState()
    state.messages = padMessages(2)
    const cb = makeCallbacks()

    await checkAndCompressContext(state, fakeModel, 999_999, cb)

    expect(cb.onCompressionProgress).not.toHaveBeenCalled()
    expect(cb.onContextCompressed).not.toHaveBeenCalled()
  })

  it('完整压缩时会发出阶段进度，并生成带 token 统计的压缩提示', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: 'compressed summary' } as any)
    const state = createLoopState()
    state.messages = padMessages(KEEP_RECENT + 4)
    state.lastInputTokens = 999_999

    const cb = makeCallbacks()
    await checkAndCompressContext(state, fakeModel, 1, cb)

    const progressCalls = vi.mocked(cb.onCompressionProgress!).mock.calls.map((c) => c[0])
    expect(progressCalls).toContain('正在移除重复的工具调用……')
    expect(progressCalls).toContain('正在截断较旧的工具结果……')
    expect(progressCalls).toContain('正在生成会话摘要……')
    expect(progressCalls).toContain('正在总结对话……')

    expect(cb.onContextCompressed).toHaveBeenCalledOnce()
    const compressedMsg = vi.mocked(cb.onContextCompressed).mock.calls[0][0]
    expect(compressedMsg).toMatch(/上下文已压缩：约 \d+k → \d+k tokens。/)
  })

  it('即使 onCompressionProgress 未定义也能正常工作', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: 'summary' } as any)
    const state = createLoopState()
    state.messages = padMessages(KEEP_RECENT + 4)
    state.lastInputTokens = 999_999

    const cb = makeCallbacks()
    delete (cb as any).onCompressionProgress

    await expect(checkAndCompressContext(state, fakeModel, 1, cb)).resolves.toBeUndefined()
    expect(cb.onContextCompressed).toHaveBeenCalled()
  })

  it('深度压缩后会重置 lastInputTokens，并设置 expectCacheMiss', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: 'summary' } as any)
    const state = createLoopState()
    state.messages = padMessages(KEEP_RECENT + 4)
    state.lastInputTokens = 999_999

    await checkAndCompressContext(state, fakeModel, 1, makeCallbacks())

    expect(state.lastInputTokens).toBe(0)
    expect(state.expectCacheMiss).toBe(true)
  })
})

// ── handleContextTooLong（被动压缩） ──

describe('handleContextTooLong', () => {
  beforeEach(() => vi.clearAllMocks())

  it('消息过少时返回 false', async () => {
    const state = createLoopState()
    state.messages = [{ role: 'user', content: 'hi' }]
    const result = await handleContextTooLong(state, fakeModel, makeCallbacks())
    expect(result).toBe(false)
  })

  it('会发出进度，并生成带 token 统计的压缩提示', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: 'compressed' } as any)
    const state = createLoopState()
    state.messages = padMessages(KEEP_RECENT + 4)

    const cb = makeCallbacks()
    const result = await handleContextTooLong(state, fakeModel, cb)

    expect(result).toBe(true)
    expect(cb.onCompressionProgress).toHaveBeenCalledWith('正在总结对话……')

    const compressedMsg = vi.mocked(cb.onContextCompressed).mock.calls[0][0]
    expect(compressedMsg).toMatch(/上下文过长，已压缩（约 \d+k → \d+k tokens）。正在重试……/)
  })

  it('会重置 lastInputTokens，并设置 expectCacheMiss', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: 'compressed' } as any)
    const state = createLoopState()
    state.messages = padMessages(KEEP_RECENT + 4)

    await handleContextTooLong(state, fakeModel, makeCallbacks())

    expect(state.lastInputTokens).toBe(0)
    expect(state.expectCacheMiss).toBe(true)
  })
})
