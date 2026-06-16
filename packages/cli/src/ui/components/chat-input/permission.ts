// 权限对话框的 cell 构建器 + `formatElapsed`。
//
// 之所以放在 ChatInput.tsx 之外，是因为权限渲染本质上只是一个
// 自包含的 data -> Cell[] 映射，不需要 React state。
import { getPermissionLevel } from '@x-code-cli/core'

import { GLYPH_ELLIPSIS } from '../../terminal-glyphs.js'
import { type Cell, textToCells } from './cells.js'
import { S_ACCENT, S_ACCENT_DIM, S_DIM, S_ERROR_BOLD, S_NONE, S_SUCCESS, S_WARNING } from './palette.js'

export function permissionTitle(toolName: string, mcp?: { serverName: string; rawName: string }): string {
  if (mcp) return `X-Code wants to use MCP tool: ${mcp.serverName}/${mcp.rawName}`
  switch (toolName) {
    case 'shell':
      return 'X-Code wants to run a shell command'
    case 'writeFile':
      return 'X-Code wants to write a file'
    case 'edit':
      return 'X-Code wants to edit a file'
    case 'enterPlanMode':
      return 'X-Code wants to enter plan mode'
    default:
      return `X-Code wants to use ${toolName}`
  }
}

const PERMISSION_LEVEL_STYLE: Record<string, { label: string; style: string }> = {
  'always-allow': { label: 'read-only', style: S_SUCCESS },
  ask: { label: 'write', style: S_WARNING },
  deny: { label: 'dangerous', style: S_ERROR_BOLD },
}

/** MCP 工具输入的一行式 `key: value, key: value` 摘要。
 *  值会先做 JSON 编码，这样字符串会保留引号，嵌套对象也更容易读；
 *  过长的值会在 join 前先截断，避免某个字段太大把其他 key 全吞掉。
 *  最外层在 `permissionContentCells` 里还有一次按终端宽度截断，
 *  用来兜住整行。 */
export function mcpInputPreview(input: Record<string, unknown>): string {
  const keys = Object.keys(input)
  if (keys.length === 0) return '(no args)'
  const PER_VALUE_MAX = 60
  const parts = keys.map((k) => {
    let v: string
    try {
      v = JSON.stringify(input[k])
    } catch {
      v = String(input[k])
    }
    if (v === undefined) v = 'undefined'
    if (v.length > PER_VALUE_MAX) v = v.slice(0, PER_VALUE_MAX - 1) + '…'
    return `${k}: ${v}`
  })
  return parts.join(', ')
}

export function permissionContentCells(
  toolName: string,
  input: Record<string, unknown>,
  termWidth: number,
  mcp?: { serverName: string; rawName: string },
): Cell[] | null {
  // frame 几何假设每一行权限内容都只占一行。
  // 如果字符串比 termWidth 长，终端会自动换行到下一物理行，
  // 这会打乱后面所有绝对光标位置
  //（Yes/No 行、输入分隔线、提示本身）——对话框就会像“只剩一半”，
  // 只看到标题。
  // 所以这里要截断，保证 cell matrix 和屏幕上的行数 1:1。
  // 这和下面 live tool-list 里的 tool-bubble 预览截断是同一个思路。
  const truncateToWidth = (text: string, reservedCols: number): string => {
    const maxLen = Math.max(10, termWidth - reservedCols)
    return text.length > maxLen ? text.slice(0, maxLen - 1) + GLYPH_ELLIPSIS : text
  }
  if (mcp) {
    // 输入的一行式 `key: value, key: value` 预览。
    // MCP 工具可以接受任意 schema，所以我们用通用序列化器兜底，
    // 而不是去猜“哪个字段才是重点”。
    // 空输入也要渲染这一行（显示 `(no args)`），这样对话框高度才能和
    // shell/edit 对齐，always-allow 那一行也会出现在用户预期的位置。
    const preview = mcpInputPreview(input)
    const cells: Cell[] = []
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push(...textToCells(truncateToWidth(preview, 2 + 2), S_ACCENT))
    return cells
  }
  if (toolName === 'shell') {
    const level = getPermissionLevel('shell', input)
    const info = PERMISSION_LEVEL_STYLE[level] ?? PERMISSION_LEVEL_STYLE.ask
    const cells: Cell[] = []
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    const rawCommand = String(input.command ?? '')
    const decoration = 2 + 2 + 1 + (info.label.length + 2) + 2
    const command = truncateToWidth('$ ' + rawCommand, decoration)
    cells.push(...textToCells(command, S_ACCENT))
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push(...textToCells(`[${info.label}]`, info.style))
    return cells
  }
  if (toolName === 'writeFile') {
    const fp = String(input.filePath ?? '')
    const cells: Cell[] = []
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    const suffix = ' (new file)'
    const truncated = truncateToWidth(fp, 2 + suffix.length + 2)
    cells.push(...textToCells(truncated, S_ACCENT))
    cells.push(...textToCells(suffix, S_ACCENT_DIM))
    return cells
  }
  if (toolName === 'edit') {
    const fp = String(input.filePath ?? '')
    const cells: Cell[] = []
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push(...textToCells(truncateToWidth(fp, 2 + 2), S_ACCENT))
    return cells
  }
  if (toolName === 'enterPlanMode') {
    // plan-mode 入口没有逐次调用输入 - 这里描述其后果，
    // 这样用户就知道 Yes/No 到底意味着什么。
    const cells: Cell[] = []
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push(...textToCells('Read-only exploration; no edits until you approve a plan.', S_DIM))
    return cells
  }
  return null
}

export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${minutes}m ${secs}s`
}
