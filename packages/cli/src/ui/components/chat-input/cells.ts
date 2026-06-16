// cell 数据结构，以及给 cell-diff 渲染器用的 cell 构造函数。
//
// 每一帧都是一个二维 Cell 网格。ChatInput.tsx 里的 diff loop 会沿着网格
// 遍历，只对和上一帧相比 `(char, style)` 发生变化的 cell 输出 SGR / 文本字节。
// `width` 用来告诉 diff loop：如果一个 CJK 字符占了 2 列，就要跳过它右边那半格，
// 避免重复输出同一个字形。
import { charWidth } from '../../text-width.js'
import { S_NONE } from './palette.js'

export interface Cell {
  char: string
  style: string
  width: number
}

export function cellsEqual(a: Cell, b: Cell): boolean {
  return a.char === b.char && a.style === b.style
}

/** 把一整行 Cell 渲染成单个带 ANSI 样式的字符串。
 *  不做光标移动，不做行尾擦除。
 *  主要给 scrollback-commit 的 inline-stream 路径使用，这样 frame 行就能
 *  作为 `content + frame` 的一部分直接输出。 */
export function renderRowToAnsi(cells: Cell[]): string {
  let out = '\x1b[0m'
  let lastStyle = '\x1b[0m'
  for (const cell of cells) {
    if (cell.style !== lastStyle) {
      out += cell.style
      lastStyle = cell.style
    }
    out += cell.char
  }
  return out + '\x1b[0m'
}

export function textToCells(text: string, style: string): Cell[] {
  const cells: Cell[] = []
  for (const ch of text) cells.push({ char: ch, style, width: charWidth(ch) })
  return cells
}

/** 把已经包含 ANSI SGR 转义的字符串解析成 Cell[]。
 *  主要给 select-options 对话框的预览窗格使用，这样由 render-diff 生成的
 *  `/syntax` 预览行（里面已经带了各种前景色 / 背景色 escape）就能被拆回
 *  cell buffer，并且每个字符都保留它当下对应的样式。
 *
 *  每个 cell 的 `style` 都是 `\x1b[0m` 加上当前时刻仍然生效的全部 SGR escape。
 *  cell-diff 发射器要求每个 cell 的样式本身就是自包含的（它只是在转场时直接
 *  blit `cell.style`，不会先做一次统一 reset），所以这里必须先 reset，
 *  把前一个 cell 留下来的终端状态清干净。SGR reset（`\x1b[0m` / `\x1b[m`）
 *  会清掉当前激活栈；非 reset escape 则按顺序追加即可（我们不刻意区分
 *  前景 / 背景 / 属性三类 bucket，因为 ANSI 自己会让后发的 escape 覆盖先发的）。
 *  这样可能会发出少量冗余字节，但渲染一定正确。 */
export function ansiTextToCells(text: string): Cell[] {
  const cells: Cell[] = []
  const active: string[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '\x1b' && text[i + 1] === '[') {
      let j = i + 2
      while (j < text.length && !/[A-Za-z]/.test(text[j]!)) j++
      if (j >= text.length) {
        // 转义不完整：把它当作普通字符，退出 escape 解析状态。
        i++
        continue
      }
      const escape = text.slice(i, j + 1)
      if (/^\x1b\[0?m$/.test(escape)) {
        active.length = 0
      } else if (/^\x1b\[[0-9;]*m$/.test(escape)) {
        active.push(escape)
      }
      // 非 SGR 的 CSI 序列直接跳过。
      // 预览行里理论上不该出现它们，但也不希望它们被当成可见文本。
      i = j + 1
      continue
    }
    const style = active.length === 0 ? S_NONE : '\x1b[0m' + active.join('')
    cells.push({ char: ch, style, width: charWidth(ch) })
    i++
  }
  return cells
}
