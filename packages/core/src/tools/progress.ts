// @x-code-cli/core — 工具进度上报器（旁路通道）
//
// AI SDK 的工具 `execute` 函数会自行运行，我们并不直接控制它们的调用点，
// 因此无法把进度回调作为普通参数直接塞进去。这里改用一个模块级小注册表，
// 以 `toolCallId` 作为键：当模型发出 tool-call 事件时，agent loop 会注册
// 一个 reporter；工具在 execute() 内部通过 `reportProgress(toolCallId, msg)`
// 查找并上报；工具返回结果后，loop 再把它清掉。
//
// 为什么不通过 `tool()` 选项传递：AI SDK 确实会把 `{ toolCallId }` 作为
// execute 的第二个参数暴露出来，但 `streamText({ tools })` 这条链路并没有
// 提供一种“按每次调用注入 UI 回调”的方式，除非把每个工具都再包一层。
// 用 `toolCallId` 查表能让工具定义保持干净，也能和我们在 `tool-execution.ts`
// 里手动分发的工具（shell、writeFile、edit、askUser）共用同一套机制。
export type ProgressReporter = (message: string) => void

const reporters = new Map<string, ProgressReporter>()

/** 为某次工具调用登记进度回调。 */
export function setProgressReporter(toolCallId: string, fn: ProgressReporter): void {
  reporters.set(toolCallId, fn)
}

/** 清理某次工具调用对应的进度回调。 */
export function clearProgressReporter(toolCallId: string): void {
  reporters.delete(toolCallId)
}

/** 上报某次工具调用的进度；如果没有登记回调则静默忽略，可在任意位置安全调用。 */
export function reportProgress(toolCallId: string | undefined, message: string): void {
  if (!toolCallId) return
  reporters.get(toolCallId)?.(message)
}
