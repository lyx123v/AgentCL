// agent/messages.ts 辅助函数测试
import { describe, expect, it } from 'vitest'

import {
  isToolErrorString,
  toolErrorFromUnknown,
  toolErrorString,
  toolResultMessage,
  userMessage,
} from '../src/agent/messages.js'

describe('toolResultMessage', () => {
  it('构造带有一个 tool-result 内容块的 tool 角色消息', () => {
    const msg = toolResultMessage('tc_1', 'shell', 'done')
    expect(msg.role).toBe('tool')
    expect(Array.isArray(msg.content)).toBe(true)
    const parts = msg.content as Array<{
      type: string
      toolCallId: string
      toolName: string
      output: { type: string; value: string }
    }>
    expect(parts).toHaveLength(1)
    expect(parts[0]).toEqual({
      type: 'tool-result',
      toolCallId: 'tc_1',
      toolName: 'shell',
      output: { type: 'text', value: 'done' },
    })
  })
})

describe('userMessage', () => {
  it('可以包装字符串输入', () => {
    expect(userMessage('hi')).toEqual({ role: 'user', content: 'hi' })
  })

  it('会保留 parts 数组结构', () => {
    const parts = [{ type: 'text' as const, text: 'hi' }]
    expect(userMessage(parts)).toEqual({ role: 'user', content: parts })
  })
})

describe('toolErrorFromUnknown', () => {
  it('可以从 Error 实例中提取消息', () => {
    expect(toolErrorFromUnknown(new Error('disk full'))).toBe('Error: disk full')
  })

  it('会把非 Error 值转成字符串', () => {
    expect(toolErrorFromUnknown('plain string')).toBe('Error: plain string')
    expect(toolErrorFromUnknown(42)).toBe('Error: 42')
    expect(toolErrorFromUnknown(null)).toBe('Error: null')
    expect(toolErrorFromUnknown(undefined)).toBe('Error: undefined')
  })
})

describe('isToolErrorString', () => {
  it('可以识别 toolErrorString 生成的前缀', () => {
    expect(isToolErrorString(toolErrorString('x'))).toBe(true)
    expect(isToolErrorString('Error: anything')).toBe(true)
  })

  it('面对非错误字符串时返回 false', () => {
    expect(isToolErrorString('File written: foo.ts')).toBe(false)
    expect(isToolErrorString('')).toBe(false)
    expect(isToolErrorString('error: lower-case')).toBe(false)
  })
})
