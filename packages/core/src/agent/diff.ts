// @x-code-cli/core — 编辑工具的 diff 负载。
//
// 在 writeFile / edit 成功后，由 tool-execution 计算并通过
// AgentCallbacks.onFileEdit 发给 UI，让滚动区能在工具条目下渲染
// 带颜色的 diff 区块。
//
// 模型本身看到的仍然只是 executeWriteTool 返回的短结果字符串
// （例如 `File edited: ...`）；这个 diff 负载仅供 UI 使用，不会进入
// state.messages 往返。
import { structuredPatch } from 'diff'

/** 一段连续的 diff hunk。
 *  结构参考 `diff` 包的 `StructuredPatchHunk`，但这里重新定义一份，
 *  这样消费方就不需要为了类型而额外依赖 `diff`。 */
export interface EditDiffHunk {
  /** 原文件中该 hunk 的起始行号。 */
  oldStart: number
  /** 原文件中该 hunk 覆盖的行数。 */
  oldLines: number
  /** 新文件中该 hunk 的起始行号。 */
  newStart: number
  /** 新文件中该 hunk 覆盖的行数。 */
  newLines: number
  /** hunk 的逐行内容，前缀分别表示上下文、新增、删除。 */
  lines: string[]
}

export interface EditDiffPayload {
  /** 发生变更的文件路径。 */
  filePath: string
  /** 结构化 diff 分块列表。 */
  hunks: EditDiffHunk[]
  /** 新增行数。 */
  additions: number
  /** 删除行数。 */
  removals: number
  /** 文件在写入前是否不存在。
   *  UI 会据此把标题从“新增 X 行，删除 Y 行”切换为“创建 N 行”。 */
  isCreate: boolean
  /** 新文件完整内容。
   *  仅在创建文件时填充，便于 UI 显示前几行预览。 */
  content?: string
}

const CONTEXT_LINES = 3
const DIFF_TIMEOUT_MS = 5_000

/**
 * 为单个文件变更构建结构化 patch 和增删统计。
 * 如果内容前后完全相同，则返回 `null`，调用方可以直接跳过 diff 展示。
 */
export function computeEditDiff(
  filePath: string,
  oldContent: string | null,
  newContent: string,
): EditDiffPayload | null {
  if (oldContent === null) {
    return {
      filePath,
      hunks: [],
      additions: countLines(newContent),
      removals: 0,
      isCreate: true,
      content: newContent,
    }
  }

  if (oldContent === newContent) return null

  const result = structuredPatch(filePath, filePath, oldContent, newContent, undefined, undefined, {
    context: CONTEXT_LINES,
    timeout: DIFF_TIMEOUT_MS,
  })

  // structuredPatch 超时会返回假值。磁盘上的改动实际上已经发生，
  // 只是拿不到 hunk 视图，因此退回到仅统计增删行数的摘要。
  const hunks: EditDiffHunk[] = result?.hunks ? result.hunks.map(toHunk) : []

  let additions = 0
  let removals = 0
  for (const h of hunks) {
    for (const line of h.lines) {
      if (line.startsWith('+')) additions++
      else if (line.startsWith('-')) removals++
    }
  }

  if (additions === 0 && removals === 0 && hunks.length === 0) {
    // diff 超时且没有 hunk 时，手工估算增删行数，让标题至少有可展示内容。
    // 这对纯替换场景不完全精确，但比完全丢失 diff 信息更实用。
    const oldLines = countLines(oldContent)
    const newLines = countLines(newContent)
    additions = Math.max(0, newLines - oldLines)
    removals = Math.max(0, oldLines - newLines)
  }

  return { filePath, hunks, additions, removals, isCreate: false }
}

/** 把底层 diff hunk 转成当前模块导出的轻量结构。 */
function toHunk(h: {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}): EditDiffHunk {
  return {
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
    lines: h.lines,
  }
}

/** 统计可见行数，并把单个末尾 `\n` 视作终止符处理。
 *  这样和编辑器的行号语义一致：3 行文件无论末尾是否带换行，都算 3 行。 */
function countLines(s: string): number {
  if (s.length === 0) return 0
  const parts = s.split('\n')
  return s.endsWith('\n') ? parts.length - 1 : parts.length
}
