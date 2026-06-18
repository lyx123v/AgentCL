import { describe, expect, it } from 'vitest'

import { classifyApiError, extractHttpStatus, isContextTooLongError } from '../src/agent/api-errors.js'

describe('extractHttpStatus', () => {
  it('能从 "status code NNN" 中提取状态码', () => {
    expect(extractHttpStatus('Request failed with status code 429')).toBe(429)
  })
  it('能从 "(NNN)" 中提取状态码', () => {
    expect(extractHttpStatus('Error (401) Unauthorized')).toBe(401)
  })
  it('能从开头的 NNN 中提取状态码', () => {
    expect(extractHttpStatus('503 Service Unavailable')).toBe(503)
  })
})

describe('isContextTooLongError', () => {
  it('能识别 context_length_exceeded', () => {
    expect(isContextTooLongError(new Error('context_length_exceeded'))).toBe(true)
  })
  it('能识别 maximum context length', () => {
    expect(isContextTooLongError(new Error('maximum context length is 128000'))).toBe(true)
  })
  it('能识别 prompt is too long', () => {
    expect(isContextTooLongError(new Error('prompt is too long'))).toBe(true)
  })
  it('能识别 HTTP 413（permanentErrorFetch 会把上下文溢出重写为 413）', () => {
    expect(isContextTooLongError(new Error('Request failed with status code 413'))).toBe(true)
  })
})

describe('classifyApiError', () => {
  it('能分类上下文过长错误', () => {
    const result = classifyApiError(new Error('maximum context length exceeded'))
    expect(result.message).toContain('上下文过长')
    expect(result.retryable).toBe(false)
  })

  it('能分类缺失 API key 的错误', () => {
    const result = classifyApiError(new Error('Anthropic API key is missing'))
    expect(result.message).toContain('API key 尚未设置')
    expect(result.message).toContain('Anthropic')
    expect(result.retryable).toBe(false)
  })

  it('能分类 401 未授权错误', () => {
    const result = classifyApiError(new Error('Request failed with status code 401'))
    expect(result.message).toContain('认证失败')
    expect(result.retryable).toBe(false)
  })

  it('能分类 402 余额不足错误', () => {
    const result = classifyApiError(new Error('Insufficient Balance (402)'))
    expect(result.message).toContain('余额或额度不足')
    expect(result.retryable).toBe(false)
  })

  it('能分类 Moonshot 账户挂起的计费错误（HTTP 429 响应体）', () => {
    // 真实的 Moonshot 错误：HTTP 429，但响应体表示账户因余额不足被暂停。
    // 这里必须归类为计费问题，而不是限流问题，
    // 这样用户会被提示去充值或切换提供商，而不是误以为只要等待重试即可。
    const result = classifyApiError(
      new Error(
        'Your account org-xxx <ak-yyy> is suspended due to insufficient balance, please recharge your account (429)',
      ),
    )
    expect(result.message).toContain('余额或额度不足')
    expect(result.retryable).toBe(false)
  })

  it('能分类 403 禁止访问错误', () => {
    const result = classifyApiError(new Error('Request failed with status code 403'))
    expect(result.message).toContain('访问被拒绝')
    expect(result.retryable).toBe(false)
  })

  it('能通过状态码分类 404 模型不存在错误', () => {
    const result = classifyApiError(new Error('Request failed with status code 404'))
    expect(result.message).toContain('模型不存在')
    expect(result.retryable).toBe(false)
  })

  it('能通过响应体关键词分类 model_not_found 错误', () => {
    const result = classifyApiError(new Error('The model `kimi-k99` does not exist (500)'))
    expect(result.message).toContain('模型不存在')
    expect(result.retryable).toBe(false)
  })

  it('能通过状态码分类 422 内容策略错误', () => {
    const result = classifyApiError(new Error('Request failed with status code 422'))
    expect(result.message).toContain('安全过滤器')
    expect(result.retryable).toBe(false)
  })

  it('能通过响应体关键词分类 content_filter 错误', () => {
    const result = classifyApiError(new Error('content_filter_triggered: prompt rejected (500)'))
    expect(result.message).toContain('安全过滤器')
    expect(result.retryable).toBe(false)
  })

  it('能将 429 限流错误分类为可重试', () => {
    const result = classifyApiError(new Error('Request failed with status code 429'))
    expect(result.message).toContain('限流')
    expect(result.retryable).toBe(true)
  })

  it('能分类 503 服务不可用错误', () => {
    const result = classifyApiError(new Error('503 Service Unavailable'))
    expect(result.message).toContain('不可用')
    expect(result.retryable).toBe(false)
  })

  it('能将网络超时分类为可重试', () => {
    const result = classifyApiError(new Error('ETIMEDOUT'))
    expect(result.message).toContain('网络错误')
    expect(result.retryable).toBe(true)
  })

  it('能分类 max_tokens 错误', () => {
    const result = classifyApiError(new Error('Invalid max_tokens: 999999'))
    expect(result.message).toContain('max_tokens')
    expect(result.retryable).toBe(false)
  })

  it('能分类 DeepSeek 的 reasoning_content 错误', () => {
    const result = classifyApiError(new Error('Missing `reasoning_content` in assistant message'))
    expect(result.message).toContain('reasoning_content')
    expect(result.retryable).toBe(false)
  })

  it('能分类格式损坏的工具调用历史', () => {
    const result = classifyApiError(
      new Error("Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"),
    )
    expect(result.message).toContain('孤立的 tool call')
    expect(result.retryable).toBe(false)
  })

  it('未知错误会直接透传原始消息', () => {
    const result = classifyApiError(new Error('something completely new'))
    expect(result.message).toBe('something completely new')
    expect(result.retryable).toBe(false)
  })
})
