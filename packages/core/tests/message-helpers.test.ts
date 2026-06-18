import { describe, expect, it } from 'vitest'

import { extractText } from '../src/utils/message-helpers.js'

describe('extractText', () => {
  it('字符串内容会原样返回', () => {
    expect(extractText('你好，世界')).toBe('你好，世界')
  })

  it('会从带类型的片段数组中提取文本', () => {
    const content = [
      { type: 'text', text: '你好，' },
      { type: 'text', text: '世界' },
    ]
    expect(extractText(content)).toBe('你好，世界')
  })

  it('会过滤掉非文本片段', () => {
    const content = [
      { type: 'text', text: '可见' },
      { type: 'image', image: 'data:...' },
      { type: 'tool-call', toolCallId: '1', toolName: 'readFile' },
      { type: 'text', text: ' 文本' },
    ]
    expect(extractText(content as any)).toBe('可见 文本')
  })
})
