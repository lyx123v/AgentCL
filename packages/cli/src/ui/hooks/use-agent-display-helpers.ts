// @x-code-cli/cli - slash 命令输出的 scrollback 追加辅助函数。
//
// 从 useAgent 里拆出来的一个小子 hook：它把 `appendMessage`
// （那个会推动 setState 的基础原语）包成 App 里的 slash 命令处理器常用的五种形态。
// 之所以用子 hook 而不是普通函数，是因为这里每个方法都是 useCallback，
// 其 memo identity 对下游消费者很重要。
import { useCallback } from 'react'

import type { DisplayMessage } from '@x-code-cli/core'

export function useAgentDisplayHelpers(appendMessage: (msg: DisplayMessage) => void) {
  const addMessage = useCallback(
    (role: 'user' | 'assistant', content: string) => {
      appendMessage({
        id: Date.now().toString(),
        role,
        content,
        timestamp: Date.now(),
      })
    },
    [appendMessage],
  )

  /** 添加一条 system/info 消息（用于 slash 命令输出） */
  const addInfoMessage = useCallback((content: string) => addMessage('assistant', content), [addMessage])

  /** 添加一条 user 消息到历史里（用于回显 slash 命令） */
  const addUserMessage = useCallback((content: string) => addMessage('user', content), [addMessage])

  /** 把 slash 命令回显成一行紧凑的 `❯ /cmd`（后面不留空行）。
   *  如果要补紧凑的 `⎿  result` 行，再接 `addCommandResult`。 */
  const echoCommand = useCallback(
    (content: string) => {
      appendMessage({
        id: `cmd-${Date.now()}`,
        role: 'user',
        content,
        timestamp: Date.now(),
        kind: 'command-echo',
      })
    },
    [appendMessage],
  )

  /** 把 slash 命令 + 它的简短结果渲染成 Claude 风格的两行块：
   *    > /cmd
   *      ⎿  result
   *  用于单行命令响应。对于长的多行输出
   *  （/help、/usage、/init），直接调用 addUserMessage + addInfoMessage。 */
  const addCommandMessage = useCallback(
    (commandText: string, resultText: string) => {
      const base = Date.now()
      appendMessage({
        id: `cmd-${base}`,
        role: 'user',
        content: commandText,
        timestamp: base,
        kind: 'command-echo',
      })
      appendMessage({
        id: `cmd-res-${base}`,
        role: 'assistant',
        content: resultText,
        timestamp: base,
        kind: 'command-result',
      })
    },
    [appendMessage],
  )

  /** 在最近一次命令回显下面再追加一行 `  ⎿  result`，
   *  但不会重新回显命令本身。
   *  适用于多步骤 slash 命令，比如 /mcp refresh 和 /mcp auth：
   *  一次用户输入会先产出一个紧凑的结果块，然后随着时间慢慢补齐：
   *    > /mcp auth sentry
   *      ⎿  Authenticating "sentry" — opening browser...    (addCommandMessage)
   *      ⎿  Opened https://...                              (addCommandResult)
   *           Waiting for the authorization redirect...
   *      ⎿  ✓ Authenticated "sentry" — 14 tools             (addCommandResult)
   *  如果 follow-up 也用 addInfoMessage，每一段都会被渲染成独立的 assistant block，
   *  前后还会带空行，结果就是在下一个提示前多出 3 行以上空白。 */
  const addCommandResult = useCallback(
    (content: string) => {
      const base = Date.now()
      appendMessage({
        id: `cmd-res-${base}`,
        role: 'assistant',
        content,
        timestamp: base,
        kind: 'command-result',
      })
    },
    [appendMessage],
  )

  return { addInfoMessage, addUserMessage, echoCommand, addCommandMessage, addCommandResult }
}
