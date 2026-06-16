// @x-code-cli/cli - 带 bracketed paste 支持的自定义 stdin 输入 hook，
// 以及给没启用该功能的终端准备的时间窗 fallback。
//
// 两层粘贴检测策略：
//
//   1. **Bracketed paste 模式**（主路径，最快）
//      挂载时我们发送 `\x1b[?2004h`。支持它的终端会把每次粘贴包成
//      `\x1b[200~ … \x1b[201~`。下面的状态机能识别这些标记，
//      并把 payload 作为一次完整的 `onPaste` 调用发出去，
//      不管 Node 是怎么切 stdin bytes 的。
//
//   2. **Debounce fallback**（给 Windows Terminal / PowerShell / tmux /
//      ConEmu / VS Code 集成终端等不尊重 bracketed paste 的环境）
//      当没看到 paste marker 时，可打印文本会先进入一个 buffer，
//      并且每次 stdin 事件都会重新（或初次）启动一个很短的
//      `PASTE_DEBOUNCE_MS` timer。人类打字的键间隔通常 >100ms，
//      所以每个字符都会按自己的 timer 单独 flush；但粘贴 burst
//      会以亚毫秒级的连续块到来 - buffer 会在一个 tick 内填满，
//      然后作为一个原子 chunk flush，接着由下面的尺寸启发式路由到 `onPaste`。
//      Claude Code 的 `usePasteHandler` 也是这么做的。
//
// 特殊按键（Enter、backspace、方向键、tab、escape、Ctrl+C）在派发前
// 都会先强制 flush 掉任何待处理文本，这样粘贴内容会先被提交，
// 再响应那个作用于它的按键。
import { useEffect, useRef } from 'react'

import { useStdin } from 'ink'

const ENABLE_BRACKETED_PASTE = '\x1b[?2004h'
const DISABLE_BRACKETED_PASTE = '\x1b[?2004l'
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

// 用来合并快速 stdin burst 的时间窗。
// 30ms 远低于人类打字的节奏（键与键之间大约 100-200ms），
// 但又远高于粘贴字符之间的亚毫秒空隙，所以可以把两者清楚分开。
const PASTE_DEBOUNCE_MS = 30

// 一个按键允许停留在 debounce buffer 里的最长时间 - 到点后必须 flush，
// 即使后面还有更多事件继续到来。
// 如果没有这个上限，长按一个键（OS repeat 约 33ms / 30Hz）会在每次 repeat
// 事件上都重置 debounce timer，结果就是直到松手前都不会 flush，
// 用户体感像冻结了一样，直到松手才一次性补出来。
// 50ms 低于人对“立刻响应”的感知阈值，但又足够让亚毫秒级的 paste burst 合并起来。
const MAX_BATCH_MS = 50

// 任何 size >= 这个阈值的 stdin chunk（或者包含换行）都会被怀疑成粘贴，
// 并走 debounce buffer，这样连续碎片会合并成一次 onPaste。
// 小于这个阈值的 chunk 则被当作正常输入并立即派发——
// 这和 Claude Code 的 PASTE_THRESHOLD（800）做法一致。
// 长按按键只会产生单字符 stdin 事件；如果阈值太低（以前是 8），
// 每个按键都会走 debounce，输入手感就会变得很拖。
const PASTE_SIZE_THRESHOLD = 32

export type PromptKey =
  | 'return'
  | 'newline'
  | 'backspace'
  | 'delete'
  | 'tab'
  | 'escape'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'home'
  | 'end'
  | 'pageup'
  | 'pagedown'

export interface PromptInputHandlers {
  /** 普通键入的文本（如果终端把一小段事件合并了，也可能是多字符）。 */
  onText: (text: string) => void
  /** 原子粘贴 - 永远是一整个 paste 事件的完整内容。 */
  onPaste: (content: string) => void
  /** 特殊按键。 */
  onKey: (key: PromptKey) => void
  /** Ctrl+C 时调用 - 应该通过 useApp().exit() 触发干净的 Ink 卸载。 */
  onInterrupt: () => void
  /** 在不卸载组件的情况下开启 / 关闭监听。 */
  enabled: boolean
}

export function usePromptInput({ onText, onPaste, onKey, onInterrupt, enabled }: PromptInputHandlers): void {
  const { stdin, setRawMode } = useStdin()

  // 把 handlers 存进 ref，这样 effect 就不会在每次 render 时重新订阅。
  // 每次 render 都会生成新的 callback closure，但我们想要的是一个稳定的订阅，
  // 它始终调用最新的 handlers。
  //
  // 这个赋值必须放在 useEffect 里，而不是 render 期间：
  // 在 render 里改 ref.current 会触发 React 并发模式相关的规则警告，
  // 还可能让 Strict Mode 的双调用看到不一致状态。
  // 没有依赖数组的 effect 会在每次 commit 后都运行，正好符合我们要的“最新值”语义。
  const handlersRef = useRef({ onText, onPaste, onKey, onInterrupt })
  useEffect(() => {
    handlersRef.current = { onText, onPaste, onKey, onInterrupt }
  })

  // bracketed-paste 状态会跨 stdin chunk 持续保存，这样分散在多个 data event 里的粘贴
  // 也能被拼成一个整体。
  const pasteStateRef = useRef<{ inPaste: boolean; buffer: string; timer: NodeJS.Timeout | null }>({
    inPaste: false,
    buffer: '',
    timer: null,
  })

  // fallback 路径用的 debounce buffer + timer。
  const pendingTextRef = useRef<string>('')
  const pendingTimerRef = useRef<NodeJS.Timeout | null>(null)
  /** 当前缓冲 burst 开始时的墙钟时间（自 epoch 起的毫秒数）。
   *  0 表示没有 burst 在进行。
   *  用来把 debounce 延迟上限钳在 MAX_BATCH_MS，这样持续的 key-repeat
   *  事件会周期性 flush，而不会无限重置 timer。 */
  const pendingBurstStartRef = useRef<number>(0)

  // 即使输入被禁用（例如加载中），Ctrl+C 也必须能工作。
  // 我们始终监听 stdin 里的 \x03，并把它路由到 onInterrupt。
  // 当 enabled=false 时，其他所有输入都会被忽略。
  useEffect(() => {
    if (!enabled) {
      // 最小监听器：只处理 Ctrl+C，其余一律忽略。
      setRawMode(true)
      const handleCtrlC = (data: Buffer | string): void => {
        const chunk = typeof data === 'string' ? data : data.toString('utf8')
        if (chunk.includes('\x03')) {
          handlersRef.current.onInterrupt()
        }
      }
      stdin.on('data', handleCtrlC)
      return () => {
        stdin.off('data', handleCtrlC)
        setRawMode(false)
      }
    }

    setRawMode(true)
    process.stdout.write(ENABLE_BRACKETED_PASTE)
    const useBracketedPaste = true

    // ── Flush debounce buffer ──
    //
    // 把上一次 burst 里积累的全部文本作为一次 onPaste（或者小 chunk 时的 onText）
    // 发出去。这里会把换行统一成 `\n`，因为 Windows 终端在粘贴换行时往往发 `\r`
    // 或 `\r\n`；而下游代码和终端的行渲染都更希望看到 `\n`。
    // 裸 `\r` 在终端打印里意味着“回到行首”，会覆盖前面的字符，
    // 这就是之前 echoed paste 里会出现那种“optimizations Claude Managed Agents is currently in beta”
    // 之类拼接错位的原因。
    const flushPending = (): void => {
      if (pendingTimerRef.current) {
        clearTimeout(pendingTimerRef.current)
        pendingTimerRef.current = null
      }
      pendingBurstStartRef.current = 0
      const raw = pendingTextRef.current
      if (!raw) return
      pendingTextRef.current = ''
      const text = raw.replace(/\r\n?/g, '\n')

      const looksLikePaste = text.length >= PASTE_SIZE_THRESHOLD || text.includes('\n')
      if (looksLikePaste) {
        handlersRef.current.onPaste(text)
      } else {
        handlersRef.current.onText(text)
      }
    }

    // 计算下一次 timer 延迟 - 既要按最新事件做 debounce，
    // 又要确保 buffer 从第一个字符开始不会停留超过 MAX_BATCH_MS
    //（否则长按键会一直重置 debounce，直到松手都不 flush）。
    const armFlushTimer = (): void => {
      if (pendingBurstStartRef.current === 0) {
        pendingBurstStartRef.current = Date.now()
      }
      if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current)
      const elapsed = Date.now() - pendingBurstStartRef.current
      const remaining = Math.max(0, MAX_BATCH_MS - elapsed)
      const delay = Math.min(PASTE_DEBOUNCE_MS, remaining)
      pendingTimerRef.current = setTimeout(flushPending, delay)
    }

    // 把文本放进 debounce buffer，并（重新）启动 flush timer。
    // 这里只用于那些足够像粘贴的大 chunk；正常打字会完全绕过这个 buffer
    //（见 processNormalInput）。
    const queueText = (data: string): void => {
      pendingTextRef.current += data
      armFlushTimer()
    }

    // 派发特殊按键。总会先强制 flush 掉待处理文本，
    // 这样例如 Enter 会先提交之前缓冲的输入，再响应这个按键。
    const dispatchKey = (key: PromptKey): void => {
      flushPending()
      handlersRef.current.onKey(key)
    }

    // 解析一段非粘贴输入。识别到特殊按键就立即返回；
    // 否则就当作普通文本缓冲起来。
    const processNormalInput = (data: string): void => {
      if (data.length === 0) return

      if (data === '\r' || data === '\n') return dispatchKey('return')
      if (data === '\x7f' || data === '\b') {
        // 如果 debounce buffer 里已经有待处理文本，就通过截断 buffer 来吸收 backspace，
        // 而不是先 flush 再派发。
        if (pendingTextRef.current.length > 0) {
          pendingTextRef.current = pendingTextRef.current.slice(0, -1)
          return
        }
        // 立即派发，这样长按 backspace 才会有响应感
        //（以前 queueBackspace 会待在 debounce buffer 里，
        // timer 又会在每次 repeat 事件上重置，导致视觉上删除会卡到松手才动）。
        dispatchKey('backspace')
        return
      }
      if (data === '\t') return dispatchKey('tab')

      // Alt/Option+Enter -> 插入一个字面换行。
      // 大多数能区分 Alt 修饰键的终端会发 prefix-ESC 形式：`\x1b\r`
      //（Windows Terminal / Linux xterm / iTerm2 开了 "Esc+" Option mapping 时的 Alt+Enter）
      // 或者少数终端会发 `\x1b\n`。
      // 下面这些 CSI 形式来自 modifyOtherKeys / kitty keyboard protocol -
      // 我们目标环境里默认都没开，但如果高级用户自己打开了，我们也照样支持。
      //   xterm modifyOtherKeys: ESC [27;3;13~ (Alt+Enter), ESC [27;5;13~ (Ctrl+Enter)
      //   kitty CSI-u:           ESC [13;3u   (Alt+Enter), ESC [13;5u   (Ctrl+Enter)
      // 原生终端里普通 Ctrl+Enter 和 Enter 根本分不出来；
      // 只有 kitty/modifyOtherKeys 的 CSI 形式能把它传到这里，所以我们把它们都当成 Alt+Enter。
      if (data === '\x1b\r' || data === '\x1b\n') return dispatchKey('newline')
      if (data === '\x1b[27;3;13~' || data === '\x1b[27;5;13~') return dispatchKey('newline')
      if (data === '\x1b[13;3u' || data === '\x1b[13;5u') return dispatchKey('newline')

      if (data === '\x1b' || data === '\x1b\x1b') return dispatchKey('escape')

      // Ctrl+C - 先 flush，然后调用 interrupt handler
      //（它会通过 useApp().exit() 触发 Ink 的干净卸载）。
      // 我们不会发送 SIGINT，因为在 Windows 上 signal-exit 会在回调运行完后重新抛它，
      // 这样进程会在我们的 gracefulShutdown 运行前就以 code 1 退出。
      if (data === '\x03') {
        flushPending()
        handlersRef.current.onInterrupt()
        return
      }

      // ANSI arrow keys and navigation (exact matches)
      if (data === '\x1b[A') return dispatchKey('up')
      if (data === '\x1b[B') return dispatchKey('down')
      if (data === '\x1b[C') return dispatchKey('right')
      if (data === '\x1b[D') return dispatchKey('left')
      if (data === '\x1b[H' || data === '\x1b[1~') return dispatchKey('home')
      if (data === '\x1b[F' || data === '\x1b[4~') return dispatchKey('end')
      if (data === '\x1b[3~') return dispatchKey('delete')
      if (data === '\x1b[5~') return dispatchKey('pageup')
      if (data === '\x1b[6~') return dispatchKey('pagedown')
      // (Mode-cycle key bindings — Shift+Tab `\x1b[Z` and the Alt+M
      // `\x1b m` Windows fallback — were removed; mode switching is
      // driven exclusively by slash commands now. See ChatInput hint
      // text and the /plan handler in App.tsx.)

      // Unknown escape sequences — drop so they don't show up as literal
      // "\x1b[…" text in the input.
      if (data.startsWith('\x1b')) return

      // Printable text. Two paths:
      //  - Large or multi-line chunks go through the debounce buffer so
      //    a paste split across several stdin events (non-bracketed
      //    terminals sometimes fragment) merges into one onPaste call.
      //  - Small single-keystroke chunks dispatch IMMEDIATELY. Holding
      //    down a key fires stdin events at ~30 Hz and debouncing each
      //    one made the input feel frozen / stutter. Claude Code does
      //    the same (their usePasteHandler bypasses the paste buffer
      //    for input.length < PASTE_THRESHOLD).
      if (data.length >= PASTE_SIZE_THRESHOLD || data.includes('\n')) {
        queueText(data)
      } else {
        // Preserve ordering: drain any already-buffered text first.
        flushPending()
        handlersRef.current.onText(data)
      }
    }

    // Top-level stdin data handler. Walks the chunk looking for bracketed
    // paste markers; anything outside a paste block goes through
    // processNormalInput (and thus the debounce buffer for text).
    const handleData = (data: Buffer | string): void => {
      let chunk = typeof data === 'string' ? data : data.toString('utf8')

      while (chunk.length > 0) {
        const state = pasteStateRef.current

        if (state.inPaste) {
          const endIdx = chunk.indexOf(PASTE_END)
          if (endIdx === -1) {
            state.buffer += chunk
            return
          }
          state.buffer += chunk.slice(0, endIdx)
          // Clear the safety timeout
          if (state.timer) {
            clearTimeout(state.timer)
            state.timer = null
          }
          // Normalize line endings for the same reason flushPending does —
          // bare `\r` in pasted content acts as carriage return and
          // overwrites previous characters when later echoed to the
          // terminal.
          const content = state.buffer.replace(/\r\n?/g, '\n')
          state.buffer = ''
          state.inPaste = false
          // Bracketed paste trumps the debounce buffer — flush pending
          // text first so it doesn't get mixed in with the paste payload.
          flushPending()
          handlersRef.current.onPaste(content)
          chunk = chunk.slice(endIdx + PASTE_END.length)
          continue
        }

        const startIdx = chunk.indexOf(PASTE_START)
        if (startIdx === -1) {
          processNormalInput(chunk)
          return
        }
        if (startIdx > 0) {
          processNormalInput(chunk.slice(0, startIdx))
        }
        // Flush any pending typing before entering paste mode so we don't
        // concatenate typed chars with the paste content.
        flushPending()
        chunk = chunk.slice(startIdx + PASTE_START.length)
        state.inPaste = true
        // Safety timeout: if PASTE_END is never received (ConHost bug),
        // force-flush the buffer after 1 second so input doesn't freeze.
        state.timer = setTimeout(() => {
          const s = pasteStateRef.current
          if (!s.inPaste) return
          const content = s.buffer.replace(/\r\n?/g, '\n')
          s.buffer = ''
          s.inPaste = false
          s.timer = null
          if (content) {
            handlersRef.current.onPaste(content)
          }
        }, 1000)
      }
    }

    stdin.on('data', handleData)
    return () => {
      flushPending()
      // Clear paste safety timeout
      const ps = pasteStateRef.current
      if (ps.timer) {
        clearTimeout(ps.timer)
        ps.timer = null
      }
      ps.inPaste = false
      ps.buffer = ''
      stdin.off('data', handleData)
      if (useBracketedPaste) {
        process.stdout.write(DISABLE_BRACKETED_PASTE)
      }
      setRawMode(false)
    }
  }, [enabled, stdin, setRawMode])
}
