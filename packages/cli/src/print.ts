// @x-code-cli/cli - 非交互（-p / --print）运行器。
//
// 这里故意完全绕开 Ink：没有 TUI 组件、没有 raw mode stdin、没有等待输入事件的
// reconciler 帧。Ink 路径在 print 模式下没法可靠自动退出，因为 `usePromptInput`
// 会把 stdin 挂成 raw mode，导致事件循环一直活着，直到用户按键或者调整终端大小，
// 这时 queued unmount 才会真正执行。把 print mode 单独拆成一条路径，就能避开这些坑。
import { agentLoop, hydrateLoopState, saveSession } from '@x-code-cli/core'
import type { AgentCallbacks, AgentOptions, LanguageModel, LoadedSession } from '@x-code-cli/core'

export async function runPrintMode(
  model: LanguageModel,
  options: AgentOptions,
  prompt: string,
  initialSession?: LoadedSession | null,
): Promise<number> {
  // 按 Ctrl+C 中断，这样长时间运行的 -p 调用也能被打断。
  const controller = new AbortController()
  const onSigint = () => controller.abort()
  process.on('SIGINT', onSigint)

  let sawError = false

  const callbacks: AgentCallbacks = {
    onTextDelta: (delta) => {
      if (delta) process.stdout.write(delta)
    },
    onToolCall: () => {},
    onToolProgress: () => {},
    onToolResult: () => {},
    onAskPermission: async (toolCall) => {
      // 非交互模式下没法询问用户。这里直接拒绝，让模型自行适应；
      // 如果希望在 -p 模式里允许写入工具，就应该传 -t / --trust。
      process.stderr.write(`\n[permission denied: ${toolCall.toolName} — pass --trust to auto-approve in -p mode]\n`)
      return 'no'
    },
    onAskUser: async (question) => {
      process.stderr.write(`\n[cannot ask question in -p mode: ${question}]\n`)
      return ''
    },
    onPlanApprovalRequest: async () => {
      // 非交互模式下没法弹审批对话框。这里直接拒绝，
      // 让模型继续停留在 plan 模式并输出最终计划，
      // 而不是假装用户批准了一个他们根本没看到的操作。
      process.stderr.write(`\n[plan approval not available in -p mode — pass --plan + interactive session]\n`)
      return false
    },
    onPlanModeChange: () => {
      // print 模式下没有 UI 要更新；
      // 模式变化仍然会作用到 LoopState，而这对这次短生命周期运行才是真正关键的地方。
    },
    onTodosUpdate: () => {
      // print 模式下没有实时面板。
      // todo 仍然存在于 LoopState，只是没有终端 UI 去渲染它们。这里静默空操作。
    },
    onShellOutput: () => {},
    onUsageUpdate: () => {},
    onContextCompressed: () => {},
    onError: (err) => {
      sawError = true
      process.stderr.write(`\n[error] ${err.message}\n`)
    },
  }

  try {
    // 在 print 模式下也要尊重 --continue / --resume：把已加载会话
    // 水合进 loop state。否则 main() 虽然读到了之前的 jsonl，
    // 这里的 agent 却会重新开启一段新对话，悄悄丢掉恢复请求。
    // Ink 路径已经通过 useAgent → hydrateLoopState 做了这条链路；
    // print 模式只是需要同样接上。
    const existingState = initialSession
      ? hydrateLoopState(initialSession, options.permissionMode ?? 'default')
      : undefined
    const { state } = await agentLoop(
      prompt,
      model,
      { ...options, abortSignal: controller.signal },
      callbacks,
      existingState,
    )

    // stdout 是 TTY 时，最后补一个换行，这样 shell prompt 能落到新的一行。
    // 如果是管道输出，就原样信任模型内容，不额外改写。
    if (process.stdout.isTTY) process.stdout.write('\n')

    // 这里要 await session save：print 模式生命周期很短，它就是退出前的最后一道工序；
    // 如果不等它，fire-and-forget 会在 process.exit 抢在 jsonl 刷新前发生时
    // 丢掉最后一轮消息。这里多等几十毫秒，换来脚本调用方 / e2e 测试能读到完整转录，
    // 更划算。（交互式 Ink 路径可以继续 fire-and-forget，因为它是靠 React unmount
    // 退出，不是直接 process.exit。）
    await saveSession(state, model).catch(() => undefined)

    return sawError ? 1 : 0
  } catch (err) {
    process.stderr.write(`\n[fatal] ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  } finally {
    process.off('SIGINT', onSigint)
  }
}
