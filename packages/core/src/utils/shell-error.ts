// @x-code-cli/core — 折叠 Shell stderr 里的噪声
//
// PowerShell 和 cmd 在解析 / 语法错误时通常会输出多行诊断：
// `At line:X char:Y` 头部、出错源码行、插入符下划线（`+ ~~~~`）、
// 一行自由描述，以及尾部标记（`+ CategoryInfo` 和
// `+ FullyQualifiedErrorId`）。当 agent 因命令引号问题反复重试时，
// 这些 5 到 10 行的堆栈会比真正有用的诊断信号更快挤满上下文，
// 所以这里会把每个错误块压缩成一行。
//
// 检测规则：
//   - 块的开始：匹配 `At line:X char:Y`
//   - 块的结束：以下任一条件先出现就停止
//     1. `FullyQualifiedErrorId` 行（PowerShell 固定的终止行）
//     2. 新的错误块开始
//     3. 达到硬编码扫描上限
//   - 扫描上限用于兜底，防止缺少 FQID 行的异常输入把无关输出一起吞掉。

/** 单个错误块最多扫描的行数。
 *  PowerShell 错误栈通常只有 5 行左右，基本不会接近 12；
 *  超出这个范围的内容大概率已经不是同一个错误块了。 */
const BLOCK_SCAN_LIMIT = 12

const PS_BLOCK_START = /^At line:\d+ char:\d+/
const PS_FQID_LINE = /^\s*\+\s*FullyQualifiedErrorId\s*:/

/** 判断一行是否为 PowerShell 错误块的起始行。 */
function isBlockStart(line: string): boolean {
  return PS_BLOCK_START.test(line)
}

/** 判断一行是否为 `FullyQualifiedErrorId` 终止行。 */
function isFqidTerminator(line: string): boolean {
  return PS_FQID_LINE.test(line)
}

/**
 * 把 `text` 中的 PowerShell 多行错误块压缩为单行摘要。
 * 摘要会保留开头的 `At line:X char:Y` 头信息，这是我们保留的核心诊断信号；
 * 其余正文、插入符、CategoryInfo 和 FullyQualifiedErrorId 等延续行都会被折叠掉。
 *
 * 如果没有识别到可折叠的错误块，就原样返回输入。
 * 这个函数可以安全用于任意 shell 输出：不在错误块内的行会逐字保留。
 */
export function foldShellErrorNoise(text: string): string {
  if (!text) return text
  // 快速路径：大多数 shell 输出都不是 PowerShell 错误栈。
  if (!text.includes('At line:')) return text

  const lines = text.split(/\r?\n/)
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!isBlockStart(line)) {
      out.push(line)
      i++
      continue
    }

    out.push(`${line.trim()} [PS parse error — details folded]`)
    i++

    // 吃掉当前错误块的正文。
    // 遇到自然终止行 `FullyQualifiedErrorId` 或新的错误头就停止；
    // 扫描上限只是防御性兜底，真实的 PowerShell 错误几乎不会触发它。
    let scanned = 0
    while (i < lines.length && scanned < BLOCK_SCAN_LIMIT) {
      if (isBlockStart(lines[i])) break
      const terminator = isFqidTerminator(lines[i])
      i++
      scanned++
      if (terminator) break
    }
  }

  return out.join('\n')
}
