// agent loop 测试，使用模拟的 LLM 响应。
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { streamText } from 'ai'

import { agentLoop } from '../src/agent/loop.js'
import type { AgentCallbacks, TokenUsage } from '../src/types/index.js'

// 模拟 cheerio + turndown（通过 toolRegistry → webFetch 间接引入）。
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

// 模拟 AI SDK。
vi.mock('ai', async () => {
  const actual = await vi.importActual('ai')
  return {
    ...actual,
    streamText: vi.fn(),
    generateText: vi.fn(),
  }
})

// 模拟 knowledge 模块，避免文件系统副作用。
vi.mock('../src/knowledge/loader.js', () => ({
  buildKnowledgeContext: vi.fn().mockResolvedValue(''),
}))

vi.mock('../src/knowledge/session.js', () => ({
  generateSessionSummary: vi.fn().mockResolvedValue({}),
}))

// 禁止 jsonl 持久化，确保测试不会在项目 `.x-code/sessions/` 下留下文件系统副作用，
// 否则这些产物会在多次运行之间泄漏，并污染开发者本地仓库。
vi.mock('../src/agent/session-store.js', () => ({
  appendHeader: vi.fn().mockResolvedValue(undefined),
  appendUsage: vi.fn().mockResolvedValue(undefined),
  appendInterrupted: vi.fn().mockResolvedValue(undefined),
  flushPendingMessages: vi.fn().mockResolvedValue(undefined),
  markBoundaryAndReflush: vi.fn().mockResolvedValue(undefined),
  getSessionFilePath: vi.fn().mockReturnValue(''),
  hydrateLoopState: vi.fn(),
  listSessions: vi.fn().mockResolvedValue([]),
  loadSession: vi.fn().mockResolvedValue(null),
  pickLatestSession: vi.fn().mockResolvedValue(null),
  shortIdFor: vi.fn().mockReturnValue(''),
}))

describe('agent loop', () => {
  let mockCallbacks: AgentCallbacks

  beforeEach(() => {
    vi.clearAllMocks()
    mockCallbacks = {
      onTextDelta: vi.fn(),
      onToolCall: vi.fn(),
      onToolProgress: vi.fn(),
      onToolResult: vi.fn(),
      onAskPermission: vi.fn().mockResolvedValue(true),
      onAskUser: vi.fn().mockResolvedValue('option1'),
      onShellOutput: vi.fn(),
      onUsageUpdate: vi.fn(),
      onContextCompressed: vi.fn(),
      onError: vi.fn(),
    }
  })

  it('会流式接收 LLM 文本并汇总用量', async () => {
    const mockChunks = [
      { type: 'text-delta', text: 'Hello' },
      { type: 'text-delta', text: ' world' },
    ]

    const mockAsyncIterable = {
      async *[Symbol.asyncIterator]() {
        for (const chunk of mockChunks) yield chunk
      },
    }

    vi.mocked(streamText).mockReturnValue({
      fullStream: mockAsyncIterable,
      response: Promise.resolve({ messages: [{ role: 'assistant', content: 'Hello world' }] }),
      usage: Promise.resolve({ inputTokens: 100, outputTokens: 20 }),
      finishReason: Promise.resolve('stop'),
      toolCalls: Promise.resolve([]),
    } as any)

    const { state, turnCount } = await agentLoop(
      'Say hello',
      {} as any,
      { modelId: 'anthropic:claude-sonnet-4-6', trustMode: false, maxTurns: 1, printMode: false },
      mockCallbacks,
    )

    expect(mockCallbacks.onTextDelta).toHaveBeenCalledWith('Hello')
    expect(mockCallbacks.onTextDelta).toHaveBeenCalledWith(' world')

    expect(mockCallbacks.onUsageUpdate).toHaveBeenCalled()
    const usageArg = vi.mocked(mockCallbacks.onUsageUpdate).mock.calls[0][0] as TokenUsage
    expect(usageArg.inputTokens).toBe(100)
    expect(usageArg.outputTokens).toBe(20)
    expect(usageArg.totalTokens).toBe(120)
    expect(usageArg.currentContextTokens).toBe(120)

    expect(turnCount).toBe(1)
    expect(state.messages.length).toBeGreaterThan(0)
  })

  it('finishReason 为 stop 时会结束（单轮）', async () => {
    vi.mocked(streamText).mockReturnValue({
      fullStream: {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text-delta', text: 'done' }
        },
      },
      response: Promise.resolve({ messages: [{ role: 'assistant', content: 'done' }] }),
      usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
      finishReason: Promise.resolve('stop'),
      toolCalls: Promise.resolve([]),
    } as any)

    const { turnCount } = await agentLoop(
      'Quick task',
      {} as any,
      { modelId: 'test:model', trustMode: false, maxTurns: 10, printMode: false },
      mockCallbacks,
    )

    expect(turnCount).toBe(1)
  })

  it('超过最大轮数时会上报错误', async () => {
    // 强制返回 tool-calls，让循环持续进行。
    vi.mocked(streamText).mockReturnValue({
      fullStream: {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text-delta', text: '' }
        },
      },
      response: Promise.resolve({ messages: [{ role: 'assistant', content: '' }] }),
      usage: Promise.resolve({ inputTokens: 5, outputTokens: 2 }),
      finishReason: Promise.resolve('tool-calls'),
      toolCalls: Promise.resolve([]),
    } as any)

    await agentLoop(
      'loop forever',
      {} as any,
      { modelId: 'test:model', trustMode: false, maxTurns: 2, printMode: false },
      mockCallbacks,
    )

    expect(mockCallbacks.onError).toHaveBeenCalled()
    const errArg = vi.mocked(mockCallbacks.onError).mock.calls[0][0]
    expect(errArg.message).toContain('maximum turns')
  })

  it('共享同一份 LoopState 的多次提交之间会重置轮数计数', async () => {
    // 回归说明：turnCount 过去挂在 LoopState 上，会在同一个 CLI 会话里的多次用户提交之间持续累加。
    // 当累计轮数接近 100 后，后续提交会立刻撞到上限。
    // 现在它改成单次调用内的局部计数，因此连续两次独立提交都应该各自得到 1。
    vi.mocked(streamText).mockReturnValue({
      fullStream: {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text-delta', text: 'ok' }
        },
      },
      response: Promise.resolve({ messages: [{ role: 'assistant', content: 'ok' }] }),
      usage: Promise.resolve({ inputTokens: 5, outputTokens: 1 }),
      finishReason: Promise.resolve('stop'),
      toolCalls: Promise.resolve([]),
    } as any)

    const opts = { modelId: 'test:model', trustMode: false, maxTurns: 1, printMode: false }
    const first = await agentLoop('msg 1', {} as any, opts, mockCallbacks)
    expect(first.turnCount).toBe(1)

    // 用同一份 LoopState 再次进入，模拟第二次用户提交。
    const second = await agentLoop('msg 2', {} as any, opts, mockCallbacks, first.state)
    expect(second.turnCount).toBe(1)
  })

  it('省略 maxTurns 时会在无上限模式下自然结束', async () => {
    // 这个修复也让 maxTurns 变成可选项。未设置时，循环应自然结束，
    // 而不是抛出 “Reached maximum turns” 错误。
    vi.mocked(streamText).mockReturnValue({
      fullStream: {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text-delta', text: 'done' }
        },
      },
      response: Promise.resolve({ messages: [{ role: 'assistant', content: 'done' }] }),
      usage: Promise.resolve({ inputTokens: 5, outputTokens: 1 }),
      finishReason: Promise.resolve('stop'),
      toolCalls: Promise.resolve([]),
    } as any)

    const { turnCount } = await agentLoop(
      'no cap',
      {} as any,
      { modelId: 'test:model', trustMode: false, printMode: false },
      mockCallbacks,
    )
    expect(turnCount).toBe(1)
    expect(mockCallbacks.onError).not.toHaveBeenCalled()
  })
})
