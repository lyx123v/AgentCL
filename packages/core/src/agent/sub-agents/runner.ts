// @x-code-cli/core — 子代理执行器
//
// 以嵌套 agentLoop 的方式执行子代理，并为它提供隔离上下文。
// 父代理只能拿到最终文本结果；中间的工具调用和消息都留在子循环内部。
import type { LanguageModel } from 'ai'

import { resolveModelId } from '../../config/index.js'
import type { HookBus } from '../../hooks/bus.js'
import type { HookEvent } from '../../hooks/types.js'
import type { AgentCallbacks, AgentOptions, TokenUsage } from '../../types/index.js'
import { debugLog } from '../../utils.js'
import { createLoopState } from '../loop-state.js'
import type { LoopState } from '../loop-state.js'
import { agentLoop } from '../loop.js'
import { buildSubAgentSystemPrompt } from '../system-prompt.js'
import type { SubAgentRegistry } from './registry.js'
import type { SubAgentDefinition } from './types.js'

/** 触发 SubagentStart / SubagentStop hook。
 *  这是尽力而为的行为；一旦父代理决定委派，子代理执行就是必要步骤，
 *  因此 hook 的失败或中止绝不能继续向外冒泡。 */
function emitSubAgentHook(
  bus: HookBus | undefined,
  event: HookEvent & { name: 'SubagentStart' | 'SubagentStop' },
  signal: AbortSignal | undefined,
): void {
  if (!bus?.has(event.name)) return
  void bus.emit(event, { signal }).catch((err) => debugLog(`agent.hook-${event.name.toLowerCase()}-error`, String(err)))
}

export interface RunSubAgentArgs {
  parentState: LoopState // 父代理当前的循环状态
  parentOptions: AgentOptions // 父代理执行选项
  callbacks: AgentCallbacks // 与父代理共用的回调集合
  toolCallId: string // 触发本次子代理的工具调用 id
  agentName: string // 要运行的子代理名称
  description: string // 本次委派任务描述
  prompt: string // 发送给子代理的完整提示词
  knowledgeContext: string // 注入子代理 system prompt 的知识上下文
  isGitRepo: boolean // 当前工作目录是否为 Git 仓库
}

export interface RunSubAgentResult {
  resultText: string // 返回给父代理的最终文本
  tokenUsage: TokenUsage // 本次子代理消耗的 Token 统计
  turnCount: number // 子代理实际执行轮数
  toolCallCount: number // 子代理触发的工具调用次数
  durationMs: number // 总耗时（毫秒）
  aborted: boolean // 是否由中断导致结束
}

/** 从消息数组中提取最后一段 assistant 文本，忽略 tool-call 片段。 */
function extractFinalText(messages: LoopState['messages']): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg || msg.role !== 'assistant') continue
    const content = msg.content
    if (typeof content === 'string') return content.trim()
    if (Array.isArray(content)) {
      const textParts = (content as Array<{ type?: string; text?: string }>)
        .filter((p) => p?.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text as string)
      const joined = textParts.join('').trim()
      if (joined) return joined
    }
  }
  return ''
}

/** 解析子代理应使用的模型，必要时回退到父代理模型。 */
function resolveSubModel(
  agentDef: SubAgentDefinition,
  parentOptions: AgentOptions,
  parentModel: LanguageModel,
): LanguageModel {
  if (!agentDef.model) return parentModel
  if (!parentOptions.modelRegistry) return parentModel

  const resolvedId = resolveModelId(agentDef.model)
  if (!resolvedId) return parentModel

  try {
    return parentOptions.modelRegistry.languageModel(resolvedId as `${string}:${string}`)
  } catch {
    debugLog('sub-agent.model', `解析模型 "${agentDef.model}" 失败，回退到父代理模型`)
    return parentModel
  }
}

/** 根据子代理定义和父代理权限模式构建工具过滤器。 */
function buildToolFilter(agentDef: SubAgentDefinition, parentPermissionMode: string) {
  const deny = [...(agentDef.disallowedTools ?? []), 'task']

  // 在 plan 模式下，general-purpose 子代理不允许使用写入类工具。
  if (parentPermissionMode === 'plan' && agentDef.name === 'general-purpose') {
    deny.push('writeFile', 'edit')
  }

  // `'*'` 是“所有工具”的通配符，对齐 Claude Code 中
  // `tools: ['*']` 的语义，供内置 general-purpose agent 使用。
  // 这里传 `undefined`，这样 `buildTools` 会跳过 allowlist 过滤，
  // 只应用明确的 deny 列表。否则 `['*']` 会被当成字面量工具名，
  // 进而把所有真实工具都错误过滤掉。
  const allow = agentDef.tools?.includes('*') ? undefined : agentDef.tools

  return {
    allow,
    deny,
  }
}

/** 运行子代理。
 *  这里需要父代理当前的 LanguageModel 实例，因为它会直接传给 agentLoop。 */
export async function runSubAgent(args: RunSubAgentArgs, parentModel: LanguageModel): Promise<RunSubAgentResult> {
  const {
    parentState,
    parentOptions,
    callbacks,
    toolCallId,
    agentName,
    description,
    prompt,
    knowledgeContext,
    isGitRepo,
  } = args
  const startTime = Date.now()

  const registry = parentOptions.subAgentRegistry as SubAgentRegistry | undefined
  if (!registry) {
    return {
      resultText: '[子代理系统尚未初始化]',
      tokenUsage: zeroUsage(),
      turnCount: 0,
      toolCallCount: 0,
      durationMs: 0,
      aborted: false,
    }
  }

  const agentDef = registry.get(agentName)
  if (!agentDef) {
    const available = registry.names().join(', ')
    return {
      resultText: `[未找到子代理 '${agentName}'。可用子代理：${available}]`,
      tokenUsage: zeroUsage(),
      turnCount: 0,
      toolCallCount: 0,
      durationMs: 0,
      aborted: false,
    }
  }

  // 通知 UI：子代理开始执行。
  callbacks.onSubAgentEvent?.({
    kind: 'start',
    toolCallId,
    agentName,
    description,
    prompt,
  })

  // 插件 hook：SubagentStart。在 agent 定义解析完成后、
  // 嵌套 agentLoop 运行前触发；失败不会阻止主流程。
  emitSubAgentHook(
    parentOptions.hookBus,
    {
      name: 'SubagentStart',
      session: { cwd: process.cwd(), modelId: parentOptions.modelId },
      agent: { name: agentName, description, prompt },
    },
    parentOptions.abortSignal,
  )

  const subModel = resolveSubModel(agentDef, parentOptions, parentModel)
  const subModelId = agentDef.model ? (resolveModelId(agentDef.model) ?? parentOptions.modelId) : parentOptions.modelId

  const subSystemPrompt = buildSubAgentSystemPrompt({
    agentPrompt: agentDef.prompt,
    knowledgeContext,
    isGitRepo,
  })

  const subState = createLoopState('default')
  subState.systemPromptCache = subSystemPrompt

  const toolFilter = buildToolFilter(agentDef, parentState.permissionMode)

  const subOptions: AgentOptions = {
    ...parentOptions,
    modelId: subModelId,
    maxTurns: agentDef.maxTurns,
    toolFilter,
    abortSignal: parentOptions.abortSignal,
    permissionMode: 'default',
    printMode: false,
    // 子代理不会再拿到自己的子代理注册表，避免递归调用。
    subAgentRegistry: undefined,
  }

  // 构建子代理回调：通过 onSubAgentEvent 把事件转发给父级 UI，
  // 但不要把子代理内部状态直接混进父代理状态。
  const subCallbacks: AgentCallbacks = {
    onTextDelta: (delta) => {
      callbacks.onSubAgentEvent?.({ kind: 'text-delta', toolCallId, delta })
    },
    onToolCall: (_subToolCallId, subToolName, subInput) => {
      callbacks.onSubAgentEvent?.({
        kind: 'tool-call',
        toolCallId,
        subToolName,
        subInput,
      })
      // 同时转发给父代理的 onToolProgress，保证实时状态提示能刷新。
      callbacks.onToolProgress(toolCallId, `${subToolName}: ${previewInput(subInput)}`)
    },
    onToolProgress: (_subToolCallId, message) => {
      callbacks.onToolProgress(toolCallId, message)
    },
    onToolResult: (subToolCallId, result, isError) => {
      const preview = result.length > 200 ? result.slice(0, 197) + '...' : result
      callbacks.onSubAgentEvent?.({
        kind: 'tool-result',
        toolCallId,
        subToolName: subToolCallId,
        resultPreview: preview,
        durationMs: 0,
        isError: isError ?? false,
      })
    },
    onFileEdit: callbacks.onFileEdit,
    onAskPermission: callbacks.onAskPermission,
    onAskUser: callbacks.onAskUser,
    onPlanApprovalRequest: callbacks.onPlanApprovalRequest,
    onPlanModeChange: () => {},
    onTodosUpdate: () => {},
    onShellOutput: callbacks.onShellOutput,
    onUsageUpdate: () => {},
    onContextCompressed: () => {},
    onError: (error) => {
      debugLog('sub-agent.error', `${agentName}: ${error.message}`)
    },
  }

  try {
    const { state: finalSubState, turnCount } = await agentLoop(prompt, subModel, subOptions, subCallbacks, subState)

    const finalText = extractFinalText(finalSubState.messages)
    const toolUseCount = countToolCalls(finalSubState.messages)

    // 将子代理的 Token 消耗累计回父代理。
    parentState.tokenUsage.inputTokens += finalSubState.tokenUsage.inputTokens
    parentState.tokenUsage.outputTokens += finalSubState.tokenUsage.outputTokens
    parentState.tokenUsage.totalTokens = parentState.tokenUsage.inputTokens + parentState.tokenUsage.outputTokens
    parentState.tokenUsage.cacheReadTokens += finalSubState.tokenUsage.cacheReadTokens
    parentState.tokenUsage.cacheCreationTokens += finalSubState.tokenUsage.cacheCreationTokens
    callbacks.onUsageUpdate(parentState.tokenUsage)

    const durationMs = Date.now() - startTime
    const resultText = finalText || '[子代理已完成，但没有生成最终回复]'

    callbacks.onSubAgentEvent?.({
      kind: 'end',
      toolCallId,
      finalText: resultText,
      tokenUsage: finalSubState.tokenUsage,
      turnCount,
      durationMs,
      aborted: false,
    })

    emitSubAgentHook(
      parentOptions.hookBus,
      {
        name: 'SubagentStop',
        session: { cwd: process.cwd(), modelId: parentOptions.modelId },
        agent: { name: agentName, description },
        durationMs,
        outcome: 'completed',
        tokenUsage: {
          inputTokens: finalSubState.tokenUsage.inputTokens,
          outputTokens: finalSubState.tokenUsage.outputTokens,
          totalTokens: finalSubState.tokenUsage.totalTokens,
        },
      },
      parentOptions.abortSignal,
    )

    if (turnCount >= agentDef.maxTurns && !finalText) {
      // 这里进入的是 !finalText 分支，因此 finalText 一定为空；
      // 且自上方提取后 messages 没再发生变化，所以 partial-output
      // 在这条路径上只能是 'none'。
      return {
        resultText: `[子代理达到最大轮数 (${agentDef.maxTurns}) 后仍未完成。部分输出：无]`,
        tokenUsage: finalSubState.tokenUsage,
        turnCount,
        toolCallCount: toolUseCount,
        durationMs,
        aborted: false,
      }
    }

    return {
      resultText: `<task_result>\n${resultText}\n</task_result>`,
      tokenUsage: finalSubState.tokenUsage,
      turnCount,
      toolCallCount: toolUseCount,
      durationMs,
      aborted: false,
    }
  } catch (err) {
    const durationMs = Date.now() - startTime

    // agentLoop 通常会在内部兜住 abort/error，并带着 outcome 正常返回。
    // 因此这里只有在某些异常穿透这些保护时才会进入，通常发生在准备阶段
    //（例如知识加载、slug 生成等）。这时子代理其实还没真正跑起来，
    // 所以把 turnCount 记为 0 是准确的。
    const fallbackTurnCount = 0

    if (isAbortError(err, parentOptions.abortSignal)) {
      const partial = extractFinalText(subState.messages)
      const text = partial
        ? `[子代理已被用户中断]\n\n部分输出：\n${partial}`
        : '[子代理已被用户中断]'
      const toolUseCount = countToolCalls(subState.messages)

      callbacks.onSubAgentEvent?.({
        kind: 'end',
        toolCallId,
        finalText: text,
        tokenUsage: subState.tokenUsage,
        turnCount: fallbackTurnCount,
        durationMs,
        aborted: true,
      })

      emitSubAgentHook(
        parentOptions.hookBus,
        {
          name: 'SubagentStop',
          session: { cwd: process.cwd(), modelId: parentOptions.modelId },
          agent: { name: agentName, description },
          durationMs,
          outcome: 'aborted',
        },
        parentOptions.abortSignal,
      )

      return {
        resultText: text,
        tokenUsage: subState.tokenUsage,
        turnCount: fallbackTurnCount,
        toolCallCount: toolUseCount,
        durationMs,
        aborted: true,
      }
    }

    const message = err instanceof Error ? err.message : String(err)
    debugLog('sub-agent.crash', `${agentName}: ${message}`)
    const toolUseCount = countToolCalls(subState.messages)

    callbacks.onSubAgentEvent?.({
      kind: 'end',
      toolCallId,
      finalText: `[子代理执行失败：${message}]`,
      tokenUsage: subState.tokenUsage,
      turnCount: fallbackTurnCount,
      durationMs,
      aborted: false,
    })

    emitSubAgentHook(
      parentOptions.hookBus,
      {
        name: 'SubagentStop',
        session: { cwd: process.cwd(), modelId: parentOptions.modelId },
        agent: { name: agentName, description },
        durationMs,
        outcome: 'failed',
      },
      parentOptions.abortSignal,
    )

    return {
      resultText: `[子代理执行失败：${message}]`,
      tokenUsage: subState.tokenUsage,
      turnCount: fallbackTurnCount,
      toolCallCount: toolUseCount,
      durationMs,
      aborted: false,
    }
  }
}

/** 判断错误是否属于用户中断或 AbortSignal 触发的取消。 */
function isAbortError(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true
  if (err instanceof Error) {
    if (err.name === 'AbortError') return true
    if (/aborted|AbortError/i.test(err.message)) return true
  }
  return false
}

/** 生成一份全零的 Token 使用统计，用作失败回退值。 */
function zeroUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    currentContextTokens: 0,
  }
}

/** 统计消息列表中包含了多少次工具调用。 */
function countToolCalls(messages: LoopState['messages']): number {
  let count = 0
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
    for (const part of msg.content as Array<{ type?: string }>) {
      if (part?.type === 'tool-call') count++
    }
  }
  return count
}

/** 生成工具输入的简短预览，供父级进度提示显示。 */
function previewInput(input: Record<string, unknown>): string {
  const val =
    (input.filePath as string) ??
    (input.command as string) ??
    (input.pattern as string) ??
    (input.query as string) ??
    (input.dirPath as string) ??
    ''
  return val.length > 80 ? val.slice(0, 77) + '...' : val
}
