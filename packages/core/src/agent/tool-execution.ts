// @x-code-cli/core — 工具执行与分发
import fs from 'node:fs/promises'
import path from 'node:path'

import type { ModelMessage } from 'ai'

import { aggregatePostToolUse, aggregatePreToolUse } from '../hooks/bus.js'
import { classifyDecision } from '../mcp/permissions.js'
import { checkPermission } from '../permissions/index.js'
import { truncateToolResult } from '../tools/index.js'
import { clearProgressReporter, reportProgress } from '../tools/progress.js'
import { getShellProvider } from '../tools/shell-provider.js'
import type { AgentCallbacks, AgentOptions, LanguageModel } from '../types/index.js'
import { debugLog } from '../utils.js'
import { foldShellErrorNoise } from '../utils/shell-error.js'
import { computeEditDiff } from './diff.js'
import { checkForLoop, recordToolCall } from './loop-guard.js'
import type { LoopState } from './loop-state.js'
import { isToolErrorString, toolErrorFromUnknown, toolErrorString, toolResultMessage } from './messages.js'
import { handleEnterPlanMode, handleExitPlanMode, handleTodoWrite } from './plan-tools.js'
import { runSubAgent } from './sub-agents/runner.js'

/** 识别任意来源的 AbortError。这里保留本地实现
 *  （与 loop.ts 中的 helper 重复），是因为仅为这几行逻辑
 *  再抽一个公共模块并不划算。两处实现保持同样语义。 */
function isAbortError(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true
  if (err instanceof Error) {
    if (err.name === 'AbortError') return true
    if (/aborted|AbortError/i.test(err.message)) return true
  }
  return false
}

/** 统计子串出现次数，避免创建中间数组。 */
function countOccurrences(content: string, search: string): number {
  let count = 0
  let pos = 0
  while ((pos = content.indexOf(search, pos)) !== -1) {
    count++
    pos += search.length
  }
  return count
}

/** 执行写入类工具（writeFile / edit）。
 *
 *  除了返回给模型看的结果字符串外，它还会在 `callbacks.onFileEdit`
 *  存在时，把结构化 patch 一并回调给 UI，这样界面就能在工具条目下面
 *  渲染彩色 diff。这个 diff payload 只服务于 UI，不会写进
 *  `state.messages`，模型只能看到简短结果字符串。 */
async function executeWriteTool(
  toolName: string,
  input: Record<string, unknown>,
  toolCallId: string,
  callbacks: AgentCallbacks,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (toolName === 'writeFile') {
    const filePath = input.filePath as string
    const content = input.content as string
    reportProgress(toolCallId, `Writing ${filePath}`)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    // 写入前先读取旧内容，便于后续算 diff。任何读取失败都按“文件原本不存在”
    // 处理，既覆盖常见 ENOENT，也覆盖权限问题或 EISDIR 这类边界情况
    // （反正真正写入时本来也会报错）。
    let oldContent: string | null = null
    try {
      oldContent = await fs.readFile(filePath, { encoding: 'utf-8', signal })
    } catch {
      oldContent = null
    }
    await fs.writeFile(filePath, content, { encoding: 'utf-8', signal })
    const isNew = oldContent === null
    const parts = content.split('\n')
    const lineCount = content.endsWith('\n') ? parts.length - 1 : parts.length

    const payload = computeEditDiff(filePath, oldContent, content)
    if (payload && callbacks.onFileEdit) callbacks.onFileEdit(toolCallId, payload)

    if (isNew) {
      return `File created: ${filePath} (${lineCount} lines)`
    }
    return `File written: ${filePath} (${lineCount} lines)`
  }

  if (toolName === 'edit') {
    const filePath = input.filePath as string
    const oldString = input.oldString as string
    const newString = input.newString as string
    const replaceAll = (input.replaceAll as boolean) ?? false

    reportProgress(toolCallId, `Editing ${filePath}`)
    const content = await fs.readFile(filePath, { encoding: 'utf-8', signal })
    if (!replaceAll) {
      const count = countOccurrences(content, oldString)
      if (count === 0) return toolErrorString(`old_string not found in ${filePath}`)
      if (count > 1)
        return toolErrorString(
          `old_string is not unique in ${filePath} (found ${count} occurrences). Provide more context or set replaceAll: true.`,
        )
    }

    const newContent = replaceAll ? content.replaceAll(oldString, newString) : content.replace(oldString, newString)
    await fs.writeFile(filePath, newContent, { encoding: 'utf-8', signal })

    const payload = computeEditDiff(filePath, content, newContent)
    if (payload && callbacks.onFileEdit) callbacks.onFileEdit(toolCallId, payload)

    return `File edited: ${filePath}`
  }

  return toolErrorString('unknown write tool')
}

/** 以流式方式执行 shell 命令。 */
async function executeShell(
  command: string,
  timeout: number,
  signal: AbortSignal | undefined,
  callbacks: AgentCallbacks,
  toolCallId: string,
): Promise<{ output: string; isError: boolean }> {
  const proc = getShellProvider().spawn(command, { timeout, signal })

  reportProgress(toolCallId, 'Running command...')

  // 把实时进度更新节流到最多每 50ms 一次。
  // 原因是：PowerShell 的 `Format-Table` 等表格类命令会在大约 1ms 内
  // 爆发式输出很多行，而且每行都可能变成一次独立的 `data` 事件。
  // 如果不节流，我们会在每毫秒里多次 reportProgress，每次都会触发
  // setState → ChatInput render → 延迟 stdout 写入。虽然延迟队列能把
  // 多数突发合并进一帧，但如果 deferred-fire 定时器恰好在工具结果提交前
  // 约 1ms 触发，用户就会看到一次明显的“进度文字闪一下，随后结果块滚进来”。
  // 在源头节流后，更新频率降到每秒最多 20 次，既足够实时，又大幅降低
  // 与即将到来的 tool-result commit 冲突的概率。
  // 注意模型仍会通过 `result` 字段看到完整输出；这里节流的只有 UI 实时进度。
  let lastProgressTime = 0
  const PROGRESS_THROTTLE_MS = 50

  const onChunk = (chunk: Buffer) => {
    const s = chunk.toString()
    callbacks.onShellOutput(s)
    const now = Date.now()
    if (now - lastProgressTime < PROGRESS_THROTTLE_MS) return
    // 取当前 chunk 中最后一条非空行作为进度信息。
    // 对 tsc、测试套件这类长命令来说，最近一行最能代表“此刻正在发生什么”。
    const lines = s.split(/\r?\n/).filter((l) => l.trim().length > 0)
    const last = lines[lines.length - 1]
    if (last) {
      lastProgressTime = now
      const trimmed = last.length > 120 ? last.slice(0, 117) + '...' : last
      reportProgress(toolCallId, trimmed)
    }
  }

  proc.stdout?.on('data', onChunk)
  proc.stderr?.on('data', onChunk)

  const result = await proc
  // 把 PowerShell/cmd 的多行错误块压成单行，再交给模型。
  // Windows 下一个引号写错的命令，单次就可能吐出 5 到 10 行错误；
  // 如果模型反复重试，这些噪音堆积速度会远远快于真正有价值的诊断信息。
  // execa 的 stdout/stderr 类型声明是 `string | unknown[] | Uint8Array`，
  // 我们这里用的是默认字符串模式，所以断言基本安全，但仍保留非字符串兜底。
  const toStr = (v: unknown): string => (typeof v === 'string' ? v : '')
  let stdout = foldShellErrorNoise(toStr(result.stdout))
  let stderr = foldShellErrorNoise(toStr(result.stderr))

  // 当 execa 因超过 maxBuffer 杀掉子进程时，stdout/stderr 里仍然保留着
  // 已经产生的部分输出。这里明确补一条截断提示，避免模型在毫无提示下丢上下文。
  const isMaxBuffer = result.isMaxBuffer ?? false
  if (isMaxBuffer) {
    const INLINE_CAP = 30_000
    if (stdout.length > INLINE_CAP)
      stdout = stdout.slice(0, INLINE_CAP) + '\n... [stdout truncated — exceeded buffer limit]'
    if (stderr.length > INLINE_CAP)
      stderr = stderr.slice(0, INLINE_CAP) + '\n... [stderr truncated — exceeded buffer limit]'
  }

  const output = [stdout, stderr].filter(Boolean).join('\n').trim()
  if (result.exitCode !== 0 || isMaxBuffer) {
    const suffix = isMaxBuffer ? ' (output exceeded buffer limit)' : ''
    const text = output ? `${output}\nExit code ${result.exitCode}${suffix}` : `Exit code ${result.exitCode}${suffix}`
    return { output: text, isError: true }
  }
  return { output: output || 'Done', isError: false }
}

/** 把工具结果推入 state，并通知 UI。 */
function pushToolResult(
  state: LoopState,
  callbacks: AgentCallbacks,
  toolCallId: string,
  toolName: string,
  output: string,
  isError = false,
): void {
  state.messages.push(toolResultMessage(toolCallId, toolName, output))
  // 对手动分发的工具（shell、writeFile、edit、askUser）来说，
  // 这里顺手清掉进度上报器。自动执行工具会走 SDK stream 的 `tool-result`
  // 事件，并在那里清除；若这里再次调用，也只是无害 no-op。
  clearProgressReporter(toolCallId)
  callbacks.onToolResult(toolCallId, output, isError)
}

type ToolCall = {
  /** 工具名。 */
  toolName: string
  /** 工具调用 id。 */
  toolCallId: string
  /** 工具输入参数。 */
  input: Record<string, unknown>
}

/** 传给每个单工具 handler 的上下文对象，
 *  用来避免在调用点反复列出一串完全相同的位置参数。 */
interface HandlerCtx {
  /** 当前工具名。 */
  toolName: string
  /** 当前工具输入。 */
  input: Record<string, unknown>
  /** 当前工具调用 id。 */
  toolCallId: string
  /** 当前 loop 状态。 */
  state: LoopState
  /** agent 运行选项。 */
  options: AgentOptions
  /** UI/外部回调集合。 */
  callbacks: AgentCallbacks
  /** 当前 loop 对应的父级模型实例。 */
  parentModel: LanguageModel
}

/** 在 pushToolResult 外包一层 PostToolUse hook 触发逻辑。
 *  目前只有两处“真实成功结果”会走这里；错误、中断、权限拒绝等路径
 *  仍直接调用 pushToolResult，因为给“合成拒绝结果”也发 PostToolUse
 *  会让 hook 作者困惑。绕过路径（askUser / task / MCP resources）
 *  现在也还是直接 push，后续可以再统一。 */
async function pushSuccessfulToolResult(ctx: HandlerCtx, output: string, isError: boolean): Promise<void> {
  let effectiveOutput = output
  if (ctx.options.hookBus?.has('PostToolUse')) {
    try {
      const decisions = await ctx.options.hookBus.emit(
        {
          name: 'PostToolUse',
          session: { cwd: process.cwd(), modelId: ctx.options.modelId },
          tool: { name: ctx.toolName, args: ctx.input, callId: ctx.toolCallId, output, isError },
        },
        { signal: ctx.options.abortSignal },
      )
      const effect = aggregatePostToolUse(decisions)
      if (effect.output !== undefined) effectiveOutput = effect.output
    } catch (err) {
      if (ctx.options.abortSignal?.aborted) return
      debugLog('agent.hook-post-tool-error', String(err))
    }
  }
  pushToolResult(ctx.state, ctx.callbacks, ctx.toolCallId, ctx.toolName, effectiveOutput, isError)
}

type ToolHandler = (ctx: HandlerCtx) => Promise<void>

/** ── askUser ──
 *  这里有意绕过 loop guard。模型重复向用户追问同一个澄清问题，
 *  大多数时候都是有意为之（例如用户回答得仍然模糊），如果拦住反而会悄悄破坏 UX。 */
async function handleAskUser(ctx: HandlerCtx): Promise<void> {
  const { input, toolCallId, toolName, state, callbacks } = ctx
  const question = input.question as string
  const optionsList = input.options as { label: string; description: string }[]
  const answer = await callbacks.onAskUser(question, optionsList)
  pushToolResult(state, callbacks, toolCallId, toolName, `User answered: ${answer}`)
}

/** ── task（分发给子 agent）── */
async function handleTask(ctx: HandlerCtx): Promise<void> {
  const { input, toolCallId, toolName, state, options, callbacks, parentModel } = ctx
  const agentName = input.subagent_type as string
  const description = input.description as string
  const taskPrompt = input.prompt as string

  reportProgress(toolCallId, `Task: ${description} (${agentName})`)

  const result = await runSubAgent(
    {
      parentState: state,
      parentOptions: options,
      callbacks,
      toolCallId,
      agentName,
      description,
      prompt: taskPrompt,
      knowledgeContext: state.knowledgeContext ?? '',
      isGitRepo: state.isGitRepo ?? false,
    },
    parentModel,
  )

  const statsLine = `<task_stats tool_calls="${result.toolCallCount}" tokens="${result.tokenUsage.totalTokens}" duration_ms="${result.durationMs}" />`
  pushToolResult(state, callbacks, toolCallId, toolName, `${result.resultText}\n${statsLine}`)
}

/** ── listMcpResources ──
 *  纯读取内存 registry，无副作用，因此不需要 loop-guard 或权限检查。
 *  server 过滤条件是可选的。 */
async function handleListMcpResources(ctx: HandlerCtx): Promise<void> {
  const { input, toolCallId, toolName, state, options, callbacks } = ctx
  const registry = options.mcpRegistry
  if (!registry) {
    pushToolResult(state, callbacks, toolCallId, toolName, toolErrorString('MCP not configured'), true)
    return
  }
  const filter = (input.server as string | undefined)?.trim() || undefined
  const items = registry.listResources().filter((r) => !filter || r.serverName === filter)
  if (items.length === 0) {
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      toolName,
      filter ? `No resources on server "${filter}".` : 'No resources from any connected MCP server.',
    )
    return
  }
  const lines = items.map((r) => {
    const mime = r.mimeType ? ` (${r.mimeType})` : ''
    const desc = r.description ? `\n    ${r.description}` : ''
    return `${r.uri}\t[${r.serverName}] ${r.name}${mime}${desc}`
  })
  pushToolResult(state, callbacks, toolCallId, toolName, lines.join('\n'))
}

/** ── readMcpResource ──
 *  转发给资源所属 server 的 client 执行。错误和中断处理方式
 *  与普通 MCP 工具调用保持一致。 */
async function handleReadMcpResource(ctx: HandlerCtx): Promise<void> {
  const { input, toolCallId, toolName, state, options, callbacks } = ctx
  const registry = options.mcpRegistry
  if (!registry) {
    pushToolResult(state, callbacks, toolCallId, toolName, toolErrorString('MCP not configured'), true)
    return
  }
  const uri = (input.uri as string | undefined) ?? ''
  if (!uri) {
    pushToolResult(state, callbacks, toolCallId, toolName, toolErrorString('Missing `uri` argument'), true)
    return
  }
  const client = registry.resourceServer(uri)
  if (!client) {
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      toolName,
      toolErrorString(`Resource URI not known: ${uri} — call listMcpResources first`),
      true,
    )
    return
  }
  reportProgress(toolCallId, `Reading ${uri}`)
  try {
    const result = await client.readResource(uri, options.abortSignal)
    pushToolResult(state, callbacks, toolCallId, toolName, truncateToolResult(result.text))
  } catch (err) {
    if (isAbortError(err, options.abortSignal)) {
      pushToolResult(state, callbacks, toolCallId, toolName, '[Tool execution interrupted by user]', true)
      return
    }
    pushToolResult(state, callbacks, toolCallId, toolName, toolErrorFromUnknown(err), true)
  }
}

/** 这些是会绕过 loop guard，以及下方 writeFile/edit/shell
 *  权限检查与执行流水线的“手动工具”。
 *  每个 handler 都自己负责 pushToolResult。要新增一个 bypass 工具，
 *  只需要在这里补一条映射。 */
const BYPASS_LOOP_GUARD_HANDLERS: Record<string, ToolHandler> = {
  askUser: handleAskUser,
  task: handleTask,
  todoWrite: ({ input, toolCallId, state, callbacks }) =>
    handleTodoWrite(input, toolCallId, state, callbacks, pushToolResult),
  enterPlanMode: ({ input, toolCallId, state, options, callbacks }) =>
    handleEnterPlanMode(input, toolCallId, state, options, callbacks, pushToolResult),
  exitPlanMode: ({ input, toolCallId, state, callbacks }) =>
    handleExitPlanMode(input, toolCallId, state, callbacks, pushToolResult),
  listMcpResources: handleListMcpResources,
  readMcpResource: handleReadMcpResource,
}

/** 为非 bypass 工具运行 loop-guard 逻辑。
 *  如果返回 true，表示这个工具调用已经被拦截，调用方应停止继续分发。
 *
 *  自动执行工具不会走到这里，因为 `processToolCalls` 更早就会跳过它们：
 *  这些工具的结果已经通过 SDK 的 `response.messages` 写进 `state.messages`，
 *  如果这里再次跑 loop-guard，要么会重复推入合成结果，
 *  要么会在一次迭代中插入用户消息，破坏严格 provider 要求的
 *  assistant→tool 顺序。
 *
 *  `deferred` 用来暂存那些必须落在“本轮所有 tool result 之后”的消息；
 *  如果在循环中途直接 push，就会形成
 *  `assistant → tool A → user → tool B` 结构，而 DeepSeek 会因此 400。 */
async function applyLoopGuard(ctx: HandlerCtx, deferred: ModelMessage[]): Promise<boolean> {
  const { toolName, input, toolCallId, state, callbacks } = ctx
  const loopCheck = checkForLoop(state, toolName, input, toolCallId)

  if (loopCheck.kind === 'ok') {
    recordToolCall(state, toolName, input, loopCheck.hash)
    return false
  }

  recordToolCall(state, toolName, input, loopCheck.hash)
  const guardMessage = `[loop-guard] ${loopCheck.message}`
  // 对手动工具来说，直接通过合成结果短路即可。真正的工具体不会执行，
  // 因而既没有副作用，也不会弹权限提示。
  pushToolResult(state, callbacks, toolCallId, toolName, guardMessage, true)

  if (loopCheck.kind === 'hard-block') {
    const answer = await callbacks
      .onAskUser(`The model keeps calling ${toolName} with identical arguments. How do you want to proceed?`, [
        { label: 'Pause', description: 'Pause the turn — you can type a new instruction.' },
        { label: 'Continue', description: 'Let the model keep trying; the loop guard stays armed.' },
      ])
      .catch(() => 'Pause')
    if (answer.toLowerCase().startsWith('pause')) {
      // 清空 recent-calls 窗口，避免下一回合在用户明确授意下
      // 合法地重试同样参数时，guard 立刻再次触发。
      state.recentToolCalls = []
      // 延迟到本轮迭代结束后再插入，确保 user 角色消息落在本轮消息末尾，
      // 而不是夹在两个 tool result 之间。
      deferred.push({
        role: 'user',
        content: '[loop-guard] User paused the loop. Wait for further instructions rather than calling more tools.',
      })
    }
  }
  return true
}

/** writeFile/edit/shell 的权限闸门。
 *  返回 true 表示可以继续执行；返回 false 表示已被拦截、拒绝或中断。 */
async function checkWriteOrShellPermission(ctx: HandlerCtx): Promise<boolean> {
  const { toolName, input, toolCallId, state, options, callbacks } = ctx
  if (toolName !== 'writeFile' && toolName !== 'edit' && toolName !== 'shell') return true

  const approved = await checkPermission(
    { toolCallId, toolName, input },
    options.trustMode,
    callbacks.onAskPermission,
    state.permissionMode,
    process.cwd(),
  )
  if (options.abortSignal?.aborted) {
    pushToolResult(state, callbacks, toolCallId, toolName, '[Tool execution interrupted by user]', true)
    return false
  }
  if (!approved) {
    pushToolResult(state, callbacks, toolCallId, toolName, 'Permission denied by user.')
    return false
  }
  return true
}

/** 运行 writeFile/edit/shell 这类带副作用工具的底层执行体。
 *  自动执行工具会提前返回，因为 AI SDK 已经为它们产出了结果。
 *  返回值是执行后的 `{ output, isError }`，若没有任何需要 push 的内容
 *  （即自动执行路径），则返回 null。 */
async function executeWriteOrShell(ctx: HandlerCtx): Promise<{ output: string; isError: boolean } | null> {
  const { toolName, input, toolCallId, state, options, callbacks } = ctx
  try {
    if (toolName === 'writeFile' || toolName === 'edit') {
      const output = await executeWriteTool(toolName, input, toolCallId, callbacks, options.abortSignal)
      // executeWriteTool 对某些“带内失败”（例如没匹配到 oldString、
      // 匹配结果不唯一）返回的是 `"Error: ..."` 字符串，而不是抛异常；
      // 这里把它们标成 error 结果，这样滚动区里的条目会正确变红。
      const isError = isToolErrorString(output)
      if (!isError) state.filesModified.add(input.filePath as string)
      return { output, isError }
    }
    if (toolName === 'shell') {
      const timeout = (input.timeout as number) ?? 30000
      const shellResult = await executeShell(
        input.command as string,
        timeout,
        options.abortSignal,
        callbacks,
        toolCallId,
      )
      return { output: shellResult.output, isError: shellResult.isError }
    }
    // 带 execute 的工具（如 readFile、glob、grep 等）都由 AI SDK 自动执行。
    return null
  } catch (err) {
    return { output: toolErrorFromUnknown(err), isError: true }
  }
}

/** 处理单个工具调用，直到它被完整分发完成才返回。
 *  `parentModel` 是当前 loop 使用的 LanguageModel 实例；
 *  task 工具在子 agent 没有覆盖模型时，需要把它作为 fallback 传下去。
 *  `deferred` 是按 turn 维度共享的延迟消息队列，会一路传给 `applyLoopGuard`；
 *  这里收集到的消息会在 `processToolCalls` 里整轮结束后统一 flush。 */
async function handleToolCall(
  tc: ToolCall,
  state: LoopState,
  options: AgentOptions,
  callbacks: AgentCallbacks,
  parentModel: LanguageModel,
  deferred: ModelMessage[],
): Promise<void> {
  const ctx: HandlerCtx = {
    toolName: tc.toolName,
    input: tc.input,
    toolCallId: tc.toolCallId,
    state,
    options,
    callbacks,
    parentModel,
  }

  // ── 插件钩子：PreToolUse ──
  // 它会在 bypass handler 路由和 MCP 分发之前触发，因此 hook 能看到
  // 模型尝试调用的每一个工具（包括 askUser、task 和 MCP 工具）。
  // deny 会变成模型可见的合成 tool_result，以保持 state.messages 合法。
  // modify 则可以改写输入参数；这里直接原地修改 ctx.input，
  // 这样下游 handler 和 loop guard 看到的都是更新后的参数。
  if (ctx.options.hookBus?.has('PreToolUse')) {
    try {
      const decisions = await ctx.options.hookBus.emit(
        {
          name: 'PreToolUse',
          session: { cwd: process.cwd(), modelId: ctx.options.modelId },
          tool: { name: ctx.toolName, args: ctx.input, callId: ctx.toolCallId },
        },
        { signal: ctx.options.abortSignal },
      )
      const effect = aggregatePreToolUse(decisions)
      if (effect.decision === 'deny') {
        const reason = effect.reason ?? 'blocked by plugin hook'
        pushToolResult(
          state,
          callbacks,
          ctx.toolCallId,
          ctx.toolName,
          toolErrorString(`Tool denied by plugin hook: ${reason}`),
          true,
        )
        return
      }
      if (effect.args && typeof effect.args === 'object' && !Array.isArray(effect.args)) {
        ctx.input = effect.args as Record<string, unknown>
      }
    } catch (err) {
      if (ctx.options.abortSignal?.aborted) return
      debugLog('agent.hook-pre-tool-error', String(err))
    }
  }

  const bypassHandler = BYPASS_LOOP_GUARD_HANDLERS[ctx.toolName]
  if (bypassHandler) {
    await bypassHandler(ctx)
    return
  }

  // MCP 工具走它们自己那套权限路径（逐工具询问 + always-allow 持久化），
  // 而不是复用 writeFile/edit/shell 的规则。但它们仍然要经过 loop-guard，
  // 防止模型在失败的 MCP 调用上无限打转。
  //
  // 这里按 registry 查表而不是按名字模式路由：MCP 工具名形如
  // `<server>__<tool>`，没有特殊前缀，因此判断“是不是 MCP 工具”
  // 的唯一权威依据就是“它是否注册在 MCP registry 中”。
  if (ctx.options.mcpRegistry?.get(ctx.toolName)) {
    await handleMcpToolCall(ctx, deferred)
    return
  }

  if (await applyLoopGuard(ctx, deferred)) return
  if (!(await checkWriteOrShellPermission(ctx))) return

  const result = await executeWriteOrShell(ctx)
  if (result == null) return

  await pushSuccessfulToolResult(ctx, truncateToolResult(result.output), result.isError)
}

/** 分发一个 MCP 工具调用。它与上面的 writeFile/edit/shell 流水线平行：
 *  复用相同的 loop-guard 和中断处理思路，但权限来源换成逐工具权限存储，
 *  实际执行则走 MCP registry 的 callTool。 */
async function handleMcpToolCall(ctx: HandlerCtx, deferred: ModelMessage[]): Promise<void> {
  const { toolName, input, toolCallId, state, options, callbacks } = ctx
  const registry = options.mcpRegistry
  const permissions = options.mcpPermissionStore

  if (!registry) {
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      toolName,
      toolErrorString(`MCP not configured; tool ${toolName} unavailable`),
      true,
    )
    return
  }

  const entry = registry.get(toolName)
  if (!entry) {
    pushToolResult(state, callbacks, toolCallId, toolName, toolErrorString(`MCP tool not found: ${toolName}`), true)
    return
  }

  // 先跑 loop-guard：即便是因为 mode 被拒绝的调用，也依然算模型“尝试”
  // 做了一件事，因此我们同样希望拦住“不断被拒绝的死循环”。
  if (await applyLoopGuard(ctx, deferred)) return

  // 在 plan mode 下，MCP 工具本质上是黑盒，我们无法预先判断它们是否写入。
  // 因此唯一安全的策略就是统一拒绝。模型会把这个拒绝当作 tool result
  // 看到；如果它确实需要外部工具继续推进，就应主动调用 exitPlanMode。
  if (state.permissionMode === 'plan') {
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      toolName,
      'MCP tools are disabled in plan mode. Call exitPlanMode first if you need this tool.',
      true,
    )
    return
  }

  // 权限闸门：trustMode 直接放行；否则先查权限存储
  // （包括 session 级和持久化级），再退回到询问用户。
  let approved = options.trustMode
  if (!approved && permissions) approved = await permissions.isApproved(toolName)

  if (!approved) {
    let decision: 'yes' | 'always' | 'no'
    try {
      decision = await callbacks.onAskPermission({ toolCallId, toolName, input })
    } catch (err) {
      if (isAbortError(err, options.abortSignal)) {
        pushToolResult(state, callbacks, toolCallId, toolName, '[Tool execution interrupted by user]', true)
        return
      }
      throw err
    }
    if (options.abortSignal?.aborted) {
      pushToolResult(state, callbacks, toolCallId, toolName, '[Tool execution interrupted by user]', true)
      return
    }
    const choice = classifyDecision(decision)
    if (choice === 'deny') {
      pushToolResult(state, callbacks, toolCallId, toolName, 'Permission denied by user.')
      return
    }
    if (permissions) {
      if (choice === 'allow-always') await permissions.approvePermanently(toolName)
      else permissions.approveForSession(toolName)
    }
  }

  // 真正执行。abortSignal 会一路传到 SDK 请求层，
  // 因此用户按 Esc 就能立刻取消正在进行中的 MCP 调用。
  reportProgress(toolCallId, `Calling ${entry.serverName}/${entry.rawName}`)
  try {
    const result = await registry.callTool(toolName, ctx.input, options.abortSignal)
    await pushSuccessfulToolResult(ctx, truncateToolResult(result.text), result.isError)
  } catch (err) {
    if (isAbortError(err, options.abortSignal)) {
      pushToolResult(state, callbacks, toolCallId, toolName, '[Tool execution interrupted by user]', true)
      return
    }
    pushToolResult(state, callbacks, toolCallId, toolName, toolErrorFromUnknown(err), true)
  }
}

/** 收集本 turn 中 AI SDK 真正写进 assistant 消息里的全部 toolCallId。
 *  SDK 的 `result.toolCalls` Promise 与 `response.messages` 并非同一来源：
 *  如果流中途出现 zod 校验失败，SDK 会发出 `tool-error` chunk，
 *  并把对应 tool_call 从 response.messages 中排除，但它仍可能出现在
 *  `toolCalls` 里。若执行这种“幽灵调用”，会有两个坏结果：
 *    1. write/edit/shell 会为一个模型从未正式提交的调用制造真实副作用。
 *    2. 推入的 tool_result 会在 state.messages 中变成孤儿
 *       （前面没有对应 assistant tool_call），下一次 API 请求就会因
 *       “tool must be a response to a preceding message with tool_calls”
 *       而 400。
 *  返回这组 id 后，`processToolCalls` 就能在任何 handler 运行前先把
 *  SDK 列表过滤干净。
 *
 *  实现上会从 state.messages 末尾向前扫描，一路收集遇到的 assistant
 *  消息中的 tool-call id，直到碰到 assistant/tool 以外的边界为止。
 *  这样既能覆盖某些 provider 会产生的“同一 turn 多个 assistant 消息”，
 *  又能保证不会把更早 turn 的 id 混进来。 */
function collectActiveAssistantToolCallIds(state: LoopState): Set<string> {
  const ids = new Set<string>()
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const msg = state.messages[i]
    if (!msg) continue
    if (msg.role === 'user') break
    if (msg.role !== 'assistant') continue
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content as Array<{ type?: string; toolCallId?: string }>) {
      if (part?.type === 'tool-call' && typeof part.toolCallId === 'string') {
        ids.add(part.toolCallId)
      }
    }
  }
  return ids
}

/** 收集当前 turn 的 state.messages 窗口里那些“已经有 tool-result”的
 *  tool_call_id。`processToolCalls` 运行前，可能有两种上游路径
 *  先把结果放进来了：
 *    1. AI SDK 自动执行工具（readFile / glob / grep / listDir /
 *       webFetch / webSearch）——其结果已经在 `response.messages` 里，
 *       并由 `collectTurnResponse` 在我们迭代前推入 state。
 *    2. AI SDK 自动拒绝不可用工具——例如子 agent 的 toolFilter 禁掉了
 *       某个工具，但模型仍然发出了调用（如 `general-purpose` agent 调
 *       `writeFile`），SDK 会补一条 `error-text` tool-result，
 *       避免 assistant 消息留下孤立 tool_call。
 *  这两种情况都不应该在这里重新执行工具：
 *    - 对于 (1)，工具已经跑过，再跑一次就会重复制造副作用。
 *    - 对于 (2)，该工具本来就不该在当前 agent 中执行，但按名字分发的
 *      `executeWriteTool` 并不知道这一点，仍然会真的执行 writeFile，
 *      既产生真实副作用，也会追加一条重复 tool-result，
 *      让 DeepSeek 下一轮直接 400。
 *  边界判断逻辑与 collectActiveAssistantToolCallIds 相同：
 *  从消息末尾向前扫描，直到遇到第一条 user 消息为止。 */
function collectFulfilledToolCallIds(state: LoopState): Set<string> {
  const ids = new Set<string>()
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const msg = state.messages[i]
    if (!msg) continue
    if (msg.role === 'user') break
    if (msg.role !== 'tool') continue
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content as Array<{ type?: string; toolCallId?: string }>) {
      if (part?.type === 'tool-result' && typeof part.toolCallId === 'string') {
        ids.add(part.toolCallId)
      }
    }
  }
  return ids
}

/** 把连续的 `task` tool-call 分组成一个批次，以便并行执行；
 *  其余工具都各自单独成批，按顺序串行分发。
 *  之所以只有 `task` 工具可以并行，是因为它启动的子 agent 真正具备隔离性：
 *    - 每个 `runSubAgent` 都会创建全新的 `LoopState`
 *      （独立消息、recentToolCalls、todos、permission mode）
 *    - `parentState.tokenUsage` 只会在子 agent 完成后做累加，
 *      因此并发更新不会撕裂（单线程事件循环 + 普通 `+=`）
 *    - 并发子 agent 触发的权限对话框也会自然排队进入父 UI
 *  其他手动工具都会改共享状态，因此必须串行：
 *    - `writeFile` / `edit` 会改文件系统和 `state.filesModified`
 *    - `shell` 会实时向父 UI 推 stdout/stderr，并发 shell 会把字节流搅乱
 *    - `askUser` / 权限对话框会占用 UI，同时开两个会让状态机互相竞争
 *    - `todoWrite` / `enterPlanMode` / `exitPlanMode` 会修改下个 turn
 *      还要继续读取的 LoopState 字段
 *  自动执行工具（readFile / glob / grep / listDir / webFetch / webSearch）
 *  根本不会出现在这里，因为到 `processToolCalls` 运行时，它们早已由 SDK 执行，
 *  并且会在前置的 skip-fulfilled 阶段被短路掉。 */
export function partitionToolCalls(calls: ToolCall[]): ToolCall[][] {
  const batches: ToolCall[][] = []
  let i = 0
  while (i < calls.length) {
    let end = i + 1
    if (calls[i]!.toolName === 'task') {
      while (end < calls.length && calls[end]!.toolName === 'task') {
        end++
      }
    }
    batches.push(calls.slice(i, end))
    i = end
  }
  return batches
}

/** 处理单个模型 turn 产生的全部工具调用。
 *
 *  连续的 `task` 调用会通过 Promise.all 并行分发，其余工具逐个串行处理。
 *  只有子 agent 适合并行的完整原因见 `partitionToolCalls`。
 *
 *  `parentModel` 会一路向下传递，供 task 工具在调用 `runSubAgent`
 *  时作为父级模型 fallback。 */
export async function processToolCalls(
  toolCalls: ToolCall[],
  state: LoopState,
  options: AgentOptions,
  callbacks: AgentCallbacks,
  parentModel: LanguageModel,
): Promise<void> {
  const activeIds = collectActiveAssistantToolCallIds(state)
  const fulfilledIds = collectFulfilledToolCallIds(state)
  // 这是按 turn 维度存在的延迟消息队列，用于收集那些必须落在
  // “本轮所有 tool result 之后”的消息。若把 `role: 'user'` 消息
  // 夹在两个 tool result 之间，会形成 DeepSeek 严格顺序检查
  // 无法接受的结构，因此统一在循环结束后再 flush。
  const deferred: ModelMessage[] = []

  // 预处理阶段：先删掉幽灵调用，再处理已经 fulfilled 的调用。
  // 能活下来的才进入 `liveCalls`，也就是后续真正要分发的那部分。
  // 在分批之前做这件事，可以让并行批处理逻辑保持简单：
  // 进入批次的每一项都是真正需要执行的调用。
  const liveCalls: ToolCall[] = []
  for (const tc of toolCalls) {
    // 跳过那些被 SDK 在流中途拒绝掉的幽灵调用。完整原因见
    // collectActiveAssistantToolCallIds。这里连 pushToolResult 也不做，
    // 因为 assistant 消息里根本没有匹配 tool_call，
    // 此时任何结果都会变成孤儿，并在下个 turn 被 sanitizer 删掉。
    // 就算这层检查某天漏过了，sanitizer 的反向孤儿清理分支也还能兜底。
    if (activeIds.size > 0 && !activeIds.has(tc.toolCallId)) {
      debugLog(
        'tool-exec.skip-ghost',
        `${tc.toolName} ${tc.toolCallId} — not in assistant tool_calls, likely SDK tool-error reject`,
      )
      continue
    }

    // 跳过已经 fulfilled 的调用，原因见 collectFulfilledToolCallIds。
    // 但仍要把它记录进 loop-guard 窗口，这样同一个自动执行工具若在后续
    // turn 形成失控模式，依然能被断路；若 guard 触发，就把 user 角色提示
    // 延迟到本轮迭代结束后再插入。
    if (fulfilledIds.has(tc.toolCallId)) {
      debugLog('tool-exec.skip-fulfilled', `${tc.toolName} ${tc.toolCallId} — tool-result already in state.messages`)
      const loopCheck = checkForLoop(state, tc.toolName, tc.input, tc.toolCallId)
      recordToolCall(state, tc.toolName, tc.input, loopCheck.hash)
      if (loopCheck.kind !== 'ok') {
        deferred.push({ role: 'user', content: `[loop-guard] ${loopCheck.message}` })
      }
      continue
    }

    liveCalls.push(tc)
  }

  // 按批次分发。批次大小为 1 时，与直接 `await handleToolCall(...)`
  // 在语义上完全相同；对单个 Promise 使用 Promise.all 也不会改变结果，
  // 因此并行分发路径可以统一覆盖两种情况。
  const batches = partitionToolCalls(liveCalls)
  let dispatched = 0
  for (const batch of batches) {
    // 用户按下了 Esc / Ctrl+C。当前正在运行的工具（如果有）
    // 已经通过 shell provider 的 cancelSignal 被 SIGKILL。
    // 但后面尚未处理的每个 tool_call 仍然必须补一条合成 tool_result，
    // 否则这些没有配对结果的孤儿 tool_call 会让用户下次输入后，
    // 下一次 API 请求立刻报出 “tool_use without tool_result”。
    if (options.abortSignal?.aborted) {
      for (let j = dispatched; j < liveCalls.length; j++) {
        pushToolResult(
          state,
          callbacks,
          liveCalls[j]!.toolCallId,
          liveCalls[j]!.toolName,
          '[Tool execution interrupted by user]',
          true,
        )
      }
      break
    }

    await Promise.all(batch.map((tc) => handleToolCall(tc, state, options, callbacks, parentModel, deferred)))
    dispatched += batch.length
  }

  // 在本 turn 的所有 tool_result 之后，再统一 flush deferred 消息。
  // 这样它们会安稳地落在 state.messages 末尾：下一个 runTurn 仍能把它们
  // 视为最新上下文，同时又不会破坏 SDK 回放给 provider 时要求的
  // assistant→tool 顺序。
  if (deferred.length > 0) state.messages.push(...deferred)
}
