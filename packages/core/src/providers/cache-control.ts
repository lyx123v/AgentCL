// @x-code-cli/core — 按提供方区分的提示词缓存
//
// 提示词缓存是降低单次会话成本最有效的手段之一。当前各家提供方都支持，
// 但启用方式并不相同：
//
//   Anthropic   — 在 SYSTEM 消息、最后一个工具定义（用一个断点缓存整份
//                 tools schema），以及最后两条非 system 消息上设置
//                 `cacheControl: { type: 'ephemeral' }`，总共四个断点，
//                 正好达到 API 上限。每个断点的内容会在服务端缓存 5 分钟；
//                 后续请求只要前缀完全一致，就能命中缓存，只为未缓存的尾部
//                 付费。tools schema 是收益最高的缓存位，因为它在每一轮都
//                 是同一段字节，而且在完整工具集注册后通常会膨胀到数千 token。
//
//   OpenAI      — 默认有自动前缀缓存，但显式设置 `promptCacheKey`
//                 （把相同 key 路由到同一缓存分片）和 `store`
//                 （是否保留调用记录供后续拉取）可以提高命中率。
//                 这里使用 sessionId 作为 key，让同一会话的每一轮都落到
//                 同一个缓存分片上。
//
//   OpenAI-     — DeepSeek / Moonshot / Alibaba / Zhipu / xAI / 自定义
//   compatible    兼容提供方都支持自动前缀缓存，不需要显式开关。唯一前提是：
//                 每一轮之间前缀字节必须稳定。如果 system prompt 每轮都会因
//                 新时间戳而重建，请求就会全部失去命中。因此我们会把 system
//                 prompt 按会话缓存到 LoopState 中（见 loop-state.ts），并在
//                 后续每一轮复用完全相同的字符串。
//
//   Google      — Gemini 使用隐式缓存；SDK 侧没有可可靠设置的逐请求开关，
//                 因此这里保持空操作。
import type { ModelMessage } from 'ai'

import { providerOf } from './capabilities.js'

/** Anthropic 可附加缓存断点的最大消息数。
 *  Anthropic 每个请求最多允许 4 个 `cache_control` 块；其中 1 个给
 *  system prompt，1 个给最后一个工具定义，剩下 2 个留给消息尾部。
 *  根据 opencode 的测试，2 个是性价比最好的配置，再多一个消息断点也只是
 *  给即将被淘汰的区域额外写一次缓存。 */
const MESSAGE_CACHE_BREAKPOINTS = 2

export interface CacheControlArgs {
  system: string // system prompt 文本；如果提供方要求挂载 cache_control，会包装成 system 角色消息
  messages: ModelMessage[] // 当前要发送的会话消息列表
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools?: Record<string, any> // 传给 streamText 的工具注册表；Anthropic 会给最后一个工具打缓存标记以缓存整份 schema
  modelId: string // `provider:model` 形式的模型标识，用于选择缓存策略
  sessionId: string // 会话级稳定 key；用于 OpenAI 的 `promptCacheKey`，把相同前缀固定到同一缓存分片
}

export interface CacheControlResult {
  system?: string // 最终传给 streamText 的 system 文本；Anthropic 场景下会被折叠进 messages，因此这里可能为空
  messages: ModelMessage[] // 处理过缓存控制后的消息列表
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools?: Record<string, any> // 处理过缓存控制后的工具注册表；Anthropic 会浅拷贝并标记最后一个工具
  providerOptions?: Record<string, unknown> // 需要透传给 streamText 的顶层 providerOptions
}

/** 给消息无副作用地附加一段 providerOptions。 */
function tagMessage(msg: ModelMessage, provider: string, entry: Record<string, unknown>): ModelMessage {
  const existing = (msg as { providerOptions?: Record<string, Record<string, unknown>> }).providerOptions ?? {}
  return {
    ...msg,
    providerOptions: {
      ...existing,
      [provider]: { ...(existing[provider] ?? {}), ...entry },
    },
  } as ModelMessage
}

/** 构造一条带有 Anthropic `cache_control` 的 system 消息。 */
function anthropicSystemMessage(system: string): ModelMessage {
  return {
    role: 'system',
    content: system,
    providerOptions: {
      anthropic: { cacheControl: { type: 'ephemeral' } },
    },
  } as unknown as ModelMessage
}

/**
 * 根据不同提供方补齐请求所需的缓存提示信息。
 * 该函数不会修改输入的 `messages` 数组；只有需要额外 providerOptions
 * 的消息才会返回新的消息对象。
 */
export function applyCacheControl(args: CacheControlArgs): CacheControlResult {
  const provider = providerOf(args.modelId)

  if (provider === 'anthropic') {
    // 把 system 折叠进 messages，方便直接挂 cache_control，
    // 然后再给最后 N 条非 system 消息标上额外断点。
    const nonSystemTail = args.messages.slice(-MESSAGE_CACHE_BREAKPOINTS)
    const tailSet = new Set(nonSystemTail)
    const tagged = args.messages.map((m) =>
      tailSet.has(m) ? tagMessage(m, 'anthropic', { cacheControl: { type: 'ephemeral' } }) : m,
    )
    return {
      system: undefined,
      messages: [anthropicSystemMessage(args.system), ...tagged],
      tools: tagLastTool(args.tools),
    }
  }

  if (provider === 'openai') {
    // `store: false` 表示我们不需要保留调用记录供后续 API 拉取，
    // 但 `promptCacheKey` 仍会把相同前缀路由到同一缓存分片，真正带来成本收益。
    return {
      system: args.system,
      messages: args.messages,
      tools: args.tools,
      providerOptions: {
        openai: { promptCacheKey: args.sessionId, store: false },
      },
    }
  }

  // OpenAI 兼容提供方与 Gemini 不需要显式标记，只依赖稳定前缀。
  // 调用方必须确保 buildSystemPrompt 已缓存进 LoopState，这样每轮发出的
  // system 字符串才能完全一致。
  return { system: args.system, messages: args.messages, tools: args.tools }
}

/** 浅拷贝 `tools`，并给最后一个工具附加 Anthropic 的缓存断点，
 *  让整份 tools schema 进入同一个缓存前缀槽位。
 *  如果没有工具则原样返回；Anthropic 不接受给不存在的块附加空
 *  `cache_control`，而且此时也没有任何内容值得缓存。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tagLastTool(tools: Record<string, any> | undefined): Record<string, any> | undefined {
  if (!tools) return tools
  const names = Object.keys(tools)
  if (names.length === 0) return tools
  const lastName = names[names.length - 1]
  const lastTool = tools[lastName]
  const existing = (lastTool?.providerOptions ?? {}) as Record<string, Record<string, unknown>>
  const tagged = {
    ...lastTool,
    providerOptions: {
      ...existing,
      anthropic: { ...(existing.anthropic ?? {}), cacheControl: { type: 'ephemeral' } },
    },
  }
  return { ...tools, [lastName]: tagged }
}
