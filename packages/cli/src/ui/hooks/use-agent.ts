// @x-code-cli/cli - Agent 状态管理 hook
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  agentLoop,
  appendCheckpoint,
  appendInterrupted,
  buildUserContent,
  capabilitiesOf,
  classifyApiError,
  compressMessages,
  flushPendingMessages,
  hydrateLoopState,
  initMemories,
  loadPersistedRules,
  markBoundaryAndReflush,
  restoreCheckpoint,
  saveSession,
} from '@x-code-cli/core'
import { extractText } from '@x-code-cli/core'
import type {
  AgentCallbacks,
  AgentOptions,
  CheckpointEntry,
  DisplayMessage,
  DisplayToolCall,
  LanguageModel,
  LoadedSession,
  LoopState,
  PermissionMode,
  TodoItem,
  TokenUsage,
} from '@x-code-cli/core'

import { isCollapsibleReadOnlyTool } from '../utils.js'
import { useAgentDisplayHelpers } from './use-agent-display-helpers.js'
import { modelMessagesToDisplay, previewSubInput } from './use-agent-display.js'
import { extractLastAssistantText, useStreamBuffer } from './use-stream-buffer.js'

export interface PendingPermission {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  /** 当工具名解析到 MCP registry 条目时填充。
   *  保存未被改写的 `<server>/<rawName>` 对，方便对话框显示
   *  “MCP tool: filesystem/read_file”，而不是被改成 `filesystem__read_file`。
   *  这里查而不是放到 ChatInput 里，是为了让 registry 仍然保持为
   *  CLI 启动阶段的职责。 */
  mcp?: { serverName: string; rawName: string }
}

interface PendingQuestion {
  question: string
  options: { label: string; description: string; freeform?: boolean; preview?: string[] }[]
  resolve: (answer: string) => void
  /** 用户中断这一轮（Ctrl+C / Esc）时传给 `resolve` 的值，
   *  这样 agent loop 才能解除阻塞。
   *  plan 审批时传 `'No'`，可关闭的选择器传 `''`，
   *  askUser 则传中断提示文本。 */
  abortAnswer: string
  /** 当 Esc 应该直接关闭对话框时为 true（会解析为空字符串）。
   *  用户主动打开的选择器（`/syntax`、`/model` 等）会设置这个值，
   *  因为用户可能只是点开看看。
   *  AI 发起的问题（`onAskUser`、plan 审批）则保持 falsy，
   *  这样就不会悄悄给模型喂一个空答案。 */
  dismissible?: boolean
  layout?: 'compact' | 'compact-vertical'
}

/** 自动追加在末尾的选项，会打开一个内联文本输入框。
 *  这和 Claude Code 的 `__other__` 行一致：模型会通过 askUser 工具的 schema
 *  描述被告知不要自己再添加 “Other” 条目。
 *  UI 会在渲染时补上这一项，这样每个 askUser 对话框都能稳定切换到自由输入。 */
const OTHER_OPTION = {
  label: 'Other',
  description: 'Type a custom answer.',
  freeform: true as const,
}

/** 运行中的工具调用，会显示在 live/dynamic UI 区域。
 *  当模型在一轮里并行发出多个 tool call 时，这里会同时存在多条记录。
 *  `progress` 字段保存 `onToolProgress` 发来的最新进度消息，
 *  它会替换 `⎿` 行里通用的 “Running...” 兜底文案，
 *  对齐 Claude Code 的实时工具状态更新。 */
export interface ActiveToolCall {
  id: string
  toolName: string
  input: Record<string, unknown>
  progress?: string
  subToolHistory?: string[]
}

export interface AgentState {
  messages: DisplayMessage[]
  isLoading: boolean
  activeToolCalls: ActiveToolCall[]
  shellOutput: string
  permissionQueue: PendingPermission[]
  pendingQuestion: PendingQuestion | null
  usage: TokenUsage
  error: string | null
  /** 当前 live model id - 和 modelIdRef 对齐，这样 /model 变化时 UI 能重新渲染。 */
  modelId: string
  /** 当前会话的实时审批模式。
   *  和 `LoopState.permissionMode` 对齐，这样当模型或用户（通过 /plan）
   *  切换它时，底部 UI 指示器就能重新渲染。 */
  permissionMode: PermissionMode
  /** 由模型通过 `todoWrite` 维护的实时清单。
   *  当模型还没开始多步骤任务，或者所有项目完成后已被自动清空时，这里为空。
   *  它驱动 ChatInput 里 spinner 上方的待办面板。 */
  todos: TodoItem[]
  /** 粘性标志：当我们处于一串连续、可折叠的只读工具
   *  （Read / Glob / Grep / ListDir）中时为 true。
   *  它会让 spinner 在前一个读取结束、下一个读取开始之间的 50-200ms 空隙里
   *  继续显示 “Reading…”；没有它的话，链路中的每个工具之间都会闪回
   *  “Thinking…”，多秒读取过程中看到的状态会非常抖。
   *  在可折叠只读工具调用时设为 true；只要运行了非只读工具、模型开始输出文本、
   *  loop 结束或者用户中断，就置回 false。 */
  bufferingReads: boolean
  /** 在上下文压缩进行中时非空。
   *  用来驱动 spinner 文案，让用户看到当前处于哪个压缩阶段，
   *  而不是一个泛泛的 “Thinking…”。压缩结束时清空。 */
  compressionLabel: string | null
}

const initialState: Omit<AgentState, 'modelId' | 'permissionMode'> = {
  messages: [],
  isLoading: false,
  activeToolCalls: [],
  shellOutput: '',
  permissionQueue: [],
  pendingQuestion: null,
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    currentContextTokens: 0,
  },
  error: null,
  todos: [],
  bufferingReads: false,
  compressionLabel: null,
}

export function useAgent(initialModel: LanguageModel, options: AgentOptions, initialSession?: LoadedSession | null) {
  // 如果启动时带了预加载会话（--continue），就用它初始化 UI 状态，
  // 这样消息会在用户还没提交任何内容前就出现在 scrollback 里。
  // token 用量也会一并恢复，这样 /usage 一开始就显示正确总数。
  // loopStateRef 会在下面对应的 useEffect 里水合——ref 不能在 useState
  // initializer 里设，因为 useState 会比其他 hook 先执行。
  const [state, setState] = useState<AgentState>({
    ...initialState,
    modelId: options.modelId,
    permissionMode: options.permissionMode ?? 'default',
    messages: initialSession ? modelMessagesToDisplay(initialSession.messages) : initialState.messages,
    usage: initialSession ? { ...initialSession.tokenUsage } : initialState.usage,
  })

  const modelRef = useRef<LanguageModel>(initialModel)
  const modelIdRef = useRef<string>(options.modelId)
  /** 让 agentLoop 每次 submit 时都能读到最新的 state.permissionMode。
   *  loop 在开始时通过 options.permissionMode 读取它；进入 loop 之后，
   *  agent 的工具分发会直接修改 LoopState，我们再通过 onPlanModeChange
   *  回调把变化同步回这里。 */
  const permissionModeRef = useRef<PermissionMode>(options.permissionMode ?? 'default')
  /** 对齐 `state.activeToolCalls.length`，供 abort() 回调同步读取。
   *  这里不能依赖 React state 闭包，否则每次状态变化都要重绑回调，
   *  ChatInput 也得每次 render 重新挂键盘处理器。 */
  const activeToolCallsLenRef = useRef(0)
  // 让 /thinking 开关也保持最新，这样即使在会话中途切换，
  // agent loop 读到的也是最新值，做法和 modelIdRef 一样。
  // 初始值来自 CLI options（启动时会从 ~/.x-code/config.json 读取）。
  const thinkingRef = useRef<boolean>(options.thinking ?? false)
  const loopStateRef = useRef<LoopState | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const initializedRef = useRef(false)
  /** 以 toolCallId 为 key 的待处理工具调用。
   *  单个槽位扛不住一轮里的并行 tool call —— SDK 的事件顺序可能是
   *  tool-call A、tool-call B、tool-result A、tool-result B，
   *  这时候共享槽位会被覆盖，后面的结果就会掉进 “unknown” 标签。 */
  const pendingToolsRef = useRef<Map<string, { toolName: string; input: Record<string, unknown>; startedAt: number }>>(
    new Map(),
  )
  /** 以 toolCallId 为 key 的 edit 工具 diff payload。
   *  由 `onFileEdit` 填充（它会在工具执行里、`onToolResult` 之前触发），
   *  再由 `onToolResult` 取出并挂到新的 DisplayToolCall 上。
   *  这里单独分开存，是因为不是每个工具都会产生 diff，
   *  我们不想让待处理记录里塞一个默认空字段。 */
  const pendingEditDiffsRef = useRef<Map<string, import('@x-code-cli/core').EditDiffPayload>>(new Map())
  /** 与 `permissionQueue` 并行：用于 `onAskPermission` promise 的 resolver。
   *  放在 ref 里，是为了让 `abort()` 能在 `controller.abort()` 之前同步拒绝
   *  队列里的所有门禁；否则 core loop 会卡在第一个 shell 上，
   *  UI 里却还显示着过时的 Yes/No。 */
  const permissionResolversRef = useRef<Array<(decision: 'yes' | 'always' | 'no') => void>>([])

  /** 往 `messages` 里追加一条消息（供 stream buffer 使用）。 */
  const appendMessage = useCallback((msg: DisplayMessage) => {
    setState((prev) => ({ ...prev, messages: [...prev.messages, msg] }))
  }, [])

  const { appendTextDelta, flushBuffer, resetBuffer } = useStreamBuffer(appendMessage)

  // 保持 ref 与 state 同步，这样 abort() 就能在不依赖 state 闭包的情况下，
  // 在 `[Request interrupted by user]` 和 `... for tool use` 之间做判断。
  useEffect(() => {
    activeToolCallsLenRef.current = state.activeToolCalls.length
  }, [state.activeToolCalls.length])

  // 在首次渲染时，把预加载会话水合进 LoopState ref。
  // ref 不能在 useState 里初始化（useState 会先跑），所以放在这里。
  // 只执行一次，后面由 initializedRef 保护。
  // useEffect 的执行顺序也很关键：它会在 mount 后、但在 App 里的 initialPrompt
  // submit effect 之前运行。这样用户在恢复会话后第一次发送消息时，
  // agentLoop 就能看到 `existingState` 并继续同一段对话。
  useEffect(() => {
    if (initialSession && !loopStateRef.current) {
      loopStateRef.current = hydrateLoopState(initialSession, options.permissionMode ?? 'default')
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /** 初始化记忆，只做一次。
   *  项目上下文来自仓库根部的 AGENTS.md（会从 cwd 往上查找，和 Codex 的方式一致），
   *  而不是来自语言专属 manifest 扫描；后者会让工具更偏向 Node/TS 项目。 */
  const initialize = useCallback(async () => {
    if (initializedRef.current) return
    initializedRef.current = true
    await initMemories()
    loadPersistedRules(process.cwd())
  }, [])

  /** 提交一条用户消息。
   *
   *  `silent: true` 时，不把文本追加到 UI scrollback，但仍然会喂给模型
   *  （agentLoop 会自己把用户轮次塞进 loopState.messages）。
   *  这个参数用于 `/init` 这类会注入很长作者侧提示词的 slash 命令：
   *  用户已经通过 echoCommand 看到了 `/init`，再把完整 prompt 打进 scrollback
   *  只会制造噪音。spinner / abort signal / session save 仍然会正常执行。 */
  const submit = useCallback(
    async (text: string, submitOptions?: { silent?: boolean }) => {
      await initialize()

      setState((prev) => ({
        ...prev,
        isLoading: true,
        shellOutput: '',
        error: null,
        messages: submitOptions?.silent
          ? prev.messages
          : [...prev.messages, { id: Date.now().toString(), role: 'user', content: text, timestamp: Date.now() }],
      }))

      const controller = new AbortController()
      abortControllerRef.current = controller

      // Track whether the stream produced any text for this submit, so the
      // safety-net extraction below doesn't duplicate already-flushed text.
      let sawTextDelta = false

      const callbacks: AgentCallbacks = {
        onTextDelta: (delta) => {
          if (delta) {
            sawTextDelta = true
            // Text streaming breaks any in-flight read chain — flip the
            // spinner back to "Thinking" so the user doesn't see
            // "Reading…" while the model is actually generating prose.
            // Wrapped in a freshness check so we don't burn a setState
            // on every chunk; only the FIRST text delta after a read
            // chain causes a flip.
            setState((prev) => (prev.bufferingReads ? { ...prev, bufferingReads: false } : prev))
          }
          appendTextDelta(delta)
        },
        onToolCall: (toolCallId, toolName, input) => {
          // Drain the streaming-text buffer AND register the live tool row
          // in the same synchronous tick so React 18 auto-batching folds
          // both setStates into one render → one ChatInput frame → one
          // stdout.write. The previous 4ms `setTimeout` deferral was
          // designed to skip the "Running…" frame for sub-5ms tools, but
          // for slow tools (WebSearch, shell, network) it produced the
          // exact double-write pattern (text-commit frame, then 4ms later
          // tool-row frame) that surfaces as visible flicker on
          // text→tool-call transitions. Fast tools now flash a brief
          // "Running…" row before the result replaces it — acceptable
          // tradeoff: the slow-tool case is the dominant one in real use,
          // and the flash is shorter (~1 frame) than the previous flicker.
          flushBuffer()
          pendingToolsRef.current.set(toolCallId, { toolName, input, startedAt: Date.now() })
          // Update sticky read-chain flag synchronously alongside the
          // active-tool list. A collapsible tool extends the chain;
          // anything else (Edit/Write/Shell/Task) breaks it so the
          // spinner doesn't say "Reading…" while a write is happening.
          const isReadOnly = isCollapsibleReadOnlyTool(toolName)
          setState((prev) => ({
            ...prev,
            activeToolCalls: [...prev.activeToolCalls, { id: toolCallId, toolName, input }],
            bufferingReads: isReadOnly ? true : false,
          }))
        },
        onToolProgress: (toolCallId, message) => {
          setState((prev) => {
            const idx = prev.activeToolCalls.findIndex((t) => t.id === toolCallId)
            if (idx < 0) return prev
            const next = prev.activeToolCalls.slice()
            next[idx] = { ...next[idx], progress: message }
            return { ...prev, activeToolCalls: next }
          })
        },
        onFileEdit: (toolCallId, payload) => {
          // Stash the structured patch so the upcoming onToolResult can
          // attach it to the DisplayToolCall. Cleared in onToolResult so a
          // permission-denied / errored re-attempt of the same toolCallId
          // can't accidentally inherit a stale diff.
          pendingEditDiffsRef.current.set(toolCallId, payload)
        },
        onToolResult: (toolCallId, result, isError) => {
          const pending = pendingToolsRef.current.get(toolCallId)
          pendingToolsRef.current.delete(toolCallId)
          const editPayload = pendingEditDiffsRef.current.get(toolCallId)
          pendingEditDiffsRef.current.delete(toolCallId)
          const durationMs = pending ? Date.now() - pending.startedAt : 0
          setState((prev) => {
            const tc: DisplayToolCall = {
              id: `tc-${Date.now()}`,
              toolName: pending?.toolName ?? 'unknown',
              input: pending?.input ?? {},
              output: result,
              status: isError ? 'error' : 'completed',
              durationMs,
              ...(editPayload ? { editPayload } : {}),
            }
            return {
              ...prev,
              activeToolCalls: prev.activeToolCalls.filter((t) => t.id !== toolCallId),
              shellOutput: '',
              messages: [
                ...prev.messages,
                {
                  id: `tool-${Date.now()}`,
                  role: 'assistant',
                  content: '',
                  toolCalls: [tc],
                  timestamp: Date.now(),
                },
              ],
            }
          })
        },
        onAskPermission: (toolCall) => {
          return new Promise<'yes' | 'always' | 'no'>((resolve) => {
            permissionResolversRef.current.push(resolve)
            // MCP lookup: the registry holds the unmangled server + raw
            // tool name pair we need for the dialog title and the
            // always-allow label. Built-in tools miss the registry and
            // leave `mcp` undefined — ChatInput falls back to its
            // existing per-tool rendering for them.
            const mcpEntry = options.mcpRegistry?.get(toolCall.toolName)
            const entry: PendingPermission = {
              toolCallId: toolCall.toolCallId,
              toolName: toolCall.toolName,
              input: toolCall.input,
              mcp: mcpEntry ? { serverName: mcpEntry.serverName, rawName: mcpEntry.rawName } : undefined,
            }
            setState((prev) => ({ ...prev, permissionQueue: [...prev.permissionQueue, entry] }))
          })
        },
        onAskUser: (question, opts) => {
          return new Promise<string>((resolve) => {
            // In plan mode, append two UI-side meta options the model
            // doesn't see in its tool input. Mirrors Claude Code's
            // QuestionView footer (`Chat about this` /
            // `Skip interview and plan immediately`) — the model is
            // taught about them via the system-prompt overlay and
            // recognizes them by their literal label when they come
            // back as the answer.
            //
            // The trailing OTHER_OPTION is appended last so it's always
            // the final row regardless of plan-mode footer presence.
            const planMeta =
              permissionModeRef.current === 'plan'
                ? [
                    {
                      label: 'Chat about this',
                      description: 'Reply in conversation without picking an option above.',
                    },
                    {
                      label: 'Skip interview and plan immediately',
                      description: 'Stop the questions — produce the final plan now with everything gathered so far.',
                    },
                  ]
                : []
            const augmented = [...opts, ...planMeta, OTHER_OPTION]
            setState((prev) => ({
              ...prev,
              pendingQuestion: {
                question,
                options: augmented,
                resolve,
                abortAnswer: '[Request interrupted by user]',
                layout: 'compact-vertical',
              },
            }))
          })
        },
        onPlanApprovalRequest: (planText) => {
          // Two-step UX: commit the plan body to scrollback as a regular
          // assistant message (full markdown rendering — headings,
          // bullets, code blocks all look right) and then pop a tight
          // Yes/No dialog. Putting a 50-line plan body inside the
          // SelectOptions `question` field instead overflows the frame,
          // pushes Yes/No off-screen, and produces a wall of `?`-prefixed
          // raw markdown the user can't navigate. The plan file on disk
          // is still the authoritative copy — this scrollback render is
          // for inline review.
          appendMessage({
            id: `plan-approval-${Date.now()}`,
            role: 'assistant',
            content: planText,
            timestamp: Date.now(),
          })
          return new Promise<boolean>((resolve) => {
            // Delay opening the dialog so the plan-text commit
            // paints first — avoids a simultaneous commit+grow
            // that confuses the geometry engine.
            setTimeout(() => {
              setState((prev) => ({
                ...prev,
                pendingQuestion: {
                  question: 'Approve the plan above?',
                  options: [
                    { label: 'Yes', description: 'Exit plan mode and start implementing (writes auto-approved).' },
                    { label: 'No', description: 'Stay in plan mode and let the model revise.' },
                  ],
                  resolve: (answer) => resolve(answer === 'Yes'),
                  abortAnswer: 'No',
                },
              }))
            }, 0)
          })
        },
        onPlanModeChange: (mode) => {
          permissionModeRef.current = mode
          setState((prev) => ({ ...prev, permissionMode: mode }))
          // Mode is session-scoped (matches Claude Code) — not
          // persisted to user config. Each new session starts in
          // 'default' unless `--plan` was passed.
        },
        onTodosUpdate: (todos) => {
          // Direct mirror — the core agent has already validated the
          // shape and applied auto-clear semantics; we just store what
          // it gives us so ChatInput can re-render the todo panel.
          setState((prev) => ({ ...prev, todos }))
        },
        onSubAgentEvent: (event) => {
          if (event.kind === 'tool-call') {
            setState((prev) => {
              const idx = prev.activeToolCalls.findIndex((t) => t.id === event.toolCallId)
              if (idx < 0) return prev
              const tc = prev.activeToolCalls[idx]!
              const label = `${event.subToolName}: ${previewSubInput((event.subInput as Record<string, unknown>) ?? {})}`
              const history = [...(tc.subToolHistory ?? []), label]
              const next = prev.activeToolCalls.slice()
              next[idx] = { ...tc, progress: label, subToolHistory: history }
              return { ...prev, activeToolCalls: next }
            })
          }
          if (event.kind === 'end') {
            const turnInfo = `${event.turnCount}t`
            const tokInfo =
              event.tokenUsage.totalTokens > 1000
                ? `${(event.tokenUsage.totalTokens / 1000).toFixed(1)}k tok`
                : `${event.tokenUsage.totalTokens} tok`
            const durInfo =
              event.durationMs > 1000 ? `${(event.durationMs / 1000).toFixed(1)}s` : `${event.durationMs}ms`
            callbacks.onToolProgress(event.toolCallId, `Done (${turnInfo}, ${tokInfo}, ${durInfo})`)
          }
        },
        onShellOutput: (chunk) => {
          setState((prev) => ({ ...prev, shellOutput: prev.shellOutput + chunk }))
        },
        onUsageUpdate: (usage) => {
          setState((prev) => ({ ...prev, usage }))
        },
        onCompressionProgress: (description) => {
          setState((prev) => ({ ...prev, compressionLabel: description }))
        },
        onContextCompressed: (summary) => {
          setState((prev) => ({ ...prev, compressionLabel: null }))
          appendMessage({
            id: `compress-${Date.now()}`,
            role: 'assistant',
            content: summary,
            timestamp: Date.now(),
            kind: 'command-result',
          })
        },
        onError: (error) => {
          setState((prev) => ({ ...prev, error: error.message }))
        },
        onMemoryWrite: ({ scope, category, key, fact }) => {
          // Fire-and-forget extractor → may arrive after submit() resolved
          // and even into the next turn. We append directly to scrollback;
          // the cell-buffer renderer treats this like any other assistant
          // message and inserts it above the (now possibly active) input
          // box without disturbing whatever the user is typing.
          appendMessage({
            id: `mem-${Date.now()}-${key}`,
            role: 'assistant',
            content: `Remembered (${scope} · ${category}) \`${key}\`: ${fact}`,
            timestamp: Date.now(),
            kind: 'command-result',
          })
        },
      }

      try {
        // Resolve any @path / bare-path references in the input into proper
        // content parts (images for multimodal providers, extracted text for
        // PDF/Office/non-vision providers). Falls through to the plain-string
        // fast path when nothing attachable is detected.
        //
        // The onNotice callback surfaces ingest-time events (currently:
        // vision sub-agent caption emitted) as `⎿`-prefixed gray lines so
        // the user can see when a non-vision model's image was forwarded
        // to a sub-agent (Gemini, GLM-4V, etc.) instead of being OCR'd.
        const content = await buildUserContent(text, capabilitiesOf(modelIdRef.current), (notice) => {
          appendMessage({
            id: `ingest-notice-${Date.now()}`,
            role: 'assistant',
            content: notice,
            timestamp: Date.now(),
            kind: 'command-result',
          })
        })

        // agentLoop returns { state, turnCount } — we only keep the state
        // (long-lived session). turnCount is per-invocation and the main
        // interactive loop has no use for it (the cap mechanism is what
        // sub-agents and --print mode use).
        const agentResult = await agentLoop(
          content,
          modelRef.current,
          {
            ...options,
            modelId: modelIdRef.current,
            thinking: thinkingRef.current,
            // permissionMode only matters for the FIRST submit (when
            // createLoopState is called inside agentLoop). For subsequent
            // submits the existing LoopState carries the live mode, so
            // this read is just a no-op fallthrough.
            permissionMode: permissionModeRef.current,
            abortSignal: controller.signal,
          },
          callbacks,
          loopStateRef.current ?? undefined,
        )
        loopStateRef.current = agentResult.state

        // Finalize: drain whatever's left in the stream buffer into messages,
        // then clear the loading flag. As a safety net, if streaming produced
        // no text (e.g. the provider only emitted reasoning chunks before
        // the final text landed on `response.messages`), extract the last
        // assistant text from loopState so the user always sees a reply.
        flushBuffer()
        if (!sawTextDelta && loopStateRef.current) {
          const fallback = extractLastAssistantText(loopStateRef.current.messages)
          if (fallback) {
            appendMessage({
              id: `text-${Date.now()}`,
              role: 'assistant',
              content: fallback,
              timestamp: Date.now(),
            })
          }
        }
        pendingToolsRef.current.clear()
        setState((prev) => ({
          ...prev,
          isLoading: false,
          activeToolCalls: [],
          bufferingReads: false,
          compressionLabel: null,
        }))
      } catch (err) {
        pendingToolsRef.current.clear()
        // User-cancel path: agentLoop swallows AbortError into a clean
        // 'aborted' outcome and returns normally, so we shouldn't reach
        // here for an Esc/Ctrl+C abort. But if some unaborted-aware
        // helper (e.g. memory load) does throw mid-flight while the
        // controller is also aborted, suppress the error banner — the
        // `[Request interrupted by user]` notice that abort() already
        // wrote into messages is the user-visible signal we want.
        const wasAborted = controller.signal.aborted
        setState((prev) => ({
          ...prev,
          isLoading: false,
          activeToolCalls: [],
          bufferingReads: false,
          compressionLabel: null,
          error: wasAborted ? null : classifyApiError(err).message,
        }))
      }
    },
    [options, initialize, appendTextDelta, flushBuffer, appendMessage],
  )

  /** Resolve the first pending permission request and pop it from the queue */
  const resolvePermission = useCallback((decision: 'yes' | 'always' | 'no') => {
    setState((prev) => {
      const [head, ...tail] = prev.permissionQueue
      if (head) {
        const r = permissionResolversRef.current[0]
        queueMicrotask(() => {
          if (r !== undefined && permissionResolversRef.current[0] === r) {
            permissionResolversRef.current.shift()
            r(decision)
          }
        })
      }
      return { ...prev, permissionQueue: tail }
    })
  }, [])

  /** Resolve a pending question */
  const resolveQuestion = useCallback((answer: string) => {
    setState((prev) => {
      if (prev.pendingQuestion) {
        queueMicrotask(() => prev.pendingQuestion!.resolve(answer))
      }
      return { ...prev, pendingQuestion: null }
    })
  }, [])

  /** Pop a multi-choice question for the user. Same SelectOptions dialog
   *  that `askUser` uses, exposed for slash commands like /model that need
   *  an interactive picker. Returns a promise that resolves to the label
   *  the user chose (or the free-form "Other" text). */
  const askQuestion = useCallback(
    (
      question: string,
      options: { label: string; description: string; preview?: string[] }[],
      opts?: { layout?: 'compact' | 'compact-vertical'; noOther?: boolean },
    ) => {
      return new Promise<string>((resolve) => {
        const augmented = opts?.noOther ? options : [...options, OTHER_OPTION]
        setState((prev) => ({
          ...prev,
          pendingQuestion: {
            question,
            options: augmented,
            resolve,
            abortAnswer: '',
            dismissible: true,
            layout: opts?.layout,
          },
        }))
      })
    },
    [],
  )

  /** Abort the in-flight turn. Mirrors Claude Code's onCancel:
   *
   *    1. Flush any buffered streamed text into messages so the user sees
   *       what the model produced before pressing Esc.
   *    2. Append a `[Request interrupted by user]` (or `for tool use`)
   *       notice so both the UI and the next-turn model context show
   *       why the response stopped.
   *    3. Trigger AbortController so streamText / shell execa unwind.
   *
   *  No-op when nothing is in flight (no controller or already aborted).
   *  React state cleanup (isLoading=false, activeToolCalls=[]) happens in
   *  submit()'s success path once agentLoop returns the 'aborted' outcome.
   *
   *  Queued permission prompts and pending SelectOptions dialogs are
   *  resolved synchronously so `processToolCalls` cannot stay blocked on
   *  `await onAskPermission` / `onAskUser` after the user cancels. */
  const abort = useCallback(() => {
    const controller = abortControllerRef.current
    if (!controller || controller.signal.aborted) return

    // Drain the stream buffer first — appendMessage runs synchronously via
    // setState so the partial assistant reply lands BEFORE the interrupt
    // notice in scrollback order.
    flushBuffer()

    const forToolUse = activeToolCallsLenRef.current > 0
    const noticeText = forToolUse ? '[Request interrupted by user for tool use]' : '[Request interrupted by user]'

    appendMessage({
      id: `interrupt-${Date.now()}`,
      role: 'assistant',
      content: noticeText,
      timestamp: Date.now(),
      kind: 'command-result',
    })

    // Mirror the notice into the agent loop's message history so the next
    // turn's API call has explicit context that the previous turn was
    // user-interrupted — without it the model would see an unfinished
    // assistant message and might silently try to resume.
    if (loopStateRef.current) {
      loopStateRef.current.messages.push({ role: 'user', content: noticeText })
      // Persist the abort to the jsonl: drop an `interrupted` meta line
      // (informational — picker can show "interrupted" tags) and flush
      // the unsaved tail (which now includes the notice we just pushed)
      // so resume picks up exactly where the user stopped. Both are
      // fire-and-forget; never block the abort path on FS errors.
      void appendInterrupted(loopStateRef.current)
      void flushPendingMessages(loopStateRef.current)
    }

    // Unblock any `await onAskPermission` in the core loop (parallel tool
    // calls queue extra UI rows, but execution is sequential — the first
    // shell often sits here while the user thinks the UI is "frozen").
    const permResolvers = permissionResolversRef.current
    permissionResolversRef.current = []
    for (const r of permResolvers) r('no')

    // Unblock askUser / plan approval / slash pickers waiting on `pendingQuestion`.
    const pendingAbortRef: {
      current: { resolve: (answer: string) => void; abortAnswer: string } | null
    } = { current: null }
    setState((prev) => {
      const pq = prev.pendingQuestion
      pendingAbortRef.current = pq ? { resolve: pq.resolve, abortAnswer: pq.abortAnswer } : null
      return { ...prev, permissionQueue: [], pendingQuestion: null, bufferingReads: false }
    })
    const pa = pendingAbortRef.current
    if (pa) pa.resolve(pa.abortAnswer)

    controller.abort()
  }, [flushBuffer, appendMessage])

  /** Save session and cleanup */
  const cleanup = useCallback(async () => {
    if (loopStateRef.current) {
      await saveSession(loopStateRef.current, modelRef.current)
    }
  }, [])

  /** Synchronous snapshot of the live session for the post-exit hint
   *  printed by index.ts. Returns null when no LoopState exists yet
   *  (user launched but never submitted) — index.ts skips the hint in
   *  that case so we don't suggest resuming an empty file. */
  const getSessionInfo = useCallback(() => {
    const ls = loopStateRef.current
    if (!ls || ls.messages.length === 0) return null
    const firstUserMsg = ls.messages.find((m) => m.role === 'user')
    const firstPrompt = firstUserMsg ? extractText(firstUserMsg.content).slice(0, 80) : ''
    return { sessionId: ls.sessionId, taskSlug: ls.taskSlug, messageCount: ls.messages.length, firstPrompt }
  }, [])

  /** Clear conversation */
  const clear = useCallback(() => {
    loopStateRef.current = null
    pendingToolsRef.current.clear()
    permissionResolversRef.current = []
    resetBuffer()
    // Preserve the current live model id and approval mode when clearing
    // — user expects the model they just picked AND the plan-mode toggle
    // they just flipped to stay after /clear (which only nukes the
    // conversation, not session-wide settings).
    setState((prev) => ({ ...initialState, modelId: prev.modelId, permissionMode: prev.permissionMode }))
  }, [resetBuffer])

  /** Mid-session resume: hot-swap the agent state to a previously-saved
   *  session. Hydrates loopStateRef from the jsonl so the next agent
   *  submit appends to the SAME file (filename derives from sessionId +
   *  taskSlug, both preserved by hydrate). Live model and approval mode
   *  carry over from the current session; the resumed session's stored
   *  `modelId` is informational only (in /usage-history).
   *
   *  Display-side: we APPEND the converted history to whatever's already
   *  in `state.messages`. We can't replace, because ChatInput's
   *  scrollback-commit diff (`writtenMessageCountRef` in ChatInput.tsx)
   *  treats `messages` as append-only — the only reset trigger is
   *  `length < writtenCount`. Replacing 1 item with 6 leaves the diff
   *  pointing at the wrong slice and the user sees nothing. Appending
   *  matches Claude Code's scrollback discipline ("/resume just
   *  continues; the old prompt and the loaded history both stay
   *  visible") and avoids any diff edge case.
   *
   *  Transient UI state (activeToolCalls, shellOutput, todos, error)
   *  belongs to the OLD session and is reset — those tool calls /
   *  shells / checklists never ran for the loaded session. */
  const resume = useCallback(
    (loaded: LoadedSession) => {
      pendingToolsRef.current.clear()
      resetBuffer()
      loopStateRef.current = hydrateLoopState(loaded, permissionModeRef.current)
      const converted = modelMessagesToDisplay(loaded.messages)
      setState((prev) => ({
        ...prev,
        activeToolCalls: [],
        shellOutput: '',
        error: null,
        todos: [],
        messages: [...prev.messages, ...converted],
        usage: { ...loaded.tokenUsage },
      }))
    },
    [resetBuffer],
  )

  /** Read the live list of /rewind checkpoints for the current session.
   *  Empty when no session exists yet or when nothing has been
   *  checkpointed (the very first turn has no preceding state to
   *  rewind to). Returned as a fresh array so callers can build picker
   *  choices without aliasing the in-memory list. */
  const getCheckpoints = useCallback((): CheckpointEntry[] => {
    return loopStateRef.current?.checkpoints.slice() ?? []
  }, [])

  /** Rewind to a previous checkpoint: restore the working tree to that
   *  point and truncate the message history past it. Caller (App.tsx)
   *  is responsible for picking `ckptId` from `getCheckpoints()` and
   *  surfacing the result message.
   *
   *  Returns ok=false with a human-readable `reason` on any precondition
   *  failure (no session, unknown id, manifest missing) — callers should
   *  surface those via addInfoMessage rather than throwing in the UI.
   *
   *  Side effects on success:
   *    - working tree rolled back per checkpoint manifest
   *    - state.messages truncated to messageCount-1 (drops the user
   *      message that triggered the snapshot AND everything after)
   *    - session jsonl gains a compact-boundary so /resume sees the
   *      same truncated history
   *    - display messages array shrinks → ChatInput's shrink-detection
   *      wipes the scrollback and repaints with the truncated view */
  const rewind = useCallback(
    async (
      ckptId: string,
    ): Promise<{ ok: true; preview: string; messageCount: number } | { ok: false; reason: string }> => {
      const ls = loopStateRef.current
      if (!ls) return { ok: false, reason: 'No active session to rewind.' }
      // Refuse mid-turn: a write tool could be executing concurrently and
      // race us into a half-restored tree. Telling the user to Esc first
      // is cleaner than asking the FS scheduler to interleave it for us.
      if (state.isLoading) {
        return { ok: false, reason: 'A turn is in progress. Press Esc to cancel it, then run /rewind.' }
      }
      const target = ls.checkpoints.find((c) => c.ckptId === ckptId)
      if (!target) return { ok: false, reason: `Checkpoint not found: ${ckptId}` }

      // Restore working tree + trim state.checkpoints in place to the
      // prefix ending at the target. Partial-failure path leaves disk
      // half-restored; we surface the error rather than masking it.
      const ok = await restoreCheckpoint(ls, ckptId)
      if (!ok) {
        return { ok: false, reason: 'Failed to read checkpoint manifest — backups may have been cleaned up.' }
      }

      // Drop the user message that triggered this snapshot, plus every
      // assistant / tool entry the model emitted after it.
      const newLen = Math.max(0, target.messageCount - 1)
      ls.messages = ls.messages.slice(0, newLen)
      ls.persistedMessageCount = ls.messages.length

      // markBoundaryAndReflush writes a compact-boundary + reflushes the
      // (now-truncated) messages, so /resume on this jsonl reconstructs
      // the same state. It also clears state.checkpoints (compaction
      // semantics) — snapshot the surviving prefix beforehand and
      // re-append after, so the picker still offers them.
      const survivingCheckpoints = ls.checkpoints.slice()
      await markBoundaryAndReflush(ls)
      ls.checkpoints = survivingCheckpoints
      for (const c of survivingCheckpoints) {
        await appendCheckpoint(ls, c)
      }

      // Replace UI messages with the converted truncated view. ChatInput
      // sees length shrink below `writtenMessageCountRef` and wipes the
      // terminal + scrollback before repainting — matches the visual
      // semantics of /clear, only stopping at the rewind point.
      pendingToolsRef.current.clear()
      resetBuffer()
      const converted = modelMessagesToDisplay(ls.messages)
      setState((prev) => ({
        ...prev,
        activeToolCalls: [],
        shellOutput: '',
        error: null,
        todos: [],
        messages: converted,
      }))

      return { ok: true, preview: target.userPrompt, messageCount: newLen }
    },
    [resetBuffer, state.isLoading],
  )

  /** Manual context compression */
  const compact = useCallback(async (onProgress?: (description: string) => void) => {
    if (!loopStateRef.current) return null
    const { estimateTokenCount, KEEP_RECENT } = await import('@x-code-cli/core')
    if (loopStateRef.current.messages.length <= KEEP_RECENT) return null
    const before = estimateTokenCount(loopStateRef.current.messages)
    onProgress?.('Summarizing conversation...')
    loopStateRef.current.messages = await compressMessages(loopStateRef.current.messages, modelRef.current)
    const after = estimateTokenCount(loopStateRef.current.messages)
    return { beforeTokens: before, afterTokens: after }
  }, [])

  /** Switch model at runtime */
  const switchModel = useCallback((newModelId: string, newModel: LanguageModel) => {
    modelRef.current = newModel
    modelIdRef.current = newModelId
    setState((prev) => ({ ...prev, modelId: newModelId }))
  }, [])

  /** Flip extended-thinking on/off at runtime. Picked up by the next
   *  agent turn via thinkingRef.current. Persistence (saveUserConfig)
   *  happens in the App.tsx command handler, not here — keeping this
   *  hook free of disk side-effects matches the existing model-switch
   *  separation. */
  const setThinking = useCallback((enabled: boolean) => {
    thinkingRef.current = enabled
  }, [])

  /** Read the current /thinking toggle (for status display). */
  const getThinking = useCallback(() => thinkingRef.current, [])

  /** Drop the cached system prompt so the next agent turn rebuilds it
   *  with whatever the current tool surface looks like.
   *
   *  The cache is the tool-list + plan-overlay snapshot the agent loop
   *  builds at the start of every session and reuses across turns to
   *  preserve OpenAI-compatible providers' prefix caches. Anything that
   *  changes the visible tools — `/mcp refresh` adding or removing
   *  servers, `/mcp auth <name>` bringing a previously-needs_auth server
   *  online — MUST invalidate the cache so the next streamText call
   *  sends a prompt that matches the actual tool list. Otherwise the
   *  model would see tools that don't exist (or miss new ones), and
   *  the loop's `MCP tool not found: …` error path would fire. */
  const invalidateSystemPromptCache = useCallback(() => {
    if (loopStateRef.current) {
      loopStateRef.current.systemPromptCache = null
    }
  }, [])

  /** Set permission mode directly. Use this for /plan-style direct
   *  setters where the user is unambiguously asking for a specific
   *  target. Updates LoopState live (so the next agent turn picks up
   *  the new mode), invalidates the system-prompt cache (so the next
   *  turn rebuilds the prompt with the right overlay), reserves /
   *  clears the plan-file path, and mirrors the change into the React
   *  state for UI re-render. */
  const setPermissionMode = useCallback((next: PermissionMode) => {
    if (permissionModeRef.current === next) return
    permissionModeRef.current = next
    if (loopStateRef.current) {
      loopStateRef.current.permissionMode = next
      loopStateRef.current.systemPromptCache = null
      // Clear the path on leaving plan mode so a future re-entry gets a
      // fresh slug derived from whatever the user is asking next; the
      // path is re-derived lazily in agentLoop / enterPlanMode handler
      // from the next user message.
      if (next !== 'plan') loopStateRef.current.currentPlanPath = null
    }
    setState((prev) => ({ ...prev, permissionMode: next }))
  }, [])

  const { addInfoMessage, addUserMessage, echoCommand, addCommandMessage, addCommandResult } =
    useAgentDisplayHelpers(appendMessage)

  return {
    state,
    submit,
    resolvePermission,
    resolveQuestion,
    abort,
    cleanup,
    clear,
    compact,
    resume,
    rewind,
    getCheckpoints,
    getSessionInfo,
    switchModel,
    setThinking,
    getThinking,
    invalidateSystemPromptCache,
    setPermissionMode,
    addInfoMessage,
    addUserMessage,
    echoCommand,
    addCommandMessage,
    addCommandResult,
    askQuestion,
  }
}
