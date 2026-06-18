// @x-code-cli/core — Agent 主循环（编排串流、工具调用与权限）
//
// 上下文压缩逻辑在 `./compression.ts`，这里主要负责编排每一轮的串流与工具分发。
import fs from 'node:fs/promises'
import path from 'node:path'

import { streamText } from 'ai'
import type { LanguageModel, UserContent } from 'ai'

import { aggregateUserPromptSubmit } from '../hooks/bus.js'
import type { HookEvent } from '../hooks/types.js'
import { buildKnowledgeContext } from '../knowledge/loader.js'
import { listMcpResources, readMcpResource } from '../mcp/resources.js'
import { bridgeMcpTool, toSystemPromptEntries } from '../mcp/tool-bridge.js'
import { applyCacheControl } from '../providers/cache-control.js'
import { getThinkingProviderOptions, mergeThinkingOptions } from '../providers/thinking.js'
import { createActivateSkillTool } from '../tools/activate-skill.js'
import { toolRegistry, truncateToolResult } from '../tools/index.js'
import { clearProgressReporter, setProgressReporter } from '../tools/progress.js'
import { createTaskTool } from '../tools/task.js'
import type { AgentCallbacks, AgentOptions } from '../types/index.js'
import { debugLog } from '../utils.js'
import { classifyApiError, isContextTooLongError } from './api-errors.js'
import { checkAndCompressContext, handleContextTooLong } from './compression.js'
import { getCompressionThreshold, getMaxOutputTokens } from './context-window.js'
import { createLoopState } from './loop-state.js'
import type { LoopState } from './loop-state.js'
import { runMemoryExtractor } from './memory-extractor.js'
import { generateTaskSlug, makePlanFilePath } from './plan-storage.js'
import { downgradeBinaryPartsForProvider, ensureReasoningContentParts } from './provider-compat.js'
import { appendCheckpoint, appendHeader, appendUsage, flushPendingMessages } from './session-store.js'
import { createCheckpoint } from './snapshot.js'
import { drainStreamResult } from './stream-utils.js'
import type { StreamResult } from './stream-utils.js'
import { buildSystemPrompt } from './system-prompt.js'
import { processToolCalls } from './tool-execution.js'
import { repairOrphanToolCalls, truncateToolResultsInMessages } from './tool-result-sanitize.js'

/** 在用户消息前插入一段插件注入的上下文。 */
function prependContext(userMessage: UserContent, context: string): UserContent {
  const block = `<plugin_context>\n${context}\n</plugin_context>\n\n`
  if (typeof userMessage === 'string') return block + userMessage
  return [{ type: 'text', text: block }, ...userMessage]
}

/** 从 UserContent 中提取纯文本，用于 slug 生成等元信息处理。 */
function userContentToText(content: UserContent): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(
        (p): p is { type: 'text'; text: string } =>
          p?.type === 'text' && typeof (p as { text?: unknown }).text === 'string',
      )
      .map((p) => p.text)
      .join(' ')
  }
  return ''
}

export type { LoopState } from './loop-state.js'
// Re-exported for the CLI's resume / manual-compact path (see use-agent.ts).
export { compressMessages } from './compression.js'

/** `agentLoop` 返回给调用方的结果。 */
export interface AgentLoopResult {
  /** 更新后的长生命周期会话状态。 */
  state: LoopState
  /** 本次调用内部实际运行了多少轮。 */
  turnCount: number
}

/** 消费 `streamText` 输出，并通过回调把增量内容分发给 UI。 */
async function streamChunksToUI(result: StreamResult, callbacks: AgentCallbacks): Promise<void> {
  for await (const chunk of result.fullStream) {
    if (chunk.type === 'error') {
      // AI SDK 在请求失败时不会直接让 fullStream 迭代抛错，而是产出一个
      // error chunk 后关闭流。这里要把原始错误重新抛出，避免后续只看到
      // NoOutputGeneratedError 这种泛化包装。
      throw chunk.error instanceof Error ? chunk.error : new Error(String(chunk.error))
    }
    if (chunk.type === 'text-delta') {
      const text = chunk.text ?? ''
      debugLog('stream.text-delta', text)
      callbacks.onTextDelta(text)
    } else if (chunk.type === 'tool-call') {
      debugLog('stream.tool-call', `${chunk.toolName ?? ''} ${JSON.stringify(chunk.input ?? {})}`)
      const toolCallId = chunk.toolCallId ?? ''
      // 必须在工具真正执行前先挂上进度通道，因为某些自动执行工具会立刻
      // 同步进入 execute，并在里面上报进度。
      if (toolCallId) {
        setProgressReporter(toolCallId, (msg) => callbacks.onToolProgress(toolCallId, msg))
      }
      callbacks.onToolCall(toolCallId, chunk.toolName ?? '', (chunk.input ?? {}) as Record<string, unknown>)
    } else if (chunk.type === 'tool-result') {
      // 把自动执行工具（如 readFile、glob、grep）的结果同步给 UI。
      const raw = typeof chunk.output === 'string' ? chunk.output : JSON.stringify(chunk.output ?? '')
      debugLog('stream.tool-result', `${chunk.toolCallId ?? ''} ${raw}`)
      if (chunk.toolCallId) clearProgressReporter(chunk.toolCallId)
      callbacks.onToolResult(chunk.toolCallId ?? '', truncateToolResult(raw))
    } else {
      debugLog('stream.other-chunk', chunk.type)
    }
    // reasoning 相关 chunk 故意不展示给用户，只在 debug 日志里保留。
  }
}

/** 从已完成的流式结果中提取响应与 usage，并合并回状态。 */
async function collectTurnResponse(
  result: StreamResult,
  state: LoopState,
  modelId: string,
  callbacks: AgentCallbacks,
): Promise<string> {
  const response = await result.response
  // 关键点：自动执行工具的结果会直接进入 `response.messages`，不会经过手动
  // pushToolResult。如果这里不清洗，大型文件读取或海量 grep 结果会直接污染
  // `state.messages`，并拖累后续每一轮上下文。
  truncateToolResultsInMessages(response.messages)
  state.messages.push(...response.messages)
  ensureReasoningContentParts(state.messages, modelId)

  const usage = await result.usage
  if (usage) {
    state.tokenUsage.inputTokens += usage.inputTokens ?? 0
    state.tokenUsage.outputTokens += usage.outputTokens ?? 0
    // AI SDK v6 会把 provider 的缓存字段统一映射到 inputTokenDetails 中。
    state.tokenUsage.cacheReadTokens += usage.inputTokenDetails?.cacheReadTokens ?? 0
    state.tokenUsage.cacheCreationTokens += usage.inputTokenDetails?.cacheWriteTokens ?? 0
    state.tokenUsage.totalTokens = state.tokenUsage.inputTokens + state.tokenUsage.outputTokens
    // 这里记录的是“当前上下文占用快照”，不是累计值。主流 provider 的上下文
    // 窗口本质上都共享输入与输出预算，因此这里直接用 input + output。
    state.tokenUsage.currentContextTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
    if (usage.inputTokens != null) state.lastInputTokens = usage.inputTokens
    callbacks.onUsageUpdate(state.tokenUsage)

    // ── 缓存命中异常检测 ──
    const turnCacheRead = usage.inputTokenDetails?.cacheReadTokens ?? 0
    if (state.expectCacheMiss) {
      state.expectCacheMiss = false
    } else if (state.prevTurnCacheRead > 2000 && turnCacheRead < state.prevTurnCacheRead * 0.5) {
      debugLog(
        'cache-break',
        `Cache read dropped ${state.prevTurnCacheRead} → ${turnCacheRead} (${Math.round((1 - turnCacheRead / state.prevTurnCacheRead) * 100)}% drop). Possible unintended cache invalidation.`,
      )
    }
    state.prevTurnCacheRead = turnCacheRead

    // 把 usage 快照写入 jsonl，这样即便进程异常退出，也尽量保留最后一轮统计。
    void appendUsage(state, modelId)
  }

  return result.finishReason
}

type TurnOutcome =
  /** 本轮正常结束，后续动作由 `finishReason` 决定。 */
  | { kind: 'done'; finishReason: string; result: StreamResult }
  /** 致命错误，且已通过 callbacks 上报。 */
  | { kind: 'error' }
  /** 本轮因上下文溢出被压缩，调用方应重试。 */
  | { kind: 'retry' }
  /** 用户主动中断请求。 */
  | { kind: 'aborted' }

/** 判断某个错误是否本质上表示“请求已被取消”。 */
function isAbortError(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true
  if (err instanceof Error) {
    if (err.name === 'AbortError') return true
    if (/aborted|AbortError/i.test(err.message)) return true
  }
  return false
}

/** 构建当前循环真正可用的工具集合。 */
function buildTools(options: AgentOptions) {
  // 这里复用现有工具注册表形状，暂时保留较宽松的工具类型。
  const tools: Record<string, any> = { ...toolRegistry }

  if (options.subAgentRegistry) {
    tools.task = createTaskTool(options.subAgentRegistry)
  }

  if (options.skillRegistry && options.skillRegistry.names().length > 0) {
    tools.activateSkill = createActivateSkillTool(options.skillRegistry)
  }

  // MCP 工具故意不带 `execute`，这样 AI SDK 会把它们保留在 `result.toolCalls`
  // 中，后续统一走权限、loop-guard 与 abortSignal 流程。
  if (options.mcpRegistry) {
    // 这两个 MCP 内置工具只在 MCP 启用时注册，避免模型在无上下文时
    // 幻觉出不存在的资源 URI。
    tools.listMcpResources = listMcpResources
    tools.readMcpResource = readMcpResource
    for (const entry of options.mcpRegistry.list()) {
      tools[entry.callableName] = bridgeMcpTool(entry)
    }
  }

  const filter = options.toolFilter
  if (filter) {
    if (filter.allow) {
      const allowSet = new Set(filter.allow)
      for (const name of Object.keys(tools)) {
        if (!allowSet.has(name)) delete tools[name]
      }
    }
    if (filter.deny) {
      for (const name of filter.deny) {
        delete tools[name]
      }
    }
  }

  return tools
}

/** 执行单个 agent turn：串流到 UI、收集响应，并对错误保持韧性。 */
async function runTurn(
  state: LoopState,
  model: LanguageModel,
  options: AgentOptions,
  systemPrompt: string,
  callbacks: AgentCallbacks,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  effectiveTools: Record<string, any>,
  /** 当前 turn 编号，仅用于调试日志标记。 */
  turn: number,
): Promise<TurnOutcome> {
  // 每次 API 调用前都做一次防御性清扫：如果历史中残留了孤立的 tool_call，
  // 就补一条合成 tool_result，保证请求体结构始终合法。
  repairOrphanToolCalls(state.messages)

  // 纯文本 provider 遇到 image/file part 会直接 400，因此发请求前要先降级成文本。
  await downgradeBinaryPartsForProvider(state.messages, options.modelId)

  // 不同 provider 的 prompt cache 机制不同，但目标都是尽量复用稳定前缀。
  const cached = applyCacheControl({
    system: systemPrompt,
    messages: state.messages,
    tools: effectiveTools,
    modelId: options.modelId,
    sessionId: state.sessionId,
  })

  // `/thinking on|off` 只是统一入口，真正下发时要翻译成各 provider 自己的选项格式。
  const thinkingOptions = getThinkingProviderOptions(options.modelId, options.thinking ?? false)
  const mergedProviderOptions = mergeThinkingOptions(cached.providerOptions, thinkingOptions)

  let result: StreamResult
  try {
    result = streamText({
      model,
      system: cached.system,
      messages: cached.messages,
      tools: cached.tools ?? effectiveTools,
      maxRetries: 3,
      abortSignal: options.abortSignal,
      // 显式设置输出上限，避免 provider 默认值静默截断长回答。
      maxOutputTokens: getMaxOutputTokens(options.modelId),
      // providerOptions 在类型层较宽松，这里集中在唯一调用点完成转换。
      providerOptions: mergedProviderOptions as Parameters<typeof streamText>[0]['providerOptions'],
      // 覆盖 SDK 默认的 stderr 原始错误输出，避免把庞大 RetryError 直接甩给用户。
      onError: ({ error }) => {
        if (process.env.DEBUG_STDOUT) debugLog('stream.onError', String(error))
      },
    }) as unknown as StreamResult
  } catch (err) {
    if (isAbortError(err, options.abortSignal)) return { kind: 'aborted' }
    callbacks.onError(new Error(classifyApiError(err).message))
    return { kind: 'error' }
  }

  // 在真正 await 这些兄弟 Promise 前先统一挂上 catch，避免 unhandled rejection。
  drainStreamResult(result)

  try {
    await streamChunksToUI(result, callbacks)
  } catch (err) {
    // 再次兜底清空未处理 Promise，防止 NoOutputGeneratedError 泄漏到 stderr。
    drainStreamResult(result)

    if (isAbortError(err, options.abortSignal)) return { kind: 'aborted' }
    if (isContextTooLongError(err)) {
      const compressed = await handleContextTooLong(state, model, callbacks, {
        hookBus: options.hookBus,
        modelId: options.modelId,
        cwd: process.cwd(),
        abortSignal: options.abortSignal,
      })
      // 压缩本身也需要一次 LLM 往返。如果用户在此期间已经取消，就直接结束。
      if (options.abortSignal?.aborted) return { kind: 'aborted' }
      if (compressed) return { kind: 'retry' }
    }
    callbacks.onError(new Error(classifyApiError(err).message))
    return { kind: 'error' }
  }

  try {
    const finishReason = await collectTurnResponse(result, state, options.modelId, callbacks)
    debugLog(
      'turn.finish',
      `reason=${finishReason} turn=${turn} input=${state.lastInputTokens} total=${state.tokenUsage.totalTokens}`,
    )
    return { kind: 'done', finishReason, result }
  } catch (err) {
    drainStreamResult(result)
    if (isAbortError(err, options.abortSignal)) return { kind: 'aborted' }
    callbacks.onError(new Error(classifyApiError(err).message))
    return { kind: 'error' }
  }
}

/** 主 agent 循环。 */
export async function agentLoop(
  userMessage: UserContent,
  model: LanguageModel,
  options: AgentOptions,
  callbacks: AgentCallbacks,
  existingState?: LoopState,
): Promise<AgentLoopResult> {
  const state = existingState ?? createLoopState(options.permissionMode ?? 'default')

  // ── 插件 Hook：SessionStart ──
  // 这是“会话首次调用”标记。虽然整体是 fire-and-forget 思路，但这里仍会等待，
  // 让 hook 有机会在真正开始处理用户输入前注入会话级环境或状态。

  // ── 插件 Hook：UserPromptSubmit ──
  // 该 hook 会在消息真正写入 state.messages 前运行；这样如果插件选择拒绝，
  // 就不会在会话记录里留下“悬空”的用户提示词。
  let effectiveUserMessage = userMessage
  if (options.hookBus?.has('UserPromptSubmit')) {
    const promptText = userContentToText(userMessage)
    try {
      const decisions = await options.hookBus.emit(
        { name: 'UserPromptSubmit', session: { cwd: process.cwd(), modelId: options.modelId }, prompt: promptText },
        { signal: options.abortSignal },
      )
      const effect = aggregateUserPromptSubmit(decisions)
      if (effect.decision === 'deny') {
        const reason = effect.reason ?? '被插件 hook 拦截'
        const notice = `[提示词已被插件 hook 拦截：${reason}]`
        callbacks.onTextDelta(notice)
        // 同时推入原始用户消息和一条合成 assistant 响应，保持消息序列依旧合法。
        state.messages.push({ role: 'user', content: userMessage })
        state.messages.push({ role: 'assistant', content: notice })
        return { state, turnCount: 0 }
      }
      if (effect.context) {
        effectiveUserMessage = prependContext(userMessage, effect.context)
      }
    } catch (err) {
      if (options.abortSignal?.aborted) {
        return { state, turnCount: 0 }
      }
      debugLog('agent.hook-user-prompt-error', String(err))
    }
  }

  state.messages.push({ role: 'user', content: effectiveUserMessage })

  // ── Rewind 检查点 ──
  // 这里会为当前已修改文件拍一个工作树快照，并记录当前消息索引锚点，
  // 供后续 `/rewind` 同时回滚文件状态与对话状态。
  if (options.subAgentRegistry) {
    const promptPreview = userContentToText(effectiveUserMessage).slice(0, 200)
    const ckpt = await createCheckpoint(state, promptPreview)
    if (ckpt) void appendCheckpoint(state, ckpt)
  }

  // 每次 agentLoop 调用都从 0 开始计 turn，避免跨提交累计导致错误触发 maxTurns。
  let turn = 0

  // 每个会话只在第一轮推导一次 task slug，后续会话文件命名都会复用它。
  const taskText = userContentToText(userMessage)
  // 去掉 <activated_skill> 注入块，保证 slug 与首条提示词反映的是用户真实意图。
  const taskTextForMeta = taskText.replace(/<activated_skill\b[^>]*>[\s\S]*?<\/activated_skill>/gi, '').trim()
  const taskSlugPromise: Promise<string> = state.taskSlug
    ? Promise.resolve(state.taskSlug)
    : generateTaskSlug(taskTextForMeta || taskText, model, options.modelId, options.abortSignal)

  // 会话续跑逻辑由 UI 显式处理，不再把续跑上下文自动注入到每一轮 system prompt 中。
  const fullKnowledgeContext = await buildKnowledgeContext()

  // 只检测一次当前目录是否为 git 仓库，避免每轮都碰磁盘。
  const isGitRepo = await fs
    .stat(path.join(process.cwd(), '.git'))
    .then(() => true)
    .catch(() => false)

  // 把知识上下文与 git 状态缓存到 state，供 sub-agent 复用。
  state.knowledgeContext = fullKnowledgeContext
  state.isGitRepo = isGitRepo

  // 这里立即等待 slug 结果，保证后续任何 usage 或 plan 文件写入都不会拿到空路径前缀。
  state.taskSlug = await taskSlugPromise

  // 计划文件路径也采用惰性推导，只在进入计划模式且还没有路径时生成一次。
  if (state.permissionMode === 'plan' && !state.currentPlanPath) {
    state.currentPlanPath = makePlanFilePath(taskText, { slug: state.taskSlug })
  }

  // 把会话头信息写入 jsonl；对 resume 来说这是幂等操作。
  void appendHeader(state, options.modelId, taskTextForMeta || taskText)

  const compressionThreshold = getCompressionThreshold(options.modelId)

  // 工具集合在整个会话内保持稳定，因此只需构建一次。
  const effectiveTools = buildTools(options)

  // 当 finishReason 为 `length` 时自动续写，避免模型在半句话时被截断。
  const MAX_CONTINUATIONS = 3
  let continuationAttempts = 0
  // 只有在正常 `stop` 结束时，才允许运行会后记忆提取器。
  let completedNormally = false

  // 若未设置 `maxTurns`，就一直运行到模型主动停止或用户中断为止。
  while (options.maxTurns === undefined || turn < options.maxTurns) {
    turn++

    // 先把上一轮尚未持久化的消息刷到 jsonl，再做压缩检查，避免压缩改写数组后
    // 造成磁盘状态与内存状态错位。
    void flushPendingMessages(state)

    await checkAndCompressContext(state, model, compressionThreshold, callbacks, {
      hookBus: options.hookBus,
      modelId: options.modelId,
      cwd: process.cwd(),
      abortSignal: options.abortSignal,
    })

    // system prompt 在同一会话中尽量只构建一次，以保持前缀字节稳定并最大化缓存命中。
    if (!state.systemPromptCache) {
      // 记录最终进入 system prompt 的技能名，便于核对禁用技能是否真的被过滤掉。
      if (options.skillRegistry) {
        const enabled = options.skillRegistry.list().map((s) => s.name)
        const disabled = options.skillRegistry
          .listAll()
          .filter((s) => s.disabled)
          .map((s) => s.name)
        debugLog('agent.skills.system-prompt', `enabled=[${enabled.join(',')}] disabled=[${disabled.join(',')}]`)
      }
      state.systemPromptCache = buildSystemPrompt({
        knowledgeContext: fullKnowledgeContext,
        modelId: options.modelId,
        isGitRepo,
        planMode: state.permissionMode === 'plan',
        planFilePath: state.currentPlanPath ?? undefined,
        // 只有 MCP 启用时才向 system prompt 附加 MCP 工具说明。
        mcpTools: options.mcpRegistry ? toSystemPromptEntries(options.mcpRegistry.list()) : undefined,
        skills: options.skillRegistry ? options.skillRegistry.list() : undefined,
      })
    }
    const systemPrompt = state.systemPromptCache

    const outcome = await runTurn(state, model, options, systemPrompt, callbacks, effectiveTools, turn)

    // ── 插件 Hook：TurnComplete ──
    // 无论正常结束、报错还是中断，都会尽力触发，让审计/通知类 hook 看见每一轮。
    if (options.hookBus?.has('TurnComplete')) {
      const event: HookEvent = {
        name: 'TurnComplete',
        session: { cwd: process.cwd(), modelId: options.modelId },
        turn,
        tokenUsage: {
          inputTokens: state.tokenUsage.inputTokens,
          outputTokens: state.tokenUsage.outputTokens,
          totalTokens: state.tokenUsage.totalTokens,
        },
      }
      void options.hookBus
        .emit(event, { signal: options.abortSignal })
        .catch((err) => debugLog('agent.hook-turn-complete-error', String(err)))
    }

    if (outcome.kind === 'error') break
    if (outcome.kind === 'aborted') break
    if (outcome.kind === 'retry') {
      // 经由被动压缩恢复成功的尝试不计入 turn 次数。
      turn--
      continue
    }

    if (outcome.finishReason === 'tool-calls') {
      // 只要工具轮次成功执行，就说明模型在推进任务，重置连续截断计数。
      continuationAttempts = 0
      let toolCalls: Awaited<StreamResult['toolCalls']>
      try {
        toolCalls = await outcome.result.toolCalls
      } catch (err) {
        if (isAbortError(err, options.abortSignal)) break
        callbacks.onError(new Error(classifyApiError(err).message))
        break
      }
      await processToolCalls(toolCalls, state, options, callbacks, model)
      // processToolCalls 在中断时会自行短路；这里直接跳过下一次 streamText。
      if (options.abortSignal?.aborted) break
      continue
    }

    if (outcome.finishReason === 'length') {
      if (continuationAttempts < MAX_CONTINUATIONS) {
        continuationAttempts++
        debugLog('turn.length-continuation', `attempt=${continuationAttempts}/${MAX_CONTINUATIONS} turn=${turn}`)
        // 给模型一个“从断点继续”的提示，但不直接显示给用户。
        state.messages.push({
          role: 'user',
          content:
            '输出 token 已达到上限。请直接续写，不要道歉，也不要复述总结。如果中断发生在一句话中间，就从中间继续，并把剩余工作拆成更小的部分。',
        })
        continue
      }
      callbacks.onError(
        new Error(`连续续写 ${MAX_CONTINUATIONS} 次后响应仍被截断。请改问更聚焦的问题。`),
      )
      break
    }

    if (outcome.finishReason === 'content-filter') {
      callbacks.onError(new Error('响应已被 provider 的内容过滤器中止。'))
    } else if (outcome.finishReason === 'stop') {
      completedNormally = true
    }

    break
  }

  // 只有真的设置了 maxTurns，且确实撞到了上限，同时模型又没在这一轮正常结束时，
  // 才报告“已达到最大轮数”。
  if (options.maxTurns !== undefined && turn >= options.maxTurns && !completedNormally) {
    callbacks.onError(new Error(`已达到最大轮数限制（${options.maxTurns}），agent 循环停止。`))
  }

  // 最后再 flush 一次，兜住因为 stop / error 直接退出而没被下一轮顶部刷盘的消息。
  void flushPendingMessages(state)

  // 会后记忆提取器只在正常 stop 后运行，并采用 fire-and-forget 方式，
  // 不阻塞用户继续输入。
  if (completedNormally && !options.abortSignal?.aborted) {
    void runMemoryExtractor({
      parentState: state,
      parentModel: model,
      abortSignal: options.abortSignal,
      onWrite: callbacks.onMemoryWrite,
    })
  }

  return { state, turnCount: turn }
}

/** 把内存中的消息同步到会话 jsonl。
 *  主要用于退出与清理路径，避免最后一轮内容丢失。 */
export async function saveSession(state: LoopState, _model: LanguageModel): Promise<void> {
  await flushPendingMessages(state)
}
