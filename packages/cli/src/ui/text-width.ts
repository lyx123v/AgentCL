// @x-code-cli/cli - 面向 CJK 的视觉宽度辅助函数。
//
// JavaScript 的 `string.length` 统计的是 UTF-16 code unit，
// 但终端渲染东亚宽字符时会占用两个 cell。两者混用会把任何“按列补齐”
// 或“按列截断”的逻辑搞坏：一行会超出预期宽度，终端自动换行，
// 用户就会看到多出来的空白“行”和错位的列，尤其是包含 CJK /
// 全角标点的文本更容易出问题。
//
// 这些范围遵循 Unicode East_Asian_Width=Wide / Fullwidth，
// 也就是终端普遍都按双宽处理的那部分。这里是所有渲染器的单一事实来源：
// chat-input 框、scrollback diff（render-diff）和 markdown 表格布局
//（render-markdown）都要读这里。以前如果只在一处补了范围、另一处没补，
// 就会重新出现这类对齐漂移，所以这个模块必须统一收口。

export function isWide(cp: number): boolean {
  return (
    // CJK 统一表意文字 + 扩展 A + 兼容表意文字
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    // 韩文：字母（Jamo）+ 音节
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    // 半角和全角形式（全角半形：0xff00-0xff60，符号：0xffe0-0xffe6）
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    // CJK 扩展 B-F
    (cp >= 0x20000 && cp <= 0x2fa1f) ||
    // CJK 部首补充 + 康熙部首 + 表意文字描述字符
    (cp >= 0x2e80 && cp <= 0x2fff) ||
    // CJK 符号 + 平假名 + 片假名 + 注音符号 + 带圈 CJK + 兼容字符
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0x3100 && cp <= 0x312f) ||
    (cp >= 0x3200 && cp <= 0x32ff) ||
    (cp >= 0x3300 && cp <= 0x33ff) ||
    // 彝文音节 + 彝文部首
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    // CJK 兼容形式
    (cp >= 0xfe30 && cp <= 0xfe4f)
  )
}

export function charWidth(ch: string): number {
  return isWide(ch.codePointAt(0)!) ? 2 : 1
}

export function visualWidth(str: string): number {
  let w = 0
  for (const ch of str) w += charWidth(ch)
  return w
}

/** 取出 `str` 的最长前缀，使其视觉宽度不超过 `maxCols`。
 *  遇到会跨过边界的宽字符时，会停在它之前，绝不会把一个宽 cell
 *  拆到两行里。 */
export function sliceByWidth(str: string, maxCols: number): string {
  let w = 0
  let i = 0
  for (const ch of str) {
    const cw = charWidth(ch)
    if (w + cw > maxCols) break
    w += cw
    i += ch.length
  }
  return str.slice(0, i)
}
