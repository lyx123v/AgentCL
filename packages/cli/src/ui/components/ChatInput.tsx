// @x-code-cli/cli - 底部动态区域（spinner + 输入框）以及新消息的 scrollback 提交路径。
//
// 渲染策略 - cell 级 diff，直接写 stdout：
//   Ink 的 Yoga 布局和 log-update 都会把 CJK/IME 的宽度算错。
//   即便是 @jrichman/ink 分支，在 Windows ConHost 上也没法完全消掉抖动，
//   因为终端层面的 CJK 渲染并不是原子性的。为了绕开这两套引擎，
//   我们直接自己渲染整个底部区域：
//
//     - 每一帧 = 由 cell 组成的二维网格（字符 + 样式 + 视觉宽度）
//     - 和上一帧逐 cell 做 diff
//     - 把所有变化一次性写进 `process.stdout.write()`
//     - 没变化的 CJK cell 永远不重新发出 -> 不会产生重绘抖动
//
//   我们向 Ink 返回 `null`，这样 Ink 的动态区域就是空的；
//   用户已经看到的 scrollback 下面整块区域都归我们自己管理。
//
// 这个组件负责的内容（而不是 Ink）：
//     - 加载中的 spinner 行（`isLoading` 为 true 时）
//     - 顶部 / 底部分隔线
//     - 带光标的输入文本
//     - slash 命令补全菜单
//     - 内嵌的 Permission 和 SelectOptions 对话框
//     - 把新到达的 `messages` 提交到 frame 上方的 scrollback
//       （通过 writeMessageToStdout，并和 frame redraw 合成同一份原子 payload
//       发送出去 - 见 flush effect）
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'

import { useStdout } from 'ink'

import { debugLog, suggestRuleLabel } from '@x-code-cli/core'
import type { DisplayMessage, TodoItem } from '@x-code-cli/core'

import { type FileEntry, applyCompletion, detectAtToken, scoreAndRank } from '../file-completion.js'
import type { ActiveToolCall } from '../hooks/use-agent.js'
import { useFileCompletion } from '../hooks/use-file-completion.js'
import { usePromptInput } from '../hooks/use-prompt-input.js'
import { HISTORY_MAX, appendInputHistory, loadInputHistory } from '../input-history.js'
import type { InputHistoryEntry } from '../input-history.js'
import { type PastedContents, expandPasteRefs, formatPasteRef, stripTrailingRef } from '../paste-refs.js'
import { renderInlineMarkdown } from '../render-markdown.js'
import {
  flushPendingReadGroup,
  lastWriteEndedWithBlankRow,
  resetScrollbackSpacing,
  writeMessageToStdout,
} from '../stdout-writer.js'
import {
  GLYPH_ACCEPT_EDITS,
  GLYPH_BULLET,
  GLYPH_ELLIPSIS,
  GLYPH_PLAN_MODE,
  GLYPH_RESULT_BRACKET,
  GLYPH_SELECT_POINTER,
  GLYPH_TODO_BRACKET,
  GLYPH_TODO_CHECK,
  GLYPH_TODO_IN_PROGRESS,
  GLYPH_TODO_PENDING,
  SPINNER_FRAMES,
} from '../terminal-glyphs.js'
import { charWidth, sliceByWidth, visualWidth } from '../text-width.js'
import { formatTokenCount, getToolInputPreview, getToolLabel, isCollapsibleReadOnlyTool } from '../utils.js'
import { type Cell, ansiTextToCells, cellsEqual, renderRowToAnsi, textToCells } from './chat-input/cells.js'
import {
  BSU,
  ESU_HIDE,
  S_ACCENT_DIM,
  S_BLUE_PURPLE,
  S_BLUE_PURPLE_BOLD,
  S_BOLD,
  S_CURSOR,
  S_DIM,
  S_ERROR_BOLD,
  S_GRAY,
  S_GRAY_90,
  S_NONE,
  S_RESET,
  S_SPINNER,
  S_SUCCESS,
  S_SUCCESS_DOT,
  S_SUCCESS_DOT_DIM,
  S_WARNING_BOLD,
} from './chat-input/palette.js'
import { formatElapsed, permissionContentCells, permissionTitle } from './chat-input/permission.js'
import { inputReducer } from './chat-input/reducer.js'
import {
  countContentRows,
  skipByWidth,
  truncateCellRow,
  truncatePathFromStart,
  wrapCellsToRows,
} from './chat-input/text-helpers.js'
import type { MenuItem, PermissionRequest, SelectRequest, SlashCommand, SpinnerState } from './chat-input/types.js'

export type { PermissionRequest, SelectRequest, SlashCommand, SpinnerState } from './chat-input/types.js'

const PASTE_REF_MIN_LINES = 3
const PASTE_REF_MIN_CHARS = 400
const MAX_VISIBLE_LINES = 10
const MAX_AT_RESULTS = 50
const MAX_VISIBLE_MENU_ITEMS = 8

interface ChatInputProps {
  /** 所有 scrollback 消息。新条目会通过直接写 stdout 提交到终端 scrollback
   *  （也就是我们 cell frame 上方的区域）。
   *  整个底部区域都由我们接管 - Ink 绝不能再写 scrollback，
   *  否则它的 log-update 会和我们抢光标位置。 */
  messages: readonly DisplayMessage[]
  /** 启动横幅（printHeader）占用的行数。
   *  用来初始化“frame 上方空白行”追踪器，这样第一次弹窗变高时，
   *  就不会把横幅本来留白的那些行也无谓地先滚走。 */
  initialContentRows?: number
  onSubmit: (text: string) => void
  /** 在 Ctrl+C 时触发。
   *  这里接到 App 的双击处理器：第一次按下会取消当前进行中的回合（如果有）并
   *  进入退出提示窗口；在这个窗口内第二次按下则直接退出进程。 */
  onInterrupt: () => void
  /** 当有回合在进行中（`isLoading`）时按 Esc 触发。
   *  语义对齐 Claude Code 的 `chat:cancel`：取消 AI 请求 + 正在运行的工具，
   *  但绝不会退出进程。没有 modal 时则不做任何事。 */
  onEscapeCancel?: () => void
  /** 当 AI 请求 / 工具正在运行时为 true。
   *  它会驱动 Esc 取消路由，以及 spinner 里的 `esc to interrupt` 提示。 */
  isLoading?: boolean
  /** 显示在输入框下方的临时单行提示，和 plan-mode / accept-edits 指示器
   *  共用同一个 footer 槽位（例如“再按一次 Ctrl+C 退出”）。
   *  由父组件在短超时后清除。 */
  notice?: string | null
  /** 忽略键盘输入（并隐藏输入光标）。 */
  disabled?: boolean
  /** 完全隐藏这块区域（例如 SelectOptions 对话框显示期间，而 Ink 仍然拥有底部区域时）。 */
  hidden?: boolean
  /** 非空时，在输入框上方渲染一行 spinner。 */
  spinner?: SpinnerState | null
  /** 运行中的工具调用。
   *  当它非空时，会替换掉通用的 “Thinking...” spinner：
   *  每个调用都会显示自己的 bullet + progress 行
   *  （`● Tool(preview)` / `⎿ ⠋ progressText`）。
   *  progress 文本通过 `onToolProgress` 流入。
   *  工具结束后，会通过常规的 tool-result DisplayMessage 路径提交到 scrollback。 */
  activeToolCalls?: readonly ActiveToolCall[]
  /** 来自模型 `todoWrite` 工具的实时清单。
   *  会以一个紧凑面板显示在 spinner 上方
   *  （☐ pending，◼ in_progress，✔ completed）。
   *  空数组会隐藏整个面板 - 当模型没用 TodoWrite 时没有任何视觉成本。 */
  todos?: readonly TodoItem[]
  /** 可选错误字符串，会以独立行显示在 spinner 上方。 */
  errorMessage?: string | null
  /** 非空时，在我们的 cell buffer 里渲染 Permission 对话框，并把
   *  键盘（Up/Down/Enter/y/n）路由给它来完成决策。
   *  之所以要自己渲染，而不是让 Ink 去画，是因为这是避免 zombie frame
   *  的唯一办法：Ink 的 log-update 会用终端里唯一的 DEC cursor-save
   *  寄存器（`\x1b7`），把我们想锚定的位置冲掉 - 所以每次 Permission 循环后，
   *  我们都没法可靠地擦掉上一帧。
   *  把 Permission 放进我们自己的 frame 里后，Ink 的动态区域就一直保持空白，
   *  不会再互相抢。 */
  permission?: PermissionRequest | null
  /** 非空时，在我们的 cell buffer 里渲染 select-options 对话框，并把
   *  Up/Down/Enter 路由给它。
   *  之所以和 `permission` 一样保持在 frame 内，是因为 Ink 的 dynamic region
   *  在高对话框 unmount 时会在 scrollback 里留下空行；
   *  终端增长时的自动滚动，在缩回去时是不可逆的。 */
  selectRequest?: SelectRequest | null
  commands?: readonly SlashCommand[]
  /** 当前审批模式，驱动输入框下方的指示行
   *  （`⏸ plan mode` / `⚡ accept edits`）。
   *  默认是 'default' - 不渲染任何指示器。 */
  permissionMode?: 'default' | 'acceptEdits' | 'plan'
  /** footer 行右侧的上下文窗口占用情况。
   *  会渲染成 `6.6k / 200k · 3%` 这种格式 - 让用户快速知道窗口有多满，
   *  而不是盯着某个单独的 arrow-token 数字。
   *  设计上对齐 Gemini-CLI / opencode 的模式（token 信息放在 footer，
   *  而不是放在 spinner 旁边）。传 null 可以完全隐藏（例如任何 API 响应还没回来时）。 */
  contextUsage?: { used: number; window: number } | null
}

// ── Component ───────────────────────────────────────────────────────────

export function ChatInput({
  messages,
  initialContentRows = 0,
  onSubmit,
  onInterrupt,
  onEscapeCancel,
  isLoading = false,
  notice,
  disabled,
  hidden,
  spinner,
  activeToolCalls,
  todos,
  errorMessage,
  permission,
  selectRequest,
  commands = [],
  permissionMode = 'default',
  contextUsage,
}: ChatInputProps) {
  const [{ text, cursor }, dispatch] = useReducer(inputReducer, { text: '', cursor: 0 })
  const cursorRef = useRef(0)
  // 双击 Esc 可以清空输入（只在 idle 模式生效；loading 模式会用单次 Esc 取消当前回合）。
  // 这里记录的是“上一次没有触发清空的 Esc”的时间戳；
  // 如果在 DOUBLE_ESC_WINDOW_MS 之内又按了一次，就会触发 RESET。
  const lastEscapeAtRef = useRef(0)
  useLayoutEffect(() => {
    cursorRef.current = cursor
  })
  const [pastedContents, setPastedContents] = useState<PastedContents>({})
  const [completionIndex, setCompletionIndex] = useState(0)
  const [atCompletionIndex, setAtCompletionIndex] = useState(0)
  // 记录用户通过 Esc 关闭掉的 trigger-key（atIdx + query）。
  // 当 atTrigger.atIdx + query 和这里相等时，菜单会隐藏；
  // 用户一旦继续输入或 backspace，trigger 自然就变了，菜单也会重新打开，
  // 不需要额外的“清空”路径。
  const [atDismissed, setAtDismissed] = useState<string | null>(null)
  const { entries: fileEntries } = useFileCompletion()
  const nextPasteIdRef = useRef(1)
  const activeRef = useRef(false)
  const prevFrameRef = useRef<Cell[][]>([])
  /** 最近一次真正写到终端上的 stdout.write 的时间戳（毫秒）。
   *  用来合并 spinner tick 的写入：它们常常会紧跟在 scrollback commit 之后触发，
   *  具体逻辑见 flush 部分。 */
  const lastFlushTimeRef = useRef(0)
  /** 待处理的 deferred（非 commit）写入，后续可能会被 commit 覆盖。 */
  const deferredFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 待执行的 throttled commit。
   *  当 commit 距离上一次写入小于 MIN_COMMIT_GAP_MS 时会进入这里 -
   *  它会再等一小会儿，确保落到一个新的 terminal paint cycle，
   *  而不是和上一写入挤进同一个 vsync。
   *  这和 `deferredFlushRef` 不一样，因为 defer 路径不能取消 throttled commit；
   *  一旦取消，就会丢掉 commit 的 preBuf 里承载的新 scrollback 内容。 */
  const commitThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 每次成功 `doFlush` 时单调递增的计数器。
   *  deferred-write 路径会在 SCHEDULE 时记录它，并在 FIRE 时再检查一次：
   *  如果值变了，就说明中途已经有 commit-path flush 跑过了，
   *  我们这次的 spinner-only frame 已经过时（commit 已经把 cell 重绘过了）。
   *  这能补上单纯 `clearTimeout` 取消抓不到的竞态 -
   *  当 deferred timer 的 macrotask 已经排队，同时 commit 的 useEffect 也在同一个 tick
   *  里排了 flush，两个写入会相隔 1-2ms 打到 stdout，用户就会看到明显闪一下。 */
  const flushGenRef = useRef(0)
  /** flush effect 上一次看到的 `spinnerFrame` 值。
   *  我们会拿它和当前 frame 对比，区分“这次 render 是被 spinner tick 触发的”
   *  （spinner glyph 轮了一格）和“这次 render 是被打字 / 内容变化触发的”
   *  （spinner 没变）。
   *  这两种情况需要不同的 deferred-flush 窗口：
   *  spinner tick 应该稍微多延后一点（约 24ms），让下一次文本流 commit 能吸收它；
   *  打字则只能很短地延后（约 8ms），不然长按键时会明显卡顿。 */
  const lastFlushedSpinnerFrameRef = useRef<number | null>(null)
  /** 当前位于终端底部的 frame 高度（也就是 prevFrameRef 上一次被设置时的值）。
   *  这里单独保存，是因为 prevFrameRef 在一些状态切换
   *  （hidden 之后、frame 高度变化）时会被重置成 []；
   *  但我们仍然需要知道屏幕上物理 frame 是从哪里开始的，
   *  这样下一个 DECSTBM scroll region 才不会和它重叠。 */
  const lastFrameHRef = useRef(0)
  /** 最近一次已知的终端尺寸。
   *  会在 render effect 里和当前值比较，用来检测 resize，
   *  并算出旧 frame 当时放在哪，这样就能在新位置绘制前先把旧位置擦掉。 */
  const lastTermRowsRef = useRef(0)
  const lastTermWidthRef = useRef(0)
  /** 最后一行可见内容和终端底部之间的空白行数。
   *  概念上和最初的“frame 上方空白行”是同一个值，
   *  只是这里改成在这块空白区内部决定 frame 画在哪里：
   *
   *    - When this is 0 the frame sits at the bottom of the terminal
   *      (the original always-anchored-at-bottom behavior).
   *    - When this is > 0 the frame floats UP so it sits immediately
   *      below the last content row, and the freeBlanks become the
   *      empty rows BELOW the input box. Mirrors Claude Code's flex-
   *      layout behavior (Box flexGrow=1 spacer doesn't push to bottom
   *      until messages fill the screen) and avoids the "tool block
   *      anchored at bottom of empty terminal" gap users see when
   *      starting a fresh conversation.
   *
   *  在后续所有 render 代码里，它仍然表示“下一次 commit 可以写入、
   *  但不用真的滚动历史记录的空白行预算”——不管 frame 停在空白区的哪个位置，
   *  这套算术关系都不变。 */
  const freeBlanksAboveFrameRef = useRef(0)
  /** 当前直接位于 frame 上方的空白行数。
   *  这些空白来自一次大幅 shrink（deltaH > 3）：frame 被压到底部，
   *  旧 frame 区域被擦掉，但没有把这些空白写进 scrollback。
   *  如果没有这个计数器，后续 grow 时就只能在 termRows 处发 LF 来“腾位置”，
   *  结果会把这些空白行推进终端历史，变成永久的空行
   *  （比如 sub-agent 连续打开多个 permission 对话框时，
   *  Task() 结果下面会出现一大块空白缝）。
   *
   *  grow 路径会先消耗这部分空白，再决定还要发多少 LF：
   *  frame 会通过 cell-grid 重定位向上延展进这些空白区（不触发滚动），
   *  所以只有超出空白区之外的行才需要真正滚进历史。
   *  commit、resize 和 `/clear` 时都会重置。 */
  const blankRowsAboveFrameRef = useRef(0)
  /** 上一次真正写到终端上的 frameTop 行号。
   *  这里单独保存，是因为 frameTop 已经不能只靠 (termRows, frameH)
   *  推出来了 —— 它现在还取决于 freeBlanksAboveFrameRef。
   *  这个值会被 unmount 清理逻辑（buildEraseRegion）和 resize 处理器读取，
   *  这样它们就能按旧 frame 的真实位置去擦，而不是只按 termRows 猜。 */
  const lastFrameTopRef = useRef(0)
  /** 当 permission 对话框刚关闭，但它批准的工具还没提交结果时，
   *  用来在 tool-running frame 内预留的垂直空间。
   *  没有这层预留的话，frame 会从 7 行直接缩到 5 行
   *  （permission 占 4 行，tool 只占 2 行），
   *  旧 permission 区域顶部那 2 行就会在“最后一次已提交的 scrollback”和
   *  正在运行的工具之间闪成空白。
   *  于是用户会短暂看到“Running...” 贴在底部、上面却有一条缝，
   *  直到工具结束并由 commit 把这些行回填。
   *  这个预留会把 frame 保持在旧尺寸，让进行中的 tool 行继续画在
   *  permission title 原来所在的位置；空白行则被挪到 tool 下方
   *  （也就是 tool 和 input 之间），下一次 commit / grow 就能干净地吃掉它们。
   *  任意 commit（tool 结果落入预留槽）或者新的 permission 到来（新的 permission
   *  自己填满这个槽）时都会清掉。 */
  const permissionSlotReserveRef = useRef(0)
  const prevHadPermissionRef = useRef(false)
  /** 上一帧是否正在显示 Permission / SelectOptions 对话框。
   *  当它消失时，我们需要先擦掉旧 frame 再重画。
   *  Ink 的 log.clear 会把光标带回对话框开始时所在的那一行，
   *  恰好就是我们 frame 的底行，所以直接按 prevFrame 做一次正常的
   *  eraseRegion 就能干净处理。 */
  const wasHiddenRef = useRef(false)
  /** 由 shrink 检测路径设置（例如 `/clear` 把 messages 清空）。
   *  这样下一次 first-paint 就会按空视口去初始化 freeBlanks，
   *  而不是在顶部继续预留一块横幅大小的空间——清屏 ANSI 写完之后，
   *  屏幕上已经没有横幅了。消耗一次后就清掉。 */
  const justClearedRef = useRef(false)
  /** 已经提交到 scrollback 的消息数量。 */
  const writtenMessageCountRef = useRef(0)
  /** 本次 render 收集到、但还没写到 stdout 的 scrollback 字节。
   *  它会跨 render 保留下来，这样被取消的 commit-throttle 就不会把消息字节丢掉。
   *  我们在遍历新消息时会同步推进 `writtenMessageCountRef`，
   *  所以后续 render 不会再通过 `writeMessageToStdout` 重复收集这些内容。
   *  如果没有这个 ref，承载字节的唯一地方就只有触发 throttle 的那次 render
   *  里的局部 `scrollbackContent`；一旦它后来被 1ms 后的高度变化覆盖
   *  （`commit-throttle-superseded-by-height`），字节就会直接消失。
   *  真正写出后会在 `doFlush` 里清空。
   *  这个修复的症状是：流式多行回复在最后一次 commit 收缩 frame
   *  （比如回合结束时 spinner 消失）后，会静默丢掉最后一条消息，
   *  scrollback 里看起来像是回复写到一半就断了，虽然 `state.messages`
   *  里明明有完整文本。 */
  const pendingScrollbackRef = useRef('')
  // Permission 对话框的选中索引（0 = Yes，1 = No）。
  // 它画在我们自己的 cell buffer 里，而不是交给 Ink，
  // 这样对话框就不会和我们的光标管理打架。
  // 每次 prompt 变化（新的 tool call）时都会重置为 0，
  // 这里使用 React 的“在 render 期间调整 state”模式：
  // React 会丢掉第一次 render 并立即重渲染，
  // 这比在 effect 里串联 setState 更便宜，也不会踩到
  // react-hooks/set-state-in-effect lint。
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [permissionSelected, setPermissionSelected] = useState(0)
  const [lastPermissionKey, setLastPermissionKey] = useState<string | null>(null)
  const permissionKey = permission ? `${permission.toolName}:${JSON.stringify(permission.input)}` : null
  if (permissionKey !== lastPermissionKey) {
    setLastPermissionKey(permissionKey)
    setPermissionSelected(0)
  }

  // frame 内 select-options 对话框的选中项。
  // 每次新对话框打开时都会重置（以 question 字符串为 key，
  // 因为变化的就是它）。
  const [selectIndex, setSelectIndex] = useState(0)
  const [lastSelectKey, setLastSelectKey] = useState<string | null>(null)
  // “Other” 自由输入项的内联文本缓冲。
  // 以 {text, cursor} 形式保存，这样反显光标的渲染方式会和主输入框一致。
  // 在同一个对话框内切换选项时会保留，方便用户回到 “Other” 继续编辑；
  // 新对话框打开时则清空，避免把旧输入带过去。
  const [freeform, setFreeform] = useState<{ text: string; cursor: number }>({ text: '', cursor: 0 })
  const selectKey = selectRequest ? selectRequest.question : null
  if (selectKey !== lastSelectKey) {
    setLastSelectKey(selectKey)
    setSelectIndex(0)
    setFreeform({ text: '', cursor: 0 })
  }

  // Spinner 动画独立封装，这样父组件就不用每秒重渲染 12 次。
  // 只在 `spinner` 有值时运行。
  //
  // 这里只保留一个 React state（`spinnerFrame`），因为它的变化
  // 就足以触发一次重渲染并刷新 cell frame。
  // `elapsedMs` 则在 render 时从 `loadingStartRef` 推导，
  // 这样就不会在 effect 里同步 setState（否则会触发连锁重渲染，
  // 也会踩到 react-hooks/set-state-in-effect lint）。
  const [spinnerFrame, setSpinnerFrame] = useState(0)
  const loadingStartRef = useRef<number>(0)

  useEffect(() => {
    if (!spinner) {
      loadingStartRef.current = 0
      return
    }
    if (loadingStartRef.current === 0) loadingStartRef.current = Date.now()
    const timer = setInterval(() => {
      setSpinnerFrame((f) => (f + 1) % SPINNER_FRAMES.length)
    }, 200) // 200ms per frame (5 Hz). Below 8 Hz the asterisk-pulse
    // breathe still reads as a smooth animation, but each cell write is
    // 38% less frequent than at 120ms — measurably less visible
    // residual flicker on weak terminals (VSCode xterm.js, ConHost)
    // where every spinner-cell update kicks the renderer's state
    // machine. A full breathe cycle is now 12 frames × 200ms = 2.4s,
    // which still feels alive without feeling jittery.
    return () => clearInterval(timer)
  }, [spinner])

  const { stdout } = useStdout()
  const termWidth = stdout?.columns ?? 80

  // ── Terminal resize handling ──
  // Force a re-render tick on resize so termWidth/termRows pick up the new
  // values. The cell matrix is invalidated but lastFrameHRef / lastTermRowsRef
  // are kept intact — the render effect needs them to compute where the OLD
  // frame sat so it can erase those rows before painting at the new position.
  const [, forceRender] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    if (!stdout) return
    const onResize = () => {
      prevFrameRef.current = []
      forceRender()
    }
    stdout.on('resize', onResize)
    return () => {
      stdout.off('resize', onResize)
    }
  }, [stdout])

  // ── Cursor visibility lifecycle (Claude-Code pattern). ──
  // The terminal cursor is hidden for the entire lifetime of the TUI
  // and shown again on unmount. We never toggle `?25h` / `?25l` per
  // render, which on Windows Terminal / VSCode-xterm.js / ConHost
  // resets the cursor blink phase each time it's processed and the
  // user perceives that as flicker at the cursor's last position.
  // The "input cursor" is rendered as an inverse-video cell on the
  // input row by the cell-diff loop below — visually it's just a
  // styled char that updates atomically with the rest of the frame.
  // Reference: D:\res\claude-code\src\ink\components\App.tsx:184
  // (HIDE_CURSOR write at componentDidMount) and :189 (SHOW_CURSOR
  // at componentWillUnmount).
  useEffect(() => {
    try {
      process.stdout.write('\x1b[?25l')
    } catch {
      /* tty closed */
    }
    return () => {
      try {
        process.stdout.write('\x1b[?25h')
      } catch {
        /* tty closed */
      }
    }
  }, [])

  // ── 模糊匹配 ──
  //
  // 两阶段菜单：第一阶段补全 slash 命令名本身
  //（`/mc` → `/mcp`）；第二阶段在用户输入空格后触发，
  // 为声明了子命令的命令补全子命令（`/mcp ` →
  // `list / tools / auth / ...`）。第三阶段（server name、model
  // id）则需要每个命令各自提供异步 `complete()` 回调——这里故意没做；
  // 第二阶段已经能解决 80% 的痛点（8 个子命令的 `/mcp` 区块），
  // 代码量却只有十分之一。
  //
  // 条目会带 `applyText`，这样接受路径（Tab / Enter）就能把输入设置成完整路径
  //（`/mcp auth`），不管用户是在哪一阶段选中的。
  // 显示列仍然只用裸 `name`（第二阶段显示 `auth`，而不是 `/mcp auth`），
  // 这样菜单更容易快速扫读。
  const matches = useMemo<MenuItem[]>(() => {
    if (!text.startsWith('/')) return []

    const fuzzyMatches = (name: string, query: string): boolean => {
      let qi = 0
      for (let ni = 0; ni < name.length && qi < query.length; ni++) {
        if (name[ni] === query[qi]) qi++
      }
      return qi === query.length
    }

    const firstSpace = text.indexOf(' ')
    if (firstSpace === -1) {
      // 第一阶段：正在输入命令名。匹配去掉 / 之后的名称。
      const query = text.slice(1).toLowerCase()
      const filtered = !query ? commands : commands.filter((c) => fuzzyMatches(c.name.slice(1).toLowerCase(), query))
      return filtered.map<MenuItem>((c) => ({
        name: c.name,
        description: c.description,
        applyText: c.name,
        argumentHint: c.argumentHint,
      }))
    }

    // 第二阶段：正在输入子命令。`head` 是命令本身（例如 "/mcp"），
    // `tail` 是第一个空格后面的内容。第二个空格表示用户已经越过子命令槽位；
    // 我们不会自动补全更后面的内容（还没有第三阶段回调）。
    const head = text.slice(0, firstSpace)
    const tail = text.slice(firstSpace + 1)
    if (tail.includes(' ')) return []

    const cmd = commands.find((c) => c.name === head)
    if (!cmd?.subcommands) return []

    const query = tail.toLowerCase()
    const filtered = !query ? cmd.subcommands : cmd.subcommands.filter((s) => fuzzyMatches(s.name.toLowerCase(), query))
    return filtered.map<MenuItem>((s) => ({
      name: s.name,
      description: s.description,
      applyText: `${head} ${s.name}`,
    }))
  }, [text, commands])

  const safeIndex = matches.length > 0 ? completionIndex % matches.length : 0
  const currentMatch = matches.length > 0 ? matches[safeIndex] : null

  // ── @ 提及文件补全 ──
  // `detectAtToken` 的代价很低；每次 render 都重算，
  // 这样它就能跟着光标移动（左右方向键）自动更新，不需要显式失效。
  const atTrigger = useMemo(() => detectAtToken(text, cursor), [text, cursor])
  const atMatches = useMemo(() => {
    if (!atTrigger.active) return [] as FileEntry[]
    return scoreAndRank(fileEntries as FileEntry[], atTrigger.query).slice(0, MAX_AT_RESULTS)
  }, [atTrigger, fileEntries])
  const safeAtIndex = atMatches.length > 0 ? atCompletionIndex % atMatches.length : 0
  const atDismissedKey = `${atTrigger.atIdx}:${atTrigger.query}`
  const atMenuVisible = atTrigger.active && atDismissed !== atDismissedKey
  // 如果两者都可能触发，slash 菜单优先（`/` 只会在行首触发，
  // 所以它们很少冲突，通常只会发生在粘贴时）。
  // 这里用硬互斥避免双重渲染。
  const activeMenu: 'slash' | 'at' | null = matches.length > 0 ? 'slash' : atMenuVisible ? 'at' : null

  // 每当触发 token 变化时，重置 @ 菜单光标，这样高亮总是从新结果集的第一项开始。
  // 这里使用 React 文档里的“把上一个 prop 存进 state，并在 render 期间 setState”的模式。
  // 比起 useEffect，它能少一次 commit，也不会触发 react-hooks/set-state-in-effect。
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const atTriggerKey = `${atTrigger.atIdx}:${atTrigger.query}:${atTrigger.active}`
  const [lastAtTriggerKey, setLastAtTriggerKey] = useState(atTriggerKey)
  if (lastAtTriggerKey !== atTriggerKey) {
    setLastAtTriggerKey(atTriggerKey)
    setAtCompletionIndex(0)
  }

  /** 擦除 frame 在固定位置上的区域（终端最后 `lastFrameHRef` 行），并清空
   *  prevFrameRef。返回 ANSI 序列，调用方可以把它和其他写入合并成一次
   *  process.stdout.write。清理后光标会落到这块（现在是空白的）frame 区域左上角。
   *
   *  现在它只用于 unmount 清理 —— 实时渲染路径会把 frame 牢牢钉在底部，
   *  并通过 DECSTBM scroll region 在它上方插入 scrollback（见下面的 flush effect），
   *  所以只有 TUI 自己要退出时才需要擦除。 */
  const buildEraseRegion = (): string => {
    const prevH = lastFrameHRef.current
    const prevTop = lastFrameTopRef.current
    prevFrameRef.current = []
    lastFrameHRef.current = 0
    lastFrameTopRef.current = 0
    if (prevH <= 0) return ''
    const termRows = stdout?.rows ?? 25
    // 优先使用实际最后渲染的位置；如果是旧路径、`lastFrameTopRef` 还没填上，
    // 才回退到底部锚定公式（那只会影响非常早期的 teardown）。
    const frameTop = prevTop > 0 ? prevTop : Math.max(1, termRows - prevH + 1)
    // 跳到 frame 顶部，擦到屏幕末尾。一次原子清除。
    return `\x1b[${frameTop};1H\x1b[J`
  }

  /** unmount 清理使用的同步擦除。
   *  外面包了 BSU/ESU，这样终端会把这次擦除当作原子操作来渲染。
   *  effect 路径会自己做组合（外层 render 已经包过 BSU/ESU 了）。 */
  const eraseRegion = () => {
    const s = buildEraseRegion()
    if (s) process.stdout.write(BSU + s + ESU_HIDE)
  }

  const handleSubmit = (override?: string) => {
    const raw = override ?? text
    if (!raw.trim()) return
    // 在 agent 还在思考时阻止提交。键盘输入仍然会继续进来
    //（键盘保持可用，所以用户可以提前输入下一条 prompt）——
    // 这里只禁用 Enter，行为和 Claude Code 对齐。
    if (spinner) return
    const expanded = override ? raw : expandPasteRefs(raw, pastedContents)
    // 把展开前的形态记入输入历史（Up/Down 回忆），这样恢复条目时，
    // 不会把整块 paste 再次展开回输入框里 —— `[#N +M lines]` 引用会保持紧凑，
    // 跟提交时看到的一样。`override` 是 slash 补全路径
    //（比如 `handleSubmit('/help')`），这里不会有 paste refs。
    pushHistory(override ? raw : text, override ? {} : pastedContents)
    resetHistoryNav()
    // 让正常的 render useEffect 去处理这次状态迁移。
    // 下一次 render 会看到 `messages.length > writtenMessageCountRef`
    //（用户自己的回声已经在 onSubmit 里追加进来了），然后一次性输出
    // 一个包在 BSU/ESU 里的原子 payload：清间隔 + scrollback 内容 + frame 重绘。
    // 这里不再同步预擦除 —— 旧代码是给已经退役的独立 MessageList writer 腾位置的，
    // 它在每次 submit 时都会额外闪一下。
    onSubmit(expanded)
    dispatch({ type: 'RESET' })
    setPastedContents({})
    setCompletionIndex(0)
  }

  /** 按 `delta` 个逻辑行上下移动光标。
   *  如果光标真的移动了就返回 `true`；如果它已经在顶部/底部边缘则返回 `false`。
   *  这个 falsy 返回值正是让 Up/Down 处理器能继续落到 history 导航路径上的关键
   *  （Claude Code 的 `upOrHistoryUp` 也是同样的思路）。 */
  const moveCursorVertically = (delta: number): boolean => {
    const lines = text.split('\n')
    let line = 0,
      col = cursorRef.current,
      charsSoFar = 0
    for (let i = 0; i < lines.length; i++) {
      if (charsSoFar + lines[i].length >= cursorRef.current && cursorRef.current >= charsSoFar) {
        line = i
        col = cursorRef.current - charsSoFar
        break
      }
      charsSoFar += lines[i].length + 1
    }
    const targetLine = Math.max(0, Math.min(lines.length - 1, line + delta))
    if (targetLine === line) return false
    const targetCol = Math.min(col, lines[targetLine].length)
    let newPos = 0
    for (let i = 0; i < targetLine; i++) newPos += lines[i].length + 1
    newPos += targetCol
    dispatch({ type: 'SET_CURSOR', cursor: newPos })
    return true
  }

  // ── Input history (Up/Down) ─────────────────────────────────────────────
  //
  // Persisted to `.x-code/history.jsonl` (project-local, append-only) and
  // mirrored into `historyRef` for synchronous Up/Down access. On mount we
  // load the most recent HISTORY_MAX entries from disk; on every successful
  // submit we both push to the ref AND fire-and-forget append to disk. Up at
  // the logical first line walks BACK through entries (newest first); Down at
  // the logical last line walks forward and, past index 0, restores the
  // draft captured on the first Up press. Mirrors Claude Code's
  // useArrowKeyHistory + history.jsonl machinery — see `../input-history.ts`
  // for the rationale on per-project vs. Claude Code's global-with-project-
  // field design.
  //
  // Why store the pre-expansion text + pastedContents instead of the expanded
  // string: the expanded string has the entire pasted block inlined, so
  // restoring it would balloon the input box with the full paste content.
  // Storing the `[#N +M lines]` reference keeps the visual compactness the
  // user originally had at submit time.
  const historyRef = useRef<InputHistoryEntry[]>([])
  /** 0 = not navigating (draft on screen). 1 = most-recent submitted entry,
   *  2 = the one before that, etc. Refs (not state) because navigation must
   *  read its own monotonic counter synchronously — React state updates lag
   *  by a render and rapid Up/Down presses see stale values. */
  const historyIndexRef = useRef(0)
  /** Snapshot of the user's in-progress input the moment they FIRST pressed
   *  Up. Restored when Down brings them back to index 0 so a stray Up doesn't
   *  destroy half-typed work. */
  const historyDraftRef = useRef<{ text: string; cursor: number; pasted: PastedContents } | null>(null)

  // Seed from disk once on mount. `process.cwd()` is captured here rather
  // than at every appendInputHistory call so an interactive `cd` inside the
  // agent doesn't end up reading from one project and writing to another.
  // No setState — `historyRef` is a ref, the load just populates it for
  // the next Up press. Failures are silent (loadInputHistory swallows).
  const initialCwdRef = useRef(process.cwd())
  useEffect(() => {
    let cancelled = false
    void loadInputHistory(initialCwdRef.current).then((entries) => {
      if (cancelled) return
      historyRef.current = entries
    })
    return () => {
      cancelled = true
    }
  }, [])

  const resetHistoryNav = () => {
    historyIndexRef.current = 0
    historyDraftRef.current = null
  }

  const pushHistory = (raw: string, pasted: PastedContents) => {
    if (!raw.trim()) return
    // Bash-style ignoredups: skip if identical to the most recent entry. The
    // user pressing Up + Enter to re-run the previous command shouldn't fill
    // history with the same line — and we don't want to duplicate it on disk
    // either, so the dedupe gate guards BOTH the in-memory ref and the
    // appendFile call below.
    const last = historyRef.current[historyRef.current.length - 1]
    if (last && last.text === raw) return
    const entry: InputHistoryEntry = { text: raw, pasted: { ...pasted }, ts: Date.now() }
    historyRef.current.push(entry)
    if (historyRef.current.length > HISTORY_MAX) historyRef.current.shift()
    // Fire-and-forget. Errors are swallowed inside appendInputHistory — a
    // disk hiccup must not block the agent loop or surface to the user.
    // Pin to startup cwd so a tool-driven `cd` mid-session doesn't split
    // writes across two `.x-code/history.jsonl` files.
    void appendInputHistory(entry, initialCwdRef.current)
  }

  /** Replace the current input with `entry`. `cursorAt` mirrors Claude Code's
   *  `cursorToStart` flag: Up navigation lands at index 0 so the next Up press
   *  immediately advances (cursor can't go further up); Down navigation lands
   *  at the end so the next Down press immediately advances forward. */
  const restoreHistoryEntry = (entry: { text: string; pasted: PastedContents }, cursorAt: 'start' | 'end') => {
    dispatch({ type: 'SET_TEXT', text: entry.text, cursor: cursorAt === 'start' ? 0 : entry.text.length })
    setPastedContents({ ...entry.pasted })
    setCompletionIndex(0)
    setAtCompletionIndex(0)
  }

  const navigateHistoryUp = () => {
    if (historyRef.current.length === 0) return
    if (historyIndexRef.current >= historyRef.current.length) return
    if (historyIndexRef.current === 0) {
      historyDraftRef.current = {
        text,
        cursor: cursorRef.current,
        pasted: { ...pastedContents },
      }
    }
    historyIndexRef.current += 1
    const entry = historyRef.current[historyRef.current.length - historyIndexRef.current]
    if (entry) restoreHistoryEntry(entry, 'start')
  }

  const navigateHistoryDown = () => {
    if (historyIndexRef.current <= 0) return
    historyIndexRef.current -= 1
    if (historyIndexRef.current === 0) {
      const draft = historyDraftRef.current
      historyDraftRef.current = null
      if (draft) {
        dispatch({ type: 'SET_TEXT', text: draft.text, cursor: draft.cursor })
        setPastedContents({ ...draft.pasted })
      } else {
        dispatch({ type: 'RESET' })
        setPastedContents({})
      }
      setCompletionIndex(0)
      setAtCompletionIndex(0)
    } else {
      const entry = historyRef.current[historyRef.current.length - historyIndexRef.current]
      if (entry) restoreHistoryEntry(entry, 'end')
    }
  }

  usePromptInput({
    enabled: !disabled && !hidden,
    onInterrupt,
    onText: (chunk) => {
      // Route single-char y/n to the Permission resolver when a dialog is
      // active; block all other text input so the user can't type into
      // the input box behind the dialog.
      if (permission) {
        const ch = chunk.toLowerCase()
        if (ch === 'y') {
          permission.onResolve('yes')
          return
        }
        if (ch === 'n') {
          permission.onResolve('no')
          return
        }
        return
      }
      if (selectRequest) {
        // Typing on a freeform option ("Other") feeds the inline text
        // buffer; on regular options it's still swallowed so the user
        // can't type into the hidden input behind the dialog.
        const opt = selectRequest.options[selectIndex]
        if (opt?.freeform) {
          setFreeform(({ text, cursor }) => ({
            text: text.slice(0, cursor) + chunk + text.slice(cursor),
            cursor: cursor + chunk.length,
          }))
        }
        return
      }
      dispatch({ type: 'INSERT', pos: cursorRef.current, chunk })
      setCompletionIndex(0)
    },
    onPaste: (content) => {
      if (permission) return
      if (selectRequest) {
        // Allow paste into the freeform buffer (e.g. pasting a long
        // path or model id). Skip the large-paste reference machinery
        // — it's a usability hit for free-text answers, which are
        // expected to be short.
        const opt = selectRequest.options[selectIndex]
        if (opt?.freeform) {
          setFreeform(({ text, cursor }) => ({
            text: text.slice(0, cursor) + content + text.slice(cursor),
            cursor: cursor + content.length,
          }))
        }
        return
      }
      const lineCount = content.split(/\r\n|\r|\n/).length
      const isLarge = lineCount >= PASTE_REF_MIN_LINES || content.length >= PASTE_REF_MIN_CHARS
      const pos = cursorRef.current
      if (isLarge) {
        const id = nextPasteIdRef.current++
        setPastedContents((prev) => ({ ...prev, [id]: { id, content, lineCount } }))
        const ref = formatPasteRef(id, lineCount)
        dispatch({ type: 'INSERT', pos, chunk: ref })
      } else {
        dispatch({ type: 'INSERT', pos, chunk: content })
      }
      setCompletionIndex(0)
    },
    onKey: (key) => {
      // Permission dialog captures navigation + submit keys.
      if (permission) {
        const hasAlwaysOption = suggestRuleLabel(permission.toolName, permission.input, !!permission.mcp) !== null
        const maxIdx = hasAlwaysOption ? 2 : 1
        if (key === 'up') {
          setPermissionSelected((p) => (p > 0 ? p - 1 : maxIdx))
          return
        }
        if (key === 'down') {
          setPermissionSelected((p) => (p < maxIdx ? p + 1 : 0))
          return
        }
        if (key === 'return') {
          const decisions: ('yes' | 'always' | 'no')[] = hasAlwaysOption ? ['yes', 'always', 'no'] : ['yes', 'no']
          permission.onResolve(decisions[permissionSelected]!)
          return
        }
        return
      }
      // Select-options dialog captures navigation + submit keys. When
      // the highlighted option is `freeform`, editing keys (backspace,
      // delete, left, right, home, end) also feed its inline text
      // buffer instead of being swallowed.
      if (selectRequest) {
        const len = selectRequest.options.length
        const opt = selectRequest.options[selectIndex]
        const isFreeform = !!opt?.freeform
        // Esc dismisses user-initiated pickers (slash commands like
        // /syntax, /model) — the user may have just been browsing and
        // shouldn't be forced to commit. AI-initiated dialogs leave
        // `dismissible` falsy so Esc is swallowed; otherwise the model
        // gets a silent empty answer back from its askUser call.
        if (key === 'escape' && selectRequest.dismissible) {
          debugLog('chatinput.select-dismiss', 'esc')
          selectRequest.onResolve('')
          return
        }
        if (key === 'up') {
          setSelectIndex((i) => (i > 0 ? i - 1 : len - 1))
          return
        }
        if (key === 'down') {
          setSelectIndex((i) => (i < len - 1 ? i + 1 : 0))
          return
        }
        if (isFreeform) {
          if (key === 'backspace') {
            setFreeform(({ text, cursor }) =>
              cursor === 0
                ? { text, cursor }
                : { text: text.slice(0, cursor - 1) + text.slice(cursor), cursor: cursor - 1 },
            )
            return
          }
          if (key === 'delete') {
            setFreeform(({ text, cursor }) =>
              cursor >= text.length
                ? { text, cursor }
                : { text: text.slice(0, cursor) + text.slice(cursor + 1), cursor },
            )
            return
          }
          if (key === 'left') {
            setFreeform(({ text, cursor }) => ({ text, cursor: Math.max(0, cursor - 1) }))
            return
          }
          if (key === 'right') {
            setFreeform(({ text, cursor }) => ({ text, cursor: Math.min(text.length, cursor + 1) }))
            return
          }
          if (key === 'home') {
            setFreeform(({ text }) => ({ text, cursor: 0 }))
            return
          }
          if (key === 'end') {
            setFreeform(({ text }) => ({ text, cursor: text.length }))
            return
          }
        }
        if (key === 'return') {
          const picked = selectRequest.options[selectIndex]
          if (!picked) return
          if (picked.freeform) {
            const trimmed = freeform.text.trim()
            // Empty buffer on Enter: ignore so the user isn't bounced
            // out of the dialog with an empty answer. The visible
            // cursor + dialog hint already signal that typing is
            // expected here.
            if (!trimmed) return
            selectRequest.onResolve(trimmed)
          } else {
            selectRequest.onResolve(picked.label)
          }
          return
        }
        return
      }
      if (key === 'return') {
        // @-completion: Enter picks the highlighted file but DOES NOT
        // submit — user is mid-prompt and likely wants to keep typing
        // after the path lands. Falls through to slash/submit when the
        // menu is empty (the "@xxx with no matches" case sends the
        // text as-is, so the user can mention a npm package or a
        // not-yet-existing file without an extra keystroke to dismiss).
        if (activeMenu === 'at' && atMatches.length > 0) {
          const picked = atMatches[safeAtIndex]
          if (picked) {
            const out = applyCompletion(text, atTrigger.atIdx, atTrigger.tokenEnd, picked)
            dispatch({ type: 'SET_TEXT', text: out.text, cursor: out.cursor })
            setAtCompletionIndex(0)
            return
          }
        }
        // Active slash-command completion: Enter picks the highlighted
        // command directly instead of submitting whatever's in the input
        // (usually just `/` or a prefix), matching Claude Code's behavior.
        // Previously the user had to hit Tab first to materialize the
        // selection, then Enter — redundant. `applyText` carries the full
        // path so picking a stage-2 subcommand submits `/mcp auth`, not
        // bare `auth`.
        if (currentMatch) {
          handleSubmit(currentMatch.applyText)
          return
        }
        // Backslash continuation: `\` immediately before the cursor + Enter
        // converts to a literal newline instead of submitting. Universal
        // fallback for terminals that can't distinguish Ctrl+Enter from
        // Enter (which is most of them — see use-prompt-input.ts).
        const cur = cursorRef.current
        if (cur > 0 && text[cur - 1] === '\\') {
          const next = text.slice(0, cur - 1) + '\n' + text.slice(cur)
          dispatch({ type: 'SET_TEXT', text: next, cursor: cur })
          setCompletionIndex(0)
          return
        }
        handleSubmit()
        return
      }
      if (key === 'newline') {
        // Alt/Option+Enter (or modifyOtherKeys / kitty Ctrl+Enter) — insert
        // a literal newline at the cursor without submitting. Bypasses the
        // @-menu and slash-completion intercepts on purpose: the user has
        // explicitly asked for a line break.
        dispatch({ type: 'INSERT', pos: cursorRef.current, chunk: '\n' })
        setCompletionIndex(0)
        return
      }
      if (key === 'escape') {
        // @-menu open: Esc just dismisses the menu for the current
        // trigger. Once the user types/backspaces the trigger key
        // changes and the menu reopens automatically, so there's no
        // explicit "re-arm" path.
        if (activeMenu === 'at') {
          setAtDismissed(atDismissedKey)
          return
        }
        // Modal dialogs (permission / selectRequest) gate above and
        // already swallow Esc. Here we only see Esc that reached the
        // input. Two distinct gestures:
        //   - loading: single Esc cancels the in-flight turn.
        //   - idle:    double-tap Esc clears input + pasted refs (matches
        //     Claude Code). Single Esc is a no-op so a stray press
        //     doesn't wipe a draft.
        if (isLoading && onEscapeCancel) {
          onEscapeCancel()
          return
        }
        if (text.length === 0 && Object.keys(pastedContents).length === 0) return
        const now = Date.now()
        const DOUBLE_ESC_WINDOW_MS = 500
        if (now - lastEscapeAtRef.current <= DOUBLE_ESC_WINDOW_MS) {
          dispatch({ type: 'RESET' })
          setPastedContents({})
          setCompletionIndex(0)
          resetHistoryNav()
          lastEscapeAtRef.current = 0
        } else {
          lastEscapeAtRef.current = now
        }
        return
      }
      if (key === 'backspace') {
        const pos = cursorRef.current
        if (pos === 0) return
        const before = text.slice(0, pos)
        const stripped = stripTrailingRef(before)
        if (stripped) {
          setPastedContents((pc) => {
            const n = { ...pc }
            delete n[stripped.id]
            return n
          })
          const deleteCount = before.length - stripped.without.length
          dispatch({ type: 'BACKSPACE_REF', pos, deleteCount })
        } else {
          dispatch({ type: 'BACKSPACE_REF', pos, deleteCount: 1 })
        }
        setCompletionIndex(0)
        return
      }
      if (key === 'delete') {
        dispatch({ type: 'DELETE', pos: cursorRef.current })
        return
      }
      if (key === 'left') {
        dispatch({ type: 'SET_CURSOR', cursor: Math.max(0, cursorRef.current - 1) })
        return
      }
      if (key === 'right') {
        dispatch({ type: 'SET_CURSOR', cursor: Math.min(text.length, cursorRef.current + 1) })
        return
      }
      if (key === 'home') {
        dispatch({ type: 'SET_CURSOR', cursor: 0 })
        return
      }
      if (key === 'end') {
        dispatch({ type: 'SET_CURSOR', cursor: text.length })
        return
      }
      if (key === 'tab') {
        if (activeMenu === 'at' && atMatches.length > 0) {
          const picked = atMatches[safeAtIndex]
          if (picked) {
            const out = applyCompletion(text, atTrigger.atIdx, atTrigger.tokenEnd, picked)
            dispatch({ type: 'SET_TEXT', text: out.text, cursor: out.cursor })
            setAtCompletionIndex(0)
          }
          return
        }
        if (currentMatch) {
          dispatch({ type: 'SET_TEXT', text: currentMatch.applyText, cursor: currentMatch.applyText.length })
          setCompletionIndex(0)
        }
        return
      }
      if (key === 'up') {
        // Suggestion menu wins over history nav when there's a real selection
        // to make. The carve-out is the single-match-in-history-nav case: a
        // restored `/model` entry auto-opens a 1-item slash menu, where
        // cycling is a no-op — if we let the menu swallow Up the user is
        // trapped with no way to keep scrolling back. With 2+ matches the
        // menu's cycling is meaningful, so it wins even mid-history; with
        // 0/1 matches we fall through to cursor + history nav.
        const inHistoryNav = historyIndexRef.current > 0
        if (activeMenu === 'at' && atMatches.length > 0 && (!inHistoryNav || atMatches.length > 1)) {
          setAtCompletionIndex((p) => (p - 1 + atMatches.length) % atMatches.length)
          return
        }
        if (activeMenu === 'slash' && matches.length > 0 && (!inHistoryNav || matches.length > 1)) {
          setCompletionIndex((p) => (p - 1 + matches.length) % matches.length)
          return
        }
        // Cursor first; fall through to history nav only when the cursor was
        // already on the logical first line (so multi-line drafts and recalled
        // entries can still be edited row-by-row).
        if (!moveCursorVertically(-1)) navigateHistoryUp()
        return
      }
      if (key === 'down') {
        const inHistoryNav = historyIndexRef.current > 0
        if (activeMenu === 'at' && atMatches.length > 0 && (!inHistoryNav || atMatches.length > 1)) {
          setAtCompletionIndex((p) => (p + 1) % atMatches.length)
          return
        }
        if (activeMenu === 'slash' && matches.length > 0 && (!inHistoryNav || matches.length > 1)) {
          setCompletionIndex((p) => (p + 1) % matches.length)
          return
        }
        if (!moveCursorVertically(1)) navigateHistoryDown()
        return
      }
      if (key === 'pageup') {
        moveCursorVertically(-MAX_VISIBLE_LINES)
        return
      }
      if (key === 'pagedown') {
        moveCursorVertically(MAX_VISIBLE_LINES)
        return
      }
    },
  })

  // ── Frame rendering with cell-level diff ─────────────────────────────

  useEffect(() => {
    if (hidden) {
      // KEEP prevFrameRef intact. Ink has written the dialog on top of
      // our frame's bottom row (its onRender runs before useEffect) and
      // moved the cursor beyond it — we can't safely erase anything NOW
      // without corrupting the dialog. But when the dialog resolves,
      // Ink's log.clear sends the cursor back to the row where the
      // dialog started (= our frame's bottom row), and at THAT point we
      // treat the next render as a fresh first-paint.
      wasHiddenRef.current = true
      return
    }

    // Accumulate ALL writes for this render into a single string, flushed
    // via one process.stdout.write at the bottom. Rationale: DEC 2026
    // Synchronized Update Mode (BSU/ESU) only buffers inter-write state on
    // terminals that support it — VS Code terminal and others paint every
    // separate write() immediately. Coalescing into one write keeps each
    // render a single atomic paint regardless of terminal support.
    let preBuf = BSU

    if (wasHiddenRef.current) {
      // Transitioning out of a dialog. We used to RESTORE_CURSOR (\x1b8)
      // back to a position we'd previously DECSC'd — but that single
      // terminal-level save register is ALSO used internally by Ink's
      // own log-update cycle for its own cursor bookkeeping. Two
      // writers, one register: every Ink render that cycled through its
      // save/restore clobbered ours, so the restore here could land at
      // Ink's saved position rather than our frame's bottom row.
      //
      // Instead of fighting for the register, treat the post-dialog
      // frame as a fresh first-paint: drop prevFrameRef (so the diff
      // loop does full-row writes with \x1b[K, no stale assumptions)
      // and the absolute-positioning below puts the frame back at the
      // terminal's bottom rows regardless of where Ink parked the cursor.
      wasHiddenRef.current = false
      prevFrameRef.current = []
      lastFrameHRef.current = 0
      lastFrameTopRef.current = 0
      freeBlanksAboveFrameRef.current = 0
      blankRowsAboveFrameRef.current = 0
      activeRef.current = false
    }

    // ── Commit new scrollback messages ───────────────────────────────────
    //
    // COLLECT-ONLY here. The actual write happens AFTER the frame cells
    // have been built, so we can emit `content + frame` as one continuous
    // stream that triggers the terminal's natural full-screen scroll at
    // its bottom edge — the only mechanism xterm.js / VSCode honor for
    // pushing rows into real scrollback (DECSTBM-restricted region scrolls
    // are splice-discarded in xterm.js's InputHandler, confirmed in source).
    //
    // /clear shrinks the message list back to empty. Used to be a silent
    // counter reset — meaning the in-memory history disappeared but the
    // OLD scrollback stayed visible, so users reported "/clear does
    // nothing". Now we erase the viewport + xterm scrollback and reset
    // the frame-tracking refs so the next paint runs as a clean
    // first-paint, anchored to the top of the empty terminal.
    if (messages.length < writtenMessageCountRef.current) {
      // \x1b[2J: erase the visible screen.
      // \x1b[3J: drop xterm-style scrollback history (Windows Terminal,
      //   xterm.js, iTerm2, kitty, GNOME Terminal — all honor it; the
      //   handful of legacy terminals that ignore it still get the
      //   viewport cleared, which is already a strict improvement).
      // \x1b[H : home the cursor so the (empty) frame paint below lands
      //   at known coordinates instead of wherever Ink last parked it.
      preBuf += '\x1b[2J\x1b[3J\x1b[H'
      writtenMessageCountRef.current = messages.length
      prevFrameRef.current = []
      lastFrameHRef.current = 0
      lastFrameTopRef.current = 0
      freeBlanksAboveFrameRef.current = 0
      blankRowsAboveFrameRef.current = 0
      // The clear wipes the scrollback we were about to write to. Any
      // pending bytes from a prior cancelled throttle are now stale —
      // they belong to messages that no longer exist (post-/clear,
      // messages.length is 0).
      pendingScrollbackRef.current = ''
      activeRef.current = false
      justClearedRef.current = true
      // Drops scrollback-spacing flags + buffered read-group entries
      // (those summaries pointed at messages we just wiped — flushing
      // them later would leave a phantom row above the empty history).
      resetScrollbackSpacing()
    }
    const termRows = stdout?.rows ?? 25
    // `hasNewMessages` — we walked new entries this render (advanced
    // `writtenMessageCountRef`). True even if every message got buffered
    // by the read-group collapser and produced zero scrollback bytes.
    // Used by the message-write loop and the permission-slot bookkeeping.
    //
    // `didCommitMessages` — actual scrollback bytes were produced. ONLY
    // this gates the geometry/scroll branches below: `countContentRows`
    // returns 1 for an empty string (a single empty line), so treating
    // a buffered-only render as if it scrolled 1 row drifted the frame
    // down on every consecutive Read/Glob/Grep tool, accumulating real
    // blank rows in terminal scrollback (the "lots of blank lines"
    // symptom on multi-read chains).
    const hasNewMessages = messages.length > writtenMessageCountRef.current
    const collectWrite: (data: string) => void = (data) => {
      pendingScrollbackRef.current += data
    }
    if (hasNewMessages) {
      for (let i = writtenMessageCountRef.current; i < messages.length; i++) {
        writeMessageToStdout(collectWrite, messages[i])
      }
      writtenMessageCountRef.current = messages.length
    }
    // End-of-turn safety net: writeMessageToStdout buffers consecutive
    // read-only tool messages (Read / Glob / Grep / ListDir) and flushes
    // them inline when the next non-collapsible message arrives. If a
    // chain ends without that closing message — user pressed Esc mid-chain,
    // the model returned `finishReason='stop'` with no text, etc. — the
    // buffer would otherwise sit until the user submits again. Flushing
    // when isLoading drops to false commits the trailing summary so it
    // lands on this same render's atomic write.
    if (!isLoading) {
      flushPendingReadGroup(collectWrite)
    }
    // Snapshot the cross-render ref into a local. The geometry path reads
    // `scrollbackContent` multiple times and the snapshot keeps a single
    // render's view consistent. The bytes stay in the ref until doFlush
    // confirms they made it to stdout — see pendingScrollbackRef's docs.
    const scrollbackContent = pendingScrollbackRef.current
    const didCommitMessages = scrollbackContent.length > 0

    // Capture "is this the first active paint?" BEFORE we flip activeRef.
    // The freeBlanks-seeding check below needs to know this, but the old
    // `!activeRef.current` guard down at the seeding site was always false
    // by the time it ran (we set activeRef=true just below), so the banner's
    // above-frame blank-row credit never got seeded — and the first commit
    // would pre-scroll through the banner rows instead of consuming the
    // unowned blanks between banner and frame. Symptom: starting with an
    // initial prompt (`xc "hi"`) clipped the top half of the logo.
    const isFirstPaint = !activeRef.current
    activeRef.current = true

    // Keep the permission-slot reservation alive only until the first commit
    // after the permission closed (that commit carries the approved tool's
    // result and overwrites the reserved rows). A fresh permission also
    // clears the reservation — the new dialog owns the slot directly.
    //
    // Only reserve when exactly ONE tool is pending. Two tools happen to
    // produce the same frame height as the permission (2×2 + 3 input = 7 =
    // 4 permission + 3 input) so no reservation is needed; three or more
    // tools make the frame LARGER than the permission, which is a grow
    // (handled correctly by the existing freeBlanks/preScroll path);
    // zero tools means the approved tool was denied or hasn't produced an
    // onToolCall yet — reserving blank rows there would just shift the
    // gap around rather than eliminate it.
    const hadPermissionLastRender = prevHadPermissionRef.current
    const runningToolCount = activeToolCalls?.length ?? 0
    if (hasNewMessages || permission) {
      permissionSlotReserveRef.current = 0
    } else if (hadPermissionLastRender && !permission && runningToolCount === 1) {
      permissionSlotReserveRef.current = 2
    }
    prevHadPermissionRef.current = !!permission

    const PROMPT_WIDTH = 2
    const vpWidth = Math.max(20, termWidth - PROMPT_WIDTH - 1)
    const sepChar = '\u2500'
    const sepText = sepChar.repeat(Math.max(0, termWidth - 1))

    // ── Input display lines (with soft-wrap + viewport windowing) ──
    // Raw lines are split by explicit `\n` only. Each raw line is then
    // soft-wrapped at vpWidth columns into one or more visual lines, so
    // the input doesn't run off the right edge of the terminal. The
    // cursor's character offset is mapped into the matching (visualLine,
    // visualCol) pair for the render/diff paths below.
    const rawLines = text.length === 0 ? [''] : text.split('\n')

    type VisualLine = { text: string; rawLineIdx: number; startCol: number }
    const visualLines: VisualLine[] = []
    for (let r = 0; r < rawLines.length; r++) {
      const line = rawLines[r]
      if (line.length === 0) {
        visualLines.push({ text: '', rawLineIdx: r, startCol: 0 })
        continue
      }
      let pos = 0
      while (pos < line.length) {
        const chunk = sliceByWidth(line.slice(pos), vpWidth)
        const advance = chunk.length > 0 ? chunk.length : line.length - pos // wide-char-overflow safety
        visualLines.push({ text: chunk, rawLineIdx: r, startCol: pos })
        pos += advance
      }
    }

    // Locate cursor in visual coordinates. Scan visual lines in order:
    // the cursor lies inside the first visual line whose raw range
    // `[startCol, startCol + text.length]` contains `cursorCol` for the
    // matching rawLineIdx. When cursor is at the end of a wrapped line
    // that continues to the next visual line (startCol + text.length ===
    // cursorCol AND the next visual line has the same rawLineIdx), we
    // prefer the next line's leading position for UX parity with shell
    // prompts.
    let visCursorLine = 0
    let visCursorCol = 0
    {
      let rawCursorLine = 0,
        cursorColInRaw = cursor
      let charsSoFar = 0
      for (let i = 0; i < rawLines.length; i++) {
        if (cursor >= charsSoFar && cursor <= charsSoFar + rawLines[i].length) {
          rawCursorLine = i
          cursorColInRaw = cursor - charsSoFar
          break
        }
        charsSoFar += rawLines[i].length + 1
      }
      for (let v = 0; v < visualLines.length; v++) {
        const vl = visualLines[v]
        if (vl.rawLineIdx !== rawCursorLine) continue
        const endCol = vl.startCol + vl.text.length
        const isLastChunkOfRawLine = v + 1 >= visualLines.length || visualLines[v + 1].rawLineIdx !== rawCursorLine
        if (
          cursorColInRaw >= vl.startCol &&
          (cursorColInRaw < endCol || (cursorColInRaw === endCol && isLastChunkOfRawLine))
        ) {
          visCursorLine = v
          visCursorCol = cursorColInRaw - vl.startCol
          break
        }
      }
    }

    let displayLines: string[]
    let cursorLine: number
    if (visualLines.length <= MAX_VISIBLE_LINES) {
      displayLines = visualLines.map((v) => v.text)
      cursorLine = visCursorLine
    } else {
      let start = visCursorLine - Math.floor(MAX_VISIBLE_LINES / 2)
      start = Math.max(0, Math.min(start, visualLines.length - MAX_VISIBLE_LINES))
      displayLines = visualLines.slice(start, start + MAX_VISIBLE_LINES).map((v) => v.text)
      cursorLine = visCursorLine - start
      if (start > 0) {
        displayLines[0] = `${GLYPH_ELLIPSIS} (+${start} above)`
        if (cursorLine === 0) cursorLine = -1
      }
      if (start + MAX_VISIBLE_LINES < visualLines.length) {
        displayLines[displayLines.length - 1] =
          `${GLYPH_ELLIPSIS} (+${visualLines.length - start - MAX_VISIBLE_LINES} below)`
        if (cursorLine === displayLines.length - 1) cursorLine = -1
      }
    }
    // `cursorCol` below refers to the visual column within the display
    // line — preserve the existing name so the input-rendering block
    // (cursor placement, long-line truncation) doesn't need changes.
    const cursorCol = visCursorCol

    // ── Build 2D cell frame ──
    const frame: Cell[][] = []

    // Error line (if any)
    if (errorMessage) {
      const S_ERR = '\x1b[38;2;244;113;116m' // red-ish
      const cells: Cell[] = []
      cells.push({ char: ' ', style: S_NONE, width: 1 })
      cells.push(...textToCells(`Error: ${errorMessage}`, S_ERR))
      frame.push(cells)
    }

    // (Streaming assistant text does NOT live here. Each complete line
    // emitted by useStreamBuffer is committed as a `streamingChunk`
    // message and written straight to scrollback above this cell buffer
    // — see writeMessageToStdout. That keeps our frame's row count
    // stable as output grows: spinner / separators / input never shift
    // position, so there's no row-shift jitter.)

    // Spinner / tool-status line. Pinned just above the input box
    // (below any permission dialog) so it always sits at the very bottom
    // of the dynamic area — matches Claude Code's layout.
    //
    // When tools are running we replace the generic "Thinking..." line with
    // a live tool-status block, one 2-row group per in-flight tool call:
    //    ● ToolName(preview)
    //    ⎿ ⠋ progressText          (← replaced by onToolProgress stream)
    // Mirrors Claude Code's AssistantToolUseMessage + renderToolUseProgress
    // flow. Elapsed/token meta moves onto the LAST progress line so the
    // block stays compact (no separate Thinking row competing for space).
    if (spinner) {
      const glyph = SPINNER_FRAMES[spinnerFrame]
      // Derive elapsed time at render time so we don't need a setState in
      // the spinner effect. The setSpinnerFrame tick is what drives the
      // ~80ms re-render that recomputes this value.
      const elapsedMs = loadingStartRef.current === 0 ? 0 : Date.now() - loadingStartRef.current
      const parts: string[] = []
      if (elapsedMs >= 2000) parts.push(formatElapsed(elapsedMs))
      // Token count is no longer shown next to the spinner — it now lives
      // in the footer below the input box (see contextUsage rendering)
      // because cumulative session counts double-count cache-served history
      // and "context size" snapshots only feel useful with a denominator.
      // Only show the cancel hint when we're actually able to honor an Esc
      // press (no modal open — the parent suppresses the spinner in that
      // case anyway, but be defensive).
      parts.push('esc to interrupt')
      const meta = parts.length > 0 ? ` (${parts.join(' · ')})` : ''

      // Top margin ONLY when the permission dialog sits immediately above
      // the spinner (they'd otherwise touch without breathing room).
      // When Thinking sits directly below scrollback content, the last
      // message already ends with `\n\n` → one blank row is ALREADY
      // there, and adding another would make the gap look too large.
      if (permission) frame.push([])

      // Collapsible read-only tools (Read/Glob/Grep/ListDir) don't get a
      // live `● Read(file) / ⎿ Running…` indicator row — their results are
      // buffered into a single summary line that flushes at chain end, and
      // showing per-tool live indicators while buffering causes a visible
      // "appears then vanishes" flash on every fast read: the tool-call
      // render commits a 7-row frame with the live indicator, the result
      // arrives 1-5ms later, the post-result commit gets throttled 50ms,
      // and during that window the user sees the indicator land — then the
      // throttle releases, the frame shrinks back to 5 rows, and because
      // the read message was buffered (no scrollback row to take its
      // place) the indicator simply disappears. CC's batched-read flow
      // does the same: spinner during the chain, summary after. Slow reads
      // lose per-file visibility this way, but they're the rare case in
      // chains and the chain-end summary lists every file by basename.
      const tools = (activeToolCalls ?? []).filter((tc) => !isCollapsibleReadOnlyTool(tc.toolName))
      if (tools.length > 0) {
        // IMPORTANT: the live tool bubble MUST use the same colour/weight
        // scheme as `stdout-writer.formatToolCall` emits for committed
        // scrollback — otherwise when the tool finishes and its line
        // switches from live-area to scrollback, the user sees a visible
        // colour flash (orange → default for label, orange → green for
        // bullet, etc.). Claude Code avoids this by rendering in-flight
        // and resolved through the SAME React component; we have two
        // rendering paths (ink-like cells here vs chalk stdout there)
        // so we align the styles by hand.
        //
        // Same reasoning applies to the leading-blank row above the tool
        // block: `stdout-writer.formatToolCall`'s commit path prepends a
        // `\n` whenever the previous write didn't already end blank, so
        // the committed tool sits one row below the preceding text. The
        // live frame must mirror that decision RIGHT NOW — otherwise the
        // user sees the blank row "appear" the instant the tool commits
        // (live frame replaced by scrollback), which reads as a one-row
        // downward jolt of every row below. Permission's own top-margin
        // case is already handled above; this branch covers tool-only
        // and tool+permission stacks.
        if (!permission && !lastWriteEndedWithBlankRow()) frame.push([])
        //
        // Layout mirrors committed:
        //    ` ● ToolName(preview)`
        //      ⎿  ⠋ progress text               ← only live, vanishes at commit
        tools.forEach((tc, idx) => {
          // Separator between adjacent live tools. The committed-tool
          // path emits `\n\n` after each tool, so consecutive committed
          // tools always have one blank row between them. Without the
          // same blank in the live frame, parallel tool calls render
          // glued together until one finishes and commits — at which
          // point the spacing "pops in" (the user's "stuck then
          // separate" jolt).
          if (idx > 0) frame.push([])

          const label = getToolLabel(tc.toolName)
          const preview = getToolInputPreview(tc.toolName, tc.input)

          const row1: Cell[] = []
          row1.push({ char: ' ', style: S_NONE, width: 1 })
          // Pulse the bullet bright↔dim while the tool runs. Period of
          // 6 frames per phase (= ~480ms at 80ms per spinner tick) reads
          // as a heartbeat without being distracting. When the tool
          // finishes and the row commits to scrollback,
          // `stdout-writer.formatToolCall` paints a steady non-pulsing
          // bullet — same hue, no dim — so the transition is just "stop
          // pulsing", not a color change.
          const dotStyle = spinnerFrame % 6 < 3 ? S_SUCCESS_DOT : S_SUCCESS_DOT_DIM
          row1.push(...textToCells(GLYPH_BULLET, dotStyle))
          row1.push({ char: ' ', style: S_NONE, width: 1 })
          row1.push(...textToCells(label, S_BOLD))
          if (preview) {
            // Mirror stdout-writer.formatToolCall's truncation budget so
            // the live row and the committed scrollback row truncate at
            // the same point — otherwise the visible text shifts at the
            // moment the tool finishes (e.g. live shows "...rg)" but
            // committed shows "...rgs.command)"). Reserve label.length+5
            // for ` ● <label>(` and `)`, plus a safety margin.
            const decoration = label.length + 5
            const safetyMargin = 4
            const maxPreviewLen = Math.max(40, termWidth - decoration - safetyMargin)
            const trimmed =
              preview.length > maxPreviewLen ? preview.slice(0, maxPreviewLen - 1) + GLYPH_ELLIPSIS : preview
            row1.push(...textToCells(`(${trimmed})`, S_BLUE_PURPLE))
          }
          frame.push(row1)

          // Sub-tool history: for task (sub-agent) tools, show the last
          // few tool calls as stacked `⎿` rows (like CC). Other tools
          // keep a single progress row.
          const history = tc.subToolHistory
          const isTask = tc.toolName.toLowerCase().replace(/[_-]/g, '') === 'task'
          if (isTask && history && history.length > 1) {
            const MAX_VISIBLE = 4
            const start = Math.max(0, history.length - MAX_VISIBLE)
            for (let hi = start; hi < history.length; hi++) {
              const isFirst = hi === start
              const isLast = hi === history.length - 1
              const row: Cell[] = []
              row.push(...textToCells('   ', S_NONE))
              if (isFirst) {
                row.push(...textToCells(GLYPH_RESULT_BRACKET, S_GRAY_90))
              } else {
                row.push({ char: ' ', style: S_NONE, width: 1 })
              }
              row.push({ char: ' ', style: S_NONE, width: 1 })
              row.push({ char: ' ', style: S_NONE, width: 1 })
              if (isLast) {
                row.push(...textToCells(glyph, S_SPINNER))
                row.push({ char: ' ', style: S_NONE, width: 1 })
              }
              row.push(...textToCells(history[hi]!, isLast ? S_DIM : S_GRAY_90))
              if (isLast && idx === tools.length - 1 && meta) {
                row.push(...textToCells(meta, S_GRAY_90))
              }
              frame.push(truncateCellRow(row, Math.max(20, termWidth - 1)))
            }
          } else {
            const row2: Cell[] = []
            row2.push(...textToCells('   ', S_NONE))
            row2.push(...textToCells(GLYPH_RESULT_BRACKET, S_GRAY_90))
            row2.push({ char: ' ', style: S_NONE, width: 1 })
            row2.push({ char: ' ', style: S_NONE, width: 1 })
            row2.push(...textToCells(glyph, S_SPINNER))
            row2.push({ char: ' ', style: S_NONE, width: 1 })
            row2.push(...textToCells(tc.progress ?? 'Running...', S_DIM))
            if (idx === tools.length - 1 && meta) {
              row2.push(...textToCells(meta, S_GRAY_90))
            }
            frame.push(row2)
          }
        })
      } else {
        // Build the whole prefix (` ${glyph} ${label}...`) under ONE style
        // (S_SPINNER) instead of alternating S_NONE / S_SPINNER per cell.
        // Why: each cell with a different style emits an SGR escape in the
        // diff loop, and on terminals that don't perfectly atomize DEC
        // 2026 sync-update those escapes arrive with visible spacing —
        // the user perceives the "Thinking" label flashing default-color
        // → blue → default → blue as the spaces in between trigger
        // resets. Keeping one continuous SGR run for the whole prefix
        // makes the row paint as one solid blue stripe.
        const cells: Cell[] = textToCells(` ${glyph} ${spinner.label}...`, S_SPINNER)
        if (meta) cells.push(...textToCells(meta, S_DIM))
        frame.push(cells)
      }
    }

    // Permission dialog — rendered ABOVE the input box (between spinner
    // and the input's top separator) so the input stays pinned at the
    // bottom of the screen regardless of dialog state.
    if (permission) {
      const titleText = permissionTitle(permission.toolName, permission.mcp)
      const titleCells: Cell[] = []
      titleCells.push({ char: ' ', style: S_NONE, width: 1 })
      titleCells.push({ char: ' ', style: S_NONE, width: 1 })
      titleCells.push(...textToCells(titleText, S_WARNING_BOLD))
      frame.push(titleCells)

      const contentCells = permissionContentCells(permission.toolName, permission.input, termWidth, permission.mcp)
      if (contentCells) frame.push(contentCells)

      const ruleLabel = suggestRuleLabel(permission.toolName, permission.input, !!permission.mcp)
      // When no rule can be suggested (e.g. powershell -Command "...",
      // enterPlanMode), only show Yes/No (2 options). When a prefix is
      // available, show Yes / Yes don't ask again / No (3 options).
      const noIndex = ruleLabel ? 2 : 1

      const yesCells: Cell[] = []
      if (permissionSelected === 0) {
        yesCells.push(...textToCells('    ', S_NONE))
        yesCells.push(...textToCells(`${GLYPH_SELECT_POINTER} Yes`, S_SUCCESS))
      } else {
        yesCells.push(...textToCells('      ', S_NONE))
        yesCells.push(...textToCells('Yes', S_ACCENT_DIM))
      }
      frame.push(yesCells)

      if (ruleLabel) {
        const alwaysCells: Cell[] = []
        if (permissionSelected === 1) {
          alwaysCells.push(...textToCells('    ', S_NONE))
          alwaysCells.push(...textToCells(`${GLYPH_SELECT_POINTER} Yes, don't ask again for: ${ruleLabel}`, S_SUCCESS))
        } else {
          alwaysCells.push(...textToCells('      ', S_NONE))
          alwaysCells.push(...textToCells(`Yes, don't ask again for: ${ruleLabel}`, S_ACCENT_DIM))
        }
        frame.push(alwaysCells)
      }

      const noCells: Cell[] = []
      if (permissionSelected === noIndex) {
        noCells.push(...textToCells('    ', S_NONE))
        noCells.push(...textToCells(`${GLYPH_SELECT_POINTER} No`, S_ERROR_BOLD))
      } else {
        noCells.push(...textToCells('      ', S_NONE))
        noCells.push(...textToCells('No', S_ACCENT_DIM))
      }
      frame.push(noCells)
    }

    // Select-options dialog — rendered inside our cell buffer, same slot
    // as Permission. The commit path below detects "shrink from above
    // viewport to at-or-below viewport" and does a clearTerminal + full
    // redraw from messages state, so the tall dialog doesn't leave blank
    // scrollback rows behind when it closes (mirrors Claude Code's
    // log-update.ts fullResetSequence_CAUSES_FLICKER approach).
    if (selectRequest) {
      // Blank line above the question title for visual separation from
      // scrollback content above (mirrors CC's PermissionRequestTitle
      // sitting inside a padded container).
      frame.push([{ char: ' ', style: S_NONE, width: 1 }])

      const questionText = selectRequest.question
      const maxRowW = Math.max(20, termWidth - 1)
      // Wrap question text across multiple lines instead of truncating.
      // The 1-cell left padding is added to each wrapped line.
      const rawCells = ansiTextToCells(renderInlineMarkdown(questionText))
      const contentW = maxRowW - 1
      let ci = 0
      while (ci < rawCells.length) {
        const row: Cell[] = [{ char: ' ', style: S_NONE, width: 1 }]
        let w = 0
        while (ci < rawCells.length && w + rawCells[ci]!.width <= contentW) {
          w += rawCells[ci]!.width
          row.push(rawCells[ci]!)
          ci++
        }
        frame.push(row)
      }
      if (rawCells.length === 0) {
        frame.push([{ char: ' ', style: S_NONE, width: 1 }])
      }

      const opts = selectRequest.options
      const hasDescriptions = opts.some(
        (o: { description?: string; freeform?: boolean }) => o.description && !o.freeform,
      )
      const isVertical = (selectRequest.layout ?? 'compact') === 'compact-vertical'
      const rowsPerOption = hasDescriptions && isVertical ? 2 : 1
      const termRows = stdout?.rows ?? 25

      // Viewport-scroll the options list when there are too many to fit
      // on screen. The visible window follows the active selection index
      // so the highlighted row is always in view.
      const questionRows = Math.max(1, Math.ceil(rawCells.reduce((s, c) => s + c.width, 0) / contentW))
      const hintRows = 1
      const selectBlanks = 2
      const separatorsAndInput = 3
      const footerRow = 1
      const spinnerRows = spinner ? 1 : 0
      const todoRows = todos && todos.length > 0 ? todos.length : 0
      // Match the live-tool-block filter above: collapsible read-only
      // tools don't draw an indicator, so they don't consume rows here
      // either. Without this filter the select-options dialog would
      // reserve phantom rows for invisible tools and place itself too
      // high (or scroll its own viewport unnecessarily).
      const tools = (activeToolCalls ?? []).filter((tc) => !isCollapsibleReadOnlyTool(tc.toolName))
      const activeToolRows =
        tools.length > 0
          ? tools.reduce((sum, tc, idx) => {
              const histLen =
                tc.toolName.toLowerCase().replace(/[_-]/g, '') === 'task' &&
                tc.subToolHistory &&
                tc.subToolHistory.length > 1
                  ? Math.min(tc.subToolHistory.length, 4)
                  : 1
              return sum + 1 + histLen + (idx > 0 ? 1 : 0)
            }, 1)
          : 0
      const fixedChrome =
        selectBlanks + hintRows + separatorsAndInput + footerRow + spinnerRows + todoRows + activeToolRows
      const chromeRows = questionRows + fixedChrome
      const maxVisibleOptions = Math.max(3, Math.floor((termRows - chromeRows) / rowsPerOption))
      const totalOpts = opts.length
      const needsScroll = totalOpts > maxVisibleOptions

      let vpStart = 0
      let vpEnd = totalOpts
      if (needsScroll) {
        const half = Math.floor(maxVisibleOptions / 2)
        vpStart = Math.max(0, selectIndex - half)
        vpEnd = vpStart + maxVisibleOptions
        if (vpEnd > totalOpts) {
          vpEnd = totalOpts
          vpStart = Math.max(0, vpEnd - maxVisibleOptions)
        }
      }

      if (needsScroll && vpStart > 0) {
        const cells: Cell[] = []
        cells.push({ char: ' ', style: S_NONE, width: 1 })
        cells.push(...textToCells(`  \u2191 ${vpStart} more above`, S_DIM))
        frame.push(cells)
      }

      // Blank line between question header and options for visual grouping
      frame.push([{ char: ' ', style: S_NONE, width: 1 }])

      const maxRowWidth = Math.max(20, termWidth - 1)
      const maxIdxWidth = totalOpts.toString().length
      const layout = selectRequest.layout ?? 'compact'

      if (layout === 'compact-vertical') {
        // compact-vertical: description on a separate indented line below
        // the label. Matches CC's QuestionView layout:
        //   ❯ 1. Label        ← focused: pointer "suggestion", label "suggestion"
        //      description     ← paddingLeft = maxIndexWidth + 4
        //     2. Label         ← unfocused: no pointer, label default (no bold)
        //      description     ← dim
        // CC's paddingLeft = maxIndexWidth + 4:
        //   1(pointer) + 1(gap) + maxIdxWidth + 1(dot) + 1(space) = maxIdxWidth + 4
        const descIndent = maxIdxWidth + 4
        for (let i = vpStart; i < vpEnd; i++) {
          const opt = opts[i]!
          const active = i === selectIndex
          const idx = `${i + 1}.`.padEnd(maxIdxWidth + 2)
          const labelStyle = active ? S_BLUE_PURPLE : S_NONE
          const cells: Cell[] = []
          cells.push({ char: ' ', style: S_NONE, width: 1 })
          if (active) {
            cells.push(...textToCells(`${GLYPH_SELECT_POINTER} `, S_BLUE_PURPLE))
          } else {
            cells.push(...textToCells('  ', S_NONE))
          }
          cells.push(...textToCells(idx, S_DIM))
          cells.push(...textToCells(opt.label, labelStyle))
          if (opt.freeform && active) {
            cells.push(...textToCells(': ', S_NONE))
            const t = freeform.text
            const c = freeform.cursor
            const before = t.slice(0, c)
            const cursorChar = c < t.length ? t[c] : ' '
            const after = c < t.length ? t.slice(c + 1) : ''
            cells.push(...textToCells(before, S_NONE))
            cells.push({ char: cursorChar, style: S_CURSOR, width: charWidth(cursorChar) })
            cells.push(...textToCells(after, S_NONE))
          }
          frame.push(truncateCellRow(cells, maxRowWidth))
          if (opt.description && !opt.freeform) {
            const descCells: Cell[] = []
            descCells.push({ char: ' ', style: S_NONE, width: 1 })
            descCells.push(...textToCells(' '.repeat(descIndent), S_NONE))
            descCells.push(...textToCells(opt.description, S_ACCENT_DIM))
            frame.push(truncateCellRow(descCells, maxRowWidth))
          }
        }
      } else {
        // compact (default): label and description on the same line,
        // right-padded into two aligned columns.
        // Compute max label column width for alignment.
        let maxLabelW = 0
        for (let i = vpStart; i < vpEnd; i++) {
          const o = opts[i]!
          const lw = visualWidth(o.label)
          if (lw > maxLabelW) maxLabelW = lw
        }
        const gapBetween = 2
        const labelCol = maxLabelW + gapBetween

        for (let i = vpStart; i < vpEnd; i++) {
          const opt = opts[i]!
          const active = i === selectIndex
          const idx = `${i + 1}.`.padEnd(maxIdxWidth + 2)
          const cells: Cell[] = []
          cells.push({ char: ' ', style: S_NONE, width: 1 })
          if (active) {
            cells.push(...textToCells(`${GLYPH_SELECT_POINTER} `, S_BLUE_PURPLE))
          } else {
            cells.push(...textToCells('  ', S_NONE))
          }
          cells.push(...textToCells(idx, S_DIM))

          const labelStyle = active ? S_BLUE_PURPLE : S_NONE
          cells.push(...textToCells(opt.label, labelStyle))

          if (opt.freeform && active) {
            cells.push(...textToCells(': ', S_NONE))
            const t = freeform.text
            const c = freeform.cursor
            const before = t.slice(0, c)
            const cursorChar = c < t.length ? t[c] : ' '
            const after = c < t.length ? t.slice(c + 1) : ''
            cells.push(...textToCells(before, S_NONE))
            cells.push({ char: cursorChar, style: S_CURSOR, width: charWidth(cursorChar) })
            cells.push(...textToCells(after, S_NONE))
          } else if (opt.description) {
            const curLabelW = visualWidth(opt.label)
            const pad = Math.max(1, labelCol - curLabelW)
            cells.push(...textToCells(' '.repeat(pad), S_NONE))
            cells.push(...textToCells(opt.description, S_ACCENT_DIM))
          }

          frame.push(truncateCellRow(cells, maxRowWidth))
        }
      }

      if (needsScroll && vpEnd < totalOpts) {
        const cells: Cell[] = []
        cells.push({ char: ' ', style: S_NONE, width: 1 })
        cells.push(...textToCells(`  \u2193 ${totalOpts - vpEnd} more below`, S_DIM))
        frame.push(cells)
      }

      // Blank line between options and hint (CC: marginTop={1} on hint Box)
      frame.push([{ char: ' ', style: S_NONE, width: 1 }])

      const hint: Cell[] = []
      hint.push({ char: ' ', style: S_NONE, width: 1 })
      const activeOpt = opts[selectIndex]
      const escHint = selectRequest.dismissible ? ' \u00b7 Esc to cancel' : ''
      const hintText = activeOpt?.freeform
        ? `Enter to select \u00b7 \u2191/\u2193 to navigate \u00b7 Type your answer${escHint}`
        : `Enter to select \u00b7 \u2191/\u2193 to navigate${escHint}`
      hint.push(...textToCells(hintText, S_DIM))
      frame.push(hint)

      // Live preview pane. The focused option may carry a `preview`
      // array of pre-rendered ANSI rows (e.g. the `/syntax` picker
      // attaches a colored diff snippet per theme). Render below the
      // hint with one blank-row separator so the visual block reads as
      // "options \u2193 preview". When the focused option has no preview
      // (e.g. the auto-appended `Other` row) the pane simply doesn't
      // appear \u2014 no flicker as the user arrows past it.
      if (activeOpt?.preview && activeOpt.preview.length > 0) {
        frame.push([{ char: ' ', style: S_NONE, width: 1 }])
        for (const row of activeOpt.preview) {
          const cells: Cell[] = []
          cells.push({ char: ' ', style: S_NONE, width: 1 })
          cells.push({ char: ' ', style: S_NONE, width: 1 })
          cells.push(...ansiTextToCells(row))
          frame.push(cells)
        }
      }
    }

    // Todo panel. Driven by the model's `todoWrite` tool; gives the
    // user a live view of multi-step task progress. Inspired by
    // Claude Code's `<MessageResponse><TaskListV2/></MessageResponse>`
    // in `Spinner.tsx:280`, but adapted to our cell-buffer where
    // multiple anchor sources can sit above the panel.
    //
    // Anchor handling: the corner glyph `\u23bf` only renders on
    // row 1 when *no* anchor exists above the panel (no spinner, no
    // active tool calls). In that orphan case we also prepend a dim
    // "Update Todos" header so the corner has something to attach to.
    // When a spinner or live-tool row is already showing above, those
    // rows already carry their own `\u23bf` connector; adding a
    // second one here produces a visible double-corner (two `\u23bf`
    // glyphs stacked) so we drop ours and let the items sit as plain
    // indented rows under the existing anchor.
    //
    //   no anchor above            anchor above (spinner/tool)
    //     Update Todos               \u23bf Running command...
    //   \u23bf <icon> Task name           <icon> Task name
    //     <icon> Task name              <icon> Task name
    //
    // Other choices:
    //   - No "N tasks (X done, ...)" summary header \u2014 CC drops it; the
    //     icon progression (\u2713 vs \u25fc vs \u25fb) IS the status.
    //   - Completed: dim check + strikethrough dim content. Pending:
    //     hollow square in default color (NOT dim \u2014 pending is
    //     "waiting", not "forgotten"). In-progress: filled square +
    //     bold content, both in default fg. CC uses its accent orange
    //     (#d77757) here, but that hue clashes with the rest of our
    //     palette, so we lean on shape (filled vs hollow) + weight
    //     (bold vs regular) instead of color to signal active state.
    //   - No `activeForm` activity line. CC doesn't render one, and
    //     when the model echoed the same phrase for both fields the
    //     extra row was visual noise.
    if (todos && todos.length > 0) {
      const hasAnchorAbove = !!spinner || (activeToolCalls?.length ?? 0) > 0
      if (!hasAnchorAbove) {
        const headerCells: Cell[] = []
        headerCells.push({ char: ' ', style: S_NONE, width: 1 })
        headerCells.push(...textToCells('Update Todos', S_DIM))
        frame.push(headerCells)
      }
      for (let i = 0; i < todos.length; i++) {
        const t = todos[i]
        const cells: Cell[] = []
        cells.push({ char: ' ', style: S_NONE, width: 1 })
        cells.push({ char: ' ', style: S_NONE, width: 1 })
        if (i === 0 && !hasAnchorAbove) {
          cells.push(...textToCells(GLYPH_TODO_BRACKET, S_GRAY_90))
        } else {
          cells.push({ char: ' ', style: S_NONE, width: 1 })
        }
        cells.push({ char: ' ', style: S_NONE, width: 1 })
        if (t.status === 'completed') {
          cells.push(...textToCells(GLYPH_TODO_CHECK, S_DIM))
          cells.push({ char: ' ', style: S_NONE, width: 1 })
          // ANSI 2 = dim, 9 = strikethrough.
          cells.push(...textToCells(t.content, '\x1b[0m\x1b[2;9m'))
        } else if (t.status === 'in_progress') {
          cells.push(...textToCells(GLYPH_TODO_IN_PROGRESS, S_BOLD))
          cells.push({ char: ' ', style: S_NONE, width: 1 })
          cells.push(...textToCells(t.content, S_BOLD))
        } else {
          cells.push(...textToCells(GLYPH_TODO_PENDING, S_RESET))
          cells.push({ char: ' ', style: S_NONE, width: 1 })
          cells.push(...textToCells(t.content, S_RESET))
        }
        frame.push(cells)
      }
    }

    // Reserved padding left over from a permission dialog that just closed.
    // Sits between the in-progress tool rows (above) and the input
    // separators (below) so the frame keeps the dialog's total height
    // until the approved tool's result commits and slides into the
    // reserved space.
    for (let i = 0; i < permissionSlotReserveRef.current; i++) {
      frame.push([])
    }

    // Top separator
    frame.push(textToCells(sepText, S_GRAY))

    // Input lines. The terminal's hardware cursor is hidden for the
    // entire TUI lifetime; the visible "cursor" the user sees is just an
    // inverse-video cell (S_CURSOR) drawn into the frame at the cursor
    // position. So we don't compute or emit a cursor-park CSI here.
    for (let i = 0; i < displayLines.length; i++) {
      const line = displayLines[i]
      const prompt = i === 0 ? '> ' : '  '
      const showCursor = !disabled && i === cursorLine && cursorLine >= 0
      const cells: Cell[] = []

      cells.push({ char: prompt[0], style: S_GRAY, width: 1 })
      cells.push({ char: prompt[1], style: S_NONE, width: 1 })

      if (!showCursor) {
        const lw = visualWidth(line)
        const truncated = lw > vpWidth ? sliceByWidth(line, vpWidth) : line
        cells.push(...textToCells(truncated, S_RESET))
      } else {
        const before = line.slice(0, cursorCol)
        const cursorChar = cursorCol < line.length ? line[cursorCol] : ' '
        const after = cursorCol < line.length ? line.slice(cursorCol + 1) : ''
        const lw = visualWidth(line)

        if (lw <= vpWidth) {
          cells.push(...textToCells(before, S_RESET))
          cells.push({ char: cursorChar, style: S_CURSOR, width: charWidth(cursorChar) })
          cells.push(...textToCells(after, S_RESET))
        } else {
          const beforeWidth = visualWidth(before)
          const halfVP = Math.floor(vpWidth / 2)
          let skipCols = Math.max(0, beforeWidth - halfVP)
          const totalWidth = lw + (cursorCol >= line.length ? 1 : 0)
          if (skipCols + vpWidth > totalWidth) skipCols = Math.max(0, totalWidth - vpWidth)
          const startIdx = skipByWidth(line, skipCols)
          const vb = line.slice(startIdx, cursorCol)
          const afterStart = cursorCol < line.length ? cursorCol + 1 : line.length
          const remaining = vpWidth - visualWidth(vb) - charWidth(cursorChar)
          const va = sliceByWidth(line.slice(afterStart), Math.max(0, remaining))
          cells.push(...textToCells(vb, S_RESET))
          cells.push({ char: cursorChar, style: S_CURSOR, width: charWidth(cursorChar) })
          cells.push(...textToCells(va, S_RESET))
        }
      }
      frame.push(cells)
    }

    // Bottom separator
    frame.push(textToCells(sepText, S_GRAY))

    // Footer row — same layout pattern Claude Code / Codex / Gemini CLI
    // use: left text and right text on a SINGLE row, with the right
    // text right-aligned at the row's bottom-right corner. Built as one
    // cell sequence (left + padding spaces + right) inside the cell
    // buffer's frame, so the cell-diff loop owns the entire row's
    // contents — no out-of-band overlay writes.
    //
    // Width is capped at `termWidth - 1` cells (same width the bottom
    // separator above uses) so this row's geometry never lands on the
    // terminal's auto-wrap column boundary.
    //
    // Left side  — notice / mode indicator (mutually exclusive). Priority:
    //              notice > plan > acceptEdits. Mode switching via slash
    //              commands only (/plan); the Shift+Tab keybinding was
    //              removed because Windows needs Node ≥22.17 VT input mode
    //              and Alt+M is too easily clobbered by IDE menus.
    // Right side — context-window occupancy (`6.6k / 200k · 3%`), shown
    //              whenever a usage snapshot is available.
    //
    // The row is omitted entirely when neither side has content, so a
    // fresh session in default mode keeps a zero-row footer footprint.
    let leftCells: Cell[] | null = null
    if (notice) {
      const cells: Cell[] = []
      cells.push({ char: ' ', style: S_NONE, width: 1 })
      cells.push(...textToCells(notice, S_DIM))
      leftCells = cells
    } else if (permissionMode === 'plan') {
      const cells: Cell[] = []
      cells.push({ char: ' ', style: S_NONE, width: 1 })
      cells.push(...textToCells(`${GLYPH_PLAN_MODE} plan mode  ·  /plan to toggle`, S_DIM))
      leftCells = cells
    } else if (permissionMode === 'acceptEdits') {
      const cells: Cell[] = []
      cells.push({ char: ' ', style: S_NONE, width: 1 })
      cells.push(...textToCells(`${GLYPH_ACCEPT_EDITS} accept edits`, S_DIM))
      leftCells = cells
    }

    let rightText: string | null = null
    if (contextUsage && contextUsage.used > 0 && contextUsage.window > 0) {
      const pct = Math.round((contextUsage.used / contextUsage.window) * 100)
      rightText = `${formatTokenCount(contextUsage.used)} / ${formatTokenCount(contextUsage.window)} · ${pct}%`
    }

    if (leftCells || rightText) {
      // Footer row built as a NARROW cell sequence — left + ` · ` + right —
      // never padded out to termWidth-1.
      //
      // Why narrow: an earlier revision right-justified `rightText` by
      // padding with spaces to termWidth-1 cells. That made the LAST row
      // of the frame land its final cell on the terminal's auto-wrap
      // column. Under BSU/ESU sync mode on xterm.js (VS Code's terminal),
      // a frame whose bottom row is that wide leaks residual cells into
      // native scrollback every time a tool-result commit fires its LF
      // auto-scroll — manifesting as ghost "Thinking…" rows piling up
      // above the live frame. Keeping the row narrow stops the cursor
      // ever reaching the wrap column and the regression doesn't fire.
      //
      // Competitor CLIs (Codex, Gemini) right-justify because their
      // committed scrollback isn't pushed via LF auto-scroll — Codex
      // uses ratatui's full-screen buffer, Gemini uses Ink `<Static>`.
      // We can't right-justify cheaply without re-architecting the
      // commit path.
      const cells: Cell[] = []
      const leftWidth = leftCells ? leftCells.reduce((sum, c) => sum + c.width, 0) : 0
      if (leftCells) cells.push(...leftCells)
      if (rightText) {
        if (leftWidth > 0) {
          cells.push(...textToCells('  ·  ', S_DIM))
        } else {
          cells.push({ char: ' ', style: S_NONE, width: 1 })
        }
        cells.push(...textToCells(rightText, S_DIM))
      }
      frame.push(cells)
    }

    // Completion menu — at most one of slash / at renders per frame
    // (activeMenu enforces the mutex). Two writers in the same frame
    // would both compete for the rows above the input box, and a
    // resize would clobber whichever drew last.
    if (activeMenu === 'slash') {
      // Column width includes the longest "name + space + argumentHint" so
      // every description column starts at the same x. Without folding
      // the hint into the width, hint-bearing rows would push description
      // to a different column from hint-less rows, producing a ragged
      // right edge.
      const labelWidth = matches.reduce((max, cmd) => {
        const hintW = cmd.argumentHint ? cmd.argumentHint.length + 1 : 0
        return Math.max(max, cmd.name.length + hintW)
      }, 0)
      // Each description is wrapped across up to 2 rows; a description that
      // still overflows gets an ellipsis at the end of row 2. Truncation is
      // required: a row wider than termWidth hard-wraps at the physical-row
      // level (cell-diff treats it as one grid row, so [K clears miss the
      // wrapped overflow) and, when it spills past the last terminal row,
      // scrolls the viewport — drifting the frame out of sync with
      // lastFrameTopRef and leaving a phantom input box on every menu
      // open/dismiss cycle.
      const maxRowWidth = Math.max(20, termWidth - 1)
      const descCol = labelWidth + 4 // 2-space gutter + label area (labelWidth + 2-space pad)
      const descWidth = Math.max(10, maxRowWidth - descCol)
      // Windowed rendering: show at most MAX_VISIBLE_MENU_ITEMS items
      // at a time, sliding the window to keep safeIndex visible. This
      // caps the frame height so the menu never pushes scrollback
      // content out of the viewport (the root cause of the streaming-
      // corruption bug where `/` during an AI reply overwrote committed
      // scrollback and froze the display).
      const total = matches.length
      const cap = MAX_VISIBLE_MENU_ITEMS
      let winStart: number
      let winEnd: number
      if (total <= cap) {
        winStart = 0
        winEnd = total
      } else {
        winStart = Math.max(0, Math.min(safeIndex - Math.floor(cap / 2), total - cap))
        winEnd = winStart + cap
      }
      if (winStart > 0) {
        frame.push(textToCells(`  ▲ ${winStart} more`, S_DIM))
      }
      for (let i = winStart; i < winEnd; i++) {
        const cmd = matches[i]
        const sel = i === safeIndex
        const labelLen = cmd.name.length + (cmd.argumentHint ? cmd.argumentHint.length + 1 : 0)
        const padRight = ' '.repeat(Math.max(2, labelWidth + 2 - labelLen))
        const padStyle = sel ? S_NONE : S_DIM
        const descStyle = sel ? S_RESET : S_DIM

        const labelCells: Cell[] = []
        labelCells.push({ char: ' ', style: S_NONE, width: 1 })
        labelCells.push({ char: ' ', style: S_NONE, width: 1 })
        labelCells.push(...textToCells(cmd.name, sel ? S_BLUE_PURPLE_BOLD : S_DIM))
        if (cmd.argumentHint) {
          labelCells.push(...textToCells(' ', padStyle))
          labelCells.push(...textToCells(cmd.argumentHint, S_DIM))
        }
        labelCells.push(...textToCells(padRight, padStyle))

        const descRows = wrapCellsToRows(textToCells(cmd.description, descStyle), descWidth, 2)
        const row1: Cell[] = [...labelCells, ...(descRows[0] ?? [])]
        frame.push(truncateCellRow(row1, maxRowWidth))
        if (descRows.length > 1) {
          const indent: Cell[] = []
          for (let k = 0; k < descCol; k++) indent.push({ char: ' ', style: S_NONE, width: 1 })
          frame.push(truncateCellRow([...indent, ...descRows[1]!], maxRowWidth))
        }
      }
      if (winEnd < total) {
        frame.push(textToCells(`  ▼ ${total - winEnd} more`, S_DIM))
      }
    } else if (activeMenu === 'at') {
      if (atMatches.length === 0) {
        // No-matches placeholder — keeps the user oriented when
        // typing `@vitejs/plugin-react` or any token that doesn't
        // map to a local file. The text still goes out to the model
        // verbatim on Enter; the placeholder is purely a UI hint.
        const cells: Cell[] = []
        cells.push({ char: ' ', style: S_NONE, width: 1 })
        cells.push({ char: ' ', style: S_NONE, width: 1 })
        cells.push(...textToCells('No matches', S_DIM))
        frame.push(cells)
      } else {
        const maxColWidth = Math.max(10, termWidth - 4)
        const atTotal = atMatches.length
        const atCap = MAX_VISIBLE_MENU_ITEMS
        let atWinStart: number
        let atWinEnd: number
        if (atTotal <= atCap) {
          atWinStart = 0
          atWinEnd = atTotal
        } else {
          atWinStart = Math.max(0, Math.min(safeAtIndex - Math.floor(atCap / 2), atTotal - atCap))
          atWinEnd = atWinStart + atCap
        }
        if (atWinStart > 0) {
          frame.push(textToCells(`  ▲ ${atWinStart} more`, S_DIM))
        }
        for (let i = atWinStart; i < atWinEnd; i++) {
          const entry = atMatches[i]
          const sel = i === safeAtIndex
          const cells: Cell[] = []
          cells.push({ char: ' ', style: S_NONE, width: 1 })
          cells.push({ char: ' ', style: S_NONE, width: 1 })
          const display = '@' + entry.relPath + (entry.isDirectory ? '/' : '')
          const truncated = truncatePathFromStart(display, maxColWidth)
          cells.push(...textToCells(truncated, sel ? S_BLUE_PURPLE_BOLD : S_DIM))
          frame.push(cells)
        }
        if (atWinEnd < atTotal) {
          frame.push(textToCells(`  ▼ ${atTotal - atWinEnd} more`, S_DIM))
        }
      }
    }

    // ── Plan b: weak-terminal streaming bail-out (REMOVED). ──────────────
    //
    // History: we used to clear the entire frame (`frame.length = 0`)
    // during streaming on terminals that didn't honor DEC 2026 sync —
    // the rationale was that pre-scroll (`\n.repeat(N)`) followed by a
    // non-atomic frame redraw produced visible "input box jitter" at
    // the bottom row. Hiding the frame cured the jitter at the cost of
    // hiding the input box, spinner, separators, elapsed-time, active
    // tool list, and todos for the entire reply.
    //
    // Why we dropped it: two things changed since.
    //
    //  1. The streaming-chunk bookkeeping was broken at the time —
    //     `freeBlanksAboveFrameRef` wasn't decremented when chunks
    //     filled the blank rows below the (hidden) frame, so the
    //     end-of-turn commit computed wrong preScroll and the
    //     `\x1b[J` swept away half the reply. Hiding the frame masked
    //     the symptom on capable terminals (xterm.js's scrollback
    //     quirks held the missing rows) but the underlying account was
    //     wrong. With the Plan b path now decrementing scrollRows
    //     correctly (~25 lines below this point), pre-scroll only
    //     fires when freeBlanks is actually exhausted, not on every
    //     chunk. That alone reduces the jitter source dramatically.
    //
    //  2. The capable-terminal whitelist above used to miss every
    //     mainstream Linux desktop terminal (no VTE_VERSION check),
    //     so Ubuntu/Fedora users on GNOME Terminal hit the bail-out
    //     unconditionally and lost their input box during every AI
    //     reply — same problem class as ConHost on Windows. Even
    //     after we expanded the whitelist, ConHost-class terminals
    //     remain "weak" by definition; the right answer for them is
    //     visible-with-some-jitter, not invisible.
    //
    // Capable terminals (Windows Terminal, iTerm2, Ghostty, kitty,
    // Alacritty, WezTerm, VTE 0.68+, foot, contour, Warp, Zed) get the
    // smooth atomic-DEC-2026 path. Weak terminals (legacy ConHost via
    // cmd.exe / Windows PowerShell host) get the same frame, just with
    // potentially-visible cursor walks during cell-diff redraws — a
    // tradeoff users explicitly preferred over a missing input box.

    // ── Diff against previous frame and emit one buffered write ──────────
    //
    // Frame is PINNED to the last `nextH` rows of the terminal. Every
    // render jumps the cursor absolutely to the frame's top-left — no
    // relative up/down walks from a "parked" position, no dependence on
    // where the last render left the cursor. This is what lets the
    // DECSTBM scrollback path (above) work correctly: that path parks the
    // cursor at row (termRows - H) after reset-scroll-region, which would
    // break any relative cursor math anchored to "the last row of the
    // previous frame".
    const nextH = frame.length
    const oldFrameH = lastFrameHRef.current
    // Floating-frame model: when there are blank rows below the frame
    // (freeBlanks > 0), the frame floats up so it sits right after the
    // last content row. When freeBlanks reaches 0 the frame is at the
    // bottom (the original behavior). frameTop is recomputed every time
    // pendingFreeBlanks changes (after a commit absorbs blanks, after
    // a frame-size change, etc.) so the cell-diff loop further down
    // always writes at the position the frame will end up at.
    const computeFrameTop = (blanks: number) => Math.max(1, termRows - nextH + 1 - blanks)
    let frameTop = computeFrameTop(freeBlanksAboveFrameRef.current)
    // Geometry trace — diagnostics for the "input box drifting / dialog
    // duplicate" symptom. Logs the inputs the bottom-anchor formula
    // depends on so we can see which render is the one that starts
    // shifting blanks. Cheap (no JSON.stringify of large structures), so
    // safe to leave on under DEBUG_STDOUT=1.
    debugLog(
      'chatinput.geom.in',
      `termRows=${termRows} oldFrameH=${oldFrameH} nextH=${nextH} ` +
        `blanks=${freeBlanksAboveFrameRef.current} frameTop=${frameTop} ` +
        `lastTop=${lastFrameTopRef.current} ` +
        `permission=${permission ? '1' : '0'} ` +
        `select=${selectRequest ? '1' : '0'} ` +
        `activeTools=${activeToolCalls?.length ?? 0} ` +
        `todos=${todos?.length ?? 0} ` +
        `spinner=${spinner ? '1' : '0'} ` +
        `didCommit=${messages.length > writtenMessageCountRef.current ? '1' : '0'}`,
    )

    // First render: seed the "blanks above frame" tracker. The banner
    // (initialContentRows) occupies the top of the viewport; everything
    // else up to where the frame sits is blank. Subsequent grows can
    // consume those blanks without pre-scrolling, so the banner stays
    // in view during normal operation.
    //
    // Post-/clear is also a first-paint (we reset activeRef above) but
    // the banner is gone — we just \x1b[2J'd the viewport — so reserving
    // initialContentRows here would leave a phantom banner-sized empty
    // strip at the top with the frame floating mid-screen. Treat the
    // entire viewport as free blanks instead, so the frame anchors at
    // row 1 with empty space below (the user's "fresh launch minus the
    // banner" expectation).
    if (justClearedRef.current) {
      freeBlanksAboveFrameRef.current = Math.max(0, termRows - nextH)
      frameTop = computeFrameTop(freeBlanksAboveFrameRef.current)
      justClearedRef.current = false
    } else if (isFirstPaint && initialContentRows > 0) {
      freeBlanksAboveFrameRef.current = Math.max(0, termRows - initialContentRows - nextH)
      // Re-seed frameTop now that freeBlanks is set so the very first
      // paint floats the frame up to sit immediately below the banner
      // instead of stranding it at the bottom of an otherwise-empty
      // terminal.
      frameTop = computeFrameTop(freeBlanksAboveFrameRef.current)
    }

    // ── Terminal resize: erase old frame at its previous position ────────
    //
    // When the terminal dimensions change, the old frame must be erased
    // before painting the new one.
    //
    // Height-only: the old frame position is predictable from oldTermRows.
    //
    // Width change: the terminal reflows ALL visible content. Old separator
    // lines (e.g. 120 '─' chars at old width) may wrap to multiple rows
    // when the terminal narrows, pushing them above where the new frame
    // will be painted. We must erase those reflowed remnants WITHOUT wiping
    // the scrollback content above (the user's conversation). Approach:
    // estimate how many extra rows the old frame now occupies after reflow,
    // then erase from (frameTop - extraRows) down to end of display.
    const oldTermRows = lastTermRowsRef.current
    const oldTermWidth = lastTermWidthRef.current
    const didResize =
      oldFrameH > 0 &&
      activeRef.current &&
      ((oldTermRows > 0 && oldTermRows !== termRows) || (oldTermWidth > 0 && oldTermWidth !== termWidth))
    if (didResize) {
      const widthChanged = oldTermWidth > 0 && oldTermWidth !== termWidth
      if (widthChanged) {
        // Estimate how many rows the old frame expanded to after reflow.
        // The old separator lines were (oldTermWidth - 1) chars each; after
        // reflow at the new termWidth, each wraps to ceil(oldChars / newW)
        // rows. The frame has 2 separators + (oldFrameH - 2) normal rows
        // (input, spinner, etc — those are short and don't wrap).
        const oldSepLen = Math.max(0, oldTermWidth - 1)
        const newW = Math.max(1, termWidth)
        const sepRowsAfterReflow = Math.ceil(oldSepLen / newW)
        // 2 separator rows expanded, the rest stayed at 1 row each
        const reflowedFrameH = oldFrameH - 2 + 2 * sepRowsAfterReflow
        const extraRows = Math.max(0, reflowedFrameH - oldFrameH)
        const eraseFrom = Math.max(1, frameTop - extraRows)
        preBuf += `\x1b[${eraseFrom};1H\x1b[J`
      } else {
        // Height-only change: use the actual last-rendered top (the
        // frame may have been floating before the resize, so the
        // bottom-anchor formula is no longer reliable).
        const oldFrameTop =
          lastFrameTopRef.current > 0 ? lastFrameTopRef.current : Math.max(1, oldTermRows - oldFrameH + 1)
        const eraseFrom = Math.min(oldFrameTop, frameTop)
        preBuf += `\x1b[${eraseFrom};1H\x1b[J`
      }
      // Resize invalidates the floating-frame state; the next render
      // re-seeds freeBlanks via the first-paint path or commit branch.
      freeBlanksAboveFrameRef.current = 0
      blankRowsAboveFrameRef.current = 0
      frameTop = computeFrameTop(0)
    }
    lastTermRowsRef.current = termRows
    lastTermWidthRef.current = termWidth

    // ── Scrollback-commit write (inline-stream) ──────────────────────────
    //
    // Writes new `content + frame` as ONE continuous stream starting at
    // row `startRow = termRows - scrollRows - nextH + 1`, ending exactly
    // at `termRows`. Rows that would be overwritten by the write AND
    // previously held real scrollback content are first pushed to the
    // terminal's real scrollback via pre-scroll `\n`s at screen bottom
    // (the only mechanism xterm.js / Windows Terminal honor for preserving
    // content — DECSTBM-restricted region scrolls are splice-discarded in
    // xterm.js's InputHandler, confirmed in source).
    //
    // Pre-scroll amount = (rows in [startRow, termRows] that were
    // above the old frame) = max(0, scrollRows + nextH - oldFrameH).
    // This is 0 on first-paint / post-hidden (oldFrameH = 0, no active
    // scrollback to preserve — pre-existing rows above stay put), it is
    // scrollRows in the steady-state active case, and scrollRows +
    // (nextH - oldFrameH) when the frame grows (e.g. spinner appearing
    // at user submission).
    //
    // After the pre-scroll, existing content rests at rows shifted up,
    // and the write zone [startRow, termRows] contains the bottom rows
    // of the old frame and the blanks just created by the pre-scroll —
    // safe to overwrite entirely. The write places new content at
    // rows [frameTop - scrollRows, frameTop - 1] and the new frame at
    // [frameTop, termRows].
    //
    // prevFrameRef is set to the just-written frame so the diff loop
    // below emits only cursor advances (no cell writes) — no separate
    // frame-redraw phase, no flicker.
    //
    // Cursor is hidden for the duration of the write.
    // Deferred-flush staging for freeBlanksAboveFrameRef. Two renders with
    // the same (oldFrameH → nextH) transition used to each apply `+=
    // deltaH` against the live ref before either one's stdout write ran —
    // so on a shrink that got re-rendered once before its deferred flush
    // fired, the blank-row credit doubled. Accumulating the target in a
    // local and committing it in doFlush makes the mutation idempotent:
    // every render of the same state computes the same target, only the
    // one whose payload actually writes applies it. Symptom it cured:
    // 3+ persistent blank lines appearing after every Bash approval.
    let pendingFreeBlanks = freeBlanksAboveFrameRef.current
    // Same idempotency story as pendingFreeBlanks above, but for the
    // blank-row-above-frame counter the shrink path may bump and the
    // grow path may consume. See blankRowsAboveFrameRef for the why.
    let pendingBlankRowsAbove = blankRowsAboveFrameRef.current
    const scrollRows = didCommitMessages ? countContentRows(scrollbackContent, termWidth) : 0
    let handledCommitWithFrame = false
    let forceFullRedraw = false
    if (didCommitMessages && scrollRows > 0 && nextH > 0 && nextH < termRows) {
      // Available rows we already "own" above the current frame: the old
      // frame itself (about to be overwritten) plus any blank rows left
      // by a recent shrink (dialog close). If the new content+frame fits
      // within that space, no full-screen scroll is needed. If it doesn't,
      // pre-scroll the shortfall into real terminal scrollback history.
      // Floating-frame model: freeBlanks always represents the budget of
      // re-usable rows below the frame (or above when frame is at the
      // bottom — same value, just placed differently). On first-paint
      // (oldFrameH = 0) it was just seeded from termRows-banner-nextH so
      // the very first commit can write content right after the banner
      // and leave the residual blanks below the frame.
      const freeBlanks = freeBlanksAboveFrameRef.current
      // Stranded blanks above the frame (left by a recent big shrink that
      // bottom-anchored the frame, e.g. permission dialog closing). They
      // are visible to the user as a blank gap between earlier scrollback
      // and the frame. Including them in availSpace lets startRow shift
      // upward so the committed content writes INTO those rows instead of
      // skipping over them — eliminating the gap. Without this, the
      // commit writes at termRows-oldFrameH-freeBlanks+1 and the rows
      // between viewport-top and that startRow stay blank forever.
      const blankAbove = blankRowsAboveFrameRef.current
      const availSpace = oldFrameH + freeBlanks + blankAbove
      // Cap pre-scroll to the actual count of viewport rows holding old
      // content above the frame (`termRows - availSpace`). The naive
      // `scrollRows + nextH - availSpace` overshoots whenever new content
      // exceeds what fits between the top of the viewport and the frame —
      // each \n past that point auto-scrolls a *blank* row into real
      // scrollback, leaving a visible gap of empty lines between the
      // user's previous history and the just-committed message. The
      // remaining shortfall is absorbed naturally by auto-scroll while
      // `scrollbackContent` is being written below (each wrapped line
      // beyond termRows triggers one row of LF-driven scroll, same
      // mechanism — just interleaved with content instead of upfront
      // blanks). Symptom this cures: long tool-result commits (e.g. a
      // ~115-row ExitPlanMode plan) leaving ~30 blank rows in scrollback
      // history above the rendered plan body.
      const maxUsefulPreScroll = Math.max(0, termRows - availSpace)
      const preScrollRows = Math.max(0, Math.min(scrollRows + nextH - availSpace, maxUsefulPreScroll))
      debugLog(
        'chatinput.geom.commit',
        `scrollRows=${scrollRows} nextH=${nextH} oldFrameH=${oldFrameH} ` +
          `availSpace=${availSpace} preScroll=${preScrollRows} ` +
          `freeBlanks=${freeBlanks} blankAbove=${blankAbove}`,
      )
      // Write scrollbackContent DIRECTLY after the last row of real
      // scrollback — this consumes the free-blank region row-by-row
      // instead of leaving it stranded as a visible gap between the
      // earlier history and the newly committed content.
      const startRow = Math.max(1, termRows - availSpace - preScrollRows + 1)
      // Rows still blank after this commit. These become the next
      // render's freeBlanks — either kept BELOW the frame (frame keeps
      // floating up) or implicitly consumed when the frame reaches the
      // bottom (freeBlanks = 0).
      const rawLeftover = Math.max(0, availSpace + preScrollRows - scrollRows - nextH)
      // When the frame shrank significantly (e.g. select/askUser dialog
      // closed), the old availSpace reflects the large dialog. Without
      // capping, leftoverBlanks can be 12+ rows, leaving the frame
      // floating at the top of the viewport with a huge blank gap below.
      // For large shrinks (> 3 rows), snap blanks to 0 so the frame
      // immediately anchors to the bottom. Small shrinks (≤ 3) use the
      // natural floor to let the floating-frame model consume blanks
      // gradually.
      const frameShrunk = oldFrameH - nextH
      const maxBlanks = frameShrunk > 3 ? 0 : termRows - nextH
      const leftoverBlanks = Math.min(rawLeftover, maxBlanks)
      pendingFreeBlanks = leftoverBlanks
      // Recompute frameTop now that pendingFreeBlanks reflects the
      // post-commit free-row budget. In the floating-frame model the
      // frame's top moves DOWN by scrollRows on every commit (until it
      // reaches the bottom and stays there) — the cell-diff loop and
      // the FULL-REDRAW path below both anchor at this updated value.
      frameTop = computeFrameTop(pendingFreeBlanks)
      // No `\x1b[?25l` here. Earlier revisions hid the cursor across the
      // scroll-clear-redraw window so its intermediate positions inside
      // the renderRowToAnsi loop wouldn't blink across rows on terminals
      // that don't fully atomize DEC 2026 — but at the 10-15Hz commit
      // cadence of streaming responses this produced exactly the same
      // hide/show flap that the spinner-tick path already removed for
      // the same reason (see comment at the top of this file). DEC 2026
      // sync on every target terminal (xterm.js / VSCode, Windows
      // Terminal, iTerm2, Ghostty) already buffers the intermediate
      // positions, and ESU_SHOW at the bottom of this render places the
      // cursor at the input column. Cursor stays visible throughout.
      // Two paths from here:
      //
      //   FULL-REDRAW PATH — used when (a) the new content forces a
      //     full-screen scroll (preScrollRows > 0) so the frame slid off
      //     the bottom and must be repainted at the new bottom, OR
      //     (b) the frame's height is changing this render (oldFrameH
      //     !== nextH), e.g. the spinner is appearing/disappearing or
      //     a permission dialog is opening/closing. Frame-height changes
      //     can't go through the optimization below because the cell-
      //     diff loop's `maxH = max(prevH, nextH)` then iterates past
      //     the new bottom row, triggering a `\x1b[1B\r` from the last
      //     terminal row and auto-scrolling the bottom separator out of
      //     view. Symptom this cured: the bottom `─────` row vanishing
      //     the moment an AI reply finished (frame went 4-row → 3-row
      //     at end-of-stream).
      //
      //   MINIMAL-WRITE PATH — used when the frame is stable in size
      //     AND no scroll is needed. Streaming responses spend almost
      //     all their commits here. Don't `[J]`-clear or repaint the
      //     frame at all; only clear the gap rows between scrollback
      //     and frame, and let the cell-diff loop below pick up genuine
      //     frame changes (typically just the 1-cell spinner glyph
      //     swap). This is what eliminates the visible wipe-and-repaint
      //     of the spinner / separator / input rows on every commit.
      const frameSizeChanged = oldFrameH !== nextH
      // Floating-frame model: any commit that moves the frame's top row
      // MUST go through FULL-REDRAW. The cell-diff loop further down
      // assumes the on-screen frame still matches prevFrameRef.current
      // — true when frame stayed put, false when it just moved. Without
      // this guard, after a commit the cell-diff would write the new
      // frame at the new frameTop while the old frame's cells are still
      // painted at the old position — leaving a phantom input box at
      // the old row.
      //
      // Two ways the frame can move on commit:
      //   (a) DOWN — freeBlanks (blank rows BELOW frame) was non-zero,
      //       gets partially consumed by `scrollRows`, frame floats
      //       toward the bottom.
      //   (b) UP — frame was bottom-anchored with blankAbove > 0 (e.g.
      //       a slash menu just shrunk), the commit writes scrollback
      //       INTO that blankAbove region (`startRow` shifts up), and
      //       the new frameTop ends up higher than where the frame
      //       currently sits.
      // The older check (`freeBlanks > 0`) only caught case (a). Case (b)
      // fell through to MINIMAL-WRITE, the old bottom-anchored frame was
      // never erased, and the user saw two stacked input boxes. We now
      // compare the just-computed `frameTop` to where the frame was
      // actually painted last (`lastFrameTopRef`) so both directions are
      // covered.
      const oldFrameTopForMoveCheck =
        lastFrameTopRef.current > 0 ? lastFrameTopRef.current : Math.max(1, termRows - oldFrameH + 1)
      const frameMoved = freeBlanksAboveFrameRef.current > 0 || oldFrameTopForMoveCheck !== frameTop
      if (preScrollRows > 0 || frameSizeChanged || frameMoved) {
        // FULL-REDRAW PATH.
        const oldFrameTopForClear =
          lastFrameTopRef.current > 0 ? lastFrameTopRef.current : Math.max(1, termRows - oldFrameH + 1)
        const oldFrameBottomForClear = Math.min(oldFrameTopForClear + oldFrameH - 1, termRows)
        if (preScrollRows > 0) {
          // Erase old frame BEFORE the pre-scroll LFs. After the LFs push
          // N viewport rows into the terminal's real scrollback history,
          // those rows become permanent — no ANSI escape can clear them.
          // If the old frame (with its Thinking/spinner line) sits at rows
          // that will be pushed above startRow by the scroll, the post-
          // scroll erase loop can't reach them and they persist as ghost
          // "Thinking..." lines in the user's scrollback. Erasing the
          // old frame here ensures only blank rows enter scrollback history.
          for (let r = oldFrameTopForClear; r <= oldFrameBottomForClear; r++) {
            preBuf += `\x1b[${r};1H\x1b[K`
          }
          // Push `preScrollRows` rows into the terminal's real scrollback
          // by emitting N LFs at the bottom row. This is the ONLY portable
          // mechanism that preserves displaced rows in scrollback history:
          // SU (`\x1b[NS`) and DECSTBM-restricted scrolls both shift cells
          // in the viewport but discard the rows that fall off the top
          // on Windows Terminal, ConHost, iTerm2, native macOS Terminal,
          // Ghostty, and Alacritty. (xterm.js was the one outlier where
          // SU sometimes lands in scrollback — an earlier revision of
          // this file used SU on that basis and silently swallowed the
          // overflow on every other target terminal: any AI reply taller
          // than the available rows above the frame lost its top lines.)
          // Auto-scroll triggered by LF at termRows is universally honored.
          preBuf += `\x1b[${termRows};1H` + '\n'.repeat(preScrollRows)
        }
        // After pre-scroll (or when no scroll needed), erase the viewport
        // rows that will hold new content. When preScroll happened, old
        // frame rows have already been blanked above; the post-scroll
        // viewport rows [startRow, termRows] are blank lines created by
        // the scroll. We still clear [startRow, clearEnd] to handle the
        // non-scroll cases (frameSizeChanged / frameMoved) where old frame
        // cells sit at their original positions.
        const clearEnd = preScrollRows > 0 ? termRows : oldFrameBottomForClear
        for (let r = startRow; r <= clearEnd; r++) {
          preBuf += `\x1b[${r};1H\x1b[K`
        }
        preBuf += `\x1b[${startRow};1H`
        preBuf += scrollbackContent
        // When the frame shrank significantly (e.g. askUser dialog closed),
        // scrollback content only fills a fraction of the space the old frame
        // occupied. Instead of anchoring the frame at the terminal bottom and
        // leaving a visible blank gap between scrollback and frame, place the
        // frame directly below the scrollback content. The remaining blank
        // rows below the frame are recorded in pendingFreeBlanks so
        // subsequent commits can consume them naturally (frame floats down
        // toward the bottom as new content arrives).
        //
        // Skip when blankAbove > 0: those stranded blanks were JUST consumed
        // (startRow shifted up to fill them), and the leftover space is the
        // budget the dialog grew into. Pulling the frame up to sit directly
        // below content would leave that leftover BELOW the frame — the
        // input bar floats in the middle of the viewport with empty rows
        // beneath it. Keep the frame bottom-anchored instead so the gap
        // stays where the dialog was, above the input bar (the familiar
        // bottom position) — visually the input stays at the terminal edge
        // and the gap is between the recent activity and the input row.
        if (preScrollRows === 0 && frameShrunk > 3 && leftoverBlanks === 0 && blankAbove === 0) {
          const scrollEndRow = startRow + scrollRows
          if (scrollEndRow < frameTop) {
            frameTop = scrollEndRow
            const belowFrame = Math.max(0, termRows - frameTop - nextH + 1)
            pendingFreeBlanks = belowFrame
          }
        }
        preBuf += `\x1b[${frameTop};1H`
        for (let i = 0; i < nextH; i++) {
          preBuf += renderRowToAnsi(frame[i]) + '\x1b[K'
          if (i < nextH - 1) preBuf += '\r\n'
        }
        prevFrameRef.current = frame
      } else {
        // MINIMAL-WRITE PATH (the dominant case during streaming).
        // Clear ONLY the rows in [startRow, frameTop), write scrollback
        // into them, and leave the frame area untouched. The cell-diff
        // loop below compares the unchanged on-screen frame against the
        // new frame and emits only the cells that actually differ
        // (spinner glyph, elapsed-time digits).
        for (let r = startRow; r < frameTop; r++) {
          preBuf += `\x1b[${r};1H\x1b[K`
        }
        preBuf += `\x1b[${startRow};1H` + scrollbackContent
        // Always park cursor at frameTop after scrollback write.
        // The cell-diff loop uses absolute positioning per row, but
        // an explicit jump prevents any cursor-position mismatch
        // from causing visual artifacts.
        preBuf += `\x1b[${frameTop};1H`
        // DON'T set prevFrameRef.current = frame here — the on-screen
        // frame is still the previous render's frame (we didn't repaint
        // it), and the cell-diff loop below needs to compare against
        // that to find the cells that genuinely changed.
      }
      handledCommitWithFrame = true
      // Commit just wrote `scrollRows` rows of scrollback content at
      // `startRow`, then placed the frame at `frameTop`. Any rows in
      // between are blank (the clear loop wiped them but no content
      // landed there — typically zero, or one when the special-block
      // path squashed the gap). Whatever it is, that's the new
      // contiguous-blank count directly above the frame; older blanks
      // farther up stop being "directly above" once committed content
      // sits between them and the frame, so they no longer interact
      // with the grow path's scroll-only-real-content logic.
      pendingBlankRowsAbove = Math.max(0, frameTop - (startRow + scrollRows))
    } else if (didCommitMessages) {
      // Plan b weak-terminal path: nextH=0 (frame was cleared by the
      // streaming bail-out above) but oldFrameH may still be > 0 — the
      // OLD frame is still painted on screen. If we let scrollbackContent
      // write first, its trailing `\r\n\r\n` triggers auto-scrolls at
      // termRows that push the OLD top-separator and OLD input row into
      // the terminal's scrollback history (visible as "horizontal line +
      // `> 查询…`" appearing above the AI response). The erase done by
      // the shrink path BELOW fires too late — it lands on the just-
      // shifted rows and erases the new echo instead.
      //
      // Fix: erase the OLD frame rows FIRST, here, before scrollbackContent
      // writes. With the frame area cleared, the echo's auto-scrolls push
      // BLANK rows into scrollback rather than old frame remnants, and
      // the echo lands cleanly. Mark handledCommitWithFrame so the shrink
      // path below doesn't double-erase.
      if (oldFrameH > 0 && nextH < oldFrameH && !permission) {
        // Use the actual previous frame top (floating-frame model means
        // the OLD frame may have sat above the bottom-anchor position).
        const oldTop = lastFrameTopRef.current > 0 ? lastFrameTopRef.current : Math.max(1, termRows - oldFrameH + 1)
        for (let i = 0; i < oldFrameH; i++) {
          preBuf += `\x1b[${oldTop + i};1H\x1b[K`
        }
        // Cursor sits at top of where the old frame was, so the echo
        // writes there instead of one row below the old input.
        preBuf += `\x1b[${oldTop};1H`
        pendingFreeBlanks = freeBlanksAboveFrameRef.current + oldFrameH
        frameTop = computeFrameTop(pendingFreeBlanks)
        debugLog(
          'chatinput.geom.commit-shrink-erase',
          `oldTop=${oldTop} oldFrameH=${oldFrameH} nextH=${nextH} ` +
            `blanks ${freeBlanksAboveFrameRef.current}->${pendingFreeBlanks} ` +
            `frameTop=${frameTop}`,
        )
        forceFullRedraw = true
        handledCommitWithFrame = true
      }
      // Account for streamed-content rows so freeBlanks tracks reality.
      // Plan b runs every render where messages committed but the frame
      // is hidden (nextH=0, the streaming bail-out) — i.e. on every chunk
      // of an AI reply. `scrollbackContent` is about to be written into
      // rows the renderer previously thought were blank (the `freeBlanks`
      // budget seeded from termRows-banner-frameH on first paint). Without
      // this decrement, freeBlanks stays at its initial value for the
      // entire response, so the FINAL render at end-of-stream (nextH:0→3,
      // takes the main FULL-REDRAW path) computes availSpace=oldFrameH+
      // freeBlanks=40, preScroll=0, and \x1b[J wipes the streamed body.
      // xterm.js / VSCode's terminal accidentally papered over this via
      // its own scrollback quirks (see SU comment around line 1932); on
      // ConHost / Windows PowerShell host / GNOME Terminal / xterm /
      // every other target, the body really did get wiped, leaving only
      // the last 1-2 lines above the input box once the spinner stopped.
      // Mirror of the leftoverBlanks bookkeeping the main commit path
      // does at line ~1869 — same idea, just applied on the Plan b side.
      if (scrollRows > 0) {
        const before = pendingFreeBlanks
        pendingFreeBlanks = Math.max(0, pendingFreeBlanks - scrollRows)
        frameTop = computeFrameTop(pendingFreeBlanks)
        debugLog(
          'chatinput.geom.commit-streaming',
          `scrollRows=${scrollRows} blanks ${before}->${pendingFreeBlanks} frameTop=${frameTop}`,
        )
      }
      preBuf += scrollbackContent
    }

    let buf = ''

    // Frame-height change: the frame is pinned to the bottom, so when
    // H grows, its top moves UP — risking overwrite of scrollback rows
    // that currently live there.
    //
    // Small grows (≤3 rows — spinner appearing, permission dialog) use
    // a full-screen scroll so the displaced content ends up preserved
    // in the terminal's real scrollback.
    //
    // Large grows (≥4 rows — SelectOptions picker, completion menu with
    // many items) are almost always sitting over blank rows in a typical
    // session (banner + some blanks + frame at bottom). Pre-scrolling
    // those blanks INTO real scrollback permanently consumes viewport
    // rows that the subsequent shrink can't recover — that's the
    // "after /model there's a big blank" complaint. We skip the
    // pre-scroll in this case and instead erase the grow area before
    // the cell diff repaints over it. When the frame shrinks back, the
    // existing erase branch below clears the expanded area and the
    // layout returns to exactly what it was before the grow.
    //
    // For shrinks, the bottom of the old frame stays exposed as "stale
    // frame cells" above the new top — clear those rows.
    if (!handledCommitWithFrame && activeRef.current && oldFrameH > 0 && oldFrameH !== nextH) {
      if (nextH > oldFrameH) {
        const deltaH = nextH - oldFrameH
        // Consume as much freshly-blank space below the frame as we can —
        // those rows can be overwritten without losing anything. Any excess
        // expansion exceeds the bottom blanks, so pre-scroll that much into
        // real scrollback to preserve content above (banner, earlier
        // messages). Without this, typing `/` to open the completion menu
        // would wipe whatever scrollback sat right above the input.
        const absorbed = Math.min(deltaH, freeBlanksAboveFrameRef.current)
        // Then consume any blank rows DIRECTLY above the frame (left
        // there by a prior large-shrink). The frame can extend up into
        // these rows via the cell-grid repaint without any LF scroll —
        // emitting LFs here would push the blanks into terminal
        // scrollback as a permanent gap (the symptom: a big stretch
        // of empty rows under a `Task()` line whenever sub-agents
        // open multiple permission dialogs in a row). Only the rows
        // BEYOND that blank zone are real content that genuinely needs
        // to be scrolled into history.
        const fromBlankAbove = Math.min(deltaH - absorbed, pendingBlankRowsAbove)
        pendingBlankRowsAbove -= fromBlankAbove
        const rawNeedsScroll = deltaH - absorbed - fromBlankAbove
        // Cap LF count to the rows of REAL CONTENT actually sitting above
        // the old frame. Without this cap, the slash menu's grow path
        // (e.g. nextH=22 in an 18-row terminal) would emit `deltaH - absorbed`
        // LFs at the bottom edge — but every LF beyond `oldTop - 1` is
        // scrolling a phantom row (frame extends upward off-screen) and
        // each phantom scroll pushes a BLANK row into terminal scrollback,
        // leaving visible empty lines between each /command's output.
        // The frame is allowed to clip at the top of the viewport (the
        // computeFrameTop floor is row 1); we don't need to "make room"
        // for the off-screen portion.
        //
        // We further subtract `blankRowsAboveFrameRef.current` because
        // those rows are blank already (a prior shrink left them) and
        // `fromBlankAbove` only consumed up to `deltaH - absorbed` of
        // them; any leftover blank rows above the frame would otherwise
        // be counted as "real content" by the `oldTop - 1` formula.
        const oldTop = lastFrameTopRef.current > 0 ? lastFrameTopRef.current : Math.max(1, termRows - oldFrameH + 1)
        const realContentAboveFrame = Math.max(0, oldTop - 1 - blankRowsAboveFrameRef.current)
        const needsScroll = Math.min(rawNeedsScroll, realContentAboveFrame)
        if (needsScroll > 0) {
          // Erase the old frame before scrolling so that blank rows — not
          // stale prompt/separator cells — get pushed into terminal scrollback.
          // Without this, the `> ▊` prompt line becomes a permanent ghost in
          // scrollback after the select dialog closes.
          for (let i = 0; i < oldFrameH; i++) {
            preBuf += `\x1b[${oldTop + i};1H\x1b[K`
          }
          preBuf += `\x1b[${termRows};1H` + '\n'.repeat(needsScroll)
        }
        pendingFreeBlanks = Math.max(0, freeBlanksAboveFrameRef.current - deltaH)
        // Recompute frameTop for the new (smaller) freeBlanks. With pure
        // absorb (no scroll), frameTop stays at the old top and the frame
        // grows downward. With scroll, frameTop drops to the bottom-anchor
        // position (newFreeBlanks=0).
        frameTop = computeFrameTop(pendingFreeBlanks)
        debugLog(
          'chatinput.geom.grow',
          `delta=${deltaH} absorbed=${absorbed} fromBlankAbove=${fromBlankAbove} ` +
            `scrolled=${needsScroll}${needsScroll !== rawNeedsScroll ? ` (capped from ${rawNeedsScroll}; realContent=${realContentAboveFrame})` : ''} ` +
            `blanks ${freeBlanksAboveFrameRef.current}->${pendingFreeBlanks} ` +
            `blankAbove ${blankRowsAboveFrameRef.current}->${pendingBlankRowsAbove} ` +
            `frameTop=${frameTop}`,
        )
        // Pre-erase the newly-occupied bottom-of-frame rows so any stale
        // cells (from prior renders or auto-scroll residue) don't bleed
        // through before the diff below repaints them.
        for (let i = 0; i < deltaH; i++) {
          preBuf += `\x1b[${frameTop + oldFrameH + i};1H\x1b[K`
        }
      } else {
        const deltaH = oldFrameH - nextH
        // Shrink: the frame got shorter (e.g. a select dialog closed).
        // Erase the ENTIRE old frame area so no ghost content remains
        // (old spinner rows, dialog options, etc.) and reposition the
        // frame near the bottom.
        //
        // Large shrinks (e.g. askUser dialog closing: 37→7) would
        // otherwise leave 26+ blank rows. The frame floats at row 1
        // and takes many commits to drift back down, leaving the user
        // staring at a mostly-blank screen. Cap blanks to 0 so the
        // frame snaps to the bottom immediately after a big shrink.
        // Small shrinks (≤3 rows, e.g. permission dialog closing) can
        // keep their blanks for the floating-frame model to consume
        // naturally — the gap is barely visible.
        const rawBlanks = freeBlanksAboveFrameRef.current + deltaH
        const MAX_SHRINK_BLANKS = deltaH > 3 ? 0 : termRows - nextH
        pendingFreeBlanks = Math.min(rawBlanks, MAX_SHRINK_BLANKS)
        const oldTop = lastFrameTopRef.current > 0 ? lastFrameTopRef.current : Math.max(1, termRows - oldFrameH + 1)
        frameTop = computeFrameTop(pendingFreeBlanks)
        debugLog(
          'chatinput.geom.shrink',
          `delta=${deltaH} blanks ${freeBlanksAboveFrameRef.current}->${pendingFreeBlanks} ` +
            `(raw=${rawBlanks}) ` +
            `oldTop=${oldTop} newTop=${frameTop}`,
        )
        // Erase the entire old frame area — not just the bottom delta
        // rows. When the frame moves from a high position (oldTop=3)
        // to near the bottom (frameTop=28), rows at the old position
        // must be cleared to prevent ghost spinners / stale content.
        for (let i = 0; i < oldFrameH; i++) {
          preBuf += `\x1b[${oldTop + i};1H\x1b[K`
        }
        // Large-shrink (deltaH > 3) snaps the frame to the bottom; the
        // rows between oldTop and the new frameTop are now blank but
        // never went to terminal scrollback. Track them so the next
        // grow can extend the frame back up via cell-grid repositioning
        // instead of LF auto-scrolls (which would push these blanks
        // into history). Small shrinks keep their freeBlanks below the
        // frame so frameTop stays put — `frameTop - oldTop` is 0 or
        // negative, yielding no contribution.
        if (frameTop > oldTop) {
          pendingBlankRowsAbove += frameTop - oldTop
        }
      }
      // Frame moved — prev cell matrix is at the wrong rows now; force
      // full redraw at the new position.
      // NOTE: do NOT mutate prevFrameRef.current here. This code runs
      // during payload construction, but for non-commit (deferred)
      // renders the doFlush that writes this payload to stdout may be
      // CANCELLED by a commit arriving 1-2 ms later. If we cleared
      // prevFrameRef now and the deferred is cancelled, the ref stays
      // [] while the on-screen frame is still the OLD frame — causing
      // the next render's cell-diff to treat every row as "fresh",
      // writing the full Thinking line at the NEW frameTop while the
      // OLD Thinking remains on screen at the OLD position → two
      // visible "Thinking…" lines.
      // Instead, use a local flag; doFlush (line below) sets
      // prevFrameRef = frame unconditionally after a successful write.
      forceFullRedraw = true
    }

    const prevFrame = forceFullRedraw ? [] : prevFrameRef.current
    const prevH = prevFrame.length
    const maxH = Math.max(prevH, nextH)

    // PER-ROW ABSOLUTE POSITIONING (Claude-Code style).
    //
    // Earlier code did `jump-to-frame-top, then walk-down each row with
    // \x1b[1B\r`. On a steady spinner tick only ONE cell in ONE row
    // actually differs, but the relative-walk approach emitted
    // `\x1b[1B\r` after every row regardless — moving the cursor through
    // every unchanged row of the frame on the way down, plus an initial
    // jump to frame-top, plus a final park to the cursor anchor. That's
    // 5+ cursor positions per tick and on terminals whose DEC 2026 sync
    // doesn't fully atomize cursor positions (Windows Terminal, VSCode
    // xterm.js, ConHost) every intermediate stop is processed by the
    // terminal's renderer — visible as a flicker even with the cursor
    // hidden, because each cursor-position command kicks the cell-render
    // pipeline.
    //
    // Per-row absolute (`\x1b[absRow;colH` only on rows we actually
    // write) means a stable spinner tick visits 2 cursor positions:
    // the spinner cell, and the final cursor-anchor park. Unchanged
    // rows are SKIPPED — no jump to them, no `\x1b[K`, no advance.
    for (let row = 0; row < maxH; row++) {
      const prevRow = row < prevH ? prevFrame[row] : []
      const nextRow = row < nextH ? frame[row] : []
      const absRow = frameTop + row

      if (row < nextH) {
        // First cell that differs from prevRow
        let diffIdx = 0
        const minCells = Math.min(prevRow.length, nextRow.length)
        while (diffIdx < minCells && cellsEqual(prevRow[diffIdx], nextRow[diffIdx])) {
          diffIdx++
        }
        // Last cell that differs (scanning from the end). On a fresh
        // redraw (prevRow empty) we keep emitting through end-of-row;
        // otherwise we cap at the last actual change so that, e.g., a
        // spinner tick rewrites just the glyph cell instead of the
        // entire " glyph  Thinking… (5s · ↑ 2k tokens)" suffix every
        // 80ms. Less to write = fewer visible cells re-painting per
        // tick = no perceptible flash on terminals where DEC 2026
        // sync-update isn't perfectly atomic.
        let endIdx = nextRow.length
        if (prevRow.length > 0 && nextRow.length === prevRow.length) {
          let last = nextRow.length - 1
          while (last >= diffIdx && cellsEqual(prevRow[last], nextRow[last])) {
            last--
          }
          endIdx = last + 1 // exclusive bound
        }

        // Force-clear branch: prevRow is empty AND nextRow is empty.
        // Normally an "empty stays empty" row is a no-op, but when the
        // upstream grow/shrink path resets prevFrameRef to [] to force a
        // full repaint, an empty row at this position can shadow stale
        // characters left on screen by the previous (taller) frame —
        // most visibly the input box's `─` top separator peeking through
        // a newly inserted blank between two parallel tool blocks. The
        // explicit \x1b[K wipes whatever the terminal still has at this
        // row before the redraw moves on.
        if (prevRow.length === 0 && nextRow.length === 0) {
          buf += `\x1b[${absRow};1H\x1b[K`
        } else if (diffIdx < nextRow.length || nextRow.length < prevRow.length) {
          // Absolute-position to (absRow, diffIdx's visual column).
          let col = 0
          for (let c = 0; c < diffIdx; c++) col += nextRow[c].width
          buf += `\x1b[${absRow};${col + 1}H`

          // Emit changed cells. Initialize lastStyle to S_NONE (= explicit
          // reset code) so the first cell's char doesn't inherit any SGR
          // state left over from the previous render — without this, the
          // diff loop's `if (cell.style !== lastStyle) buf += cell.style`
          // branch could emit '' (no-op) for an S_NONE cell whose char
          // then renders in whatever color was active before.
          let lastStyle = S_NONE
          buf += S_NONE
          for (let c = diffIdx; c < endIdx; c++) {
            const cell = nextRow[c]
            if (cell.style !== lastStyle) {
              buf += cell.style
              lastStyle = cell.style
            }
            buf += cell.char
          }
          buf += S_RESET
          if (prevRow.length === 0) {
            // Fresh redraw (post-eraseRegion or first paint). The row may
            // carry stale chars from scrollback writes that preceded this
            // frame (e.g. a CJK line whose width miscalculation bumped
            // residuals onto the spinner/input row). Erase to EOL so we
            // start from a clean line. We deliberately DON'T do this on
            // diff updates: the 80 ms spinner tick would then emit an
            // \x1b[K every frame, which visibly flickers on terminals
            // without full DEC 2026 sync-update support.
            buf += '\x1b[K'
          } else {
            // Diff update — pad with spaces when the old row was wider.
            // Invisible on terminals (no SGR change), so no flicker.
            let oldTailW = 0
            for (let c = diffIdx; c < prevRow.length; c++) oldTailW += prevRow[c].width
            let newTailW = 0
            for (let c = diffIdx; c < nextRow.length; c++) newTailW += nextRow[c].width
            if (oldTailW > newTailW) {
              buf += ' '.repeat(oldTailW - newTailW)
            }
          }
        }
        // else: row identical — skip without moving the cursor.
      } else {
        // Extra old row — absolute-position and blank it out.
        buf += `\x1b[${absRow};1H\x1b[K`
      }
    }

    // No cursor parking. The terminal cursor is hidden for the whole
    // life of the TUI (see the mount useEffect that emits `\x1b[?25l`),
    // so its position is invisible and doesn't matter for display. The
    // visual "input cursor" the user sees is the inverse-video cell on
    // the input row (S_CURSOR), drawn atomically by the cell-diff loop
    // above. Skipping the park removes one cursor-position command per
    // flush — on weak terminals each such command kicks the renderer's
    // state machine even when the cursor itself is hidden, so dropping
    // it visibly reduces residual flicker.

    // Flush everything as a single write: preBuf (BSU + DECSTBM scrollback
    // insertion + any frame-height-change scrolling) + frame diff + ESU.
    // One write() = one atomic paint on every terminal, not just those
    // with DEC 2026 support. NOTE: we no longer tack on SAVE_CURSOR (\x1b7)
    // at the end. That DEC save register is single-slot AND shared with
    // Ink's log-update internals, so our save was being clobbered on every
    // Ink tree reconcile. Instead we jump absolutely to (frameTop, 1) at
    // the start of every render — no cross-render cursor-state dependency.
    // ESU never carries a visibility command. The cursor is hidden for
    // the entire lifetime of this component (see the mount useEffect
    // above) and the input "cursor" is just an inverse-video cell on
    // the input row, drawn atomically with the rest of the frame. Per-
    // flush `?25h` / `?25l` toggling resets the cursor blink phase on
    // Windows Terminal and VSCode's xterm.js — that is the flicker
    // users were reporting at the rightmost typed column.
    const esu = '\x1b[?2026l'

    // Early-return for no-op flushes. When the spinner ticks but no
    // cell content has changed (preBuf empty after BSU, buf empty),
    // the wrapper alone (`?2026h` + `?2026l`, 16 bytes) is enough to
    // make the terminal re-process the sync window — and on weak
    // terminals this still resets the cursor blink phase, producing
    // the cursor flicker the user was seeing at 12 Hz. Skipping the
    // write entirely is the same trick Claude Code uses
    // (D:\res\claude-code\src\ink\ink.tsx:623, 668-671 — the
    // `hasDiff || targetMoved` early-return).
    if (preBuf === BSU && buf === '') {
      lastFlushTimeRef.current = Date.now()
      // Empty diff means the current render's frame matches what's
      // already on screen (prevFrameRef). If a deferred flush is
      // pending, it was scheduled by an earlier render whose frame
      // diverged from prevFrameRef — letting it fire now would draw
      // that intermediate state on top of the (already correct)
      // current frame. Concrete case: a fast read tool grew the frame
      // to 7 rows (deferred 8ms), then the result arrived and the
      // next render computed 5 rows — same as last actually-flushed,
      // so this empty-diff branch ran. Without the cancel below, the
      // 8ms deferred fired and painted the stale `● Read / ⎿ Running`
      // live indicator after the read had already finished, leaving
      // it stuck on screen until the next tool call's grow overwrote
      // it. Symptom users reported as "read tool appears then
      // disappears between consecutive reads".
      if (deferredFlushRef.current !== null) {
        clearTimeout(deferredFlushRef.current)
        deferredFlushRef.current = null
        debugLog('chatinput.flush.deferred-cancelled-empty', 'empty diff supersedes stale deferred')
      }
      // Still need to apply the pending blank-rows update; the
      // shrink path may have computed a new value.
      if (pendingFreeBlanks !== freeBlanksAboveFrameRef.current) {
        debugLog('chatinput.geom.persist-noop', `blanks ${freeBlanksAboveFrameRef.current}->${pendingFreeBlanks}`)
      }
      freeBlanksAboveFrameRef.current = pendingFreeBlanks
      if (pendingBlankRowsAbove !== blankRowsAboveFrameRef.current) {
        debugLog(
          'chatinput.geom.persist-noop',
          `blankAbove ${blankRowsAboveFrameRef.current}->${pendingBlankRowsAbove}`,
        )
      }
      blankRowsAboveFrameRef.current = pendingBlankRowsAbove
      return
    }

    const payload = preBuf + buf + esu
    debugLog(
      'chatinput.flush',
      `bytes=${payload.length} preBufBytes=${preBuf.length} bufBytes=${buf.length} msgsCommitted=${writtenMessageCountRef.current} pendingBlanks=${pendingFreeBlanks} frameTop=${frameTop} nextH=${nextH}`,
    )
    debugLog('chatinput.flush.payload', JSON.stringify(payload))

    // ── Anti-flicker write scheduling ──────────────────────────────────
    //
    // Fast tools (listDir, glob, readFile) complete in <5ms. React renders
    // frames back-to-back:
    //   Frame A (non-commit): shows "⠼ Running…" for the tool
    //   Frame B (commit, ~2ms later): replaces it with the result summary
    // Both are large redraws (~600-700 bytes). Painting both within one
    // vsync window (16ms) causes visible flicker/jitter.
    //
    // Strategy:
    //   • Commit frames (carrying new scrollback) write IMMEDIATELY — they
    //     cancel any pending deferred write since commits involve complex
    //     scroll/frame state that must be written atomically.
    //   • Non-commit frames are DEFERRED. Two windows:
    //       — Spinner ticks (spinnerFrame changed since last flush): 24ms.
    //         A wider window so a useStreamBuffer 150ms-drain commit
    //         landing 1-20ms after the spinner tick supersedes the
    //         spinner-only write instead of producing a back-to-back
    //         spinner-cell + commit pair (the visible "tick + content
    //         scroll-in" flicker observed during long streaming
    //         responses).
    //       — Everything else (typing, content changes that didn't tick
    //         the spinner): 8ms. Held-down letter keys produce one
    //         non-commit render per keystroke; a wider window here
    //         visibly stutters under continuous typing because each
    //         keystroke's deferred-fire happens on the wider cadence
    //         instead of feeling immediate.
    //     If a commit arrives during the deferred window, the deferred
    //     frame is discarded and only the commit is painted.
    //   • Additionally, non-commit frames within 16ms of the last write
    //     are dropped entirely (spinner coalescing).

    const doFlush = () => {
      const ok = process.stdout.write(payload)
      if (!ok) debugLog('chatinput.flush.backpressure', 'process.stdout.write returned false')
      lastFlushTimeRef.current = Date.now()
      lastFlushedSpinnerFrameRef.current = spinner != null ? spinnerFrame : null
      prevFrameRef.current = frame
      lastFrameHRef.current = nextH
      lastFrameTopRef.current = frameTop
      // Bytes are now on stdout. Drop the ref so the next render doesn't
      // re-emit them. Setting to '' (rather than slicing scrollbackContent
      // off the front) is safe: any render that mutates the ref between
      // scheduling and firing this throttled doFlush would have entered
      // the commit branch (didCommitMessages || hasNewMessages) and
      // cancelled this throttle in line 3235's `clearTimeout`, replacing
      // it with a fresh throttle whose payload includes the new bytes.
      pendingScrollbackRef.current = ''
      if (pendingFreeBlanks !== freeBlanksAboveFrameRef.current) {
        debugLog(
          'chatinput.geom.persist',
          `blanks ${freeBlanksAboveFrameRef.current}->${pendingFreeBlanks} ` + `frameTop=${frameTop} nextH=${nextH}`,
        )
      }
      freeBlanksAboveFrameRef.current = pendingFreeBlanks
      if (pendingBlankRowsAbove !== blankRowsAboveFrameRef.current) {
        debugLog(
          'chatinput.geom.persist',
          `blankAbove ${blankRowsAboveFrameRef.current}->${pendingBlankRowsAbove} ` +
            `frameTop=${frameTop} nextH=${nextH}`,
        )
      }
      blankRowsAboveFrameRef.current = pendingBlankRowsAbove
      // Bump the generation. Any pending deferred-flush macrotask whose
      // captured flushId now differs from this value will short-circuit
      // when it runs — see the schedule path below.
      flushGenRef.current++
    }

    // `hasNewMessages` (not `didCommitMessages`) drives the scheduler:
    // a render that processed new messages — even if every one got
    // buffered by the read-group collapser and produced zero scrollback
    // bytes — is still "real" state change and must paint promptly.
    // Without this, the post-result render of a buffered read tool
    // takes the deferred path (160ms delay) and the previous render's
    // grow-frame (the `● Read(file) / ⎿ Running…` live indicator) sits
    // staged in the deferred timer. It fires later — long after the
    // read actually finished — leaving a stale live indicator on screen
    // until the next read's grow overwrites it. Visible symptom users
    // reported: the `● Read` row "appears then disappears" between
    // consecutive read tools.
    if (didCommitMessages || hasNewMessages) {
      if (deferredFlushRef.current !== null) {
        clearTimeout(deferredFlushRef.current)
        deferredFlushRef.current = null
        debugLog('chatinput.flush.deferred-cancelled', 'commit superseded deferred frame')
      }
      // Newer commit's payload (incl. fresher scrollback + spinner glyph)
      // supersedes any previously throttled commit.
      if (commitThrottleRef.current !== null) {
        clearTimeout(commitThrottleRef.current)
        commitThrottleRef.current = null
        debugLog('chatinput.flush.commit-throttle-superseded', 'newer commit replaces throttled')
      }
      const dt = Date.now() - lastFlushTimeRef.current
      // Minimum gap between consecutive stdout writes. Two writes inside
      // the same terminal paint window (~16ms vsync) appear as flicker
      // even when each is wrapped in BSU/ESU — DEC 2026 sync is per-write
      // atomic but doesn't span writes. Most common cause: a 160ms spinner
      // deferred-fire (T) followed by a useStreamBuffer drain commit
      // (T+10–50ms). Throttling the commit to land ≥50ms after the last
      // write puts it in a fresh paint cycle. 50ms = ~3 vsyncs, enough
      // headroom on terminals that buffer multiple frames.
      const MIN_COMMIT_GAP_MS = 50
      if (lastFlushTimeRef.current > 0 && dt < MIN_COMMIT_GAP_MS) {
        const delay = MIN_COMMIT_GAP_MS - dt
        const capturedGen = flushGenRef.current
        commitThrottleRef.current = setTimeout(() => {
          commitThrottleRef.current = null
          if (flushGenRef.current !== capturedGen) {
            debugLog(
              'chatinput.flush.commit-throttled-stale',
              `gen ${capturedGen}->${flushGenRef.current}, skipping stale flush`,
            )
            return
          }
          doFlush()
          debugLog('chatinput.flush.commit-throttled-fired', `delay=${delay}ms`)
        }, delay)
        debugLog('chatinput.flush.commit-throttled', `delay=${delay}ms dt=${dt}ms`)
      } else {
        doFlush()
      }
    } else {
      // A throttled commit is in flight. If this non-commit frame has a
      // DIFFERENT height (dialog opening/closing, error row, etc.) it
      // supersedes the throttled commit — cancel the stale throttle and
      // let this frame through immediately. Height-preserving frames
      // (spinner ticks) can safely wait.
      if (commitThrottleRef.current !== null) {
        const heightChanged = nextH !== lastFrameHRef.current
        if (!heightChanged) {
          debugLog('chatinput.flush.deferred-skipped', 'commit throttle pending')
          return
        }
        clearTimeout(commitThrottleRef.current)
        commitThrottleRef.current = null
        debugLog(
          'chatinput.flush.commit-throttle-superseded-by-height',
          `nextH=${nextH} lastH=${lastFrameHRef.current}`,
        )
      }
      const now = Date.now()
      // Only coalesce identical-height frames (spinner ticks, single-cell
      // input edits). A frame-height change signals a structural update —
      // dialog opening/closing, error row appearing, etc. — and must paint
      // even when it lands within 16ms of the previous write. Coalescing
      // a height-changing frame used to strand the UI on the old frame
      // when the event that triggered it (e.g. stream end → permission
      // prompt render) also happened to be the last thing that would ever
      // re-render: the spinner interval clears on `spinner === null`, no
      // further React ticks arrive, and the dropped payload carrying the
      // prompt is never retried. Symptom: tool-call row stuck showing
      // "⠴ Running... (↓ N tokens)" forever with frozen input.
      const isSpinnerTick = nextH === lastFrameHRef.current
      // True when this render's only meaningful change is the spinner
      // glyph cycling — content/text/dialogs are unchanged. We can be
      // far more aggressive about dropping these because the next commit
      // will repaint the entire frame anyway, picking up the latest
      // spinner glyph as part of the full redraw.
      const spinnerTicked = spinner != null && spinnerFrame !== lastFlushedSpinnerFrameRef.current
      // Coalesce. Only drop back-to-back same-height frames within a
      // single terminal refresh window (16ms) — anything wider gets
      // through. The job of preventing spinner-vs-commit flicker is
      // handed to the deferred-fire mechanism below: a wide spinner
      // deferMs lets in-flight commits clearTimeout the deferred,
      // turning would-be near-collisions into single commit-only
      // writes. We deliberately do NOT coalesce against commit time
      // here — that approach (drop spinner-only frames during
      // streaming) tied the spinner glyph to commit cadence, which is
      // visibly jittery at the variable 50-300ms gaps that
      // useStreamBuffer's COMMIT_BATCH_MS produces.
      const coalesceWindow = 16
      const dt = now - lastFlushTimeRef.current
      if (isSpinnerTick && dt < coalesceWindow) {
        debugLog('chatinput.flush.coalesced', `dt=${dt}ms spinner=${spinnerTicked ? 1 : 0}`)
        return
      }
      if (deferredFlushRef.current !== null) {
        clearTimeout(deferredFlushRef.current)
      }
      // Spinner ticks defer 160ms. Rationale:
      //   - useStreamBuffer drains 150ms after a chunk queues, then a
      //     React render scheduling adds ~10ms before our commit lands.
      //     A 160ms defer lets that drain-driven commit reliably hit
      //     the clearTimeout above BEFORE our spinner-only write fires,
      //     collapsing the spinner+commit pair into a single commit-only
      //     write (the commit's full-frame redraw repaints the spinner
      //     glyph anyway).
      //   - Previous value was 100ms. Symptom: spinner outer-enter at
      //     queue+42ms → defer fires at queue+142ms; drain commit at
      //     queue+160ms — spinner wrote 18ms before commit, two stdout
      //     writes per vsync = visible flicker.
      //   - Must remain strictly less than the 200ms spinner-tick
      //     interval — at ≥200ms a back-to-back tick would re-arm the
      //     timer perpetually and the spinner would freeze.
      // Typing edits keep the original 8ms so held-key echo stays snappy.
      const deferMs = spinnerTicked ? 160 : 8
      // Capture flush generation at SCHEDULE time. If a commit-path
      // doFlush() runs before our timer fires, flushGenRef advances and
      // our deferred frame becomes stale (its cells were built from a
      // pre-commit React state). setImmediate yields one Node tick so
      // any React commit queued in the same macrotask flushes first;
      // the staleness check then short-circuits us.
      const flushId = flushGenRef.current
      deferredFlushRef.current = setTimeout(() => {
        deferredFlushRef.current = null
        setImmediate(() => {
          if (flushId !== flushGenRef.current) {
            debugLog('chatinput.flush.deferred-stale', `flushId=${flushId} gen=${flushGenRef.current}`)
            return
          }
          doFlush()
          debugLog('chatinput.flush.deferred-fired', `delayed=${deferMs}ms`)
        })
      }, deferMs)
      debugLog('chatinput.flush.deferred', `non-commit frame deferred ${deferMs}ms`)
    }
  })

  // Unmount cleanup
  useEffect(() => {
    return () => {
      if (deferredFlushRef.current !== null) {
        clearTimeout(deferredFlushRef.current)
        deferredFlushRef.current = null
      }
      if (commitThrottleRef.current !== null) {
        clearTimeout(commitThrottleRef.current)
        commitThrottleRef.current = null
      }
      if (activeRef.current) {
        eraseRegion()
        activeRef.current = false
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ChatInput renders nothing through Ink — the full bottom region is
  // owned by direct stdout writes inside the useEffect above.
  return null
}
