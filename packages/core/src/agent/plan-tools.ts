// @x-code-cli/core — 计划模式与 todoWrite 工具处理器
//
// 这些逻辑从 tool-execution.ts 中拆出，避免 handleToolCall 过于庞大。
// 每个处理器都遵循同一契约：修改 state、通过 pushToolResult 推送结果，并返回 void。
import type { AgentCallbacks, AgentOptions, TodoItem } from '../types/index.js'
import { extractText } from '../utils/message-helpers.js'
import type { LoopState } from './loop-state.js'
import { toolErrorString } from './messages.js'
import { makePlanFilePath, readPlan, writePlan } from './plan-storage.js'

type PushToolResult = (
  state: LoopState,
  callbacks: AgentCallbacks,
  toolCallId: string,
  toolName: string,
  output: string,
  isError?: boolean,
) => void

/** 从消息尾部向前查找最后一条用户消息的纯文本内容。 */
function lastUserMessageText(messages: LoopState['messages']): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m && m.role === 'user') {
      return extractText(m.content)
    }
  }
  return ''
}

/** 处理 `todoWrite`：规范化待办项、刷新状态，并把结果回推给模型。 */
export async function handleTodoWrite(
  input: Record<string, unknown>,
  toolCallId: string,
  state: LoopState,
  callbacks: AgentCallbacks,
  pushToolResult: PushToolResult,
): Promise<void> {
  type RawTodo = { content?: string; activeForm?: string; status?: TodoItem['status'] }
  const raw = (input.todos as RawTodo[] | undefined) ?? []
  const normalized: TodoItem[] = []
  for (const t of raw) {
    const content = (t.content ?? '').trim()
    const activeForm = (t.activeForm ?? '').trim()
    if (!content && !activeForm) continue
    normalized.push({
      content: content || activeForm,
      activeForm: activeForm || content,
      status: t.status ?? 'pending',
    })
  }
  const allDone = normalized.length > 0 && normalized.every((t) => t.status === 'completed')
  state.todos = allDone ? [] : normalized
  callbacks.onTodosUpdate(state.todos)
  const dropped = raw.length - normalized.length
  const droppedNote =
    dropped > 0
      ? ` 有 ${dropped} 条待办被丢弃，因为它们既没有 content，也没有 activeForm。下次请同时提供这两个字段，方便用户看到更清晰的标签。`
      : ''
  const VERIFY_RE = /\b(verif|test|check|lint|build|typecheck|tsc)\b/i
  const needsVerifyNudge =
    allDone &&
    normalized.length >= 3 &&
    !normalized.some((t) => VERIFY_RE.test(t.content) || VERIFY_RE.test(t.activeForm))
  const verifyNote = needsVerifyNudge
    ? ' 在结束前请记得验证你的工作，例如运行测试、lint 或 type-check。'
    : ''
  pushToolResult(
    state,
    callbacks,
    toolCallId,
    'todoWrite',
    allDone
      ? `所有待办都已完成，清单已清空。${verifyNote}${droppedNote}`
      : `待办清单已更新。请保持清单始终最新：任务一完成就立刻标记，并确保始终只有一项处于 in_progress。${droppedNote}`,
  )
}

/** 处理进入计划模式，包括权限确认、模式切换和计划文件路径初始化。 */
export async function handleEnterPlanMode(
  input: Record<string, unknown>,
  toolCallId: string,
  state: LoopState,
  options: AgentOptions,
  callbacks: AgentCallbacks,
  pushToolResult: PushToolResult,
): Promise<void> {
  if (state.permissionMode === 'plan') {
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      'enterPlanMode',
      '当前已经处于计划模式。请继续对话；等用户要求开始实现且你的计划准备好后，再调用 exitPlanMode。',
    )
    return
  }
  const decision = await callbacks.onAskPermission({ toolCallId, toolName: 'enterPlanMode', input })
  if (options.abortSignal?.aborted) {
    pushToolResult(state, callbacks, toolCallId, 'enterPlanMode', '[工具执行已被用户中断]', true)
    return
  }
  if (decision === 'no') {
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      'enterPlanMode',
      '用户拒绝进入计划模式。请继续以默认模式处理用户请求，并按任务需要进行编辑或执行 shell 命令（仍受各工具权限约束）。',
      true,
    )
    return
  }
  state.permissionMode = 'plan'
  state.systemPromptCache = null
  state.expectCacheMiss = true
  if (!state.currentPlanPath) {
    const topic = (input.topic as string | undefined)?.trim()
    const fallbackText = lastUserMessageText(state.messages)
    const explicitSlug = topic && topic.length > 0 ? topic : state.taskSlug || undefined
    state.currentPlanPath = makePlanFilePath(fallbackText, { slug: explicitSlug })
  }
  callbacks.onPlanModeChange('plan')
  pushToolResult(
    state,
    callbacks,
    toolCallId,
    'enterPlanMode',
    [
      '已进入计划模式（用户已批准）。',
      '',
      '只读工具不受限制（readFile、glob、grep、listDir、webSearch、webFetch）。',
      `本次会话的计划文件路径：${state.currentPlanPath}`,
      '请使用 writeFile/edit 修改计划文件来编写计划；在用户通过 exitPlanMode 批准计划前，',
      '不要编辑其他文件，也不要执行会改变状态的 shell 命令。',
      '',
      '推荐流程：探索 → 更新计划文件 → askUser → 重复。',
      '',
      '重要：当计划准备好后，必须调用 **exitPlanMode** 来请求批准，而不是',
      'askUser。无论用户如何回答，askUser 都不能退出计划模式；只有',
      'exitPlanMode 才会切换模式，并解锁 writeFile/edit/shell 调用。',
    ].join('\n'),
  )
}

/** 处理退出计划模式，包括计划读取、审批请求和模式切换。 */
export async function handleExitPlanMode(
  input: Record<string, unknown>,
  toolCallId: string,
  state: LoopState,
  callbacks: AgentCallbacks,
  pushToolResult: PushToolResult,
): Promise<void> {
  if (state.permissionMode !== 'plan') {
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      'exitPlanMode',
      toolErrorString('当前不在计划模式。exitPlanMode 只能在会话处于计划模式时调用。'),
      true,
    )
    return
  }
  const planPath =
    state.currentPlanPath ??
    makePlanFilePath(lastUserMessageText(state.messages), { slug: state.taskSlug || undefined })
  state.currentPlanPath = planPath
  const planOverride = (input.plan as string | undefined)?.trim()
  let planBody = planOverride ?? ''
  if (!planBody) {
    planBody = (await readPlan(planPath)).trim()
  }
  if (!planBody) {
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      'exitPlanMode',
      toolErrorString(
        `计划文件 ${planPath} 当前为空。请先使用 writeFile 或 edit 写入计划内容，然后再调用 exitPlanMode。`,
      ),
      true,
    )
    return
  }

  let savedPath: string | null = planPath
  if (planOverride) {
    try {
      savedPath = await writePlan(planPath, planBody)
      state.currentPlanPath = savedPath
    } catch {
      // 非致命错误：审批对话框仍可使用内存中的计划正文。
    }
  }

  const approved = await callbacks.onPlanApprovalRequest(planBody)
  if (approved) {
    state.permissionMode = 'acceptEdits'
    state.systemPromptCache = null
    state.expectCacheMiss = true
    const persisted = savedPath ?? state.currentPlanPath
    state.currentPlanPath = null
    callbacks.onPlanModeChange('acceptEdits')
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      'exitPlanMode',
      [
        '用户已批准计划，现已退出计划模式。',
        persisted ? `已批准的计划已保存到：${persisted}` : '',
        '现在可以编辑文件并执行 shell 命令了，请开始按计划实现。',
        '',
        '如果计划包含多个步骤，建议先调用 **todoWrite**，把计划拆成',
        '可跟踪的清单。这样用户能实时看到进度，你也不容易在实现过程中漏掉剩余步骤。',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    state.messages.push({
      role: 'user',
      content: [
        '## 已退出计划模式',
        '',
        '你已经退出计划模式，现在可以编辑文件、调用工具并执行实际操作。',
        '写入类工具（writeFile、edit）现已自动批准（acceptEdits 模式）；shell 命令',
        '仍会按照常规权限分类处理。',
        persisted ? `如需参考，计划文件位于：${persisted}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    })
    return
  }
  pushToolResult(
    state,
    callbacks,
    toolCallId,
    'exitPlanMode',
    [
      '用户拒绝了当前计划，你仍然处于计划模式。',
      '请阅读用户下一条消息中的反馈，按反馈修改计划，',
      '然后带着修订后的内容再次调用 exitPlanMode。如果不确定该改什么，',
      '可以先通过 askUser 向用户确认。',
    ].join('\n'),
    true,
  )
}
