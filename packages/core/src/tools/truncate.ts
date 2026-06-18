// @x-code-cli/core — 工具输出截断
//
// 采用双预算截断：按“行数上限”或“字节上限”二选一，谁先触发就按谁截。
// 20/80 的头尾切分来自 gemini-cli；不同工具默认保留方向的思路来自 opencode。
// shell 输出适合只保留开头，因为尾部常重复提示符或退出信息；而文件读取和 grep
// 结果更适合保留头尾两端，这样文件开头上下文和最后一段都能看见。
//
// 为什么不再单独加字符数预算？因为 ASCII 下字符数等于字节数，字符预算和字节
// 预算重复；而中文等非 ASCII 内容里，provider 真正关心的是 UTF-8 字节数，
// 不是 UTF-16 code unit。若同时跑字符和字节两套限制，切片逻辑会更复杂，但
// 几乎没有行为收益。

/** 单次结果默认最大行数。超过后会进入截断逻辑。 */
export const MAX_TOOL_RESULT_LINES = 2000

/** 单次结果默认最大字节数（UTF-8）。
 *  既覆盖 ASCII 的超长单行压缩输出，也覆盖“字符数不多但传输字节很多”的中文内容。 */
export const MAX_TOOL_RESULT_BYTES = 50 * 1024

/** 头尾切片比例。0.2 表示保留前 20% 和后 80%。 */
export const DEFAULT_HEAD_RATIO = 0.2

export interface TruncateOptions {
  /** 超过多少行后开始截断，默认值见 {@link MAX_TOOL_RESULT_LINES}。 */
  maxLines?: number
  /** 允许的最大 UTF-8 字节数，默认值见 {@link MAX_TOOL_RESULT_BYTES}。 */
  maxBytes?: number
  /**
   * 截断时保留哪一段内容：
   *  - `head-tail`（默认）：保留前 20% 和后 80%，丢掉中间部分。
   *  - `head`：只保留前 N 字节，丢弃尾部。适合 shell 流式输出，尾部常是
   *    提示符或退出码噪音。
   *  - `tail`：只保留最后 N 字节，丢弃前部。适合日志类内容，重点通常在最近部分。
   */
  direction?: 'head-tail' | 'head' | 'tail'
  /** head-tail 模式下头部占比，默认值见 {@link DEFAULT_HEAD_RATIO}。 */
  headRatio?: number
}

/** 计算字符串的 UTF-8 字节长度。 */
function byteLength(str: string): number {
  return Buffer.byteLength(str, 'utf-8')
}

/** 按字节裁切 Buffer，并确保切点落在 UTF-8 边界上，避免生成替换字符。 */
function sliceBytes(buf: Buffer, bytes: number, direction: 'head' | 'tail'): Buffer {
  if (buf.length <= bytes) return buf
  if (direction === 'head') {
    let end = bytes
    // 回退到最后一个完整码点的起始字节。UTF-8 续字节的高位形态是 `10xxxxxx`，
    // 因此我们要停在它们之前。
    while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
    return buf.subarray(0, end)
  }
  let start = buf.length - bytes
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
  return buf.subarray(start)
}

type SliceResult = {
  sliced: string
  /** `sliced` 中头部结束、尾部开始的位置（仅 head-tail 模式）。
   *  用来把“已截断”提示平滑插进中间。 */
  headEnd: number | null
}

/** 先按行数预算裁切文本，并返回被丢弃的行数。 */
function applyLineSlice(
  result: string,
  maxLines: number,
  direction: 'head-tail' | 'head' | 'tail',
  headRatio: number,
): { result: SliceResult; linesDropped: number } {
  const lines = result.split('\n')
  if (lines.length <= maxLines) return { result: { sliced: result, headEnd: null }, linesDropped: 0 }

  if (direction === 'head') {
    return {
      result: { sliced: lines.slice(0, maxLines).join('\n'), headEnd: null },
      linesDropped: lines.length - maxLines,
    }
  }
  if (direction === 'tail') {
    return {
      result: { sliced: lines.slice(-maxLines).join('\n'), headEnd: null },
      linesDropped: lines.length - maxLines,
    }
  }

  const headLines = Math.max(1, Math.floor(maxLines * headRatio))
  const tailLines = maxLines - headLines
  const head = lines.slice(0, headLines).join('\n')
  const tail = lines.slice(-tailLines).join('\n')
  return { result: { sliced: head + '\n' + tail, headEnd: head.length }, linesDropped: lines.length - maxLines }
}

/** 再按字节预算裁切文本，保证最终结果不会超出传输大小限制。 */
function applyByteSlice(
  input: SliceResult,
  maxBytes: number,
  direction: 'head-tail' | 'head' | 'tail',
  headRatio: number,
): SliceResult {
  const buf = Buffer.from(input.sliced, 'utf-8')
  if (buf.length <= maxBytes) return input

  if (direction === 'head') return { sliced: sliceBytes(buf, maxBytes, 'head').toString('utf-8'), headEnd: null }
  if (direction === 'tail') return { sliced: sliceBytes(buf, maxBytes, 'tail').toString('utf-8'), headEnd: null }

  const headBudget = Math.max(256, Math.floor(maxBytes * headRatio))
  const tailBudget = maxBytes - headBudget
  const head = sliceBytes(buf, headBudget, 'head').toString('utf-8')
  const tail = sliceBytes(buf, tailBudget, 'tail').toString('utf-8')
  return { sliced: head + tail, headEnd: head.length }
}

/**
 * 把工具输出限制在行数 / 字节预算内。
 * 若两者都未超限则原样返回；否则补一行提示，让模型知道这是有意截断而非内容损坏。
 */
export function truncateToolResult(result: string, options: TruncateOptions = {}): string {
  const maxLines = options.maxLines ?? MAX_TOOL_RESULT_LINES
  const maxBytes = options.maxBytes ?? MAX_TOOL_RESULT_BYTES
  const direction = options.direction ?? 'head-tail'
  const headRatio = options.headRatio ?? DEFAULT_HEAD_RATIO

  const origLines = (result.match(/\n/g)?.length ?? 0) + 1
  const origBytes = byteLength(result)
  const origChars = result.length

  if (origLines <= maxLines && origBytes <= maxBytes) return result

  // 先按行裁：这样能尽量保住按行组织的结构，比如 grep 命中或目录列表。
  // 但裁完行后仍可能超字节，例如单行特别长，或中文内容虽行数不多但字节很大，
  // 所以再由按字节裁切补最后一道限制。
  const lineSlice = applyLineSlice(result, maxLines, direction, headRatio)
  const byteSlice = applyByteSlice(lineSlice.result, maxBytes, direction, headRatio)

  const droppedChars = origChars - byteSlice.sliced.length
  const marker =
    lineSlice.linesDropped > 0
      ? `[输出已截断：省略了 ${lineSlice.linesDropped} 行 / ${droppedChars.toLocaleString()} 个字符，请缩小工具参数范围或读取更具体的区段]`
      : `[输出已截断：省略了 ${droppedChars.toLocaleString()} 个字符，因为结果超过了字节预算]`

  if (direction === 'head') return `${byteSlice.sliced}\n\n${marker}`
  if (direction === 'tail') return `${marker}\n\n${byteSlice.sliced}`

  if (byteSlice.headEnd != null && byteSlice.headEnd > 0 && byteSlice.headEnd < byteSlice.sliced.length) {
    return `${byteSlice.sliced.slice(0, byteSlice.headEnd)}\n\n${marker}\n\n${byteSlice.sliced.slice(byteSlice.headEnd)}`
  }
  return `${marker}\n\n${byteSlice.sliced}`
}
