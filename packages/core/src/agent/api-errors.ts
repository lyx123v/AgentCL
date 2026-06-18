// @x-code-cli/core — API 错误分类与模式识别

/** 表示请求超出模型上下文窗口的特征子串。 */
const CONTEXT_TOO_LONG_PATTERNS = [
  'maximum context length',
  'context_length_exceeded',
  'token limit',
  'prompt is too long',
  'prompt_too_long',
  'input tokens',
  'context window',
] as const

/** 从 `"status code 400"`、`"(400)"` 或 `"400 ..."` 这类文本中提取 HTTP 状态码。 */
export function extractHttpStatus(msg: string): number {
  const match = msg.match(/\bstatus(?:\s+code)?\s+(\d{3})\b/i) ?? msg.match(/\((\d{3})\)/) ?? msg.match(/^(\d{3})\s/)
  return match ? Number(match[1]) : 0
}

/** 判断错误是否表示请求超出了上下文窗口。
 *  也会匹配 HTTP 413，因为 `permanentErrorFetch` 会把这类上下文溢出
 *  响应改写成 413，确保 SDK 将其视为不可重试错误。 */
export function isContextTooLongError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  if (extractHttpStatus(msg) === 413) return true
  for (const pattern of CONTEXT_TOO_LONG_PATTERNS) {
    if (msg.includes(pattern)) return true
  }
  return false
}

export interface ClassifiedError {
  /** 供用户展示的友好错误信息。 */
  message: string
  /** 是否适合由上层继续自动重试。 */
  retryable: boolean
}

// ── 错误形态判断函数 ───────────────────────────────────────────────
// 每个谓词函数负责匹配一种 provider 失败模式。拆成具名辅助函数后，
// classifyApiError() 更容易阅读，单元测试也能直接覆盖单个分支。

/** 判断是否为 reasoning_content 缺失错误。 */
function isReasoningContentError(msg: string): boolean {
  // DeepSeek Reasoner 在工具调用链中要求 assistant 消息带上
  // reasoning_content；线上会出现这两种不同措辞。
  return msg.includes('Missing `reasoning_content`') || msg.includes('reasoning_content')
}

/** 判断是否为缺少 API Key 的错误。 */
function isMissingApiKeyError(msg: string): boolean {
  return msg.includes('API key is missing') || msg.includes('API_KEY')
}

/** 判断是否为鉴权失败。 */
function isUnauthorizedError(msg: string, status: number): boolean {
  return status === 401 || msg.includes('Unauthorized') || msg.includes('Invalid API Key')
}

/** 判断是否为余额或额度不足。 */
function isInsufficientBalanceError(msg: string, status: number): boolean {
  if (status === 402) return true
  // 这里统一转小写做宽松匹配，因为各家 provider 返回文案并不一致：
  // DeepSeek 用 "Insufficient Balance"，OpenAI 用 "insufficient_quota"，
  // Moonshot 甚至会返回 429 且正文是 "is suspended due to insufficient
  // balance, please recharge your account"。如果这里不放宽，Moonshot
  // 的计费失败会误落到 429 限流分支，被无意义重试多次。
  const lower = msg.toLowerCase()
  return (
    lower.includes('insufficient balance') ||
    lower.includes('insufficient_balance') ||
    lower.includes('insufficient_quota') ||
    lower.includes('insufficient quota') ||
    lower.includes('exceeded your current quota') ||
    lower.includes('exceeded_current_quota') ||
    lower.includes('suspended due to insufficient') ||
    lower.includes('please recharge')
  )
}

/** 判断是否为无权限访问。 */
function isForbiddenError(msg: string, status: number): boolean {
  return status === 403 || msg.includes('Forbidden')
}

/** 判断是否为 max_tokens 配置越界。 */
function isMaxTokensError(msg: string): boolean {
  if (msg.includes('Invalid max_tokens') || msg.includes('Range of max_tokens') || msg.includes('InvalidParameter')) {
    return true
  }
  // 兜底：只要同时提到 "max_tokens" 和 invalid/range 标记，就认为是同类错误。
  if (!msg.includes('max_tokens')) return false
  return /invalid|range/i.test(msg)
}

/** 判断模型服务是否不可用。 */
function isServiceUnavailableError(msg: string, status: number): boolean {
  return status === 503 || msg.includes('Service Unavailable') || msg.includes('overloaded')
}

/** 判断内容是否被 provider 的安全或审核策略拦截。
 *  `permanentErrorFetch` 会把匹配响应改写成 HTTP 422，因此状态码即可命中；
 *  额外的文本模式则覆盖那些绕过 fetch shim 的入口。 */
function isContentPolicyError(msg: string, status: number): boolean {
  if (status === 422) return true
  const lower = msg.toLowerCase()
  return (
    lower.includes('content_policy_violation') ||
    lower.includes('content_filter_triggered') ||
    lower.includes('content_filter') ||
    lower.includes('content_policy') ||
    lower.includes('input_blocked') ||
    lower.includes('harmful_content') ||
    lower.includes('safety_violation')
  )
}

/** 判断 provider 是否不认识当前模型 id（拼写错误、已废弃、无权限等）。
 *  `permanentErrorFetch` 会把对应的 5xx/429 响应规范化成 404；
 *  文本模式则兼容那些本来就返回描述性 404 的 provider。 */
function isModelNotFoundError(msg: string, status: number): boolean {
  if (status === 404) return true
  const lower = msg.toLowerCase()
  // OpenAI 会把模型名夹在 "model" 和 "does not exist" 中间，
  // 所以不能直接匹配固定短语，只能要求两个片段同时出现。
  if (lower.includes('model') && lower.includes('does not exist')) return true
  return lower.includes('model_not_found') || lower.includes('model not found') || lower.includes('unknown model')
}

/** 判断是否命中限流。 */
function isRateLimitedError(msg: string, status: number): boolean {
  return status === 429 || /rate limit/i.test(msg)
}

/** 判断是否为常见网络错误。 */
function isNetworkError(msg: string): boolean {
  return msg.includes('timeout') || msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET')
}

/** 判断是否为 AI SDK 的类型校验错误。 */
function isTypeValidationError(err: unknown, msg: string): boolean {
  return (
    (err instanceof Error && err.constructor.name === 'AI_TypeValidationError') ||
    msg.includes('Type validation failed')
  )
}

/** 判断是否为 tool_call / tool_result 配对损坏导致的 provider 拒绝。
 *  这类问题在 DeepSeek 上最常见，但 OpenAI 等 provider 也会有变体。
 *  `runTurn` 里的 `repairOrphanToolCalls` 理论上会兜底；如果仍然漏出，
 *  这里返回更可操作的提示，而不是原始 provider 报错。 */
function isMalformedToolHistoryError(msg: string): boolean {
  return (
    msg.includes("Messages with role 'tool' must be a response to a preceding message with 'tool_calls'") ||
    msg.includes('tool_calls and tool_call_ids') ||
    msg.includes('tool_call_id')
  )
}

/** 从 `"Anthropic API key is missing"` 这类文本中提取 provider 名称。 */
function extractProviderName(msg: string): string {
  const m = msg.match(/^(\w+)\s+API key/i)
  return m ? m[1]! : 'Provider'
}

/**
 * 从 AI SDK 错误对象里提取真正有意义的错误信息。
 * TypeValidationError（例如 provider 返回错误 JSON，而不是合法的 SSE
 * 流）会把真实 provider 报错塞进 `.value` 里；这里把它挖出来，避免后续
 * 只匹配到外层的 Zod 校验包装信息。
 */
function extractErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const msg = err.message
  // AI SDK TypeValidationError：真正的 provider 错误通常藏在 `.value` 中。
  const val = (err as unknown as Record<string, unknown>).value
  if (val && typeof val === 'object') {
    const inner = (val as Record<string, unknown>).error
    if (inner && typeof inner === 'object') {
      const innerMsg = (inner as Record<string, string>).message
      if (typeof innerMsg === 'string') return innerMsg
    }
  }
  return msg
}

/** 对 API 错误进行分类，并返回更适合展示给用户的恢复提示。 */
export function classifyApiError(err: unknown): ClassifiedError {
  const msg = extractErrorMessage(err)
  const status = extractHttpStatus(msg)

  if (isContextTooLongError(err)) {
    return {
      message:
        '上下文过长：当前对话已经超过模型的 token 上限。可以尝试用 /compact 压缩上下文，或用 /clear 重新开始。',
      retryable: false,
    }
  }
  if (isReasoningContentError(msg)) {
    return {
      message:
        'DeepSeek Reasoner 在工具调用链中要求 assistant 消息包含 reasoning_content。这通常是 SDK 兼容性问题，建议反馈此问题。',
      retryable: false,
    }
  }
  if (isMissingApiKeyError(msg)) {
    const provider = extractProviderName(msg)
    return {
      message: `${provider} 的 API key 尚未设置。请配置对应的环境变量（例如 ${provider.toUpperCase()}_API_KEY）。`,
      retryable: false,
    }
  }
  if (isUnauthorizedError(msg, status)) {
    return {
      message: 'API 认证失败（401）。请检查你的 API key，可通过 /model 查看，或使用 `xc init` 重新配置。',
      retryable: false,
    }
  }
  if (isInsufficientBalanceError(msg, status)) {
    return {
      message: 'API 账户余额或额度不足（402）。请先充值，或通过 /model 切换到其他 provider。',
      retryable: false,
    }
  }
  if (isForbiddenError(msg, status)) {
    return {
      message: 'API 访问被拒绝（403）。你的 API key 可能没有该模型的访问权限。',
      retryable: false,
    }
  }
  if (isModelNotFoundError(msg, status)) {
    return {
      message: '模型不存在（404）。模型 id 可能写错、已废弃，或当前账号未开通。可以用 /model 切换模型。',
      retryable: false,
    }
  }
  if (isContentPolicyError(msg, status)) {
    return {
      message: '内容被 provider 的安全过滤器拦截（422）。请尝试换个表达方式，或使用 /model 切换其他模型。',
      retryable: false,
    }
  }
  if (isMaxTokensError(msg)) {
    return {
      message:
        '当前配置的 max_tokens 超过了该模型上限。请尝试用 /model 切换模型，或反馈此问题以便补充正确上限。',
      retryable: false,
    }
  }
  if (isServiceUnavailableError(msg, status)) {
    return {
      message: '模型服务当前不可用（503）。请稍后重试，或用 /model 切换其他模型。',
      retryable: false,
    }
  }
  if (isRateLimitedError(msg, status)) {
    return {
      message: '触发限流（429）。正在等待自动重试……（AI SDK 会使用 `maxRetries: 3` 自动执行指数退避）',
      retryable: true,
    }
  }
  if (isNetworkError(msg)) {
    return {
      message: `网络错误：${msg}。正在重试……`,
      retryable: true,
    }
  }
  // AI SDK TypeValidationError：provider 返回了非标准响应，例如错误 JSON，
  // 而不是合法的 SSE 流。这里优先展示 provider 的原始报错。
  if (isTypeValidationError(err, msg)) {
    return {
      message: `Provider 返回错误：${msg}。可以尝试用 /model 切换其他模型。`,
      retryable: false,
    }
  }
  if (isMalformedToolHistoryError(msg)) {
    return {
      message:
        '对话历史中存在孤立的 tool call（模型产出的工具输入格式异常，被 SDK 拒绝）。下一轮会尝试自动修复；如果反复出现，可用 /clear 重置会话。',
      retryable: false,
    }
  }

  return { message: msg, retryable: false }
}
