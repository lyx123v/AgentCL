// @x-code-cli/cli - 面向终端能力的 Unicode 图形回退。
//
// 传统 ConHost（cmd.exe / Windows Terminal 之外的 Windows PowerShell 主机）
// 默认使用的字体（Lucida Console、Consolas、SimSun、NSimSun、MS Gothic）
// 对 CP437 / Latin-1 Supplement 范围之外的很多 Unicode 字形支持都很差。
// 像 ●、❯、⎿、✢、✶、⏸、⚡、✓、◼、•、▎ 这类字符，要么会显示成缺字方框（□），
// 要么宽度计算不对，最终把界面渲染成用户描述的那种“丑”“坏掉了”的效果。
//
// 这个模块把 TUI 里所有“装饰性 Unicode 字形”统一收口到能力检测之后。
// 任何渲染路径（ChatInput 单元格缓冲、stdout-writer 回滚区、render-markdown、
// AppHeader）都应该从这里导入字形，而不是自己硬编码字面量。
//
// 检测逻辑和 ChatInput.tsx 里原本就有的 spinner ASCII 回退保持一致：
// WT_SESSION → Windows Terminal（Cascadia Mono，Unicode 支持完整）；
// TERM_PROGRAM=vscode → VSCode 集成终端；在 win32 上两者都没有时，就认为是传统 ConHost。
// 非 Windows 平台默认直接使用完整字形。

/** 当终端属于传统 ConHost，无法可靠渲染 CP437 / Latin-1 Supplement
 *  （U+0000–U+00FF）以及部分方框绘图字符时返回 true。 */
export const IS_LEGACY_TERMINAL =
  process.platform === 'win32' && !process.env.WT_SESSION && process.env.TERM_PROGRAM !== 'vscode'

// ── 字形表 ─────────────────────────────────────────────────────────
//
// 每个导出常量都表示一个“富字形 + 回退字形”的映射。
// 消费方只需要导入名字，模块加载时就会根据当前终端能力自动得到合适的版本。

/** 工具调用的圆点：富样式为 `●`（U+25CF），回退为 `*`。 */
export const GLYPH_BULLET = IS_LEGACY_TERMINAL ? '*' : '●'

/** 用户消息前的提示箭头：富样式为 `❯`（U+276F），回退为 `>`。 */
export const GLYPH_PROMPT_ARROW = IS_LEGACY_TERMINAL ? '>' : '❯'

/** 工具结果或子项左侧的括号：富样式为 `⎿`（U+23BF），回退为 `|`。 */
export const GLYPH_RESULT_BRACKET = IS_LEGACY_TERMINAL ? '|' : '⎿'

/** 权限菜单或选项列表的指针：富样式为 `❯`（U+276F），回退为 `>`。 */
export const GLYPH_SELECT_POINTER = IS_LEGACY_TERMINAL ? '>' : '\u276f'

/** Plan 模式标记：富样式为 `⏸`（U+23F8），回退为 `=`。 */
export const GLYPH_PLAN_MODE = IS_LEGACY_TERMINAL ? '=' : '\u23f8'

/** 接受修改的标记：富样式为 `⚡`（U+26A1），回退为 `*`。 */
export const GLYPH_ACCEPT_EDITS = IS_LEGACY_TERMINAL ? '*' : '\u26a1'

/** Todo 已完成的勾选标记：富样式为 `✓`（U+2713），回退为 `+`。 */
export const GLYPH_TODO_CHECK = IS_LEGACY_TERMINAL ? '+' : '\u2713'

/** Todo 进行中的实心方块：富样式为 `◼`（U+25FC），回退为 `#`。 */
export const GLYPH_TODO_IN_PROGRESS = IS_LEGACY_TERMINAL ? '#' : '\u25fc'

/** Todo 未开始的空心方块：富样式为 `◻`（U+25FB），回退为 `-`。 */
export const GLYPH_TODO_PENDING = IS_LEGACY_TERMINAL ? '-' : '\u25fb'

/** Todo 面板左下角的收口符号：富样式为 `⎿`（U+23BF），回退为 `|`。 */
export const GLYPH_TODO_BRACKET = IS_LEGACY_TERMINAL ? '|' : '\u23bf'

/** 引用块左侧竖线：富样式为 `▎`（U+258E），回退为 `|`。 */
export const GLYPH_BLOCKQUOTE_BAR = IS_LEGACY_TERMINAL ? '|' : '\u258e'

/** 无序列表圆点：富样式为 `•`（U+2022），回退为 `-`。 */
export const GLYPH_LIST_BULLET = IS_LEGACY_TERMINAL ? '-' : '\u2022'

/** 标题分隔用竖线：富样式为 `│`（U+2502），回退为 `|`。 */
export const GLYPH_HEADER_PIPE = IS_LEGACY_TERMINAL ? '|' : '\u2502'

/** 省略号：`…`（U+2026）在 Windows-1252 和所有 ConHost 字体中都可用，
 *  不需要回退。这里仍然导出只是为了统一，避免调用方直接硬编码字面量。 */
export const GLYPH_ELLIPSIS = '\u2026'

// Spinner 帧序列：ChatInput.tsx 里原本就有一部分回退逻辑，这里统一收口。
// ConHost 默认字体缺少 U+2722–U+273D 这一段 dingbats 字符，因此需要更保守的替换。
const SPINNER_BASE_RICH = ['·', '✢', '*', '✶', '✻', '✽']
const SPINNER_BASE_ASCII = ['·', ':', '+', '*', '+', ':']
const BASE = IS_LEGACY_TERMINAL ? SPINNER_BASE_ASCII : SPINNER_BASE_RICH

/** 完整的 spinner 帧序列，包含正向和反向两段，形成呼吸感动画。 */
export const SPINNER_FRAMES = [...BASE, ...[...BASE].reverse()]

// ── 方框绘图字符（render-markdown 里的表格） ──────────────────
//
// 轻量方框绘图字符范围 U+2500–U+257F 在所有 ConHost 字体里都存在
//（Lucida Console、Consolas、SimSun、所有中文回退字体都支持），
// 因为它们属于 CP437，也就是最早的 IBM PC 字符集。
// AppHeader 的 logo 里用到的双线字符范围 U+2550–U+256C 也是一样。
// 这些字符不需要做回退处理。
//
// 横线字符 `─`（U+2500）以及表格字符 `┌┐└┘├┤┬┴┼│` 都在这个安全范围内。
// 这里不需要额外导出，因为它们在我们支持的所有终端里都能正常渲染。
