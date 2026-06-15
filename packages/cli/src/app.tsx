// @x-code-cli/cli - Ink 渲染入口。
//
// 这里依赖的是 `@jrichman/ink`（在 package.json 里别名成 `ink`），而不是
// 上游 Ink。这个分支提供了 cell 级终端缓冲区、基于 string-width / StyledLine
// 的宽度测量、DEC 2026 Synchronized Updates，以及更适配 IME 的光标定位。
// 组合起来能明显减少长时间聊天界面里常见的 CJK / IME 抖动问题。
// 对我们自己的代码来说没有 API 变化，仍然兼容 `ink` 的用法。
import { render } from 'ink'

import type { AgentOptions, LanguageModel, LoadedSession } from '@x-code-cli/core'

import { App } from './ui/components/App.js'
import { printHeader } from './ui/components/AppHeader.js'

/** 全局 cleanup 引用，由 App 通过 onCleanupReady 传入。 */
let registeredCleanup: (() => Promise<void>) | null = null

export function getCleanupFn(): (() => Promise<void>) | null {
  return registeredCleanup
}

/** 当前会话的轻量快照，由 App 通过 onSessionInfoReady 设置。
 *  退出后 index.ts 会用它打印 `xc --resume <id>`，
 *  这样就不用在 React 卸载后再反查状态。
 *  如果会话还没真正开始（用户只是打开程序但没提交过消息），
 *  getter 会返回 null，index.ts 会跳过这条提示。 */
export interface SessionExitInfo {
  sessionId: string
  taskSlug: string
  messageCount: number
}
let registeredSessionInfoGetter: (() => SessionExitInfo | null) | null = null
export function getSessionExitInfo(): SessionExitInfo | null {
  return registeredSessionInfoGetter ? registeredSessionInfoGetter() : null
}

export interface StartAppOptions {
  /** 来自 `--continue` 的预加载会话（由 index.ts 在 Ink 挂载前同步加载）。
   *  首次渲染时会直接把 agent 水合到这条会话上。 */
  initialSession?: LoadedSession | null
  /** 当设为 `pick` 时，App 会在挂载时弹出会话选择器。
   *  这是 `--resume` 的路径。这个选择器复用 /resume 的 askQuestion UI，
   *  这样就只需要维护一条交互路径。 */
  resumeIntent?: 'pick' | null
}

export function startApp(
  model: LanguageModel,
  options: AgentOptions,
  initialPrompt?: string,
  startOpts: StartAppOptions = {},
) {
  // 在 Ink 启动前只打印一次 header，避免 Static 重新渲染时重复输出标题。
  printHeader(options.modelId)

  const { waitUntilExit } = render(
    <App
      model={model}
      options={options}
      initialPrompt={initialPrompt}
      initialSession={startOpts.initialSession ?? null}
      resumeIntent={startOpts.resumeIntent ?? null}
      onCleanupReady={(fn) => {
        registeredCleanup = fn
      }}
      onSessionInfoReady={(getter) => {
        registeredSessionInfoGetter = getter
      }}
    />,
    { exitOnCtrlC: false },
  )
  return waitUntilExit
}
