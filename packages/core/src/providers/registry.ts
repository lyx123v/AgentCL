// @x-code-cli/core — AI SDK 提供方注册表（多模型支持）
import { zhipu } from 'zhipu-ai-provider'

import { createAlibaba } from '@ai-sdk/alibaba'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createMoonshotAI } from '@ai-sdk/moonshotai'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createXai } from '@ai-sdk/xai'
import { createProviderRegistry } from 'ai'

import { getProviderOptions } from '../config/index.js'

/** 根据当前环境变量里的 provider 配置，构建 AI SDK 使用的模型注册表。
 *  只有实际配置了凭证或必要参数的提供方才会被注册进去。 */
export function createModelRegistry() {
  const opts = getProviderOptions()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const providers: Record<string, any> = {}

  if (opts.anthropic) providers.anthropic = createAnthropic({ fetch: permanentErrorFetch })
  if (opts.openai) providers.openai = createOpenAI({ fetch: permanentErrorFetch })
  if (opts.google) providers.google = createGoogleGenerativeAI({ fetch: permanentErrorFetch })
  if (opts.xai) providers.xai = createXai({ fetch: permanentErrorFetch })
  if (opts.deepseek) providers.deepseek = createDeepSeek({ fetch: deepseekReasoningFetch })
  if (opts.alibaba) {
    providers.alibaba = createAlibaba({
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      fetch: permanentErrorFetch,
    })
  }
  if (opts.zhipu) providers.zhipu = zhipu
  if (opts.moonshotai) providers.moonshotai = createMoonshotAI({ fetch: permanentErrorFetch })

  // 自定义 OpenAI 兼容提供方
  if (opts.custom.apiKey && opts.custom.baseURL) {
    providers.custom = createOpenAICompatible({
      name: 'custom',
      apiKey: opts.custom.apiKey,
      baseURL: opts.custom.baseURL,
      fetch: permanentErrorFetch,
    })
  }

  return createProviderRegistry(providers)
}

/**
 * 在请求体到达 DeepSeek V4 之前，为每条 assistant 消息补上
 * `reasoning_content: ""`。
 * 上游 `@ai-sdk/deepseek` 的转换器（convert-to-deepseek-chat-messages.ts）
 * 会移除最后一条 user 消息及其之前 assistant 消息上的 `reasoning_content`。
 * 这对禁止回传推理内容的 deepseek-reasoner（R1）是正确的，但对“必须回传”
 * 的 deepseek-v4-* 则是错误的。否则第二轮请求会直接 400，并提示
 * “thinking 模式下必须把 reasoning_content 传回 API”。
 * 这里只对 v4 族生效，避免影响 R1 的既有行为；等上游按模型区分后可移除。
 */
const deepseekReasoningFetch: typeof fetch = async (input, init) => {
  // 继续走 permanentErrorFetch，这样 DeepSeek 请求既能获得
  // v4 的 reasoning_content 回填，也能共享账单类错误的快速短路逻辑。
  if (!init?.body || typeof init.body !== 'string') return permanentErrorFetch(input, init)

  try {
    const body = JSON.parse(init.body) as { model?: string; messages?: Array<Record<string, unknown>> }
    if (typeof body.model === 'string' && body.model.includes('deepseek-v4') && Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (msg.role === 'assistant' && msg.reasoning_content == null) {
          msg.reasoning_content = ''
        }
      }
      return permanentErrorFetch(input, { ...init, body: JSON.stringify(body) })
    }
  } catch {
    // 请求体不是我们能识别的 JSON，保持原样透传。
  }

  return permanentErrorFetch(input, init)
}

/**
 * 将“响应体关键字”映射为“不可重试状态码”。
 * SDK 的 `APICallError` 会把 408 / 409 / 429 / 5xx 统一标记为
 * `isRetryable: true`；除此之外的 4xx 则视为不可重试。下面这些规则用于捕获：
 * 某些提供方明明返回的是“重试也不会成功”的错误，却仍然套用了可重试状态码
 * （最常见的是 Moonshot 把余额问题返回成 429）。
 * 我们把它们改写成语义更准确的状态码，这样下游 `classifyApiError`
 * 也能仅凭状态码给出正确恢复提示。
 *
 * 顺序很重要：按第一个命中的分类生效。账单 / 上下文长度相关的匹配要放在
 * 内容策略 / 鉴权之前，因为前者语义更具体。
 */
type PermanentErrorMatcher = string | RegExp

const PERMANENT_ERROR_CATEGORIES: ReadonlyArray<{
  status: number
  statusText: string
  patterns: readonly PermanentErrorMatcher[]
}> = [
  {
    // 402 Payment Required：账户余额不足或额度耗尽。
    // 真实案例：Moonshot 会用 HTTP 429 返回：
    // `{"error":{"message":"... is suspended due to insufficient balance,
    //   please recharge ...","type":"exceeded_current_quota_error"}}`
    // DeepSeek 会用 HTTP 400 返回 “Insufficient Balance”。
    // 后者本来就不可重试；这里改成 402 只是为了统一状态码，让分类器输出一致提示。
    status: 402,
    statusText: 'Payment Required',
    patterns: [
      'insufficient balance',
      'insufficient_balance',
      'insufficient_quota',
      'insufficient quota',
      'exceeded_current_quota',
      'exceeded your current quota',
      'suspended due to insufficient',
      'please recharge',
    ],
  },
  {
    // 413 Payload Too Large：提示词超出模型上下文窗口。
    // 同一份 prompt 重试仍然会溢出，只有 /compact、/clear 或换模型才有用。
    status: 413,
    statusText: 'Payload Too Large',
    patterns: [
      'context_length_exceeded',
      'context length exceeded',
      'maximum context length',
      'prompt is too long',
      'prompt_too_long',
      'context window',
    ],
  },
  {
    // 422 Unprocessable Entity：请求或响应被提供方安全策略拦截。
    // 同样内容重试还是会被拦，用户只能改写内容或切换模型。
    status: 422,
    statusText: 'Unprocessable Entity',
    patterns: [
      'content_policy_violation',
      'content_filter_triggered',
      'content_filter',
      'content_policy',
      'input_blocked',
      'harmful_content',
      'unsafe content',
      'safety_violation',
    ],
  },
  {
    // 401 Unauthorized：鉴权失败。
    // 有些上游代理 / 网关配置异常时会错误地把它包成 5xx 或 429，
    // 但使用同一把错误 key 重试只会得到同样结果。
    status: 401,
    statusText: 'Unauthorized',
    patterns: [
      'invalid api key',
      'invalid_api_key',
      'incorrect api key',
      'api key not found',
      'api_key_invalid',
      'expired api key',
    ],
  },
  {
    // 404 Not Found：模型 id 错误、已废弃，或当前账号未开通。
    // 某些提供方在模型别名无法识别时会错误返回 5xx，这里统一规范化。
    // 其中正则用于匹配 OpenAI 风格的：
    // “The model `gpt-x` does not exist or you do not have access...”
    status: 404,
    statusText: 'Not Found',
    patterns: ['model_not_found', 'model not found', 'unknown model', /\bmodel\b[^]*?\bdoes not exist\b/],
  },
] as const

/**
 * 拦截那些“语义上是永久失败、状态码却被错误标成可重试”的上游错误响应
 * （4xx / 5xx），并在 AI SDK 解析前把它们改写成不可重试状态码。
 * SDK 的 `APICallError` 会根据状态码计算 `isRetryable`；凡是不在
 * `{408, 409, 429, 5xx}` 里的状态码都会被视为不可重试，因此
 * `_retryWithExponentialBackoff` 会在首轮就停止，而不是白白消耗约 30 秒，
 * 最后再包一层 `RetryError` 返回一个本来就不可能靠重试修复的问题。
 *
 * 这里只做响应体关键字识别。没有命中关键字的错误响应会原样放行，这样真正的
 * 限流、网络抖动、临时 5xx 仍然能享受 SDK 默认重试。成功响应（`< 400`）
 * 永远不会读取响应体，因此不会影响 SSE 流。
 */
const permanentErrorFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init)
  // 流式响应或成功响应不能动；如果读取其响应体，会把 SDK 即将解析的 SSE 流消费掉。
  if (response.status < 400) return response

  const text = await response
    .clone()
    .text()
    .catch(() => '')
  if (!text) return response

  const lower = text.toLowerCase()
  for (const category of PERMANENT_ERROR_CATEGORIES) {
    const hit = category.patterns.some((p) => (typeof p === 'string' ? lower.includes(p) : p.test(lower)))
    if (!hit) continue
    // 如果提供方本来就返回了正确状态码，则无需改写。
    if (response.status === category.status) return response
    // 保留原始响应体不变，这样 SDK 的错误解析器仍能提取提供方自己的 message，
    // 下游 classifyApiError 也就还能据此给出更友好的恢复提示。
    return new Response(text, {
      status: category.status,
      statusText: category.statusText,
      headers: response.headers,
    })
  }
  return response
}
