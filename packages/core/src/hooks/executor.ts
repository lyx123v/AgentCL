// @x-code-cli/core — Hook 命令执行器
//
// 它会启动 hook 的 shell 命令，把事件 JSON 写入 stdin，再从 stdout
// 读取决策 JSON。整个协议都是按行工作的：输入一个 JSON 对象，输出一个
// JSON 对象（如果 stdout 为空，则默认 allow）。stdout 中的其他内容
// 都会被忽略，这很适合那些只想往 stderr 打日志、不想影响代理流程的 hook。
//
// 失败处理刻意设计得比较宽松（默认 `failurePolicy: 'allow'`）：
// 一个损坏的 hook 绝不能把 agent loop 卡死。非零退出、超时或崩溃，
// 都会降级为 `allow`，并留下一条调试日志。`block` 是显式选择的策略，
// 只留给插件作者明确设计成“闸门型”的 hook 使用。
//
// AbortSignal 会继续向下传递给 execa 的 `cancelSignal`，这样当用户在
// hook 执行中按下 Esc 时，子进程会被 SIGKILL。shell 工具走的是同一套机制。
import { execa } from 'execa'

import { getPluginUserConfigEnv } from '../plugins/user-config.js'
import { debugLog } from '../utils.js'
import type { HookConfigEntry, HookDecision, HookEvent, RegisteredHook } from './types.js'
import { buildVariableContext, expandVariables } from './variables.js'

/** 根据当前操作系统选择要执行的命令。插件作者会把 `command` 作为可移植的默认值，并可通过 `commandWindows` / `commandDarwin` / `commandLinux` 处理各平台差异（例如 shebang、可执行文件名、引号规则）。未知平台（freebsd、sunos、aix）会回退到基础命令。 */
function pickPlatformCommand(entry: HookConfigEntry): string {
  switch (process.platform) {
    case 'win32':
      return entry.commandWindows ?? entry.command
    case 'darwin':
      return entry.commandDarwin ?? entry.command
    case 'linux':
      return entry.commandLinux ?? entry.command
    default:
      return entry.command
  }
}

const DEFAULT_TIMEOUT_MS = 5_000
const MAX_TIMEOUT_MS = 30_000

export interface ExecuteHookOptions {
  /** 触发后会取消 hook 子进程。agent loop 的 abort signal 会沿着这里传下来，因此慢 hook 运行时按 Esc 可以及时终止它。 */
  signal?: AbortSignal
  /** 覆盖默认的 5 秒超时。若同时设置了每个 hook 自己的 `entry.timeout`，则后者优先；两者都会被限制在 30 秒内。 */
  defaultTimeoutMs?: number
}

/** 执行一个 hook 与一个事件的组合。返回解析后的决策结果（任何意外情况都会默认 allow）。除非调用方的 AbortSignal 触发，否则这里不会抛错；因为 abort 是唯一值得向上传播的异常，此时调用方的循环本身已经在收尾。 */
export async function executeHook(
  hook: RegisteredHook,
  event: HookEvent,
  opts: ExecuteHookOptions = {},
): Promise<HookDecision> {
  const timeoutMs = Math.min(hook.entry.timeout ?? opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)

  const vars = buildVariableContext({
    pluginDir: hook.pluginDir,
    cwd: event.session.cwd,
    pluginId: hook.pluginId,
  })
  const expandedCommand = expandVariables(pickPlatformCommand(hook.entry), vars)
  const stdinPayload = JSON.stringify(buildStdinPayload(hook, event))

  // 把所属插件的 userConfig 合并进 hook 的环境变量。
  // 这样一来，hook 脚本如果需要读取 manifest 中声明的 API key，
  // 直接通过 `process.env[KEY]` 即可，不需要额外胶水代码；
  // 命令字符串里的 `${env:KEY}` 替换也会基于这份合并后的 env。
  // 如果读取失败，我们会静默处理（例如还没设置 userConfig，此时就当空映射）。
  let pluginEnv: Record<string, string> = {}
  try {
    pluginEnv = await getPluginUserConfigEnv(hook.pluginId)
  } catch (err) {
    debugLog('hooks.user-config-read-failed', `${hook.pluginId}: ${String(err)}`)
  }

  try {
    const result = await execa(expandedCommand, [], {
      shell: true,
      input: stdinPayload,
      timeout: timeoutMs,
      cancelSignal: opts.signal,
      stdio: 'pipe',
      reject: false, // 非零退出会在下方显式处理，而不是以抛错形式处理。
      cwd: event.session.cwd,
      env: { ...process.env, ...pluginEnv },
    })

    if (opts.signal?.aborted) {
      // 执行中途被中止。调用方的循环已经开始收尾，因此这里通过抛错
      // 向上传递，让 bus 停止继续级联后续 hook。
      throw new Error('aborted')
    }

    if (result.timedOut) {
      debugLog('hooks.exec-timeout', `${hook.pluginId} ${event.name}: timed out after ${timeoutMs}ms`)
      return failurePolicyDecision(hook, `hook 执行超时：${timeoutMs}ms`)
    }
    if (typeof result.exitCode === 'number' && result.exitCode !== 0) {
      const stderrTail = (result.stderr ?? '').toString().slice(0, 200)
      debugLog('hooks.exec-nonzero', `${hook.pluginId} ${event.name}: exit ${result.exitCode} stderr=${stderrTail}`)
      return failurePolicyDecision(hook, `hook 非零退出：${result.exitCode}`)
    }

    const decision = parseDecision(result.stdout ?? '', hook, event)
    // 记录成功执行的 hook，方便插件作者确认 hook 确实被触发，
    // 而不必自己额外加日志。由于 stdio 被设成 `pipe`（我们要从 stdout
    // 读取 JSON 决策），hook 自己写到 stderr 的内容默认并不会直接可见；
    // 因此这条 breadcrumb 就是 `--plugin-debug` / `DEBUG_STDOUT=1`
    // 用户用来确认链路是否接通的关键线索。
    debugLog('hooks.exec-ran', `${hook.pluginId} ${event.name}: decision=${decision.decision}`)
    return decision
  } catch (err) {
    if (opts.signal?.aborted) throw err
    debugLog('hooks.exec-error', `${hook.pluginId} ${event.name}: ${String(err)}`)
    return failurePolicyDecision(hook, `hook 执行崩溃：${err instanceof Error ? err.message : String(err)}`)
  }
}

function failurePolicyDecision(hook: RegisteredHook, reason: string): HookDecision {
  if (hook.entry.failurePolicy === 'block') return { decision: 'deny', reason }
  return { decision: 'allow' }
}

/** 构建通过 stdin 发送给 hook 的 JSON 对象。事件专属字段会被拍平到顶层，这与 Claude Code 的 hook 协议形状保持一致。 */
function buildStdinPayload(hook: RegisteredHook, event: HookEvent): Record<string, unknown> {
  const base: Record<string, unknown> = {
    event: event.name,
    session: event.session,
    plugin: { id: hook.pluginId, dir: hook.pluginDir },
  }
  switch (event.name) {
    case 'UserPromptSubmit':
      base.prompt = event.prompt
      break
    case 'PreToolUse':
      base.tool = event.tool
      break
    case 'PostToolUse':
      base.tool = event.tool
      break
    case 'PreCompact':
      base.trigger = event.trigger
      base.messageCount = event.messageCount
      base.tokenEstimate = event.tokenEstimate
      break
    case 'PostCompact':
      base.trigger = event.trigger
      base.messageCount = event.messageCount
      base.summary = event.summary
      break
    case 'SubagentStart':
      base.agent = event.agent
      break
    case 'SubagentStop':
      base.agent = event.agent
      base.durationMs = event.durationMs
      base.outcome = event.outcome
      if (event.tokenUsage) base.tokenUsage = event.tokenUsage
      break
    case 'TurnComplete':
      base.turn = event.turn
      if (event.tokenUsage) base.tokenUsage = event.tokenUsage
      break
    // SessionStart / SessionEnd 除了 session/plugin 之外没有额外字段。
  }
  return base
}

function parseDecision(stdout: string, hook: RegisteredHook, event: HookEvent): HookDecision {
  const trimmed = (stdout ?? '').toString().trim()
  if (!trimmed) return { decision: 'allow' }

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>
      const d = obj.decision
      if (d === 'allow' || d === 'deny' || d === 'modify') {
        return obj as HookDecision
      }
    }
  } catch {
    // 不是 JSON。很多 hook 会把 stdout 当成人看的日志输出。
    // 这里按默认 allow 处理，但会留下一条 breadcrumb，以防用户原本希望它能影响代理行为。
    debugLog(
      'hooks.decision-not-json',
      `${hook.pluginId} ${event.name}: ignoring non-JSON stdout: ${trimmed.slice(0, 200)}`,
    )
  }
  return { decision: 'allow' }
}
