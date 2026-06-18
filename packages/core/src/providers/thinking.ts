// @x-code-cli/core — 按提供方区分的深度思考 / 推理开关
//
// 不同提供方对“先多消耗一些 token 进行推理，再输出结果”这件事提供了不同开关。
// 我们支持的这些提供方默认值并不一致：Gemini 和 Kimi 默认开启；
// Claude Sonnet、DeepSeek V4、Qwen 以及多数其他模型默认关闭；
// GPT-4.1/5.5 和 Grok-4.3 在对应模型 id 上甚至没有“thinking”这个概念。
// 面向用户的 `/thinking on|off` 就是为了把它们统一成一个一致的控制旋钮。
//
// 这里会把该开关映射到各家 AI SDK 中最接近的等价能力：
//
//   anthropic   thinking: { type: 'enabled' | 'disabled', budgetTokens }
//   deepseek    thinking: { type: 'enabled' | 'disabled' }
//   moonshotai  thinking: { type: 'enabled' | 'disabled' }
//   alibaba     enableThinking: boolean
//   google      thinkingConfig: { thinkingBudget: -1（动态）| 0（关闭） }
//   xai         reasoningEffort: 'high' | 'low'            （仅 grok-3-mini 等）
//   openai      reasoningEffort: 'high' | 'minimal'        （仅 o 系列等）
//   zhipu       thinking: { type: 'enabled' | 'disabled' } （GLM-5/5.1；
//                 GLM-4-Plus 会静默忽略）
//
// Anthropic 的数值预算设置得比较宽松但不过度：8000 个 reasoning token
// 足以覆盖除超长 agent loop 之外的大多数场景，同时远低于 100 万上下文窗口上限。
// 如果 Opus 用户想要更高预算，可以直接改这里再重建；单独暴露一个 `budget`
// 斜杠参数，对一个大多数用户只会在 “on / off” 二选一的功能来说有点过度设计。
import { providerOf } from './capabilities.js'

const ANTHROPIC_BUDGET_TOKENS = 8000

/**
 * 构造把指定模型切换到目标 thinking 状态所需的 `providerOptions`。
 * 如果该模型没有 thinking 相关开关，则返回空对象，便于调用方无条件合并。
 *
 * `enabled` 语义：
 *   true  — 主动开启，并尽量使用提供方支持的高推理模式
 *   false — 主动关闭；如果提供方默认强制开启并且有最低推理预算限制，
 *           就退而求其次，请求一个尽可能低或最接近关闭的模式
 */
export function getThinkingProviderOptions(modelId: string, enabled: boolean): Record<string, Record<string, unknown>> {
  const provider = providerOf(modelId)
  switch (provider) {
    case 'anthropic':
      return enabled
        ? { anthropic: { thinking: { type: 'enabled', budgetTokens: ANTHROPIC_BUDGET_TOKENS } } }
        : { anthropic: { thinking: { type: 'disabled' } } }

    case 'deepseek':
      // V4 系列支持这个开关；旧版 `deepseek-chat` /
      // `deepseek-reasoner` 会静默忽略不认识的 providerOptions。
      return enabled
        ? { deepseek: { thinking: { type: 'enabled' } } }
        : { deepseek: { thinking: { type: 'disabled' } } }

    case 'moonshotai':
      // kimi-k2.5 默认就是推理模型；显式传 `disabled`
      // 可以在提供方侧关闭推理。
      return enabled
        ? { moonshotai: { thinking: { type: 'enabled' } } }
        : { moonshotai: { thinking: { type: 'disabled' } } }

    case 'alibaba':
      // 混合型 Qwen 模型会按请求尊重 `enableThinking`；
      // 专用推理模型（如 qwq-plus、qwen3-*-thinking-*）即便收到
      // `enableThinking: false` 也会继续保持 thinking 开启。
      return { alibaba: { enableThinking: enabled } }

    case 'google':
      // Gemini 2.5 Pro 无法完全关闭（最小预算是 128）；
      // 这里在 OFF 时仍发送 `thinkingBudget: 0`，交给 SDK 做钳制。
      // 2.5 Flash 和 Lite 会把 0 当作“不思考”。
      // `-1` 是 SDK 表示“动态预算，由模型自行决定”的哨兵值，
      // 这也是 Pro 默认行为，且符合我们对 ON 的预期。
      return enabled
        ? { google: { thinkingConfig: { thinkingBudget: -1 } } }
        : { google: { thinkingConfig: { thinkingBudget: 0 } } }

    case 'xai':
      // 只有 grok-3-mini 和 grok-4-mini 会真正识别 `reasoningEffort`；
      // grok-3 和 grok-4 会忽略它。即便如此，发送这个选项也无害：
      // SDK 会原样透传，API 会静默丢弃。
      return enabled ? { xai: { reasoningEffort: 'high' } } : { xai: { reasoningEffort: 'low' } }

    case 'openai':
      // 只有 o 系列和 gpt-5 推理模型会使用 `reasoningEffort`；
      // gpt-4.1 会忽略它。和 xAI 一样，透传这个选项是安全的。
      return enabled ? { openai: { reasoningEffort: 'high' } } : { openai: { reasoningEffort: 'minimal' } }

    case 'zhipu':
      // GLM-5/5.1 使用与 DeepSeek 类似的 thinking 开关；
      // GLM-4-Plus 不支持。对不支持的模型发送此选项也没关系，
      // API 会静默忽略。
      return enabled ? { zhipu: { thinking: { type: 'enabled' } } } : { zhipu: { thinking: { type: 'disabled' } } }

    case 'custom':
    default:
      return {}
  }
}

/** 把 thinking 模式对应的 providerOptions 合并进已有配置，
 *  且不覆盖无关字段（例如 Anthropic 的 cache-control）。
 *  合并粒度是“每个 provider 下一层对象”，因此 `x.thinking` 与
 *  `x.cacheControl` 可以同时存在于 `providerOptions.anthropic` 中。 */
export function mergeThinkingOptions(
  base: Record<string, unknown> | undefined,
  thinking: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(base ?? {}) }
  for (const [provider, entry] of Object.entries(thinking)) {
    const existing = (merged[provider] as Record<string, unknown> | undefined) ?? {}
    merged[provider] = { ...existing, ...entry }
  }
  return merged
}
