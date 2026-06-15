// ─── UI 主题系统 ───────────────────────────────────────────────────────
//
// 这里的设计对齐 Claude Code 的 `/theme`：用户从 6 套 UI 主题里选一套，
// 这个选择会同时影响 diff 背景色和语法高亮调色板。
// 以前 diff 背景色是写死的常量，这导致切换 /theme 对 diff 区域没效果，
// 但 diff 偏偏又是最显眼的代码展示区域。现在这些颜色都在渲染时根据当前主题计算。
//
// 每个主题还会绑定一个语法调色板（例如 dark → one-dark，dark-ansi → ansi）。
// 我们把这个名字直接暴露在主题对象上，这样启动时的初始化和 `/theme` 命令
// 就能共用同一套定义。
import type { SyntaxThemeName } from './syntax-highlight.js'

// @x-code-cli/cli - 共享 UI 颜色 token。
//
// 这套配色对齐 Claude Code 的 dark theme（`src/utils/theme.ts` 里的 darkTheme）。
// 所有值都用 hex 字符串，这样 Ink 的 `<Text color={...}>` 在任何现代
// 24-bit 终端里都能正确渲染。

/** 主强调色 - Claude 品牌橙色（`claude = rgb(215,119,87)`） */
export const ACCENT = '#d77757'

/** 次强调色 - 中灰，用于状态栏里的次要标签 */
export const ACCENT_DIM = '#999999'

/** 系统 spinner 蓝色（`claudeBlue_FOR_SYSTEM_SPINNER = rgb(147,165,255)`） */
export const SPINNER_BLUE = '#93a5ff'

/** 浅蓝紫 - 用于权限对话框、建议、高亮（`permission = rgb(153,204,255)`） */
export const BLUE_PURPLE = '#99ccff'

/** 成功 / 完成 / diff-added（`success = rgb(78,186,101)`） */
export const SUCCESS = '#4eba65'

/** 警告 / 权限提示 / 待处理（`warning = rgb(255,193,7)`） */
export const WARNING = '#ffc107'

/** 错误 / 拒绝 / diff-removed（`error = rgb(255,107,128)`） */
export const ERROR = '#ff6b80'

/** 弱化元素 - 使用命名 ANSI gray，兼容性更广。 */
export const DIM = 'gray'

/** 低调的深灰，用于边框 / 背景（`subtle = rgb(80,80,80)`） */
export const SUBTLE = '#505050'

/** 输入框上下边线（`promptBorder = rgb(136,136,136)`） */
export const PROMPT_BORDER = '#888888'

export type ThemeName = 'dark' | 'light' | 'dark-daltonized' | 'light-daltonized' | 'dark-ansi' | 'light-ansi'

export interface ThemeColors {
  name: ThemeName
  label: string
  description: string
  /** `#rrggbb` 表示 24-bit 颜色，`ansi:default` 则用于纯 ANSI 主题
   *  （这类主题保留终端默认背景，用 DIM / decoration-fg 来标记 `-` 行）。
   *  render-diff 会把这些字符串翻译成对应的 chalk 调用。
   *
   *  这里的值与 Claude Code 的 `native-ts/color-diff/index.ts buildTheme()`
   *  保持一致，也就是实际画到终端上的颜色。CC 的 `utils/theme.ts`
   *  里那些更浅的值只是主题选择器里的 UI 指示色，不是 scrollback 里
   *  真正看到的 diff 内容颜色。 */
  diffAdded: string
  diffRemoved: string
  /** diff 行 gutter（行号 + `+`/`-` 符号）的前景色。
   *  CC 会把 gutter 画成饱和的“装饰色”，让它能从接近黑色的背景里跳出来；
   *  如果没有这个，gutter 在 diffAdded/diffRemoved 这些深色背景上就会几乎看不见。 */
  diffAddedDecoration: string
  diffRemovedDecoration: string
  /** diff 行里未高亮文本的默认前景色。
   *  对齐 CC 的 `Theme.foreground`（color-diff/index.ts:303,334）：
   *  dark 用 `#f8f8f2`，light 用 `#333333`。没有这个设置时，未匹配字符
   *  和普通 `-` 行会回退到终端默认白色（通常接近 `#cccccc`），
   *  diff 区域会显得比 CC 亮很多。ANSI 主题这里传 `null`，
   *  因为它们应该尊重用户的 16 色终端调色板，而不是强行指定 hex 值。 */
  defaultFg: string | null
  /** 这个主题会驱动哪套语法高亮调色板。
   *  选择上尽量和主题整体氛围一致：色盲友好主题用低对比调色板，
   *  ANSI 主题则使用 16 色 ansi 调色板。 */
  syntaxPalette: SyntaxThemeName
}

// 主题标签要和 CC 的 ThemePicker 完全对齐（这里只保留 label 文本，
// 因为 CC 的主题行本身没有 description 字段）。
// 语法调色板映射也对齐 CC 的 `defaultSyntaxThemeName`（color-diff/index.ts:182）：
// dark* → Monokai，light* → GitHub，*ansi → ansi。
export const THEMES: ThemeColors[] = [
  {
    name: 'dark',
    label: 'Dark mode',
    description: '',
    diffAdded: '#022800',
    diffRemoved: '#3d0100',
    diffAddedDecoration: '#50c850',
    diffRemovedDecoration: '#dc5a5a',
    defaultFg: '#f8f8f2',
    syntaxPalette: 'monokai',
  },
  {
    name: 'light',
    label: 'Light mode',
    description: '',
    diffAdded: '#dcffdc',
    diffRemoved: '#ffdcdc',
    diffAddedDecoration: '#248a3d',
    diffRemovedDecoration: '#cf222e',
    defaultFg: '#333333',
    syntaxPalette: 'github-light',
  },
  {
    name: 'dark-daltonized',
    label: 'Dark mode (colorblind-friendly)',
    description: '',
    diffAdded: '#001b29',
    diffRemoved: '#3d0100',
    diffAddedDecoration: '#51a0c8',
    diffRemovedDecoration: '#dc5a5a',
    defaultFg: '#f8f8f2',
    syntaxPalette: 'monokai',
  },
  {
    name: 'light-daltonized',
    label: 'Light mode (colorblind-friendly)',
    description: '',
    diffAdded: '#dbedff',
    diffRemoved: '#ffdcdc',
    diffAddedDecoration: '#24578a',
    diffRemovedDecoration: '#cf222e',
    defaultFg: '#333333',
    syntaxPalette: 'github-light',
  },
  {
    name: 'dark-ansi',
    label: 'Dark mode (ANSI colors only)',
    description: '',
    diffAdded: 'ansi:default',
    diffRemoved: 'ansi:default',
    diffAddedDecoration: 'ansi:green',
    diffRemovedDecoration: 'ansi:red',
    // CC 为 ansi 设置的是 `foreground: ansiIdx(7)`（color-diff/index.ts:296），
    // 也就是明确把未匹配字符画成白色。没有这个的话，我们 `+` 行里的标点
    //（`()`、`;`、`.`、`log`）会继承终端默认色，看起来会比 CC 更不清晰。
    // Chalk 的 `white` 会产出 \e[37m，正好对应 ansiIdx(7)。
    defaultFg: 'white',
    syntaxPalette: 'ansi',
  },
  {
    name: 'light-ansi',
    label: 'Light mode (ANSI colors only)',
    description: '',
    diffAdded: 'ansi:default',
    diffRemoved: 'ansi:default',
    diffAddedDecoration: 'ansi:green',
    diffRemovedDecoration: 'ansi:red',
    defaultFg: 'white',
    syntaxPalette: 'ansi',
  },
]

export const DEFAULT_THEME: ThemeName = 'dark'

let currentTheme: ThemeName = DEFAULT_THEME

export function setTheme(name: ThemeName): void {
  currentTheme = name
}

export function getTheme(): ThemeName {
  return currentTheme
}

export function getThemeColors(name?: ThemeName): ThemeColors {
  const target = name ?? currentTheme
  return THEMES.find((t) => t.name === target) ?? THEMES[0]!
}

export function parseThemeName(input: unknown): ThemeName | null {
  if (typeof input !== 'string') return null
  const normalized = input
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
  const aliases: Record<string, ThemeName> = {
    daltonized: 'dark-daltonized',
    colorblind: 'dark-daltonized',
    'colorblind-friendly': 'dark-daltonized',
    ansi: 'dark-ansi',
    'dark-colorblind': 'dark-daltonized',
    'light-colorblind': 'light-daltonized',
  }
  if (normalized in aliases) return aliases[normalized]!
  if (THEMES.some((t) => t.name === normalized)) return normalized as ThemeName
  return null
}
