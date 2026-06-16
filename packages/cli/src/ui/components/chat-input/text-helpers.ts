// ChatInput cell-diff 渲染器用的宽度 / 路径 / ANSI 辅助函数。
// `isWide` / `charWidth` / `visualWidth` / `sliceByWidth` 都在
// `../../text-width.js` 里 - 那是 chat-input frame、scrollback diff
// 和 markdown 表格布局的单一事实来源。下面这些 helper 都建立在这些原语之上。
import { GLYPH_ELLIPSIS } from '../../terminal-glyphs.js'
import { charWidth, visualWidth } from '../../text-width.js'
import type { Cell } from './cells.js'

export function truncateCellRow(cells: Cell[], maxWidth: number): Cell[] {
  let w = 0
  for (let i = 0; i < cells.length; i++) {
    if (w + cells[i]!.width > maxWidth) {
      const truncated = cells.slice(0, i)
      if (w + 1 <= maxWidth) {
        truncated.push({ char: GLYPH_ELLIPSIS, style: cells[i]!.style, width: 1 })
      }
      return truncated
    }
    w += cells[i]!.width
  }
  return cells
}

/** 把 `cells` 硬换行到最多 `maxRows` 行、每行 `maxWidth` 宽。
 *  当内容超过行预算时，会从最后一行删掉尾部 cell，再补一个省略号。
 *  这是按字符而不是按单词换行 - 和 `truncateCellRow` 同一模型，只是多行版。 */
export function wrapCellsToRows(cells: Cell[], maxWidth: number, maxRows: number): Cell[][] {
  if (maxRows <= 0 || maxWidth <= 0) return []
  const rows: Cell[][] = []
  let current: Cell[] = []
  let currentWidth = 0
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]!
    if (currentWidth + c.width > maxWidth) {
      rows.push(current)
      if (rows.length >= maxRows) {
        const last = rows[rows.length - 1]!
        let lastW = currentWidth
        const ellipsisStyle = last.length > 0 ? last[last.length - 1]!.style : c.style
        while (last.length > 0 && lastW + 1 > maxWidth) {
          lastW -= last.pop()!.width
        }
        last.push({ char: GLYPH_ELLIPSIS, style: ellipsisStyle, width: 1 })
        return rows
      }
      current = []
      currentWidth = 0
    }
    current.push(c)
    currentWidth += c.width
  }
  if (current.length > 0) rows.push(current)
  return rows
}

export function skipByWidth(str: string, skipCols: number): number {
  let w = 0,
    i = 0
  for (const ch of str) {
    if (w >= skipCols) break
    w += charWidth(ch)
    i += ch.length
  }
  return i
}

/** 从开头截断一个用斜杠分隔的路径，确保 basename 一定保住。
 *  `packages/core/src/agent/very-long-name.ts` -> `…/agent/very-long-name.ts`。
 *  这里只用于 @ 补全菜单 - 读者更关心“是哪一个文件”，而不是它顶层属于哪个包，
 *  所以丢掉前面的目录能保留最有信息量的字符。
 *  只有在 basename 自己都超长时，才会退回到尾部截断。 */
export function truncatePathFromStart(p: string, maxCols: number): string {
  if (visualWidth(p) <= maxCols) return p
  const segs = p.split('/')
  const basename = segs[segs.length - 1] ?? ''
  // basename 自己也超长 - 那就尾部截断（很少见，basename 一般不会长过终端宽度，
  // 但单个超长文件不应该把渲染搞崩）。
  if (visualWidth(basename) >= maxCols - 1) {
    return '…' + basename.slice(basename.length - Math.max(1, maxCols - 1))
  }
  let acc = basename
  for (let i = segs.length - 2; i >= 0; i--) {
    const next = segs[i] + '/' + acc
    if (visualWidth('…/' + next) > maxCols) break
    acc = next
  }
  return '…/' + acc
}

/** 去掉 ANSI CSI + OSC 转义序列，这样视觉宽度计算就不会把它们算进去。
 *  这用于统计一段 scrollback payload 会占多少终端行，
 *  从而决定 pre-scroll 要滚多少行 - 如果算多了或算少了，
 *  就会留下可见空隙，或者让内容溢出进 frame 区域。 */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
}

/** 计算 `content` 写在一块空白区域顶部时会占多少显示行。
 *  会按 `termWidth` 处理换行，并使用视觉宽度（兼容 CJK）的算法。
 *  尾部的 `\n` 不计为一行（光标只是前进到下一行，但那一行没有内容）。 */
export function countContentRows(content: string, termWidth: number): number {
  const clean = stripAnsi(content).replace(/\r\n/g, '\n').replace(/\r/g, '')
  const lines = clean.split('\n')
  const effective = clean.endsWith('\n') ? lines.slice(0, -1) : lines
  const w = Math.max(1, termWidth)
  let rows = 0
  for (const line of effective) {
    rows += Math.max(1, Math.ceil(visualWidth(line) / w))
  }
  return rows
}
