// processToolCalls 测试：跳过幽灵调用路径
import { describe, expect, it, vi } from 'vitest'

import type { ModelMessage } from 'ai'

import { createLoopState } from '../src/agent/loop-state.js'
import { partitionToolCalls, processToolCalls } from '../src/agent/tool-execution.js'
import type { AgentCallbacks, AgentOptions, LanguageModel } from '../src/types/index.js'

// 构造默认回调，按需覆盖当前测试关心的钩子。
function makeCallbacks(overrides: Partial<AgentCallbacks> = {}): AgentCallbacks {
  return {
    onTextDelta: vi.fn(),
    onToolCall: vi.fn(),
    onToolProgress: vi.fn(),
    onToolResult: vi.fn(),
    onAskPermission: vi.fn().mockResolvedValue('yes'),
    onAskUser: vi.fn().mockResolvedValue('answer'),
    onPlanApprovalRequest: vi.fn().mockResolvedValue(true),
    onPlanModeChange: vi.fn(),
    onTodosUpdate: vi.fn(),
    onShellOutput: vi.fn(),
    onUsageUpdate: vi.fn(),
    onContextCompressed: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  }
}

const options: AgentOptions = {
  modelId: 'test:model',
  trustMode: false,
  maxTurns: 10,
  printMode: false,
}

const stubModel = {} as LanguageModel

// 生成一个带有 askUser 工具调用的 assistant 消息，便于测试当前轮工具执行逻辑。
function assistantWithToolCalls(ids: string[]): ModelMessage {
  return {
    role: 'assistant',
    content: ids.map((toolCallId) => ({
      type: 'tool-call',
      toolCallId,
      toolName: 'askUser',
      input: {
        question: 'q',
        options: [
          { label: 'a', description: 'a' },
          { label: 'b', description: 'b' },
        ],
      },
    })),
  } as ModelMessage
}

describe('processToolCalls ghost-call skip', () => {
  it('当 assistant 消息中包含全部 id 时，会执行所有工具', async () => {
    const state = createLoopState()
    state.messages.push({ role: 'user', content: 'hi' } as ModelMessage, assistantWithToolCalls(['tc-A', 'tc-B']))
    const onAskUser = vi.fn().mockResolvedValue('a')
    const callbacks = makeCallbacks({ onAskUser })
    await processToolCalls(
      [
        {
          toolName: 'askUser',
          toolCallId: 'tc-A',
          input: {
            question: 'q',
            options: [
              { label: 'a', description: 'a' },
              { label: 'b', description: 'b' },
            ],
          },
        },
        {
          toolName: 'askUser',
          toolCallId: 'tc-B',
          input: {
            question: 'q',
            options: [
              { label: 'a', description: 'a' },
              { label: 'b', description: 'b' },
            ],
          },
        },
      ],
      state,
      options,
      callbacks,
      stubModel,
    )
    expect(onAskUser).toHaveBeenCalledTimes(2)
  })

  it('会跳过 assistant 消息中不存在 id 的幽灵工具调用', async () => {
    // 这里模拟 deepseek 的 tool-error 路径：SDK 拒绝了某个 tool_call，
    // 因而它不会出现在 response.messages 中，但 result.toolCalls
    // 里仍然会暴露出来。我们绝不能执行这种幽灵调用，否则对 write/shell
    // 而言就会对一个模型从未真正提交的调用产生真实副作用。
    const state = createLoopState()
    state.messages.push({ role: 'user', content: 'hi' } as ModelMessage, assistantWithToolCalls(['tc-real']))
    const onAskUser = vi.fn().mockResolvedValue('a')
    const callbacks = makeCallbacks({ onAskUser })
    await processToolCalls(
      [
        {
          toolName: 'askUser',
          toolCallId: 'tc-real',
          input: {
            question: 'q',
            options: [
              { label: 'a', description: 'a' },
              { label: 'b', description: 'b' },
            ],
          },
        },
        {
          toolName: 'askUser',
          toolCallId: 'tc-ghost',
          input: {
            question: 'q',
            options: [
              { label: 'a', description: 'a' },
              { label: 'b', description: 'b' },
            ],
          },
        },
      ],
      state,
      options,
      callbacks,
      stubModel,
    )
    expect(onAskUser).toHaveBeenCalledTimes(1)
    // 幽灵调用不应生成 tool_result，因为 assistant 消息里根本没有
    // 与之对应的 tool_call 可供锚定。
    const ghostResult = state.messages.find(
      (m) =>
        m.role === 'tool' &&
        Array.isArray(m.content) &&
        (m.content as Array<{ toolCallId?: string }>).some((p) => p?.toolCallId === 'tc-ghost'),
    )
    expect(ghostResult).toBeUndefined()
  })

  it('当 assistant 消息完全没有 tool_calls 时，会回退为执行全部工具', async () => {
    // 边界情况：如果 `activeIds` 最终为空，我们就没有证据去区分
    // 幽灵调用和合法调用，因此保守做法是全部执行。
    // 另外还有反向 orphan 检查作为最后一道兜底。
    const state = createLoopState()
    state.messages.push(
      { role: 'user', content: 'hi' } as ModelMessage,
      { role: 'assistant', content: 'plain text reply' } as ModelMessage,
    )
    const onAskUser = vi.fn().mockResolvedValue('a')
    const callbacks = makeCallbacks({ onAskUser })
    await processToolCalls(
      [
        {
          toolName: 'askUser',
          toolCallId: 'tc-X',
          input: {
            question: 'q',
            options: [
              { label: 'a', description: 'a' },
              { label: 'b', description: 'b' },
            ],
          },
        },
      ],
      state,
      options,
      callbacks,
      stubModel,
    )
    expect(onAskUser).toHaveBeenCalledTimes(1)
  })

  it('只检查当前轮的 assistant 消息（遇到上一条 user 消息就停止）', async () => {
    // 来自旧轮次的 tool_call id 绝不能满足当前轮幽灵调用的 activeIds 检查。
    // 轮次边界由 user 消息界定，因此我们会从消息尾部向前走，
    // 第一次看到 role==='user' 就停止。没有这层停止条件的话，
    // 幽灵调用可能借用一个旧 id 混进来。
    const state = createLoopState()
    state.messages.push(
      { role: 'user', content: 'turn 1' } as ModelMessage,
      assistantWithToolCalls(['old-id']),
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'old-id', toolName: 'askUser', output: { type: 'text', value: 'r' } },
        ],
      } as ModelMessage,
      { role: 'user', content: 'turn 2' } as ModelMessage,
      assistantWithToolCalls(['new-id']),
    )
    const onAskUser = vi.fn().mockResolvedValue('a')
    const callbacks = makeCallbacks({ onAskUser })
    await processToolCalls(
      [
        {
          toolName: 'askUser',
          toolCallId: 'new-id',
          input: {
            question: 'q',
            options: [
              { label: 'a', description: 'a' },
              { label: 'b', description: 'b' },
            ],
          },
        },
        {
          toolName: 'askUser',
          toolCallId: 'old-id',
          input: {
            question: 'q',
            options: [
              { label: 'a', description: 'a' },
              { label: 'b', description: 'b' },
            ],
          },
        },
      ],
      state,
      options,
      callbacks,
      stubModel,
    )
    // new-id 应执行；old-id 属于上一轮，必须被视为幽灵调用。
    expect(onAskUser).toHaveBeenCalledTimes(1)
  })
})

// 构造带 shell 工具调用的 assistant 消息，便于测试工具结果对齐逻辑。
function shellAssistant(ids: string[]): ModelMessage {
  return {
    role: 'assistant',
    content: ids.map((toolCallId) => ({
      type: 'tool-call',
      toolCallId,
      toolName: 'shell',
      input: { command: 'echo hi' },
    })),
  } as ModelMessage
}

// 构造 tool 角色消息，模拟 SDK 已经产出的 tool-result。
function toolResult(
  toolCallId: string,
  toolName: string,
  value: string,
  type: 'text' | 'error-text' = 'text',
): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId,
        toolName,
        output: { type, value },
      },
    ],
  } as ModelMessage
}

describe('processToolCalls skip-fulfilled (SDK already produced a tool-result)', () => {
  it('当 SDK 已把 writeFile 判为不可用并给出结果时，会跳过再次执行', async () => {
    // 真实失败案例来自 a.log 中的 disk-info 子代理：
    // 通用代理的工具过滤器排除了 writeFile，但模型依然发出了
    // writeFile tool_call。SDK 随后自动为这个不可用工具生成了
    // `error-text` 类型的 tool-result。若没有 skip-fulfilled 检查，
    // 我们就会按名字继续派发 executeWriteTool（它本身不检查过滤器），
    // 从而真的创建文件，并再推一次重复的 tool-result，最终触发 DeepSeek 400。
    const state = createLoopState()
    state.messages.push(
      { role: 'user', content: 'hi' } as ModelMessage,
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tc-write',
            toolName: 'writeFile',
            input: { filePath: '/tmp/should-not-exist.txt', content: 'x' },
          },
        ],
      } as ModelMessage,
      toolResult('tc-write', 'writeFile', "Model tried to call unavailable tool 'writeFile'.", 'error-text'),
    )
    const askPermission = vi.fn().mockResolvedValue('yes')
    const callbacks = makeCallbacks({ onAskPermission: askPermission })
    await processToolCalls(
      [
        {
          toolName: 'writeFile',
          toolCallId: 'tc-write',
          input: { filePath: '/tmp/should-not-exist.txt', content: 'x' },
        },
      ],
      state,
      options,
      callbacks,
      stubModel,
    )
    // 不应弹权限确认，否则就意味着我们正准备真的执行该工具。
    expect(askPermission).not.toHaveBeenCalled()
    // 不应再追加第二个 tc-write 的 tool-result。
    const toolResults = state.messages.filter(
      (m) =>
        m.role === 'tool' &&
        Array.isArray(m.content) &&
        (m.content as Array<{ toolCallId?: string }>).some((p) => p?.toolCallId === 'tc-write'),
    )
    expect(toolResults).toHaveLength(1)
  })

  it('当 auto-executed 工具的结果已存在于 state.messages 时，会跳过再次执行', async () => {
    // readFile/grep/listDir 等工具会由 SDK 自动执行，
    // 在 processToolCalls 运行前，它们的结果已经进入 `response.messages`。
    // 这里若再次执行，要么只是空转（这些名字对 executeWriteOrShell 返回 null），
    // 要么更糟，会触发 loop-guard，而它曾经会在处理中途插入一条 user 消息。
    const state = createLoopState()
    state.messages.push(
      { role: 'user', content: 'hi' } as ModelMessage,
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tc-read',
            toolName: 'readFile',
            input: { filePath: '/x' },
          },
          {
            type: 'tool-call',
            toolCallId: 'tc-shell',
            toolName: 'shell',
            input: { command: 'echo manual' },
          },
        ],
      } as ModelMessage,
      toolResult('tc-read', 'readFile', '/x contents'),
    )
    const askPermission = vi.fn().mockResolvedValue('yes')
    const callbacks = makeCallbacks({ onAskPermission: askPermission })
    // shell 在测试里可能无法真实拉起（没有真正的 shell provider），
    // 我们只关心 processToolCalls 能继续走到它，同时不会二次执行 readFile。
    await processToolCalls(
      [
        { toolName: 'readFile', toolCallId: 'tc-read', input: { filePath: '/x' } },
        { toolName: 'shell', toolCallId: 'tc-shell', input: { command: 'echo manual' } },
      ],
      state,
      options,
      callbacks,
      stubModel,
    ).catch(() => {})
    // tc-read 只能存在一条 tool-result，也就是最初那条。
    const readResults = state.messages.filter(
      (m) =>
        m.role === 'tool' &&
        Array.isArray(m.content) &&
        (m.content as Array<{ toolCallId?: string }>).some((p) => p?.toolCallId === 'tc-read'),
    )
    expect(readResults).toHaveLength(1)
  })

  it('会把连续的 task tool-call 放进同一个并行批次执行', async () => {
    // partition + Promise.all 的意义就在这里：同一轮 assistant 发出的
    // 3 个 task tool-call 必须并发启动，而不是前一个做完再等下一个。
    // 这个测试里没有真实的 subAgentRegistry，因此 handleTask 会短路成
    // '[Sub-agent system not initialized]'，pushToolResult 也会立刻触发。
    // 我们通过记录 tool-result 的落地顺序来侧面验证：对并行批次来说，
    // 缺注册表这个分支是足够同步的，三个结果会在 processToolCalls 返回前全部打完。
    const state = createLoopState()
    const ids = ['tc-task-1', 'tc-task-2', 'tc-task-3']
    state.messages.push(
      { role: 'user', content: 'hi' } as ModelMessage,
      {
        role: 'assistant',
        content: ids.map((toolCallId) => ({
          type: 'tool-call',
          toolCallId,
          toolName: 'task',
          input: { description: 'd', subagent_type: 'general-purpose', prompt: 'p' },
        })),
      } as ModelMessage,
    )
    const seen: string[] = []
    const callbacks = makeCallbacks({
      onToolResult: (id) => {
        seen.push(id)
      },
    })
    await processToolCalls(
      ids.map((toolCallId) => ({
        toolName: 'task',
        toolCallId,
        input: { description: 'd', subagent_type: 'general-purpose', prompt: 'p' },
      })),
      state,
      options,
      callbacks,
      stubModel,
    )
    expect(seen).toHaveLength(3)
    expect(new Set(seen)).toEqual(new Set(ids))
  })

  it('会在所有 tool-result 之后再 flush 延迟消息，避免 assistant 与 tool-result 之间插入 user 消息', async () => {
    // 这里防的是一个很隐蔽的 bug：在 assistant.tool_calls 与之后的
    // tool-result 之间插入了 user 消息。DeepSeek 会因此 400，
    // 错误类似 “Messages with role 'tool' must be a response to a
    // preceding message with 'tool_calls'”。
    // 这里不直接测 deferred-flush 的内部实现，而是通过检查调用后的
    // 消息结构不变量来间接验证。
    const state = createLoopState()
    state.messages.push(
      { role: 'user', content: 'hi' } as ModelMessage,
      shellAssistant(['tc-1', 'tc-2']),
      toolResult('tc-1', 'shell', 'first result'), // already fulfilled by SDK
    )
    const callbacks = makeCallbacks()
    await processToolCalls(
      [
        { toolName: 'shell', toolCallId: 'tc-1', input: { command: 'echo hi' } },
        { toolName: 'shell', toolCallId: 'tc-2', input: { command: 'echo bye' } },
      ],
      state,
      options,
      callbacks,
      stubModel,
    ).catch(() => {})
    // 遍历消息数组：每一条 tool 角色消息之前，都必须能找到一条更早的
    // assistant tool_calls 消息，而且中间不能插入 user 消息。
    let lastAssistantWithToolCalls = -1
    let lastUserMessage = -1
    for (let i = 0; i < state.messages.length; i++) {
      const m = state.messages[i]!
      if (m.role === 'user') lastUserMessage = i
      if (m.role === 'assistant' && Array.isArray(m.content)) {
        const hasToolCall = (m.content as Array<{ type?: string }>).some((p) => p?.type === 'tool-call')
        if (hasToolCall) lastAssistantWithToolCalls = i
      }
      if (m.role === 'tool') {
        // 最近的一条 assistant.tool_calls 必须出现在最近的一条 user 消息之后。
        expect(lastAssistantWithToolCalls).toBeGreaterThan(lastUserMessage)
      }
    }
  })
})

describe('partitionToolCalls', () => {
  const tc = (toolName: string, toolCallId: string) => ({ toolName, toolCallId, input: {} })

  it('空列表不会产生任何批次', () => {
    expect(partitionToolCalls([])).toEqual([])
  })

  it('每个非 task 工具都会被放进独立的单元素批次', () => {
    const calls = [tc('shell', '1'), tc('writeFile', '2'), tc('edit', '3')]
    const batches = partitionToolCalls(calls)
    expect(batches.map((b) => b.length)).toEqual([1, 1, 1])
  })

  it('会把连续的 task tool-call 归为一个批次', () => {
    const calls = [tc('task', '1'), tc('task', '2'), tc('task', '3')]
    const batches = partitionToolCalls(calls)
    expect(batches).toHaveLength(1)
    expect(batches[0]!.map((c) => c.toolCallId)).toEqual(['1', '2', '3'])
  })

  it('当 task 之间插入非 task 工具时，会切断并行批次', () => {
    // [task, task, shell, task, task] →
    //   [[task, task], [shell], [task, task]]
    // shell 必须单独执行，并把前后批次串行化，
    // 因为 shell 会修改父级 UI 状态（stdout 流式输出）。
    const calls = [tc('task', '1'), tc('task', '2'), tc('shell', '3'), tc('task', '4'), tc('task', '5')]
    const batches = partitionToolCalls(calls)
    expect(batches.map((b) => b.map((c) => c.toolCallId))).toEqual([['1', '2'], ['3'], ['4', '5']])
  })

  it('单个 task 调用也会成为独立批次', () => {
    const batches = partitionToolCalls([tc('task', '1')])
    expect(batches).toEqual([[tc('task', '1')]])
  })

  it('会让尾部的 task 批次与前面的非 task 工作保持分离', () => {
    const calls = [tc('shell', '1'), tc('task', '2'), tc('task', '3')]
    const batches = partitionToolCalls(calls)
    expect(batches.map((b) => b.length)).toEqual([1, 2])
    expect(batches[1]!.map((c) => c.toolCallId)).toEqual(['2', '3'])
  })
})
