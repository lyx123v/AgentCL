// agent/light-compact.ts 的测试
import { describe, expect, it } from 'vitest'

import type { ModelMessage } from 'ai'

import { lightCompactMessages } from '../src/agent/light-compact.js'

// 构造工具结果消息，便于覆盖压缩逻辑。
function toolResultMsg(toolCallId: string, text: string): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId,
        toolName: 'shell',
        output: { type: 'text', value: text },
      },
    ],
  } as ModelMessage
}

// 构造带有工具调用的 assistant 消息。
function assistantWithToolCall(toolCallId: string): ModelMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text: '调用 shell' },
      { type: 'tool-call', toolCallId, toolName: 'shell', input: { command: 'ls' } },
    ],
  } as unknown as ModelMessage
}

describe('lightCompactMessages', () => {
  it('没有 loop-guard 提示时保持原样返回', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '收到' },
      toolResultMsg('tc1', '执行成功输出'),
    ]
    const out = lightCompactMessages(messages)
    expect(out.dropped).toBe(0)
    expect(out.messages).toBe(messages)
  })

  it('会移除以 [loop-guard] 开头的工具结果', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: '你好' },
      assistantWithToolCall('tc1'),
      toolResultMsg('tc1', '[loop-guard] 停止重试'),
    ]
    const out = lightCompactMessages(messages)
    expect(out.dropped).toBeGreaterThan(0)
    // 工具结果消息应该被删除。
    const hasToolResult = out.messages.some((m) => m.role === 'tool')
    expect(hasToolResult).toBe(false)
  })

  it('也会从前一条 assistant 消息中移除匹配的 tool-call 片段', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: '你好' },
      assistantWithToolCall('tc1'),
      toolResultMsg('tc1', '[loop-guard] 已阻止'),
    ]
    const out = lightCompactMessages(messages)
    const assistantMsg = out.messages.find((m) => m.role === 'assistant')
    if (assistantMsg && Array.isArray(assistantMsg.content)) {
      const parts = assistantMsg.content as Array<{ type?: string }>
      const hasToolCall = parts.some((p) => p.type === 'tool-call')
      expect(hasToolCall).toBe(false)
    }
  })

  it('如果 assistant 消息只剩被移除的 tool-call，则整条消息也会被删除', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: '你好' },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'tc1', toolName: 'shell', input: { command: 'ls' } }],
      } as unknown as ModelMessage,
      toolResultMsg('tc1', '[loop-guard] 已阻止'),
    ]
    const out = lightCompactMessages(messages)
    const hasAssistant = out.messages.some((m) => m.role === 'assistant')
    expect(hasAssistant).toBe(false)
  })

  it('会保留无关的工具结果', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: '你好' },
      assistantWithToolCall('good'),
      toolResultMsg('good', '成功工具调用的真实输出'),
      assistantWithToolCall('bad'),
      toolResultMsg('bad', '[loop-guard] 阻止重试'),
    ]
    const out = lightCompactMessages(messages)
    // `good` 的工具结果必须仍然存在。
    const survivors = out.messages.filter((m) => m.role === 'tool')
    expect(survivors).toHaveLength(1)
    const survivor = survivors[0].content as Array<{ toolCallId?: string }>
    expect(survivor[0].toolCallId).toBe('good')
  })

  it('不会修改输入数组', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: '你好' },
      assistantWithToolCall('tc1'),
      toolResultMsg('tc1', '[loop-guard] 已阻止'),
    ]
    const before = messages.length
    lightCompactMessages(messages)
    expect(messages.length).toBe(before)
  })
})
