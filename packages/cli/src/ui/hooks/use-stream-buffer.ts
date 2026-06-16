// @x-code-cli/cli - 流式文本缓冲管理
//
// delta 会累积到 `bufferRef` 里。每次收到新 delta 后，我们都会寻找
// 最新的、单个 `\n` 的安全位置：它的前缀不能落在一个打开的多行 markdown
// 结构内部（table、code fence、list、blockquote）。
// 找到后，就把这之前的内容作为一条 `streamingChunk` 消息提交出去。
// 切点之后的内容继续留在 buffer 里，和后续 delta 合并，直到找到下一个安全边界
//（或者流结束，此时 `flushBuffer()` 会把剩余内容强制排空）。
//
// 为什么按“行”而不是按“段落”切：按段落（`\n\n`）切会变成“块状揭示”——
// 可读，但长回答会显得很碎。只要在安全前提下按每个 `\n` 切，就能一行一行地出，
// 这和 Claude Code 的做法一致（它每个 delta 都重绘整段文本，只把正在生成的尾行先藏起来，
// 等下一个 `\n` 到来后再显示）。我们没法在已经提交的 scrollback 上做任意重绘，
// 所以按行切是 append-only 架构里最接近的方案。
//
// 为什么要检查 open block：marked 的 lexer 需要整块结构一次性解析，
// 对 table、code fence、list、blockquote 都是如此——
// 单独提交 `| a | b |\n` 会被当成段落（渲染成裸管道符），
// 单独提交 `- item 1\n` 再提交 `- item 2\n` 会变成两个 1 项列表，中间还隔一行，
// 而不是一个完整列表。所以只要最后一行看起来还像是开放结构的一部分，
// 我们就把 buffer 留着，只有当下一行不是延续内容时才释放
// （标题、普通段落，或者一个明确关闭块的空行）。
//
// 直接“整段缓存后一次性输出”会彻底杀死流式体验。
// 直接“每个 `\n` 都无条件提交”又会破坏 table 和 list。
// 这个带保护的按行切分，正好是中间方案。
//
// 在安全边界切分之上，我们还会在一个很小的时间窗口内把连续提交合并成一次
// `appendMessage` 调用。模型经常连续吐出 2-3 个短段落
//（"...整理：\n\n"、"---\n\n"、"## 标题\n\n"）。
// 如果不合并，每个片段都会触发一次 setState → ChatInput render →
// BSU/ESU [J+redraw payload。对于那些没法把 DEC 2026 sync 完美原子化的终端
//（尤其是 VS Code 里的 xterm.js）来说，一个 vsync 窗口里连着几次大重绘会直接表现成闪烁。
// 约 32ms 的 always-defer 窗口（约 60Hz 下 2 帧）比 provider 常见的 80-200ms
// delta 间隔更短，也远低于人眼感知阈值，同时能让同一窗口内到来的提交只走一次
// React render -> 一次 stdout write。
import { useCallback, useRef } from 'react'

import type { DisplayMessage, ModelMessage } from '@x-code-cli/core'
import { debugLog } from '@x-code-cli/core'

/** `text` 是否已经结束在一个打开的多行 markdown 结构内部，
 *  而这个结构必须整体渲染才正确？
 *
 *  我们只保留那些被拆开后视觉上真的会坏掉的结构：
 *
 *  - 代码块：如果开头行里的 ``` 数量是奇数，就说明 fence 还开着。
 *    在打开的 fence 里切开，会把半截代码渲染成普通文本，丢掉等宽块的上下文。
 *  - 表格：最后一个非空行以 `|` 开头。GFM 表格必须在一次 lexer pass 里同时拿到
 *    header + separator + rows；中途切开会把不完整行渲染成原始的 `| a | b |` 文本。
 *
 *  有序列表、无序列表和 blockquote 则故意不在这里拦截——
 *  即便按行提交，它们的渲染也和整块提交几乎一致。
 *  每个单独解析的 `- item N\n` 都会变成一个 1 项列表，显示成 `• item N\n`，
 *  拼起来和整段列表解析得到的字节流一样（`- a\n- b\n` → `• a\n• b\n`）。
 *  `> line\n` 引用也一样（每段都会渲染成 `▎ line\n`）。
 *  唯一的小代价是：多行列表项里的 lazy continuation 可能会被渲染成单独缩进段落，
 *  但这种情况在 AI 输出里很少见；换来的是列表项能随着模型输出一个个出现，
 *  而不是等整块完成后一起跳出来。 */
function hasOpenMarkdownBlock(text: string): boolean {
  const fences = text.match(/^```/gm)
  if (fences && fences.length % 2 !== 0) return true

  const lines = text.split('\n')
  // 去掉 `split('\n')` 在文本以换行结尾时额外产生的那个尾部空串。
  // 这只是 split 的伪影，不是真正的空行。
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length === 0) return false

  const lastLine = lines[lines.length - 1]
  if (lastLine.trim() === '') return false
  if (lastLine.trimStart().startsWith('|')) return true
  return false
}

/** 返回 `text` 中最新一个安全的单个 `\n` 之后的位置；
 *  如果不存在则返回 -1。
 *  “安全”表示：这个 `\n` 之前的前缀没有终结在一个打开的多行块内部——
 *  把这个前缀提交出去后，markdown renderer 就能完整格式化它。
 *
 *  这里从尾部向前扫描，所以第一个命中的位置就是最新安全切点，
 *  不需要把每个换行都走一遍再取最大值。 */
function findSafeBoundary(text: string): number {
  let scan = text.length
  while (scan > 0) {
    const found = text.lastIndexOf('\n', scan - 1)
    if (found < 0) return -1
    const prefix = text.slice(0, found + 1)
    if (!hasOpenMarkdownBlock(prefix)) {
      return found + 1
    }
    scan = found
  }
  return -1
}

// 当代码块是打开状态时，正常的 `\n\n` 安全边界逻辑会把内容一直留到 fence 关闭。
// 对很长的代码块（100+ 行）来说，这会产生一次超大的提交，而那些 pre-scroll 的
// `\n` 会在终端 scrollback 里留下可见的空白行。为了避免这种情况，
// 我们在打开 fence 且 buffer 超过这个阈值时，强制按行提交一次。
// markdown renderer 的 `code` token handler 输出的是原始文本，
// 所以在 fence 内部切开在视觉上等价——唯一的区别是第一段会带上开头的 ```
// （被 marked.lexer 解析成 `code` token），后续片段则是普通文本行
// （由 fallback path 原样渲染）。
const CODE_FENCE_COMMIT_THRESHOLD = 800

/**
 * 安全网：从 loop state 里提取最近一条 assistant message 的文本。
 * 当流式过程中没有任何 text-delta 事件，但最终 response message 里仍然带着文本时，
 * 这个函数就用来把回复显示出来
 * （例如某些 reasoning model provider 会把所有内容都塞到最后一个 part 里）。
 */
export function extractLastAssistantText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== 'assistant') continue
    const content = msg.content
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    const parts: string[] = []
    for (const part of content as Array<{ type: string; text?: string }>) {
      if (part.type === 'text' && typeof part.text === 'string') {
        parts.push(part.text)
      }
    }
    return parts.join('')
  }
  return ''
}

export interface StreamBufferApi {
  /** 接收来自 agent loop 的 text delta。
   *  会为 rolling buffer 里每一条完整行（以 `\n` 结尾的子串）发出一条
   *  streamingChunk 消息；末尾的半截行则继续留在 buffer 里。 */
  appendTextDelta: (delta: string) => void
  /** 把剩余的半截行作为最后一条 streamingChunk 发出去。
   *  在 tool-call / turn end 边界调用，用来排空 buffer。 */
  flushBuffer: () => void
  /** 丢弃所有已缓存文本，不做任何发出。 */
  resetBuffer: () => void
}

let streamChunkSeq = 0

function makeStreamChunkMessage(content: string): DisplayMessage {
  return {
    id: `stream-${Date.now()}-${streamChunkSeq++}`,
    role: 'assistant',
    content,
    streamingChunk: true,
    timestamp: Date.now(),
  }
}

/** 用来合并提交的 always-defer 时间窗。
 *  在一段安静期里的第一条提交会启动一个 timer；
 *  在 timer 触发之前到来的后续提交会并入同一次发出。
 *  150ms 低于人对“卡顿”的大约 200ms 感知阈值，
 *  但又足够吞掉大多数“段落 + 分隔线 + 标题”式的 burst
 *  （它们通常在 section 边界附近以 30-150ms 的间隔到达）。
 *  和之前 48ms 的窗口相比，这会把大型 terminal frame redraw 的频率
 *  大约减半——streaming 时 live scrollback 区域“抖动”次数少一半，
 *  代价是段落会以稍微更成块的方式出现。 */
const COMMIT_BATCH_MS = 150

export function useStreamBuffer(appendMessage: (msg: DisplayMessage) => void): StreamBufferApi {
  /** 累积 buffer - 保存自上一次安全边界提交（或上一次 flush）以来的全部内容。 */
  const bufferRef = useRef<string>('')
  /** 等待合并成一次 appendMessage 调用的安全边界 chunk。
   *  在 deferred timer 触发（或 flushBuffer 排空）时清空。 */
  const pendingChunksRef = useRef<string[]>([])
  /** 触发 deferred emit 的 timer。没有待发内容时为 null。 */
  const emitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const drainPending = useCallback(() => {
    if (emitTimerRef.current !== null) {
      clearTimeout(emitTimerRef.current)
      emitTimerRef.current = null
    }
    const chunks = pendingChunksRef.current
    if (chunks.length === 0) return
    pendingChunksRef.current = []
    // 只有一个 chunk 时直接复用，避免不必要的 join 分配
    // （这通常是段落已经稳定下来的常见情况）。
    const combined = chunks.length === 1 ? chunks[0] : chunks.join('')
    debugLog('buffer.emit', `chunks=${chunks.length} chars=${combined.length}`)
    appendMessage(makeStreamChunkMessage(combined))
  }, [appendMessage])

  const queueChunk = useCallback(
    (chunk: string) => {
      pendingChunksRef.current.push(chunk)
      if (emitTimerRef.current === null) {
        emitTimerRef.current = setTimeout(drainPending, COMMIT_BATCH_MS)
      }
      // timer 已经启动 - 这个 chunk 直接搭在现有 deadline 上，
      // 这样长 burst 就不会无限延长等待时间。
    },
    [drainPending],
  )

  const appendTextDelta = useCallback(
    (delta: string) => {
      if (!delta) return
      debugLog('buffer.append', delta)
      bufferRef.current += delta
      const boundary = findSafeBoundary(bufferRef.current)
      if (boundary > 0) {
        const chunk = bufferRef.current.slice(0, boundary)
        bufferRef.current = bufferRef.current.slice(boundary)
        debugLog('buffer.commit', `chars=${chunk.length}`)
        queueChunk(chunk)
      } else if (bufferRef.current.length > CODE_FENCE_COMMIT_THRESHOLD && hasOpenMarkdownBlock(bufferRef.current)) {
        // 打开状态下的巨大代码块 - 强制在最后一个换行处做一次中间提交，
        // 这样终端就不用一次性 pre-scroll 100+ 行空白。
        // 这里找的是最后一个不属于 `\n\n` 对的 `\n`
        // （` \n\n` 已经由上面的 findSafeBoundary 处理过），然后在那里切开。
        const lastNL = bufferRef.current.lastIndexOf('\n')
        if (lastNL > 0) {
          const chunk = bufferRef.current.slice(0, lastNL + 1)
          bufferRef.current = bufferRef.current.slice(lastNL + 1)
          debugLog('buffer.commit', `chars=${chunk.length} (fence-split)`)
          queueChunk(chunk)
        }
      }
    },
    [queueChunk],
  )

  const flushBuffer = useCallback(() => {
    // turn 结束 / tool-call 边界 - 不会再有 delta 进来了，所以把剩下的全排空
    //（即便是没闭合的 table，也没有继续等的意义）。
    // 把 pending chunk + remainder 合成一条消息：
    // 如果分开发，会连续触发两次 setState → render → flush，
    // 这正是 batching 想要避免的闪烁。
    if (emitTimerRef.current !== null) {
      clearTimeout(emitTimerRef.current)
      emitTimerRef.current = null
    }
    const remainder = bufferRef.current
    bufferRef.current = ''
    if (remainder) pendingChunksRef.current.push(remainder)
    if (pendingChunksRef.current.length === 0) return
    const chunks = pendingChunksRef.current
    pendingChunksRef.current = []
    const combined = chunks.length === 1 ? chunks[0] : chunks.join('')
    debugLog('buffer.commit', `chars=${combined.length} (flush)`)
    appendMessage(makeStreamChunkMessage(combined))
  }, [appendMessage])

  const resetBuffer = useCallback(() => {
    if (emitTimerRef.current !== null) {
      clearTimeout(emitTimerRef.current)
      emitTimerRef.current = null
    }
    pendingChunksRef.current = []
    bufferRef.current = ''
  }, [])

  return { appendTextDelta, flushBuffer, resetBuffer }
}
