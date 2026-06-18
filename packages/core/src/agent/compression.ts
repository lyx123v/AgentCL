// @x-code-cli/core — 上下文窗口压缩
//
// 这里有两条压缩路径，共用同一套基础能力：
//   - 主动压缩（`checkAndCompressContext`）：每轮开始前执行，
//     一旦超过模型阈值就裁剪旧消息。
//   - 被动压缩（`handleContextTooLong`）：当流式请求因
//     “prompt too long” 报错时执行，压缩后通知上层重试。
//
// 两条路径都会先尝试一次廉价的进程内轻量压缩（丢弃 loop-guard
// 配对消息，不调用 LLM）。只有在这一步还不够时，才会进入
// `compressMessages`，通过 generateText 生成总结。
import { generateText } from 'ai'
import type { LanguageModel, ModelMessage } from 'ai'

import type { HookBus } from '../hooks/bus.js'
import { generateSessionSummary } from '../knowledge/session.js'
import type { AgentCallbacks } from '../types/index.js'
import { debugLog } from '../utils.js'
import { estimateTokenCount } from './context-window.js'
import { lightCompactMessages, truncateOldToolResults } from './light-compact.js'
import type { LoopState } from './loop-state.js'
import { markBoundaryAndReflush } from './session-store.js'

/** 两条压缩路径都会透传的可选 hook 上下文。
 *  便于插件在压缩前后观察或记录行为，例如做检查点持久化或审计。 */
export interface CompactionHookContext {
  /** 可选的 hook 总线，用于发出压缩前后事件。 */
  hookBus?: HookBus
  /** 当前使用的模型 id。 */
  modelId: string
  /** 当前工作目录。 */
  cwd: string
  /** 可选的中断信号。 */
  abortSignal?: AbortSignal
}

/** 压缩时原样保留的最近消息数量。 */
export const KEEP_RECENT = 6

/** 把较早的消息压缩成一段摘要，并保留最近消息原文。 */
export async function compressMessages(messages: ModelMessage[], model: LanguageModel): Promise<ModelMessage[]> {
  // 确保 recent 片段不会以孤立的 tool result 开头；
  // 否则 provider 会因为缺少前置 tool_calls 而拒绝请求。
  let keepCount = KEEP_RECENT
  while (keepCount < messages.length && messages[messages.length - keepCount]?.role === 'tool') {
    keepCount++
  }
  const recent = messages.slice(-keepCount)
  const old = messages.slice(0, -keepCount)

  if (old.length === 0) return messages

  const { text: summary } = await generateText({
    model,
    system:
      '请简明总结下面的对话，保留继续任务所需的关键决策、文件改动和上下文。',
    messages: old,
  })

  return [{ role: 'user', content: `[Previous conversation summary]\n${summary}` }, ...recent]
}

/**
 * 主动压缩入口：只要最近一次真实 input token 数，或基于字符的估算值
 * 任一超过阈值，就触发压缩。
 *
 * 会先执行一次 O(n) 的轻量压缩（删除 loop-guard 配对消息，不走网络）。
 * 如果这样就能回到阈值以内，就完全跳过昂贵的 LLM 总结路径。
 */
export async function checkAndCompressContext(
  state: LoopState,
  model: LanguageModel,
  threshold: number,
  callbacks: AgentCallbacks,
  hookCtx?: CompactionHookContext,
): Promise<void> {
  const needsCompression = state.lastInputTokens > threshold || estimateTokenCount(state.messages) > threshold
  if (!needsCompression || state.messages.length <= KEEP_RECENT) return

  // PreCompact：在任一压缩路径开始前触发。压缩一旦越阈值就是必做动作，
  // 因此这里不等待 hook 返回结果来影响行为，只做尽力通知。
  const messageCountBefore = state.messages.length
  const tokenEstimateBefore = estimateTokenCount(state.messages)
  emitCompactionHook(hookCtx, {
    name: 'PreCompact',
    trigger: 'proactive',
    messageCount: messageCountBefore,
    tokenEstimate: tokenEstimateBefore,
  })

  callbacks.onCompressionProgress?.('正在移除重复的工具调用……')
  const light = lightCompactMessages(state.messages)
  if (light.dropped > 0) {
    state.messages = light.messages
    const stillOver = estimateTokenCount(state.messages) > threshold
    callbacks.onContextCompressed(
      `已移除 ${light.dropped} 条循环工具调用消息以回收上下文${stillOver ? '，但仍超出阈值，继续生成摘要。' : '。'}`,
    )
    if (!stillOver) {
      // 轻量压缩已足够，写入一个边界标记，避免 resume 时把已删除的
      // loop-guard 消息重新捞回来。这里没有摘要文本，因为并未走总结。
      void markBoundaryAndReflush(state)
      emitCompactionHook(hookCtx, {
        name: 'PostCompact',
        trigger: 'proactive',
        messageCount: state.messages.length,
        summary: '',
      })
      return
    }
  }

  callbacks.onCompressionProgress?.('正在截断较旧的工具结果……')
  const trunc = truncateOldToolResults(state.messages)
  if (trunc.truncatedCount > 0) {
    const stillOver = estimateTokenCount(state.messages) > threshold
    callbacks.onContextCompressed(
      `已截断 ${trunc.truncatedCount} 条较旧工具结果，约节省 ${Math.round(trunc.charsSaved / 3)} 个 token${stillOver ? '，但仍超出阈值，继续生成摘要。' : '。'}`,
    )
    if (!stillOver) {
      void markBoundaryAndReflush(state)
      emitCompactionHook(hookCtx, {
        name: 'PostCompact',
        trigger: 'proactive',
        messageCount: state.messages.length,
        summary: '',
      })
      return
    }
  }

  callbacks.onCompressionProgress?.('正在生成会话摘要……')
  let summaryText = ''
  try {
    const summary = await generateSessionSummary(state.messages, model, state.sessionId, state.startedAt, [
      ...state.filesModified,
    ])
    summaryText = summary.summary
  } catch {
    // 结构化摘要生成失败时，继续向下走空摘要。后面的 compressMessages
    // 仍会自行调用 LLM 生成总结，因此上下文依然会缩小，只是少了那段
    // 会写在 boundary 行里的结构化摘要。
  }
  callbacks.onCompressionProgress?.('正在总结对话……')
  const tokensBefore = estimateTokenCount(state.messages)
  state.messages = await compressMessages(state.messages, model)
  state.lastInputTokens = 0
  state.expectCacheMiss = true
  const tokensAfter = estimateTokenCount(state.messages)
  // 写入 compact-boundary 并重新刷盘裁剪后的消息，确保边界后的 jsonl
  // 内容与当前内存状态一致。
  void markBoundaryAndReflush(state, summaryText)
  const beforeK = Math.round(tokensBefore / 1000)
  const afterK = Math.round(tokensAfter / 1000)
  callbacks.onContextCompressed(`上下文已压缩：约 ${beforeK}k → ${afterK}k tokens。`)
  emitCompactionHook(hookCtx, {
    name: 'PostCompact',
    trigger: 'proactive',
    messageCount: state.messages.length,
    summary: summaryText,
  })
}

/**
 * 被动压缩入口：当流式请求因 prompt 过长报错时执行，压缩后通知调用方重试。
 * 返回 true 表示本轮已经完成压缩，调用方应重试当前 turn。
 */
export async function handleContextTooLong(
  state: LoopState,
  model: LanguageModel,
  callbacks: AgentCallbacks,
  hookCtx?: CompactionHookContext,
): Promise<boolean> {
  if (state.messages.length <= KEEP_RECENT) return false
  emitCompactionHook(hookCtx, {
    name: 'PreCompact',
    trigger: 'reactive',
    messageCount: state.messages.length,
    tokenEstimate: estimateTokenCount(state.messages),
  })
  callbacks.onCompressionProgress?.('正在总结对话……')
  const tokensBefore = estimateTokenCount(state.messages)
  state.messages = await compressMessages(state.messages, model)
  state.lastInputTokens = 0
  state.expectCacheMiss = true
  const tokensAfter = estimateTokenCount(state.messages)
  // 与主动压缩保持同样的 boundary 纪律：被动压缩同样会原地改写
  // state.messages，因此 jsonl 也需要 compact-boundary 标记。
  void markBoundaryAndReflush(state)
  const beforeK = Math.round(tokensBefore / 1000)
  const afterK = Math.round(tokensAfter / 1000)
  callbacks.onContextCompressed(`上下文过长，已压缩（约 ${beforeK}k → ${afterK}k tokens）。正在重试……`)
  emitCompactionHook(hookCtx, {
    name: 'PostCompact',
    trigger: 'reactive',
    messageCount: state.messages.length,
    summary: '',
  })
  return true
}

/** 带上会话上下文触发 PreCompact / PostCompact hook。
 *  这里采用尽力而为策略，因为压缩本身已经发生或即将发生，不能让 hook
 *  的失败或中断反向影响主流程。 */
function emitCompactionHook(
  ctx: CompactionHookContext | undefined,
  partial:
    | { name: 'PreCompact'; trigger: 'proactive' | 'reactive'; messageCount: number; tokenEstimate: number }
    | { name: 'PostCompact'; trigger: 'proactive' | 'reactive'; messageCount: number; summary: string },
): void {
  if (!ctx?.hookBus?.has(partial.name)) return
  void ctx.hookBus
    .emit(
      {
        ...partial,
        session: { cwd: ctx.cwd, modelId: ctx.modelId },
      },
      { signal: ctx.abortSignal },
    )
    .catch((err) => debugLog(`agent.hook-${partial.name.toLowerCase()}-error`, String(err)))
}
