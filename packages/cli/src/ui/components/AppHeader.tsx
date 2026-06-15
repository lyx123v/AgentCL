// @x-code-cli/cli - 启动头部横幅
//
// printHeader() 会在 Ink 启动之前直接把横幅写到 stdout。
// 这样可以避开 Ink <Static> 的重复渲染问题，否则当动态区域高度变化时，
// 头部就可能被反复绘制多次。
import { Chalk } from 'chalk'

import { VERSION } from '../../version.js'
import { GLYPH_HEADER_PIPE } from '../terminal-glyphs.js'

const c = new Chalk({ level: 3 })

/** Logo 颜色 - 刻意保留原来的柔和天空蓝（`#89b4fa`），
 *  不跟随主 ACCENT 的 Claude Code 橙色。 */
const LOGO_COLOR = '#89b4fa'

// ── 不同终端宽度下使用的 ASCII logo ──

const LOGO_WIDE = `
  ██╗  ██╗       ██████╗ ██████╗ ██████╗ ███████╗
  ╚██╗██╔╝      ██╔════╝██╔═══██╗██╔══██╗██╔════╝
   ╚███╔╝ █████╗██║     ██║   ██║██║  ██║█████╗  
   ██╔██╗ ╚════╝██║     ██║   ██║██║  ██║██╔══╝  
  ██╔╝ ██╗      ╚██████╗╚██████╔╝██████╔╝███████╗
  ╚═╝  ╚═╝       ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝`

const LOGO_COMPACT = `
  ╔═╗       ╔═╗╔═╗╔╦╗╔═╗
  ╔╩╦╝ ───── ║  ║ ║ ║║║╣ 
  ╩ ╚═       ╚═╝╚═╝═╩╝╚═╝`

const LOGO_TINY = '  X-Code'

/**
 * 返回启动横幅占用多少个终端行。
 * ChatInput 需要这个值来正确初始化“输入框上方空白行”的追踪器，
 * 否则第一次弹出补全菜单 / 对话框并变高时，组件会把其实是空白的行也先滚走，
 * 白白浪费视口空间，还会把横幅推进真正的 scrollback 里。
 */
export function getHeaderRowCount(modelId: string): number {
  return renderHeader(modelId).split('\n').length - 1 // final '\n' adds one empty split
}

/**
 * 将启动横幅组装成字符串。
 */
export function renderHeader(modelId: string): string {
  const cols = process.stdout.columns ?? 80

  // 根据终端宽度选择不同尺寸的 logo。
  let logo: string
  if (cols >= 52) {
    logo = LOGO_WIDE
  } else if (cols >= 30) {
    logo = LOGO_COMPACT
  } else {
    logo = LOGO_TINY
  }

  // 从 "provider:model-name" 中拆出 provider 和 model。
  const [provider, ...modelParts] = modelId.split(':')
  const modelName = modelParts.join(':') || modelId

  // 换行快捷键提示：
  //   - 行末 `\` + Enter 是最通用的兜底方案（适用于所有终端，
  //     包括 ConHost、Terminal.app 以及 xterm 系列）。
  //   - Alt/Option+Enter 在大多数现代终端里都可用
  //     （Windows Terminal、iTerm2 配合 Esc+Option、GNOME Terminal、
  //     kitty、WezTerm）。在 macOS Terminal.app 里，用户需要在 profile
  //     设置中启用 “Use Option as Meta key”，否则只能用 `\` 这一种形式。
  // 为什么不用 Ctrl/Cmd+Enter：原生终端对普通 Enter 和 Ctrl+Enter
  // 会发出相同字节，我们没法区分。modifyOtherKeys / kitty CSI-u 形式
  // 是支持的（见 use-prompt-input.ts），但它们需要终端侧单独开启，
  // 这里就不额外暴露了。
  const isMac = process.platform === 'darwin'
  const abortKey = isMac ? '⌃C' : 'Ctrl+C'
  const newlineHint = isMac ? '⌥⏎ or \\⏎ for newline' : 'Alt+Enter or \\+Enter for newline'

  const lines = [
    c.hex(LOGO_COLOR).bold(logo),
    ` ${c.dim(`v${VERSION}`)} ${c.dim(GLYPH_HEADER_PIPE)} ${c.hex(LOGO_COLOR)(provider)} ${c.dim('/')} ${c.hex(LOGO_COLOR).bold(modelName)}`,
    ` ${c.dim(`Type /help for commands, ${abortKey} to abort, ${newlineHint}`)}`,
    '', // 横幅后留一行空白
  ]

  return lines.join('\n') + '\n'
}

/**
 * 直接把启动横幅打印到 stdout。
 * 要在 Ink 的 render() 之前只调用一次，这样它就不会被重复重绘。
 */
export function printHeader(modelId: string): void {
  // 先把终端视口里已有内容推入 scrollback，并把光标停到 (1,1) 再写横幅。
  // 不这么做的话，启动阶段如果前面已经有一堆噪音输出
  //（pnpm dev 的构建日志、用户输入命令的回显等），光标会停在窗口底部，
  // 横幅也会被写到底部，而 ChatInput 的底部固定框会把横幅最后几行盖掉。
  // 这就是之前只看到 logo 上半截的原因。
  //
  // `\n` × (rows - 1) 会把当前 viewport 的内容滚进真正的 scrollback 历史里
  //（用户之后仍然可以往上翻看到），随后 `\x1b[H` 把光标归位到左上角，
  // 这样横幅就会从第 1 行开始写，下面的所有行都留空给 ChatInput 贴底使用。
  //
  // 之前试过两种方案，但都被放弃了：
  //   - `\x1b[2J\x1b[H`（清屏 + 归位）：概念上更直接，但 Windows 上某些
  //     终端 / 代码页组合会把 CSI 2J 也理解成清掉可见 scrollback，
  //     用户会丢掉上下文（自己刚输入的命令也没了）。
  //   - 用 `fs.writeSync(1, ...)` 强制同步写：这会绕过 Node 在 Windows TTY 上
  //     的 UTF-16 转换路径，logo 里的框线字符会在 CP936（zh-CN PowerShell
  //     默认编码）下被渲染成 GBK 字节对，结果就是严重乱码加 scrollback 污染。
  //
  // 目前只有通过 Node 的 tty 层走 `process.stdout.write`，才能在各类 Windows
  // 代码页下都正确处理 Unicode。
  const rows = process.stdout.rows ?? 25
  if (process.stdout.isTTY && rows > 1) {
    process.stdout.write('\n'.repeat(rows - 1) + '\x1b[H')
  }
  process.stdout.write(renderHeader(modelId))
}
