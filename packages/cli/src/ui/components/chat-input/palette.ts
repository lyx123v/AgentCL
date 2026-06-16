// ChatInput 直接写 stdout 的 cell-diff 渲染器所使用的样式色板。
//
// 这里必须硬编码 RGB ANSI 转义序列，因为 Cell 里存的是原始样式字符串，
// cell-diff 发射器不能现场跑 chalk。各个值和 `ui/theme.ts` 保持一致，而
// `ui/theme.ts` 又对齐 Claude Code 的深色主题（`src/utils/theme.ts` 的 darkTheme）。
// 这两张表必须同步维护，否则 committed 文本和 live 渲染会出现明显色差。

export const S_GRAY = '\x1b[38;2;136;136;136m' // promptBorder rgb(136,136,136) #888888
export const S_ACCENT = '\x1b[38;2;215;119;87m' // claude rgb(215,119,87) #d77757
export const S_ACCENT_DIM = '\x1b[38;2;153;153;153m' // inactive rgb(153,153,153) #999999
export const S_SPINNER = '\x1b[38;2;147;165;255m' // claudeBlue rgb(147,165,255) #93a5ff
export const S_SUCCESS = '\x1b[38;2;78;186;101;1m' // success rgb(78,186,101) #4eba65
// SUCCESS 的非粗体版本。用于 live 工具行里的 `●` 圆点，目的是和
// 已提交到 scrollback 的 `stdout-writer.formatToolCall` 输出完全一致。
// 那边 `c.hex(SUCCESS)('●')` 本来就是非粗体；如果 live 先用粗体，
// 工具结束切换到 committed 行时，圆点会肉眼可见地“从粗体变普通体”。
export const S_SUCCESS_DOT = '\x1b[0m\x1b[38;2;78;186;101m'
// 正在运行的工具圆点动画里使用的“暗一档”版本。
// 它和 S_SUCCESS_DOT 颜色相同，只是在 ANSI 上叠加了 dim 属性 (2)，
// 这样终端会把它渲染成同色系的更弱亮度，而不是换成另一种颜色。
// 每隔几个 spinner frame 在它和 S_SUCCESS_DOT 之间切换，就能得到 Claude Code
// 常见的明↔暗“心跳”效果，用户一眼就能看出哪一条已提交记录正处于 live 状态。
export const S_SUCCESS_DOT_DIM = '\x1b[0m\x1b[38;2;78;186;101;2m'
// 只有粗体、没有前景色。要和已提交态里的 `c.bold(label)` 保持一致。
// 必须以 `\x1b[0m` 开头，先清掉之前 cell 留下的前景色，否则粗体会继承
// 前一个 cell 的颜色，效果就会飘。
export const S_BOLD = '\x1b[0m\x1b[1m'
// BLUE_PURPLE（permission #99ccff）用于 live tool bubble 里的 `(preview)`，
// 目的是和 committed 态的 `c.hex(BLUE_PURPLE)('(...)')` 完全一致。
// 之前这里误用了 S_SPINNER 那种蓝色 (147,165,255)，色相不同，
// live → committed 切换时会出现很明显的跳色。
export const S_BLUE_PURPLE = '\x1b[0m\x1b[38;2;153;204;255m'
export const S_BLUE_PURPLE_BOLD = '\x1b[0m\x1b[38;2;153;204;255;1m'
export const S_WARNING = '\x1b[38;2;255;193;7m' // warning rgb(255,193,7) #ffc107
export const S_WARNING_BOLD = '\x1b[38;2;255;193;7;1m'
export const S_ERROR_BOLD = '\x1b[38;2;255;107;128;1m'
// 注意：前面的 `\x1b[0m` 很关键。单独的 `\x1b[2m` 只会在当前前景色上
// 再叠一层 dim 属性，不会清掉已有颜色。于是如果 meta 文本接在一段带色
// 的内容后面渲染（比如 spinner 行里，前面刚发过 S_SPINNER 蓝色），
// 就会变成“蓝色 + dim”，而不是我们想要的“灰色 + dim”。
// 另一方面，在某些 spinner tick 里如果只有秒数字段变化，diff loop 会先
// 输出 S_NONE（reset），再从秒数字开始输出 S_DIM，于是同一段 meta 文字又会
// 被重绘成“白色 + dim”。结果就是 meta 会随着 diff 路径不同在白/蓝之间闪。
// 先 reset 再 dim，可以把颜色固定回终端默认色，避免这个抖动。
export const S_DIM = '\x1b[0m\x1b[2m'
// ANSI 90（bright black）。等价于 chalk 里的 `c.gray()` 输出。
// `c.gray('⎿')` 会发出 `\x1b[90m...\x1b[39m`。凡是必须在视觉上和
// 已提交滚动区里的 `c.gray()` 字符一致的 cell，都应该用这个值
// （目前主要是 `⎿` 连接符和工具行里的 `(duration)` 后缀）。
// `S_DIM`（`\x1b[2m`，在默认前景上加 dim 属性）在大多数终端里
// 都会渲染成和 `\x1b[90m` 明显不同的灰度；工具结束、行从 live 变成
// scrollback 的瞬间，用户就会看到一次颜色闪烁。
export const S_GRAY_90 = '\x1b[0m\x1b[90m'
// S_NONE 表示“默认样式 - 没有前景色，也没有属性”，而且它必须是
// 一个非空 escape。否则 cell-diff loop 里这段逻辑：
// `if (cell.style !== lastStyle) buf += cell.style`
// 就会拼出空字符串，终端会继续沿用前面留下来的 SGR 状态。
// 以前这会把类似下面这样的行渲染坏：
// `[' '(NONE)][glyph(BLUE)][' '(NONE)][T(BLUE)]…`
// 最后的 NONE 空格会继承 BLUE；在非原子刷新的终端里，用户还能看到
// “Thinking” 文本在帧与帧之间白→蓝闪一下，因为冗余的 SGR 指令是在
// 字符后面才到的。把 S_NONE 设成显式的 DEC reset (`\x1b[0m`，和 S_RESET
// 同字节)，就能让每个 NONE cell 在自己的 glyph 之前先清空样式，
// 彻底去掉这种继承和闪烁。
// 行尾要重置所有属性（`\x1b[0m`），而不只是前景色（`\x1b[39m`）。
// 否则粗体 cell（例如 Permission 的 Yes/No 高亮）会把粗体属性泄漏到下一行。
// cell-diff 发射器会在下一行的第一个 cell 重新发出任何非空样式，所以这里
// 做完整 reset 是安全的。
export const S_RESET = '\x1b[0m'
export const S_NONE = '\x1b[0m'
// 反显块，用来把输入光标的位置“涂”成一个普通 cell。
// 真实终端光标在整个应用里都是隐藏的（见组件挂载时的 useEffect），
// 所以用户眼里看到的“光标”其实就是这里画出来的这个方块。
// 它会和 cell-diff 帧里的其他内容一起原子更新，因此不会单独抖动。
// 这个做法和 Gemini CLI 的 `<Text terminalCursorFocus>` 类似（在光标位画
// 一个反显块），也沿用了 Claude Code 的隐藏系统光标策略。
export const S_CURSOR = '\x1b[7m'

// 注意：本文件里刻意完全不使用 `\x1b7` / `\x1b8`（DECSC / DECRC）。
// 终端只提供一个保存寄存器，而 Ink 自己的 log-update 在每次渲染时也会复用它；
// 两边同时占用同一份状态，会制造出“幽灵恢复位置”。我们改为用相对移动
// （CUU / CUD / \r / `\x1b[NG` 绝对列）来重建光标位置，并且把对话框关闭后的
// 过渡当成一次全新的首帧绘制（清空 prevFrameRef），这样就彻底消除了多写者
// 争用。关于这个过渡态的处理逻辑，可以看 ChatInput 里的 wasHidden 处理器。

/** DEC 2026 的 “Synchronized Update Mode”。
 *  在 BSU 和 ESU 之间，受支持的终端会把所有输出先缓冲起来，
 *  再一次性作为原子帧渲染出来。这样就能消掉 eraseRegion 清空画面
 *  到后续整帧重绘之间那一下闪白，用户只会看到最终状态，看不到中间的
 *  空白区域。
 *  不支持的终端会静默忽略这些序列。
 *
 *  这里刻意不在每次渲染前后切换光标可见性。
 *  早期版本曾在 BSU 时发 `\x1b[?25l`、在 ESU 时发 `\x1b[?25h`，
 *  用来遮住那些没有完全原子化 DEC 2026 的终端上的中间光标位置。
 *  但在 80ms spinner 节奏下，这会产生 12Hz 的 hide/show 抖动，
 *  用户会感觉输入行附近在“上下抖动”。而我们目标的终端
 *  （xterm.js / VSCode、Windows Terminal、iTerm2、Ghostty）本来就已经
 *  能通过 sync-mode batching 隐藏中间态了。所以现在的策略是：
 *  光标全程保持可见，atomicity 交给 sync mode 处理；在 ESU 提交前，
 *  把光标停在输入列上。若没有 active anchor（禁用 / 对话框态），
 *  则由 ESU_HIDE 显式隐藏。 */
export const BSU = '\x1b[?2026h'
export const ESU_HIDE = '\x1b[?2026l\x1b[?25l'

// 注意：这里曾短暂放过一个基于 DECSTBM 的 `buildInsertHistoryAbove`
// 实现（参考 codex-rs 的 insert_history.rs），但后来回滚了，因为它要求
// cell buffer 必须锚定在终端最底部。codex-rs 里这成立（ratatui 的 Terminal
// 自己管理 viewport rect），但我们的布局不一样：banner + 部分滚动状态
// 可能让 cell buffer 停在屏幕中间。此时再设置 scroll region
// `[1, termRows - cellBufH]` 就会和 live cell buffer 行重叠，导致历史输出
// 直接穿透当前帧。要把这个方案真正做对，需要先重构成“每次渲染都通过绝对
// 光标定位强制把 cell buffer 放到终端最后 N 行”。
