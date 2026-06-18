// @x-code-cli/core — 上下文窗口查询与估算
import type { ModelMessage } from 'ai'

/**
 * 当上下文使用量超过模型上下文窗口的这个比例时触发压缩。
 * 这里会被两个检查点使用：
 *   1. 每轮结束后：基于 API 返回的真实 input token 数，这是最可靠的信号。
 *   2. 每次 API 调用前：基于字符长度做一次兜底估算。
 */
export const COMPRESSION_TRIGGER_RATIO = 0.8

/**
 * 调用前估算时使用的粗略“每 token 字符数”比例。
 * 英文通常约 4 chars/token，中文和代码往往更低；这里取 3.0，让估算略偏保守，
 * 以便兜底机制更早触发。
 */
const CHARS_PER_TOKEN_ESTIMATE = 3.0

/** 当模型级和 provider 级查询都未命中时使用的默认上下文窗口。 */
const DEFAULT_CONTEXT_WINDOW = 128000

/** 各模型的上下文窗口大小（单位：token）。 */
const MODEL_CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map([
  // Anthropic
  ['anthropic:claude-fable-5', 1000000],
  ['anthropic:claude-opus-4-8', 1000000],
  ['anthropic:claude-opus-4-7', 1000000],
  ['anthropic:claude-sonnet-4-6', 1000000],
  ['anthropic:claude-haiku-4-5', 200000],
  // OpenAI
  ['openai:gpt-5.5', 1047576],
  ['openai:gpt-5.4-mini', 1047576],
  ['openai:gpt-4.1', 1047576],
  ['openai:gpt-4.1-mini', 1047576],
  ['openai:gpt-4.1-nano', 1047576],
  ['openai:o3', 200000],
  ['openai:o4-mini', 200000],
  // Google
  ['google:gemini-3.5-flash', 1000000],
  ['google:gemini-2.5-pro', 1000000],
  ['google:gemini-2.5-flash', 1000000],
  // DeepSeek
  ['deepseek:deepseek-v4-flash', 1000000],
  ['deepseek:deepseek-v4-pro', 1000000],
  // Alibaba：根据 DashScope 文档，qwen-turbo 和 qwen3-coder-plus 支持到 1M；
  // qwen-max 仍然只有 32k（若需 256k 应使用 qwen3-max）。
  // 数值已对照 https://help.aliyun.com/zh/model-studio/models 校验。
  ['alibaba:qwen3.7-max', 131072],
  ['alibaba:qwen-turbo', 1000000],
  ['alibaba:qwen-plus', 131072],
  ['alibaba:qwen-max', 32768],
  ['alibaba:qwen3-max', 262144],
  ['alibaba:qwen3-coder-plus', 1000000],
  ['alibaba:qwq-plus', 131072],
  // xAI
  ['xai:grok-4.3', 1000000],
  ['xai:grok-3', 131072],
  ['xai:grok-3-mini', 131072],
  // Zhipu
  ['zhipu:glm-5.1', 200000],
  ['zhipu:glm-5', 200000],
  ['zhipu:glm-4-plus', 128000],
  // Moonshot
  ['moonshotai:kimi-k2.6', 131072],
  ['moonshotai:kimi-k2.5', 131072],
])

/** provider 级别的上下文窗口兜底值。 */
const PROVIDER_CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map([
  ['anthropic', 1000000],
  ['openai', 128000],
  ['google', 1000000],
  ['deepseek', 1000000],
  ['alibaba', 128000],
  ['xai', 128000],
  ['zhipu', 128000],
  ['moonshotai', 128000],
])

/** 根据 `provider:model` 形式的模型 id 解析上下文窗口大小。 */
export function getContextWindow(modelId: string): number {
  const exact = MODEL_CONTEXT_WINDOWS.get(modelId)
  if (exact !== undefined) return exact
  const provider = modelId.split(':')[0]
  return PROVIDER_CONTEXT_WINDOWS.get(provider) ?? DEFAULT_CONTEXT_WINDOW
}

/** 计算某个模型触发压缩的 token 阈值。 */
export function getCompressionThreshold(modelId: string): number {
  return Math.floor(getContextWindow(modelId) * COMPRESSION_TRIGGER_RATIO)
}

/**
 * 各模型允许的 max_tokens 上限（即回复体积上限）。
 * 某些 provider 超上限会直接拒绝请求，而不是静默裁剪。
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 16384
const MODEL_MAX_OUTPUT_TOKENS: ReadonlyMap<string, number> = new Map([
  // DeepSeek V4：flash 和 pro 理论上都支持到 384K 输出 token。
  // 这里保守限制在 131072，避免边缘情况下触发 400。
  ['deepseek:deepseek-v4-flash', 131072],
  ['deepseek:deepseek-v4-pro', 131072],
  // Alibaba：qwen-turbo 超过 16384 会直接拒绝；其他 Qwen3 模型支持
  // 32768（非 thinking）/ 81920（thinking）。这里统一卡在非 thinking
  // 上限，保证请求始终可通过。qwen-max 只有 32k 上下文窗口，因此输出上限
  // 也要明显低于它。
  ['alibaba:qwen-turbo', 16384],
  ['alibaba:qwen-plus', 32000],
  ['alibaba:qwen-max', 8192],
  ['alibaba:qwen3-max', 32000],
  ['alibaba:qwen3-coder-plus', 32000],
  ['alibaba:qwq-plus', 32000],
])

/** 解析发送给 provider 的 max_tokens 上限。 */
export function getMaxOutputTokens(modelId: string): number {
  return MODEL_MAX_OUTPUT_TOKENS.get(modelId) ?? DEFAULT_MAX_OUTPUT_TOKENS
}

/**
 * 基于消息字符数粗略估算总 token 数。
 * 这里故意偏保守一些，用作真正 API 上限到来前的提前预警。
 */
export function estimateTokenCount(messages: ModelMessage[]): number {
  let chars = 0
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      chars += msg.content.length
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content as Array<{ type: string; text?: string }>) {
        if (typeof part.text === 'string') chars += part.text.length
      }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE)
}
