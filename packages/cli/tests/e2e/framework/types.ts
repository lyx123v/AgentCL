// e2e 测试框架中由 runner / harness / scenarios 共享的类型定义。

export interface ToolCall {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  /** 如果在同一会话中找到了配对的 tool-result，这里保存其结果文本。 */
  resultText?: string
  /** 标记该工具结果是否被 provider 或工具自身声明为错误。 */
  isError?: boolean
}

export interface RunResult {
  /** 本次运行中所有 assistant 消息拼接后的最终文本。 */
  assistantText: string
  /** 按调用顺序记录的全部工具调用；如果能找到结果，会一并合并进来。 */
  toolCalls: ToolCall[]
  /** `xc -p` 的原始 stdout，调试时仍然有用。 */
  stdout: string
  /** 原始 stderr。 */
  stderr: string
  /** 进程退出码。 */
  exitCode: number
  /** 实际耗时，单位毫秒。 */
  durationMs: number
  /** 本次运行生成的 session jsonl 绝对路径；若没有生成则为空字符串。 */
  sessionJsonlPath: string
  /** 最新 usage 事件上报的 token 用量（如果存在）。 */
  tokenUsage?: { input: number; output: number; cacheRead: number; cacheWrite: number }
}

export interface RunCliOptions {
  /** 额外的 CLI 参数，例如 `['--trust', '--max-turns', '20']`。 */
  args?: string[]
  /** 覆盖默认超时时间，单位毫秒。 */
  timeoutMs?: number
  /** 需要额外合并的环境变量；会叠加在基础环境变量之上。 */
  env?: Record<string, string>
  /** 工作目录；默认使用场景的 tmpDir。 */
  cwd?: string
}

export interface ScenarioContext {
  /** 当前场景临时目录的绝对路径，也是 CLI 运行时的 CWD。 */
  tmpDir: string
  /** 已选中的模型 ID，并且已经过 MODEL_ALIASES 映射。 */
  modelId: string
  /** 指向 packages/cli/dist/cli.js 的路径，由 runner 统一解析。 */
  cliBin: string
  /** 可用环境变量，通常只保留 `*_API_KEY` 及少量必要项。 */
  env: Record<string, string>

  // ── 文件辅助方法（除非传入绝对路径，否则都相对 tmpDir）──
  /** 在场景目录中写入文件内容。 */
  writeFile(relPath: string, content: string): Promise<void>
  /** 读取场景目录中的文件内容。 */
  readFile(relPath: string): Promise<string>
  /** 判断场景目录中的文件是否存在。 */
  fileExists(relPath: string): Promise<boolean>
  /** 在场景目录中创建文件夹。 */
  mkdir(relPath: string): Promise<void>

  // ── CLI 运行方法 ──
  /** 以给定提示词运行一次 CLI，并返回结构化结果。 */
  runCli(prompt: string, options?: RunCliOptions): Promise<RunResult>

  // ── 断言辅助方法（失败时抛出 ScenarioAssertionError）──
  expect: ScenarioExpect
}

export interface ScenarioExpect {
  /** 断言某个工具至少被调用过一次。
   *  inputMatcher 支持部分对象匹配，值可以是字面量、正则或谓词函数。 */
  toolCalled(
    result: RunResult,
    toolName: string,
    inputMatcher?: Record<string, unknown | RegExp | ((v: unknown) => boolean)>,
  ): ToolCall
  /** 断言某个工具没有被调用。 */
  toolNotCalled(result: RunResult, toolName: string): void
  /** 断言拼接后的助手文本包含某段子串或匹配某个正则。 */
  assistantMentions(result: RunResult, needle: string | RegExp): void
  /** 断言退出码符合预期。 */
  exitCode(result: RunResult, code: number): void
  /** 断言 tmpDir 相对路径上的文件存在。 */
  fileExists(relPath: string): Promise<void>
  /** 断言文件内容包含某段子串或匹配某个正则。 */
  fileContent(relPath: string, matcher: string | RegExp): Promise<void>
  /** 断言不存在 `isError` 为真的工具调用结果。 */
  noToolErrors(result: RunResult): void
  /** 自定义断言：当条件不为真时，抛出指定消息。 */
  truthy(condition: unknown, message: string): void
}

export interface Scenario {
  /** 用于状态持久化和 CLI 过滤的稳定 ID。
   *  建议使用 `01-` 前缀，以便文件名能自然排序。 */
  id: string
  /** 展示在进度输出中的可读名称。 */
  name: string
  /** 如果提供该函数，当环境判断返回 false 时会跳过该场景。
   *  适合用于依赖可选 Key 的场景，例如 `TAVILY_API_KEY`。 */
  requires?: (env: Record<string, string>) => boolean
  /** `requires` 返回 false 时展示的跳过原因。 */
  requiresReason?: string
  /** 场景的实际测试逻辑，失败时应直接抛错。 */
  run(ctx: ScenarioContext): Promise<void>
}

export interface ScenarioResult {
  id: string
  name: string
  status: 'passed' | 'failed' | 'skipped'
  /** 实际耗时，单位秒。 */
  durationSec: number
  /** 简短的可读错误信息，仅在 `status === 'failed'` 时存在。 */
  error?: string
  /** 当前场景最近一次 CLI 运行生成的 session jsonl 路径。 */
  lastSessionJsonl?: string
  /** 场景 tmpDir 的路径；失败时保留，通过时删除。 */
  tmpDir?: string
  /** 跳过原因（当 `status === 'skipped'` 时使用）。 */
  skipReason?: string
}

export interface RunState {
  /** 上一次运行所选的模型 ID。 */
  model: string
  /** 上一次运行开始时的 ISO 时间戳。 */
  startedAt: string
  /** 以场景 ID 为键保存的逐场景运行结果。 */
  results: Record<string, ScenarioResult>
}

export class ScenarioAssertionError extends Error {
  // 用于标识场景断言失败，方便与执行期异常区分。
  constructor(message: string) {
    super(message)
    this.name = 'ScenarioAssertionError'
  }
}
