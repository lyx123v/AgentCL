// @x-code-cli/cli - 将 writeFile / edit 的 diff payload 渲染为 ANSI 文本。
//
// 输出结果是一个多行字符串，直接交给 scrollback writer 使用。整体布局
// 对齐 Claude Code 的 StructuredDiff：每一行都有独立的 gutter，包含右对
// 齐的行号和符号位，然后是经过语法高亮的代码；代码再补齐到整列宽度，
// 让红 / 绿背景能一直铺到最右侧。
//
// 每一行都会加上 RESULT_INDENT，这样 diff 会紧贴在 tool-call bullet
// 的下方显示（scrollback 中的结构是 `   ⎿  Added X lines, removed Y`
// 这一行标题，下面再接 6 个空格缩进的 diff 正文）。
//
// 两条渲染路径共用同一套 gutter / 列宽 / 高亮流水线：
//   - 更新路径 (`renderHunks`)：hunk 行带绿色 / 红色背景和符号位
//   - 创建路径 (`renderCreatePreview`)：只展示新内容的前 N 行，
//     不加 diff 背景（整个文件都“新建”时，给每一行都刷背景只会
//     增加视觉噪音），但仍保留相同的语法高亮和 gutter 风格。
import { Chalk } from 'chalk'

import type { EditDiffHunk, EditDiffPayload } from '@x-code-cli/core'

import { type SyntaxThemeName, applyColor, detectLanguage, highlightLine } from './syntax-highlight.js'
import { sliceByWidth, visualWidth } from './text-width.js'
import { type ThemeName, getThemeColors } from './theme.js'
import { RESULT_INDENT } from './utils.js'

const c = new Chalk({ level: 3 })

/** 将主题的 diff 背景色应用到文本上。这里支持三种值形态：
 *   - `'#rrggbb'`：真彩色十六进制色值，走 chalk.bgHex
 *   - `'ansi:default'`：保持背景不变，也就是终端默认背景。
 *     纯 ANSI 主题会用这个值，并依赖有颜色的 DECORATION 前景色
 *     来标识 `-` 行；如果继续刷背景色，会把用户终端原本的背景
 *     直接盖掉。
 *   - `'ansi:green'` / `'ansi:red'`：命名 ANSI 背景色（目前还没
 *     实际用上，但保留是为了兼容性和可读性）。 */
function applyBg(text: string, color: string): string {
  if (color === 'ansi:default') return text
  if (color.startsWith('ansi:')) {
    const name = color.slice(5)
    if (name === 'green') return c.bgGreen(text)
    if (name === 'red') return c.bgRed(text)
    if (name === 'blue') return c.bgBlue(text)
    if (name === 'yellow') return c.bgYellow(text)
    return text
  }
  return c.bgHex(color)(text)
}

/** 将主题的 gutter（行号 + 符号位）前景色应用到文本上。逻辑和
 *  applyBg 对称，只不过这是前景色版本。Claude Code 会把 gutter
 *  画成更饱和的装饰色，这样行号列能从接近黑色的背景里“浮出来”；
 *  如果不这么做，"1 +" 这类内容会直接和 diff 背景融在一起。 */
function applyGutterFg(text: string, color: string): string {
  if (color === 'ansi:green') return c.green(text)
  if (color === 'ansi:red') return c.red(text)
  if (color === 'ansi:blue') return c.blue(text)
  if (color === 'ansi:yellow') return c.yellow(text)
  if (color.startsWith('#')) return c.hex(color)(text)
  return text
}

/** 限制单个 diff 正文的高度。多 hunk、上百行的 patch 在 scrollback
 *  里并不实用（用户大概率会直接滚过去），所以超过上限后会折叠成
 *  `… +N more lines` 这一行。
 *  这和 Claude Code 对长 StructuredDiff 的裁剪方式保持一致。 */
const MAX_DIFF_LINES = 60

/** create 模式下内容预览的最大行数。Claude Code 的
 *  FileWriteToolCreatedMessage 使用 MAX_LINES_TO_RENDER = 10；
 *  我们沿用同样的数量，这样新建的 package.json / 配置文件会露出
 *  足够多的上下文，但又不会把 scrollback 整个占满。 */
const MAX_CREATE_PREVIEW_LINES = 10

/** 格式化数量汇总行（例如 "Added 3 lines, removed 1 line"）。 */
function formatCounts(p: EditDiffPayload): string {
  if (p.isCreate) {
    const n = p.additions
    return `Created ${c.bold(String(n))} ${n === 1 ? 'line' : 'lines'}`
  }
  const parts: string[] = []
  if (p.additions > 0) {
    parts.push(`Added ${c.bold(String(p.additions))} ${p.additions === 1 ? 'line' : 'lines'}`)
  }
  if (p.removals > 0) {
    const verb = parts.length > 0 ? 'removed' : 'Removed'
    parts.push(`${verb} ${c.bold(String(p.removals))} ${p.removals === 1 ? 'line' : 'lines'}`)
  }
  if (parts.length === 0) return 'No changes'
  return parts.join(', ')
}

/** 取所有 hunk 中最大的可见行号，这样每个 gutter 的宽度都一致，
 *  从而让不同 hunk 之间的符号列保持对齐。 */
function maxLineNumber(hunks: EditDiffHunk[]): number {
  let max = 1
  for (const h of hunks) {
    const o = h.oldStart + h.oldLines - 1
    const n = h.newStart + h.newLines - 1
    if (o > max) max = o
    if (n > max) max = n
  }
  return max
}

/** 遍历 hunk 的 `lines` 数组，为每一行分配它在文件中的相对行号。
 *  这里遵循标准 unified diff 约定：`-` 行按旧文件编号，`+` 行和
 *  上下文行按新文件编号。两个计数器各自独立递增，所以连续删除行
 *  也能拿到各自不同的旧文件行号。 */
function numberLines(h: EditDiffHunk): { sigil: ' ' | '+' | '-'; code: string; lineNum: number }[] {
  const out: { sigil: ' ' | '+' | '-'; code: string; lineNum: number }[] = []
  let oldN = h.oldStart
  let newN = h.newStart
  for (const raw of h.lines) {
    const sigil = raw[0] === '+' ? '+' : raw[0] === '-' ? '-' : ' '
    const code = raw.slice(1)
    if (sigil === '-') {
      out.push({ sigil, code, lineNum: oldN })
      oldN++
    } else if (sigil === '+') {
      out.push({ sigil, code, lineNum: newN })
      newN++
    } else {
      out.push({ sigil, code, lineNum: newN })
      oldN++
      newN++
    }
  }
  return out
}

/** 截断单行代码，让最终渲染出来的 row 能塞进列宽。
 *  可用宽度 = 终端总宽度 - 缩进 - gutter。截断位置用 UTF 省略号
 *  标记，和 tool-input 预览保持一致。
 *
 *  这里的“能否放得下”以及“截到哪里”为都按视觉列宽计算，而不是
 *  按 JS 字符串长度计算。CJK / 全角字符占 2 个 cell，但 `length`
 *  只算 1；如果直接用长度判断，一个 50 字中文行可能会被误判为
 *  能放进 100 列，实际却已经超出 50 列，终端就会在行中间换行，
 *  于是每一条 diff 行下面都会多出一个莫名其妙的空白行。 */
function fitCode(code: string, width: number): string {
  if (visualWidth(code) <= width) return code
  if (width < 1) return ''
  return sliceByWidth(code, Math.max(0, width - 1)) + '…'
}

/**
 * 渲染 diff 正文。返回 N 行字符串（不带开头或结尾换行）。
 * 每一行都已经包含 RESULT_INDENT。
 *
 * `terminalWidth` 是终端总宽度 - 函数会先扣掉 RESULT_INDENT.length
 * 个 cell，再用剩余空间计算 gutter + code 的列宽。如果终端宽度
 * 不可用或数值异常，则回退到 120。
 */
function renderHunks(
  payload: EditDiffPayload,
  terminalWidth: number,
  syntaxTheme?: SyntaxThemeName,
  /** 从哪个 UI theme 读取 diff 背景色。
   *  `undefined` → 使用模块级当前激活主题（真实渲染时走这里）。
   *  `/theme` 选择器在构建预览时会传入每个候选主题的名字，这样
   *  用户就能并排看到每个主题真实的 diff 颜色。 */
  uiTheme?: ThemeName,
): string[] {
  const themeColors = getThemeColors(uiTheme)
  // 通过 `'ansi:default'` 这个背景色哨兵值识别 ANSI 模式。
  // 这类主题没法画 hex 背景（为了兼容 16 色终端），所以会改用
  // DIM 来区分删除行。这里对齐 Claude Code 的 color-diff/index.ts:924。
  const isAnsiMode = themeColors.diffAdded === 'ansi:default'
  // Claude Code 会把 diff 行里未高亮的文本画成 `Theme.foreground`
  //（深色主题是 #f8f8f2，浅色主题是 #333333）。如果不这么做，
  // 我们这些未命中的字符就会退回到终端默认的 `#cccccc`，视觉上
  // 会比 CC 更灰、更暗。ANSI 主题则传 null，直接尊重终端配色。
  const defaultFg = themeColors.defaultFg
  const cols = Math.max(40, terminalWidth)
  const lineNumWidth = Math.max(1, String(maxLineNumber(payload.hunks)).length)
  // gutter 格式：` <num> <sigil> `，也就是 1 个前导空格 + 行号 + 1 个空格 +
  // 符号位 + 1 个尾随空格。
  const gutterWidth = lineNumWidth + 4
  // 这里要额外预留 1 个尾随 cell 作为安全边界：`-` / `+` 行会用
  // 带背景色的空格把 code 区域补到最右侧，这样整条 diff 带会铺满。
  // 但如果一行的可打印宽度刚好等于 `cols`，终端会进入最后一列的
  // delayed-wrap 状态；某些 Windows conhost / Windows Terminal 配置
  // 会把这个状态算作真正换行，于是每条补满背景的 `-` / `+` 行
  // 下面都会多出一个幽灵空白行。留 1 列不涂色可以保证光标始终停在
  // 行内，不会触发这个问题。
  const codeWidth = Math.max(1, cols - RESULT_INDENT.length - gutterWidth - 1)
  const lang = detectLanguage(payload.filePath)

  const out: string[] = []
  let emitted = 0
  let truncated = 0

  for (let hi = 0; hi < payload.hunks.length; hi++) {
    if (hi > 0) {
      // hunk 分隔符 - Claude Code 会用一行变暗的 `...` 来隔开。
      out.push(`${RESULT_INDENT}${c.gray('...')}`)
    }
    const hunk = payload.hunks[hi]!
    const numbered = numberLines(hunk)
    for (const { sigil, code, lineNum } of numbered) {
      if (emitted >= MAX_DIFF_LINES) {
        truncated++
        continue
      }
      emitted++

      const numStr = String(lineNum).padStart(lineNumWidth)
      const fitted = fitCode(code, codeWidth)
      // 这里要按 RAW（未高亮）文本来补空格，这样有颜色的背景才能刚好
      // 填满到最右边。高亮只会增加 escape code，不会改变可见字符数。
      // 这里必须使用 visual width（CJK 字符虽然 `length === 1`，但占
      // 2 个 cell）；如果按 length 补空格，就会多补 `visualWidth - length`
      // 个 cell，导致每一条 CJK diff 行下面都多出一个空白视觉行。
      const padding = ' '.repeat(Math.max(0, codeWidth - visualWidth(fitted)))
      const gutter = ` ${numStr} ${sigil} `
      // 语法高亮只应用在上下文行上。对于 +/- 行，我们只在 diff 背景上
      // 画纯文本，因为多色高亮叠在饱和的红 / 绿底色上会和背景打架，
      // 视觉上反而很吵。Claude Code 的 fallback diff 也是这么做的：
      // 背景色本身已经足够表达增删，周围的上下文行则提供完整的彩色
      // 锚点帮助阅读。
      let styled: string
      if (sigil === '+') {
        // `+` 行：背景色 + 带装饰色的 gutter + 语法高亮代码。
        // CC 一定会高亮 `+` 行，因为它们本身就是新代码。
        // 我们会先把 gutter 涂成主题里的 add-decoration 颜色，再把
        // 整行包进背景色里，这样前景色才能稳定保留下来。
        // defaultFg 会一路传进来，所以未命中的字符（`;`、`(`、`)`、
        // `{`、`}`）和没被单独装饰的标识符（比如 `console.log` 里的
        // `log`）能得到 CC 那种亮奶白 / 深灰，而不是终端默认白色。
        const code = highlightLine(fitted, lang, syntaxTheme, defaultFg)
        const coloredGutter = applyGutterFg(gutter, themeColors.diffAddedDecoration)
        styled = applyBg(coloredGutter + code + padding, themeColors.diffAdded)
      } else if (sigil === '-') {
        // `-` 行：背景色 + 带装饰色的 gutter + 纯文本（永远不做语法高亮，
        // 包括 picker 预览）。CC 的 color-diff/index.ts:916-918 会始终把
        // `-` 行交给 `defaultStyle(theme)`，而不是 highlightLine，所以删
        // 掉的文本在真实 diff 和主题预览里都是白字 / 亮字压在红底上。
        // 多色前景叠在饱和红底上会互相打架；纯文本更像“这段内容要被
        // 去掉了”。不过 defaultFg 还是要保留 - 这正是 CC 的 defaultStyle
        // 让删除文本比终端默认值更亮的原因。
        const plainCode = defaultFg ? applyColor(fitted, defaultFg) : fitted
        const coloredGutter = applyGutterFg(gutter, themeColors.diffRemovedDecoration)
        let row = applyBg(coloredGutter + plainCode + padding, themeColors.diffRemoved)
        // ANSI 模式没有背景色可用来标记删除行，所以要把整行都 dim
        // 掉 - 这和 CC 的 `dimContent` 一致（color-diff/index.ts:924）。
        // 否则 ANSI 模式下的 `-` 行会和 `+` 行几乎看不出区别。
        if (isAnsiMode) row = c.dim(row)
        styled = row
      } else {
        // 上下文行：完整语法高亮、没有背景色，gutter 也使用默认前景色
        //（对应 CC 在 marker === ' ' 时的 addLineNumber 路径）。
        // 这里保留 defaultFg，是为了让上下文行与 +/- 行的亮度一致 - CC
        // 会把这三类行都画成同一个 Theme.foreground。
        const highlighted = highlightLine(fitted, lang, syntaxTheme, defaultFg)
        styled = gutter + highlighted + padding
      }
      out.push(`${RESULT_INDENT}${styled}`)
    }
  }

  if (truncated > 0) {
    out.push(`${RESULT_INDENT}${c.gray(`… +${truncated} more line${truncated === 1 ? '' : 's'}`)}`)
  }

  return out
}

/**
 * 将新建文件内容的前 ~10 行渲染成一个预览块。
 * 它和更新路径共享同样的 gutter 样式 + 语法高亮；视觉上区分 create
 * 和 update 的关键，是 create 没有 diff 背景色：对一个全新的文件来说，
 * 把每一行都刷成绿色不会传达任何额外信息，只会增加噪音。
 * 超出部分会折叠成 `… +N lines`。
 */
function renderCreatePreview(
  filePath: string,
  content: string,
  terminalWidth: number,
  theme?: SyntaxThemeName,
): string[] {
  const cols = Math.max(40, terminalWidth)
  const allLines = content.split('\n')
  // 去掉末尾多出来的一个空行 - 大多数文件内容都会以 `\n` 结束，
  // split 之后会得到一个我们不想渲染的空字符串。
  if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop()
  if (allLines.length === 0) return []

  const visible = allLines.slice(0, MAX_CREATE_PREVIEW_LINES)
  const truncated = allLines.length - visible.length
  const lineNumWidth = Math.max(1, String(allLines.length).length)
  const gutterWidth = lineNumWidth + 2 // ` <num> `
  const codeWidth = Math.max(1, cols - RESULT_INDENT.length - gutterWidth)
  const lang = detectLanguage(filePath)

  const out: string[] = []
  for (let i = 0; i < visible.length; i++) {
    const numStr = String(i + 1).padStart(lineNumWidth)
    const fitted = fitCode(visible[i] ?? '', codeWidth)
    const highlighted = highlightLine(fitted, lang, theme)
    out.push(`${RESULT_INDENT}${c.gray(` ${numStr} `)}${highlighted}`)
  }
  if (truncated > 0) {
    out.push(`${RESULT_INDENT}${c.gray(`… +${truncated} ${truncated === 1 ? 'line' : 'lines'}`)}`)
  }
  return out
}

/**
 * 将完整的 diff 块（数量汇总头 + hunk 正文或内容预览）渲染成 tool-call
 * result 行的正文。第一行是要接在 stdout-writer 发出的 `   ⎿  ` 前缀
 * 后面的，所以这里不自己再加前缀 - 由调用方把整段拼起来。
 *
 * 返回值说明：
 *   - line[0]：数量汇总，例如 "Added 3 lines, removed 1 line" /
 *     "Created 20 lines"
 *   - line[1..]：diff hunks（更新路径）或者内容预览（创建路径）
 *
 * 如果是 update payload 但没有 hunks（比如 diff 超时），就只保留头部
 * 文本 - 因为已经没有 patch 可以渲染了。
 */
/** 在给定的 UI theme 下渲染一个固定的 JS 片段 diff - 这个用于
 * `/theme` 和首次启动时的 picker，为当前焦点项展示实时颜色预览。
 * 这里的 hunk 是手工拼出来的（4 行，1 次替换），不是走 computeEditDiff，
 * 这样 picker 冷路径就不会顺带把 diff 库也拖进来。
 *
 * picker 会传进候选主题的名字；我们会同时查出这个主题的 diff 颜色和
 * 对应的语法调色板，这样预览里背景色和代码色会一起变化 - 这才是
 * picker 真正想展示的内容。
 *
 * 这里会把每一行前面的 RESULT_INDENT 去掉，这样预览能直接贴着对话框
 * 左边缘显示（它不是嵌在 tool bullet 下面的，它本身就是一个独立块）。 */
export function buildThemePreview(themeName: ThemeName, terminalWidth: number): string[] {
  const theme = getThemeColors(themeName)
  const payload: EditDiffPayload = {
    filePath: 'preview.ts',
    hunks: [
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        lines: [' function greet() {', '-  console.log("Hello, World!");', '+  console.log("Hello, X-Code!");', ' }'],
      },
    ],
    additions: 1,
    removals: 1,
    isCreate: false,
  }
  return renderHunks(payload, terminalWidth, theme.syntaxPalette, themeName).map((row) =>
    row.startsWith(RESULT_INDENT) ? row.slice(RESULT_INDENT.length) : row,
  )
}

export function renderEditDiff(payload: EditDiffPayload, terminalWidth: number, theme?: SyntaxThemeName): string[] {
  const header = formatCounts(payload)
  if (payload.isCreate) {
    if (!payload.content) return [header]
    return [header, ...renderCreatePreview(payload.filePath, payload.content, terminalWidth, theme)]
  }
  if (payload.hunks.length === 0) return [header]
  return [header, ...renderHunks(payload, terminalWidth, theme)]
}
