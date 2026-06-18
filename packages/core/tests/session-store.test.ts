// 每会话 JSONL transcript 存储测试。
//
// 这个模块是 resume 功能的事实来源：
// CLI 启动参数（`-c`、`-r`）以及应用内的 `/resume` 命令
// 都通过 `loadSession` 恢复状态，而每一轮 assistant 输出
// 则会通过 `flushPendingMessages` / `appendUsage` 追加到会话文件。
// 这里最关心的几个不变量如下：
//
//   1. 往返一致：写入 header + N 条消息 + usage 后重新加载，
//      messages 与 tokenUsage 必须完全一致。
//   2. 边界行为：每个 `compact-boundary` 都必须清空加载时的累计器，
//      让最终视图只反映最后一个 boundary 之后的内容。
//   3. 清洗逻辑：结尾处如果存在没有配套 tool_result 的 assistant
//      tool_call，就必须裁掉，避免下一次 API 请求看到孤儿调用。
//   4. 中日韩回退：当 taskSlug 为空时，要回退成仅时间戳命名的文件名，
//      行为与 plan 文件保持一致。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mkdtempSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createLoopState } from '../src/agent/loop-state.js'
import {
  appendHeader,
  appendUsage,
  flushPendingMessages,
  getSessionFilePath,
  hydrateLoopState,
  listSessions,
  loadSession,
  markBoundaryAndReflush,
  pickLatestSession,
} from '../src/agent/session-store.js'

let tempDir: string
let originalCwd: string

beforeEach(() => {
  // 每个测试都切到一个干净的临时 cwd，避免 jsonl 写入污染开发者真实仓库。
  // （`.x-code/sessions/` 以 process.cwd() 为根。）
  tempDir = mkdtempSync(join(tmpdir(), 'xc-session-store-'))
  originalCwd = process.cwd()
  process.chdir(tempDir)
})

afterEach(() => {
  process.chdir(originalCwd)
  rmSync(tempDir, { recursive: true, force: true })
})

describe('session-store: filename derivation', () => {
  it('当 slug 非空时，会使用 slug-id 作为文件名', () => {
    const state = { sessionId: '20260101-120000-000', taskSlug: 'fix-login' }
    const p = getSessionFilePath(state, tempDir)
    expect(p.endsWith('fix-login-20260101-120000-000.jsonl')).toBe(true)
  })

  it('当 slug 为空时，会回退为仅使用 id（适配中日韩首条消息）', () => {
    const state = { sessionId: '20260101-120000-000', taskSlug: '' }
    const p = getSessionFilePath(state, tempDir)
    expect(p.endsWith('20260101-120000-000.jsonl')).toBe(true)
  })
})

describe('session-store: round-trip', () => {
  it('可以持久化并重新加载一个简单对话', async () => {
    const state = createLoopState()
    state.sessionId = '20260101-120000-000'
    state.taskSlug = 'fix-login'
    state.messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ]

    await appendHeader(state, 'anthropic:claude-sonnet-4-6', 'Hello')
    await flushPendingMessages(state)
    state.tokenUsage.inputTokens = 100
    state.tokenUsage.outputTokens = 20
    state.tokenUsage.totalTokens = 120
    await appendUsage(state, 'anthropic:claude-sonnet-4-6')

    const filePath = getSessionFilePath(state)
    const loaded = await loadSession(filePath)
    expect(loaded).not.toBeNull()
    expect(loaded!.sessionId).toBe('20260101-120000-000')
    expect(loaded!.taskSlug).toBe('fix-login')
    expect(loaded!.firstPrompt).toBe('Hello')
    expect(loaded!.messages).toHaveLength(2)
    expect(loaded!.messages[0]).toEqual({ role: 'user', content: 'Hello' })
    expect(loaded!.messages[1]).toEqual({ role: 'assistant', content: 'Hi there' })
    expect(loaded!.tokenUsage.inputTokens).toBe(100)
    expect(loaded!.tokenUsage.totalTokens).toBe(120)
  })

  it('persistedMessageCount 会在多次 flush 后保持同步', async () => {
    const state = createLoopState()
    state.sessionId = '20260101-120000-000'
    state.taskSlug = 'multi-flush'

    state.messages.push({ role: 'user', content: 'msg 1' })
    await appendHeader(state, 'anthropic:claude-sonnet-4-6', 'msg 1')
    await flushPendingMessages(state)
    expect(state.persistedMessageCount).toBe(1)

    state.messages.push({ role: 'assistant', content: 'reply 1' })
    state.messages.push({ role: 'user', content: 'msg 2' })
    await flushPendingMessages(state)
    expect(state.persistedMessageCount).toBe(3)

    // 幂等性校验：没有新消息时再次 flush 应该是无操作。
    await flushPendingMessages(state)
    expect(state.persistedMessageCount).toBe(3)

    const loaded = await loadSession(getSessionFilePath(state))
    expect(loaded!.messages).toHaveLength(3)
  })
})

describe('session-store: compact boundary', () => {
  it('加载时会丢弃 boundary 之前的全部内容', async () => {
    const state = createLoopState()
    state.sessionId = '20260101-120000-000'
    state.taskSlug = 'compaction'

    // 压缩前：先正常持久化 4 条消息。
    state.messages = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
    ]
    await appendHeader(state, 'anthropic:claude-sonnet-4-6', 'q1')
    await flushPendingMessages(state)
    expect(state.persistedMessageCount).toBe(4)

    // 压缩后，内存中的消息数组会变短。markBoundaryAndReflush
    // 会写入一条 boundary 记录以及裁剪后的消息，并把计数器重置为新长度，
    // 这样后续 flush 才能基于 boundary 之后的状态做 diff。
    state.messages = [
      { role: 'user', content: '[Previous summary]\nDiscussed q1 and q2' },
      { role: 'assistant', content: 'a2' },
    ]
    await markBoundaryAndReflush(state, 'Discussed q1 and q2')
    expect(state.persistedMessageCount).toBe(2)

    const loaded = await loadSession(getSessionFilePath(state))
    expect(loaded!.messages).toHaveLength(2)
    expect(loaded!.messages[0]).toMatchObject({ role: 'user' })
    expect(loaded!.messages[0].content).toContain('[Previous summary]')
  })

  it('真正决定加载结果的只有最后一个 boundary（多 boundary 场景）', async () => {
    const state = createLoopState()
    state.sessionId = '20260101-120000-000'
    state.taskSlug = 'multi-boundary'

    state.messages = [{ role: 'user', content: 'q1' }]
    await appendHeader(state, 'anthropic:claude-sonnet-4-6', 'q1')
    await flushPendingMessages(state)

    // 第一个 boundary
    state.messages = [{ role: 'user', content: 'after-first-boundary' }]
    await markBoundaryAndReflush(state, 'first summary')

    // 继续追加内容，然后再写入第二个 boundary
    state.messages.push({ role: 'assistant', content: 'mid' })
    await flushPendingMessages(state)

    state.messages = [{ role: 'user', content: 'after-second-boundary' }]
    await markBoundaryAndReflush(state, 'second summary')

    const loaded = await loadSession(getSessionFilePath(state))
    expect(loaded!.messages).toHaveLength(1)
    expect(loaded!.messages[0]).toEqual({ role: 'user', content: 'after-second-boundary' })
  })
})

describe('session-store: orphan tool-call sanitisation', () => {
  it('会裁掉结尾没有配对 tool_result 的 assistant tool_call', async () => {
    const state = createLoopState()
    state.sessionId = '20260101-120000-000'
    state.taskSlug = 'orphan-tail'

    // 已解决的 tool-call（后面跟着匹配的 tool result）必须保留；
    // 而最后那个孤儿 tool_call 必须被裁掉。
    state.messages = [
      { role: 'user', content: 'work on something' },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'tc-resolved', toolName: 'shell', input: { command: 'ls' } }],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'tc-resolved', toolName: 'shell', output: { type: 'text', value: 'ok' } },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'tc-orphan', toolName: 'shell', input: { command: 'failed' } }],
      },
    ] as never[]
    await appendHeader(state, 'anthropic:claude-sonnet-4-6', 'work on something')
    await flushPendingMessages(state)

    const loaded = await loadSession(getSessionFilePath(state))
    // 索引 3 处的孤儿 tool_call assistant 消息应被丢弃。
    expect(loaded!.messages).toHaveLength(3)
    const lastAssistant = loaded!.messages[1]
    expect(lastAssistant.role).toBe('assistant')
  })

  it('会完整保留已完全解析的 assistant tool_call', async () => {
    const state = createLoopState()
    state.sessionId = '20260101-120000-000'
    state.taskSlug = 'clean-tail'

    state.messages = [
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'tc-1', toolName: 'shell', input: { command: 'ls' } }],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'tc-1', toolName: 'shell', output: { type: 'text', value: 'ok' } },
        ],
      },
    ] as never[]
    await appendHeader(state, 'anthropic:claude-sonnet-4-6', 'do it')
    await flushPendingMessages(state)

    const loaded = await loadSession(getSessionFilePath(state))
    expect(loaded!.messages).toHaveLength(3)
  })
})

describe('session-store: malformed input', () => {
  it('文件不存在时返回 null', async () => {
    const result = await loadSession(join(tempDir, 'nonexistent.jsonl'))
    expect(result).toBeNull()
  })

  it('文件中没有可解析的 header 时返回 null', async () => {
    const sessionsDir = join(tempDir, '.x-code', 'sessions')
    const filePath = join(sessionsDir, 'orphan.jsonl')
    await writeFile(filePath, '{"t":"msg","message":{"role":"user","content":"x"},"ts":"now"}\n', { flag: 'wx' }).catch(
      async () => {
        // 目录可能还不存在，这里通过一次 appendHeader 探针调用来创建它。
        const state = createLoopState()
        state.sessionId = 'probe'
        state.taskSlug = 'probe'
        await appendHeader(state, 'm', 'p')
        await writeFile(filePath, '{"t":"msg","message":{"role":"user","content":"x"},"ts":"now"}\n')
      },
    )
    const result = await loadSession(filePath)
    expect(result).toBeNull()
  })

  it('会静默跳过格式损坏的行', async () => {
    const state = createLoopState()
    state.sessionId = '20260101-120000-000'
    state.taskSlug = 'mixed-junk'
    state.messages = [{ role: 'user', content: 'real' }]
    await appendHeader(state, 'anthropic:claude-sonnet-4-6', 'real')
    await flushPendingMessages(state)
    // 追加一行损坏数据。
    const fp = getSessionFilePath(state)
    await writeFile(fp, '{not json\n', { flag: 'a' })
    state.messages.push({ role: 'assistant', content: 'reply' })
    await flushPendingMessages(state)

    const loaded = await loadSession(fp)
    expect(loaded!.messages).toHaveLength(2)
  })
})

describe('session-store: listSessions / pickLatestSession', () => {
  it('当不存在 sessions 目录时返回空结果', async () => {
    expect(await listSessions(tempDir)).toEqual([])
    expect(await pickLatestSession(tempDir)).toBeNull()
  })

  it('会按从新到旧列出 sessions', async () => {
    // 创建两个 slug 不同的 session，并在中间加入一点延迟，
    // 让 mtime 排序结果稳定可预测。
    const s1 = createLoopState()
    s1.sessionId = '20260101-120000-000'
    s1.taskSlug = 'older'
    s1.messages = [{ role: 'user', content: 'old prompt' }]
    await appendHeader(s1, 'm1', 'old prompt')
    await flushPendingMessages(s1)

    await new Promise((r) => setTimeout(r, 20))

    const s2 = createLoopState()
    s2.sessionId = '20260101-120001-000'
    s2.taskSlug = 'newer'
    s2.messages = [{ role: 'user', content: 'new prompt' }]
    await appendHeader(s2, 'm2', 'new prompt')
    await flushPendingMessages(s2)

    const list = await listSessions()
    expect(list).toHaveLength(2)
    expect(list[0].taskSlug).toBe('newer')
    expect(list[1].taskSlug).toBe('older')

    const latest = await pickLatestSession()
    expect(latest!.taskSlug).toBe('newer')
  })
})

describe('session-store: hydrateLoopState', () => {
  it('会生成一个可供 agentLoop 继续运行的 LoopState', async () => {
    const s = createLoopState()
    s.sessionId = '20260101-120000-000'
    s.taskSlug = 'continue'
    s.messages = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ]
    s.tokenUsage = {
      inputTokens: 50,
      outputTokens: 5,
      totalTokens: 55,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      currentContextTokens: 55,
    }
    await appendHeader(s, 'anthropic:claude-sonnet-4-6', 'q')
    await flushPendingMessages(s)
    await appendUsage(s, 'anthropic:claude-sonnet-4-6')

    const loaded = await loadSession(getSessionFilePath(s))
    const hydrated = hydrateLoopState(loaded!)
    expect(hydrated.sessionId).toBe('20260101-120000-000')
    expect(hydrated.taskSlug).toBe('continue')
    expect(hydrated.messages).toHaveLength(2)
    expect(hydrated.tokenUsage.inputTokens).toBe(50)
    expect(hydrated.persistedMessageCount).toBe(2)
  })
})
