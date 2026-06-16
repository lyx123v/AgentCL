// @x-code-cli/cli - 直接写 stdout 的消息渲染器。
//
// 之所以需要这个文件，是因为 Ink 的布局引擎对宽字符（CJK）视觉宽度
// 计算不准，所以当 Ink 重绘某个区域时，可能会按错误的行数往回退，
// 结果把前面的内容盖住。表现出来就是长中文回复里会出现“bullets 被
// 切开”或者工具结果文本被打散的问题。
//
// Claude Code 通过内置一份定制版 Ink，并补上 grapheme-aware 的
// stringWidth 和 soft-wrap 元数据来规避同类问题。我们采用更简单的
// 路线：把消息历史完全放在 Ink 之外渲染，直接通过 Ink 的
// `useStdout()` hook 返回的 `write` 方法往 stdout 写原始 ANSI。
// 这个方法在文档里被描述成“类似 <Static>，只是……它只能处理字符串”。
// 它会走 Ink 内部的 writeToStdout，从而和 log-update 正确协作
// （先清空动态区域 -> 写入 -> 再重绘）。我们没有选 `console.log` +
// `patchConsole`，因为后者在超大的多行写入场景里，内部字符串处理
// 曾经被观察到会丢内容。
//
// Ink 仍然负责屏幕底部那块动态区域（spinner、进行中的 tool call、
// 权限弹窗、chat input）。那一块内容很短，而且大多是 ASCII，所以
// Ink 自己的宽度测量已经足够。
import { Chalk } from 'chalk'

import { debugLog } from '@x-code-cli/core'
import type { DisplayMessage, DisplayToolCall } from '@x-code-cli/core'

import { renderEditDiff } from './render-diff.js'
import { renderInlineMarkdown, renderMarkdown } from './render-markdown.js'
import { GLYPH_BULLET, GLYPH_ELLIPSIS, GLYPH_PROMPT_ARROW, GLYPH_RESULT_BRACKET } from './terminal-glyphs.js'
import { BLUE_PURPLE, ERROR, PROMPT_BORDER, SUCCESS } from './theme.js'
import {
  RESULT_INDENT,
  formatDuration,
  formatReadGroupSummary,
  getToolInputPreview,
  getToolLabel,
  getToolResultSummary,
  isCollapsibleReadOnlyTool,
  normalizeLineEndings,
} from './utils.js'

const c = new Chalk({ level: 3 })

/** 通过 Ink 的 log-update 协调机制写 stdout 的函数。 */
export type InkWrite = (data: string) => void

/**
 * 截断 `s`，让它在视觉上塞进 `maxLen` 个可打印 cell。
 * 这里用 UTF 省略号（…）作为截断标记 - 它只占 1 个 cell，
 * 比三个点更紧凑，也和 CC 的预览截断风格一致。
 */
function truncatePreview(s: string, maxLen: number): string {
  if (maxLen < 4 || s.length <= maxLen) return s
  return s.slice(0, maxLen - 1) + GLYPH_ELLIPSIS
}

function formatToolCall(tc: DisplayToolCall): string {
  const label = getToolLabel(tc.toolName)
  const rawPreview = getToolInputPreview(tc.toolName, tc.input)
  // 给预览加上上限，避免很长的 Bash 命令 / 文件路径在 scrollback 里
  // 换成参差不齐的多行块。这里按终端宽度来算预算，所以宽终端能拿
  // 到更多空间。line1 前缀是 ` ● <label>(`，结尾还要补 `)`，所以要
  // 为这些装饰预留 label.length + 5 个 cell；另外再留一点安全余量，
  // 给终端可能额外加上的 `\x1b[K` / 光标定位字符腾地方。
  const cols = Math.max(40, process.stdout.columns ?? 120)
  const decoration = label.length + 5
  const safetyMargin = 4
  const maxPreviewLen = Math.max(40, cols - decoration - safetyMargin)
  const inputPreview = truncatePreview(rawPreview, maxPreviewLen)
  const resultSummary = getToolResultSummary(tc.toolName, tc.output, tc.status)
  const isDenied = tc.status === 'denied'
  const isError = tc.status === 'error'
  const isFailure = isDenied || isError
  const durationStr = tc.durationMs != null ? formatDuration(tc.durationMs) : null

  const dotColor = isFailure ? ERROR : SUCCESS
  const previewSuffix = inputPreview ? c.hex(BLUE_PURPLE)(`(${inputPreview})`) : ''
  const line1 = ` ${c.hex(dotColor)(GLYPH_BULLET)} ${c.bold(label)}${previewSuffix}`

  // edit / writeFile 成功路径：在 bullet 下面渲染结构化 diff，取代那种
  // 纯文本的 "Wrote N lines" / "Applied changes" 汇总。
  // 只有工具真的成功时才走这里；如果编辑失败，就保留普通的 markdown
  // 汇总，这样红色错误信息会落在用户预期的位置。
  if (tc.editPayload && !isFailure) {
    const cols = Math.max(40, process.stdout.columns ?? 120)
    const diffLines = renderEditDiff(tc.editPayload, cols)
    const head = `   ${c.gray(GLYPH_RESULT_BRACKET)}  ${diffLines[0] ?? ''}`
    const body = diffLines.slice(1)
    const durSuffix = durationStr ? c.gray(` (${durationStr})`) : ''
    const combined = body.length > 0 ? [head, ...body] : [head]
    combined[combined.length - 1] = combined[combined.length - 1] + durSuffix
    return `${line1}\n${combined.join('\n')}`
  }

  if (!resultSummary) return line1

  // 通过 markdown pipeline 渲染结果，这样带标题 / 列表 / 行内代码等
  // 的 tool 输出就会以样式化方式显示，而不是原样露出 `### ...` /
  // `**...**` 这些字符。被拒绝或出错的结果会以纯红文本显示，让失败
  // 在 scrollback 里更醒目 - 这和 Claude Code 对非零 shell 退出时
  // 把 stderr / exit-code block 染红的行为一致。
  const rendered = isFailure ? resultSummary : renderMarkdown(resultSummary).replace(/\n+$/, '')

  // 去掉空行 - markdown 渲染会在块与块之间插入段落间距，这会让
  // tool result summary 看起来很散（标题、空行、URL、空行、"... +7 lines"）。
  // 这里我们想要的是紧凑的 2-3 行摘要，而不是段落化正文。
  const lines = normalizeLineEndings(rendered)
    .split('\n')
    .filter((l) => l.trim().length > 0)
  const durSuffix = durationStr ? c.gray(` (${durationStr})`) : ''
  // 出错行要在拆分成行之后再统一套 ERROR 颜色。
  // 如果提前染色再 split，ANSI reset 序列会把中间样式拆开，导致
  // 一半内容没上色。按行上色更稳妥。
  const paint = isFailure ? (s: string) => c.hex(ERROR)(s) : (s: string) => s
  const head = `   ${c.gray(GLYPH_RESULT_BRACKET)}  ${paint(lines[0] ?? '')}`
  const tail = lines.slice(1).map((l) => `${RESULT_INDENT}${paint(l)}`)
  // 耗时信息放在正文最后一行，这样在被截断的摘要里看起来就是
  // `... +13 lines (1.2s)` 这种形式。
  const combined = tail.length > 0 ? [head, ...tail] : [head]
  combined[combined.length - 1] = combined[combined.length - 1] + durSuffix
  return `${line1}\n${combined.join('\n')}`
}

/** 把所有 LF 替换成 CRLF。
 *  这是为了防御某些终端里 stdout 的 ONLCR 输出转换被禁用的情况
 *  （Ink 会把 stdin 设成 raw mode，但 stdout 的 termios 配置会因
 *  实现不同而不同；尤其是 VS Code terminal，已经观察到它不会把
 *  纯 LF 翻译成 CRLF）。如果不显式加 `\r`，光标就会停留在线尾，
 *  而后续的 cell-buffer 重绘又会通过 `\x1b[1G` 把列定位到 1，
 *  结果只覆盖前几列，刚写进去的文本尾巴还会“挂”在下一行内容右边，
 *  看起来就像 Thinking 旁边残留了一截半截文本。 */
function toCRLF(s: string): string {
  return s.replace(/\r?\n/g, '\r\n')
}

/**
 * 上一次 scrollback 写入后，最后一行下面是不是已经留出了完整空行？
 * 这个标记用来保证相邻实体之间永远只隔 1 个空白行，不管谁先写都一样。
 *
 * 为什么需要这个标记：流式文本 chunk 每次结尾都只有一个 `\n`
 * （光标到下一行，但并没有额外空白行），所以如果某个 tool call 刚好
 * 在流式输出结束后提交，它就会紧贴着文本。用户消息和最终完成的
 * tool / text 写入本来就会留一个尾随空白，所以它们之间不需要再额外
 * 插空行。这个标记让下一个实体可以自己判断：如果前一次写入没有先
 * 画出空白行，那就补一个；否则就别补。
 *
 * 这里初始化为 `true`，这样一个会话里的第一次写入不会在终端顶部
 * 先画出一个前导空白行。
 */
let prevWriteEndedWithBlankRow = true

/**
 * 上一次写入是不是 streaming text chunk？
 * 如果下一次写入也是 streaming chunk，我们会把它视为同一条 assistant
 * 消息的续写，并且不再补 `prevWriteEndedWithBlankRow` 机制原本会加的
 * 那个前导空白行。每个 streaming chunk 都只以一个 `\n` 结尾
 * （没有尾随空白行），所以如果没有这个保护，空白行会在每个 chunk
 * 边界都被插进去；而流式缓冲是按节奏 flush 的，不是按 Markdown 结构
 * flush 的，于是这些边界会落在相邻列表项 / 段落行之间，形成模型
 * 本来没写出来的可见空隙。
 */
let prevWriteWasStreamingChunk = false

/** 重置间距标记 - 在 scrollback 被清空时调用（比如 /clear），这样
 *  下一次写入就不会误以为上方还留着空白行。
 *  同时也要清掉任何缓冲中的 read-group：/clear 之后这些条目都指向
 *  已经不在 scrollback 里的旧消息了，如果还提交它们的汇总，就会在
 *  现在空空的历史上方留下一个幽灵行。 */
export function resetScrollbackSpacing(): void {
  prevWriteEndedWithBlankRow = true
  prevWriteWasStreamingChunk = false
  pendingReadGroup = []
}

/** 最近一次 scrollback 写入后，最后一行下面有没有已经空出完整空行？
 *  ChatInput 的 frame builder 会读这个值，这样 live 的 tool / spinner
 *  块就能和已提交 tool 的路径使用同一套前导空白规则 - 否则 live
 *  frame 会直接贴着 streaming text 画，等工具真正结束时空白才突然
 *  “冒出来”，视觉上就会有一个明显的跳变。 */
export function lastWriteEndedWithBlankRow(): boolean {
  return prevWriteEndedWithBlankRow
}

/** 连续完成的只读 tool call 的待处理缓冲区。
 *  它会收集连续到达的 Read / Glob / Grep / ListDir
 *  （`isCollapsibleReadOnlyTool`）行，然后把它们折叠成一条
 *  `● Read 3 files (foo.ts, bar.ts, baz.ts)` 这样的汇总行。
 *
 *  为什么要用模块级缓冲，而不是在渲染时顺手做转换：
 *  scrollback 是只增不改的终端历史 - 一旦某行通过 `process.stdout.write`
 *  写出去了，就不能回头修改。Claude Code 能把这件事放在渲染时处理，
 *  是因为 Ink 拥有整段 transcript，并且会在状态变化时整段重渲染；
 *  我们没有这种能力，所以要想“合并”这些行，只能先延迟提交，
 *  等确认后面还会不会再来更多行。
 *
 *  触发 flush 的时机有两个：
 *  (a) 任何不可折叠的消息进入 `writeMessageToStdout`
 *      （assistant 文本、write tool、user message，都会打断链条）
 *  (b) 外部显式调用 `flushPendingReadGroup`
 *      ，例如 ChatInput 在 turn 结束时的 commit 流程。
 *
 *  用户能直接感知到的后果是：单独一个 read tool 不会立刻出现在
 *  scrollback 里，要等 assistant 发出收尾文本（或者 turn 结束）后才
 *  会落盘。好处是 live tool indicator 会在这段时间内盖住空白，所以
 *  正常流程下这个延迟是看不出来的。这个取舍能换来多 read 链条的
 *  更清爽显示，代价是可以接受的。 */
let pendingReadGroup: DisplayToolCall[] = []

/** 当 `msg` 是一个只包含已完成、非编辑、只读 tool call 的单消息包时
 *  返回 true（没有 assistant 文本，也没有 command kind）。
 *  这类消息可以进入缓冲；其他任何消息都会先把缓冲刷掉，再正常渲染。 */
function isCollapsibleMessage(msg: DisplayMessage): boolean {
  if (msg.role !== 'assistant') return false
  if (msg.content) return false
  if (msg.kind) return false
  if (!msg.toolCalls || msg.toolCalls.length === 0) return false
  return msg.toolCalls.every(
    (tc) => tc.status === 'completed' && !tc.editPayload && isCollapsibleReadOnlyTool(tc.toolName),
  )
}

/** 渲染一条 tool row（单 tool flush 路径）。
 *  结构和 `writeMessageToStdout` 的 tool 循环里 `formatToolCall` 产出的
 *  结果一致。把它抽出来，是为了让 flush 逻辑能复用，而不用重新推导
 *  前导空白行规则。 */
function writeToolRow(write: InkWrite, tc: DisplayToolCall): void {
  const lead = prevWriteEndedWithBlankRow ? '' : '\n'
  write(toCRLF(lead + normalizeLineEndings(formatToolCall(tc)) + '\n'))
  prevWriteEndedWithBlankRow = false
  prevWriteWasStreamingChunk = false
}

/** 渲染折叠后的分组汇总行，例如：
 *    ` ● Read 3 files (foo.ts, bar.ts, baz.ts)`
 *  这个格式会尽量保持普通 tool row 的视觉节奏：绿色 bullet
 *  （表示所有成员都已完成）、加粗标签、BLUE_PURPLE 的括号细节。
 *  这里不再输出 `⎿` 的 result 正文 - 因为折叠的目的就是把每个调用
 *  的单独结果行去掉。 */
function writeCollapsedGroup(write: InkWrite, tools: readonly DisplayToolCall[]): void {
  const { label, detail } = formatReadGroupSummary(tools)
  const detailSuffix = detail ? c.hex(BLUE_PURPLE)(`(${detail})`) : ''
  const line = ` ${c.hex(SUCCESS)(GLYPH_BULLET)} ${c.bold(label)}${detailSuffix}`
  const lead = prevWriteEndedWithBlankRow ? '' : '\n'
  write(toCRLF(lead + line + '\n'))
  prevWriteEndedWithBlankRow = false
  prevWriteWasStreamingChunk = false
}

/** 把缓冲中的连续只读 tool call 提交到 scrollback。
 *  单个 tool 时，会按普通 tool row 渲染（带 result 正文，这样单独的
 *  read 不会丢掉它自己的结果说明）。两个及以上时，则会折叠成一条
 *  汇总行。这个函数是幂等的 - 缓冲为空时调用也没问题。
 *
 *  它会在 `writeMessageToStdout` 处理每个不可折叠消息之前自动调用，
 *  也会在 ChatInput 的 commit pass 里、当 `isLoading` 为 false 时
 *  被外部调用。这样一条没有收尾文本就结束的链条（比如用户中断）
 *  也能把汇总真正写进 scrollback，而不是一直悬在缓冲里。 */
export function flushPendingReadGroup(write: InkWrite): void {
  if (pendingReadGroup.length === 0) return
  const buffered = pendingReadGroup
  pendingReadGroup = []
  if (buffered.length === 1) {
    writeToolRow(write, buffered[0]!)
  } else {
    writeCollapsedGroup(write, buffered)
  }
}

/** 把一条 DisplayMessage 打印到 stdout。 */
export function writeMessageToStdout(write: InkWrite, msg: DisplayMessage): void {
  // read-group 缓冲：如果一条消息只包含已完成、非编辑、只读的 tool
  // call，它会先进 `pendingReadGroup`，直到下一个不可折叠消息到来，
  // 或者外部显式调用 `flushPendingReadGroup`。
  // 在其它分支最前面先 flush，可以保证当前消息渲染之前，积累下来的
  // read 都已经写出去了，这样链式摘要就会按正确的 scrollback 顺序
  // 排列（` ● Read 3 files` 会出现在 ` …final assistant text` 上面）。
  if (isCollapsibleMessage(msg)) {
    for (const tc of msg.toolCalls!) pendingReadGroup.push(tc)
    return
  }
  flushPendingReadGroup(write)

  if (msg.role === 'user') {
    const content = normalizeLineEndings(msg.content)
    debugLog('stdout.user', content)
    writeUserMessage(write, content, msg.kind === 'command-echo')
    // writeUserMessage 总会输出一个尾随 `\n\n`
    // （compact slash-echo 时则是 `\n`） - 不管哪种情况，下一条
    // 内容都会落在一个已经预留好前导空白的全新行上。
    prevWriteEndedWithBlankRow = msg.kind !== 'command-echo'
    prevWriteWasStreamingChunk = false
    return
  }

  // 紧凑的 slash-command 结果 - 渲染成一条收紧的 `  ⎿  text` 行，这样
  // `> /cmd` + result 会显示成 Claude 风格的 2 行块，而不是 command +
  // 空行 + 缩进正文 + 空行。
  //
  // 正文会走 `renderInlineMarkdown`，这样我们在 slash-command handler
  // 里发出的 `**name**` / `` `code` `` / `_italic_` 标记就能真正显示成
  // 样式，而不是直接露出原始的 `**` / backtick 字符。这里我们刻意不把
  // 正文包进 `c.gray(...)`，虽然灰色常被当成“次要信息”的统一色调，
  // 但它会把内部所有内容一起压暗（包括 bold 和真彩 inline-code），
  // 结果 markdown 的样式几乎看不出来 - bold 变成“灰色的灰色”，
  // inline-code 的蓝紫色也会和灰底失去对比。`⎿` glyph 仍然保留为灰色
  // 结构标记；正文则使用终端默认前景色，让 bold 和 inline-code 自己
  // 跳出来。
  if (msg.kind === 'command-result' && msg.content) {
    const content = normalizeLineEndings(msg.content)
    debugLog('stdout.command-result', content)
    const lines = content.split('\n')
    const head = `  ${c.gray(GLYPH_RESULT_BRACKET)}  ${renderInlineMarkdown(lines[0] ?? '')}`
    const tail = lines.slice(1).map((l) => `${RESULT_INDENT}${renderInlineMarkdown(l)}`)
    write(toCRLF([head, ...tail].join('\n') + '\n'))
    prevWriteEndedWithBlankRow = false
    prevWriteWasStreamingChunk = false
    return
  }

  // Assistant message — may have tool calls, a text body, or both.
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    for (const tc of msg.toolCalls) {
      debugLog('stdout.tool-call-line', `${tc.toolName} ${tc.status}`)
      // Prepend a `\n` if the previous write (most often the final
      // streaming-chunk of an assistant text body) didn't leave a blank
      // row below it. Without this guard, text→tool transitions paste
      // the bullet row directly under the text — exactly the "no
      // breathing room above the tool" issue the user flagged. After
      // writes that already ended with `\n\n` the flag is true and we
      // skip the leading newline so we don't double-blank.
      const lead = prevWriteEndedWithBlankRow ? '' : '\n'
      write(toCRLF(lead + normalizeLineEndings(formatToolCall(tc)) + '\n'))
      prevWriteEndedWithBlankRow = false
      prevWriteWasStreamingChunk = false
    }
  }

  if (msg.content) {
    const content = normalizeLineEndings(msg.content)
    debugLog(msg.streamingChunk ? 'stdout.assistant-chunk' : 'stdout.assistant-full', content)
    // 当这个 chunk 只是同一条 assistant 消息里前一个 streaming chunk
    // 的续写时，不要再补前导空白 - 前一个 chunk 已经靠尾部的 `\n`
    // 把光标推进到下一行了。再补一个 `\n` 会在相邻列表项 / 段落行之间
    // 画出一个看得见的空白，而模型原文里其实只有一个普通换行。
    // 不过在非 streaming 的实体之间（比如 tool result → final text）
    // 仍然会正常补空白，避免内容贴在一起。
    const isStreamContinuation = !!msg.streamingChunk && prevWriteWasStreamingChunk
    if (!prevWriteEndedWithBlankRow && !isStreamContinuation) {
      write(toCRLF('\n'))
      prevWriteEndedWithBlankRow = true
    }

    // 对纯空白的 streaming chunk 做特判（比如单独一个 `"\n"`，
    // 它表示两段 prose 之间的段落断点）。Markdown 渲染会把它折叠成
    // 空字符串，这样视觉上的段落断开就会丢失，所以这里直接把空白
    // 原样传过去。
    if (msg.streamingChunk && content.trim() === '') {
      // 这是一个纯段落断点 token。它本身已经编码了一个空行
      // （只包含空白的 `\n` 或 `\n\n`）；写完之后光标会落在空白行
      // 下面，所以下一条实体就不需要再额外前置空行了。
      write(toCRLF(content))
      prevWriteEndedWithBlankRow = content.endsWith('\n\n') || content.endsWith('\n')
      prevWriteWasStreamingChunk = true
      return
    }

    // 这里统一使用两个空格缩进，和整个 assistant 正文的间距保持一致。
    const body = renderMarkdown(content)
    const indented = normalizeLineEndings(body)
      .split('\n')
      .map((line) => (line ? `  ${line}` : line))
      .join('\n')
    if (msg.streamingChunk) {
      // Streaming chunk 自带尾随换行 - renderMarkdown 会让列表项输出
      // `"line\n"`、标题输出 `"line\n"`，如果一个 block 后面跟着段落
      // 断点 token，则会输出 `"line\n\n"`。这里的 `  ${line}` 缩进映射
      // 会原样保留这些结尾的 \n。
      //
      // 我们必须确保 chunk 至少以一个 \n 结尾，这样光标才能真的
      // 前进到下一行：后续的 frame 重绘会从 writeMessage 留下的光标
      // 位置开始，如果这里不换行，下一帧的 row-0 就会把 chunk 文本
      // 直接盖掉。保险起见，如果 renderMarkdown 返回了一个没有尾随
      // 换行的 body（理论上可能发生在未知 token 形态或 catch 回退的
      // 纯文本路径里），这里就补一个。
      const out = indented.endsWith('\n') ? indented : indented + '\n'
      write(toCRLF(out))
      // 如果 streaming chunk 以 `\n\n` 结尾，就说明它已经到达了一个
      // 真正的段落断点（比如 heading + blank line 这种结构之后）。
      // 这时下一条实体会落在一个真实的空白行下面。其它情况则只以
      // 单个 `\n` 结尾，所以还需要下一条实体自己再补一个空白。
      prevWriteEndedWithBlankRow = out.endsWith('\n\n')
      prevWriteWasStreamingChunk = true
    } else {
      write(toCRLF(indented + '\n\n'))
      prevWriteEndedWithBlankRow = true
      prevWriteWasStreamingChunk = false
    }
  }
}

/**
 * 原样回显一条用户消息。
 * 对于多行内容，我们会把后续行缩进两个空格，这样它们会和第一行里
 * 跟在 `❯` prompt glyph 后面的文本对齐。这里假设 `content` 已经被
 * 归一化成 `\n` 分隔。
 *
 * `compact` 用在 slash-command 的回显里：我们会去掉尾随空白行，这样
 * 后面的 `  ⎿  result` 行就能紧贴在回显下面，形成和 Claude Code
 * 一样的 2 行命令块。
 */
function writeUserMessage(write: InkWrite, content: string, compact = false): void {
  const arrow = c.hex(PROMPT_BORDER)(GLYPH_PROMPT_ARROW)
  const lines = content.split('\n')
  const [first = '', ...rest] = lines
  const indentedRest = rest.map((line) => `  ${line}`)
  const body = [`${arrow} ${first}`, ...indentedRest].join('\n')
  // 前面的 \n 会先留出一行 margin-top，这样回显就不会和上一个
  // assistant 回复的最后一行内容挤在一起。
  // 这里使用显式 CRLF 换行 - 原因见上面的 toCRLF()。
  const trailing = compact ? '\n' : '\n\n'
  write(toCRLF('\n' + body + trailing))
}
