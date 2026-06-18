// agent/tool-result-sanitize.ts 的测试
import { describe, expect, it } from 'vitest'

import type { ModelMessage } from 'ai'

import { repairOrphanToolCalls, truncateToolResultsInMessages } from '../src/agent/tool-result-sanitize.js'

// 构造一条 assistant 的 tool-call 消息，方便复用在多个场景断言中。
function assistantToolCallMsg(toolCallId: string, toolName: string): ModelMessage {
  return {
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId, toolName, input: {} }],
  } as ModelMessage
}

// 构造一条标准的 tool-result 消息，用于模拟工具执行后的返回。
function toolResultMsg(toolCallId: string, toolName: string, value: string): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId,
        toolName,
        output: { type: 'text', value },
      },
    ],
  } as ModelMessage
}

// 构造单个 tool-result 的简化工具消息，适合做截断类测试。
function toolMsg(toolName: string, value: string): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'tc',
        toolName,
        output: { type: 'text', value },
      },
    ],
  } as ModelMessage
}

describe('truncateToolResultsInMessages', () => {
  it('会原地截断超大的 readFile 结果', () => {
    const huge = '行内容\n'.repeat(5000) // 5000 行，超过默认的 2000 行上限
    const messages: ModelMessage[] = [toolMsg('readFile', huge)]
    truncateToolResultsInMessages(messages)
    const after = (messages[0].content as unknown as Array<{ output: { value: string } }>)[0].output.value
    expect(after.length).toBeLessThan(huge.length)
    expect(after).toMatch(/truncated/)
  })

  it('对 grep 应用仅保留前部的截断策略', () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `匹配-${i}: 一些内容`).join('\n')
    const messages: ModelMessage[] = [toolMsg('grep', lines)]
    truncateToolResultsInMessages(messages)
    const after = (messages[0].content as unknown as Array<{ output: { value: string } }>)[0].output.value
    // grep 的策略是只保留前部，因此末尾内容不应被保留。
    expect(after).toContain('匹配-0')
    expect(after).not.toContain('匹配-1999')
  })

  it('不会改动非工具消息', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'x'.repeat(100000) } as ModelMessage,
      toolMsg('readFile', '短内容'),
    ]
    truncateToolResultsInMessages(messages)
    expect((messages[0].content as string).length).toBe(100000)
  })

  it('能处理 content 类型输出中带 text 条目的数组', () => {
    const huge = 'x'.repeat(100000)
    const messages: ModelMessage[] = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tc',
            toolName: 'readFile',
            output: {
              type: 'content',
              value: [{ type: 'text', text: huge }],
            },
          },
        ],
      } as ModelMessage,
    ]
    truncateToolResultsInMessages(messages)
    const entry = (messages[0].content as unknown as Array<{ output: { value: Array<{ text: string }> } }>)[0].output
      .value[0]
    expect(entry.text.length).toBeLessThan(huge.length)
  })
})

describe('repairOrphanToolCalls', () => {
  it('会为没有结果的 assistant tool_call 追加一条合成错误结果', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: '你好' } as ModelMessage,
      assistantToolCallMsg('tc1', 'todoWrite'),
    ]
    repairOrphanToolCalls(messages)
    expect(messages).toHaveLength(3)
    const synth = messages[2]
    expect(synth.role).toBe('tool')
    const part = (synth.content as unknown as Array<{ toolCallId: string; output: { value: string } }>)[0]
    expect(part.toolCallId).toBe('tc1')
    expect(part.output.value).toMatch(/Tool input failed validation/)
  })

  it('会丢弃 toolCallId 从未出现在 assistant 消息中的 tool_result', () => {
    // SDK 拒绝了模型生成的非法工具输入，因此 response.messages 里没有 tool_call，
    // 但 processToolCalls 仍执行了工具并推入了 tool_result。
    // 这种孤儿结果不能带进下一次 API 请求体。
    const messages: ModelMessage[] = [
      { role: 'user', content: '你好' } as ModelMessage,
      { role: 'assistant', content: '普通回复，没有工具调用' } as ModelMessage,
      toolResultMsg('orphan-id', 'todoWrite', '待办列表已更新。'),
    ]
    repairOrphanToolCalls(messages)
    expect(messages).toHaveLength(2)
    expect(messages[1].role).toBe('assistant')
  })

  it('会保留已匹配的 tool_result，只移除同一消息中的孤儿部分', () => {
    // 混合 tool 消息：同一个 tool 消息里既有合法结果，也有孤儿结果。
    // 这里只应过滤孤儿部分，合法结果和外围消息结构都必须保留下来。
    const messages: ModelMessage[] = [
      assistantToolCallMsg('tc-valid', 'readFile'),
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tc-valid',
            toolName: 'readFile',
            output: { type: 'text', value: '文件内容' },
          },
          {
            type: 'tool-result',
            toolCallId: 'tc-orphan',
            toolName: 'todoWrite',
            output: { type: 'text', value: '孤儿结果' },
          },
        ],
      } as ModelMessage,
    ]
    repairOrphanToolCalls(messages)
    expect(messages).toHaveLength(2)
    const parts = messages[1].content as unknown as Array<{ toolCallId: string }>
    expect(parts).toHaveLength(1)
    expect(parts[0].toolCallId).toBe('tc-valid')
  })

  it('具有幂等性，连续运行两次结果一致', () => {
    const messages: ModelMessage[] = [
      assistantToolCallMsg('tc1', 'todoWrite'),
      toolResultMsg('orphan', 'shell', '孤儿结果'),
    ]
    repairOrphanToolCalls(messages)
    const first = messages.length
    repairOrphanToolCalls(messages)
    expect(messages.length).toBe(first)
    // tc1 的前向孤儿合成结果仍必须存在。
    const ids = messages
      .flatMap((m) => (Array.isArray(m.content) ? (m.content as unknown as Array<{ toolCallId?: string }>) : []))
      .map((p) => p.toolCallId)
      .filter(Boolean)
    expect(ids).toContain('tc1')
    expect(ids).not.toContain('orphan')
  })

  it('对完全合法的消息序列保持不变', () => {
    const messages: ModelMessage[] = [
      assistantToolCallMsg('tc1', 'readFile'),
      toolResultMsg('tc1', 'readFile', '文件正文'),
      assistantToolCallMsg('tc2', 'shell'),
      toolResultMsg('tc2', 'shell', '命令输出'),
    ]
    const before = JSON.stringify(messages)
    repairOrphanToolCalls(messages)
    expect(JSON.stringify(messages)).toBe(before)
  })

  // 问题 1：如果一个只包含孤儿结果的 tool 消息夹在两个 assistant 之间，
  // 绝不能直接 splice 掉，否则会形成 assistant→assistant，相当于触发
  // Anthropic 的 400："messages: roles must alternate"。这里应改成 user 文本占位。
  it('当孤儿 tool 消息夹在两个 assistant 之间时，会替换成 user 占位消息', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: '你好' } as ModelMessage,
      { role: 'assistant', content: [{ type: 'text', text: '正在处理' }] } as ModelMessage,
      toolResultMsg('orphan_1', 'shell', 'stale'),
      { role: 'assistant', content: [{ type: 'text', text: '继续处理' }] } as ModelMessage,
    ]
    repairOrphanToolCalls(messages)
    expect(messages).toHaveLength(4)
    expect(messages[2].role).toBe('user')
    const blocks = messages[2].content as Array<{ type: string; text?: string }>
    expect(blocks[0]?.type).toBe('text')
    expect(blocks[0]?.text).toMatch(/stale tool result/i)
    for (let i = 1; i < messages.length; i++) {
      expect(messages[i].role).not.toBe(messages[i - 1].role)
    }
  })

  // 问题 1 的边界条件：只要相邻两侧不同时是 assistant，直接删除孤儿 tool
  // 消息仍然是正确的，因为 splice 后不会制造 assistant→assistant 的相邻冲突。
  it('当相邻两侧不同时是 assistant 时，仍会直接删除孤儿 tool 消息', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: '你好' } as ModelMessage,
      { role: 'assistant', content: [{ type: 'text', text: '普通回复' }] } as ModelMessage,
      toolResultMsg('orphan_x', 'shell', 'stale'),
    ]
    repairOrphanToolCalls(messages)
    expect(messages).toHaveLength(2)
    expect(messages[1].role).toBe('assistant')
  })

  // 问题 2：多个前向孤儿 tool_call 必须折叠成一个尾部 tool 消息，
  // 不能变成 N 个相邻的 tool 消息。Anthropic SDK 目前碰巧会合并同角色相邻消息，
  // 但 Google 转换器不会，因此输出一个 tool 消息才是跨 provider 的安全形状。
  it('会把多个前向孤儿合成结果折叠为一个 tool 消息', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: '做两件事' } as ModelMessage,
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'tc_a', toolName: 'shell', input: {} },
          { type: 'tool-call', toolCallId: 'tc_b', toolName: 'shell', input: {} },
        ],
      } as ModelMessage,
    ]
    repairOrphanToolCalls(messages)
    const last = messages[messages.length - 1]
    expect(last.role).toBe('tool')
    const parts = last.content as unknown as Array<{ toolCallId: string }>
    expect(parts).toHaveLength(2)
    const ids = parts.map((p) => p.toolCallId).sort()
    expect(ids).toEqual(['tc_a', 'tc_b'])
    for (let i = 1; i < messages.length; i++) {
      expect(messages[i].role).not.toBe(messages[i - 1].role)
    }
  })

  // 问题 2 的防御性补强：如果尾部本来已经有 tool 消息
  // （例如 processToolCalls 在同一轮里已经为部分 tool_call 推入了真实结果），
  // 那么孤儿合成结果应该并入这个尾部消息，而不是再生成一个相邻的 tool 消息。
  it('会把合成结果合并进现有的尾部 tool 消息', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: '你好' } as ModelMessage,
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'tc_done', toolName: 'shell', input: {} },
          { type: 'tool-call', toolCallId: 'tc_orphan', toolName: 'shell', input: {} },
        ],
      } as ModelMessage,
      toolResultMsg('tc_done', 'shell', '完成'),
    ]
    repairOrphanToolCalls(messages)
    expect(messages).toHaveLength(3)
    const last = messages[messages.length - 1]
    expect(last.role).toBe('tool')
    const parts = last.content as unknown as Array<{ toolCallId: string }>
    const ids = parts.map((p) => p.toolCallId).sort()
    expect(ids).toEqual(['tc_done', 'tc_orphan'])
    for (let i = 1; i < messages.length; i++) {
      expect(messages[i].role).not.toBe(messages[i - 1].role)
    }
  })
})
