// @x-code-cli/cli - 共享 UI 工具函数。
//
// 这里放的是多个模块都会用到的小工具。统一抽出来是为了避免
// 各文件各写一份后慢慢漂移，最后行为不一致。
import type { DisplayToolCall } from '@x-code-cli/core'
import { getShellProvider } from '@x-code-cli/core'

// ── Layout constants ───────────────────────────────────────────────────

/** tool-result 行的缩进量，确保正文能对齐到 `   ⎿  `
 *  这个括号下方（3 个空格 + 括号 + 2 个空格 = 6 个 cell）。
 *  scrollback writer（stdout-writer）和 diff renderer（render-diff）
 *  都会用到它。 */
export const RESULT_INDENT = '      '

// ── Line-ending normalization ──────────────────────────────────────────

/** 将换行统一成 `\n`。
 *  这是任何终端写入前的关键步骤：Windows 粘贴 / 剪贴板内容常常带着
 *  `\r\n`，甚至单独的 `\r`；而终端里的裸 `\r` 表示“把光标移到当前行
 *  的第 0 列”，后续字符会直接覆盖那一行上原本打印的内容。 */
export function normalizeLineEndings(s: string): string {
  return s.replace(/\r\n?/g, '\n')
}

// ── Boolean argument parsing ───────────────────────────────────────────

/** 将字符串解析为 CLI 可用的布尔值。
 *  接受 `on/true/1/enable/enabled` → true，
 *  `off/false/0/disable/disabled` → false，
 *  其他输入 → null（调用方可以据此报错）。 */
export function parseBooleanArg(s: string): boolean | null {
  const trimmed = s.trim().toLowerCase()
  if (trimmed === 'on' || trimmed === 'true' || trimmed === '1' || trimmed === 'enable' || trimmed === 'enabled')
    return true
  if (trimmed === 'off' || trimmed === 'false' || trimmed === '0' || trimmed === 'disable' || trimmed === 'disabled')
    return false
  return null
}

// ── Duration formatting ────────────────────────────────────────────────

export interface DurationFmtOptions {
  /** 小于 1 秒时的精度：duration < 60s 时 seconds 字段保留几位小数。默认 1。 */
  precision?: number
  /** 为 true 时省略 seconds 字段结尾的 `s`。默认 false。 */
  compact?: boolean
}

/**
 * Format a millisecond duration into a human-readable string.
 *   <1s  → `"120ms"`
 *   <60s → `"3.5s"` (precision from options)
 *   >=60s → `"2m 15s"` (or `"2m"` when compact && secs === 0)
 */
export function formatDuration(ms: number, opts: DurationFmtOptions = {}): string {
  const { precision = 1, compact = false } = opts
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(precision)}s`
  const minutes = Math.floor(seconds / 60)
  const secs = Math.round(seconds % 60)
  if (compact && secs === 0) return `${minutes}m`
  return `${minutes}m ${secs}s`
}

// ── 工具展示辅助函数 ───────────────────────────────────────────────

function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[_-]/g, '')
}

export function isCollapsibleReadOnlyTool(toolName: string): boolean {
  return COLLAPSIBLE_READ_ONLY_TOOLS.has(normalizeToolName(toolName))
}

const COLLAPSIBLE_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'readfile',
  'read',
  'glob',
  'grep',
  'search',
  'listdir',
  'ls',
])

export function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

const SHELL_LABELS: Record<string, string> = {
  bash: 'Bash',
  zsh: 'Zsh',
  powershell: 'PowerShell',
}

export function getToolLabel(toolName: string): string {
  const n = normalizeToolName(toolName)
  if (n === 'shell' || n === 'bash') return SHELL_LABELS[getShellProvider().type] ?? 'Shell'
  if (n === 'readfile' || n === 'read') return 'Read'
  if (n === 'writefile' || n === 'write') return 'Write'
  if (n === 'edit' || n === 'update') return 'Update'
  if (n === 'glob') return 'Glob'
  if (n === 'grep' || n === 'search') return 'Grep'
  if (n === 'listdir' || n === 'ls') return 'ListDir'
  if (n === 'websearch') return 'WebSearch'
  if (n === 'webfetch') return 'WebFetch'
  if (n === 'askuser') return 'AskUser'
  if (n === 'enterplanmode') return 'EnterPlanMode'
  if (n === 'exitplanmode') return 'ExitPlanMode'
  if (n === 'task') return 'Task'
  if (n === 'todowrite') return 'TodoWrite'
  return toolName
}

export function getToolInputPreview(toolName: string, input: Record<string, unknown>): string {
  const n = normalizeToolName(toolName)

  if (n === 'shell' || n === 'bash') {
    return (input.command as string) || ''
  }

  if (n === 'readfile' || n === 'read' || n === 'writefile' || n === 'write' || n === 'edit' || n === 'update') {
    return (input.filePath as string) || (input.file_path as string) || (input.path as string) || ''
  }

  if (n === 'listdir' || n === 'ls') {
    return (input.dirPath as string) || (input.dir_path as string) || (input.path as string) || ''
  }

  if (n === 'glob' || n === 'grep' || n === 'search') {
    return (input.pattern as string) || (input.query as string) || ''
  }

  if (n === 'websearch' || n === 'webfetch') {
    return (input.query as string) || (input.url as string) || ''
  }

  if (n === 'task') {
    return (input.description as string) || ''
  }

  if (n === 'askuser') {
    const q = (input.question as string) || ''
    const firstLine = q.split(/\r?\n/)[0]?.trim() || ''
    return firstLine
  }

  // 兜底方案：展示第一个字符串值，而不是直接 JSON.stringify。
  for (const val of Object.values(input)) {
    if (typeof val === 'string' && val.length <= 100) return val
  }

  return ''
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(tokens)
}

export interface ReadGroupSummary {
  label: string
  detail?: string
}

export function formatReadGroupSummary(tools: readonly DisplayToolCall[]): ReadGroupSummary {
  let readCount = 0
  let grepCount = 0
  let globCount = 0
  let lsCount = 0
  const readPaths: string[] = []

  for (const tc of tools) {
    const n = normalizeToolName(tc.toolName)
    if (n === 'read' || n === 'readfile') {
      readCount++
      const p = (tc.input.filePath as string) || (tc.input.file_path as string) || (tc.input.path as string) || ''
      if (p) readPaths.push(basename(p))
    } else if (n === 'grep' || n === 'search') {
      grepCount++
    } else if (n === 'glob') {
      globCount++
    } else if (n === 'listdir' || n === 'ls') {
      lsCount++
    }
  }

  const clauses: string[] = []
  if (readCount > 0) clauses.push(`read ${readCount} file${readCount === 1 ? '' : 's'}`)
  if (grepCount > 0) clauses.push(`searched for ${grepCount} pattern${grepCount === 1 ? '' : 's'}`)
  if (globCount > 0) clauses.push(`globbed ${globCount} pattern${globCount === 1 ? '' : 's'}`)
  if (lsCount > 0) clauses.push(`listed ${lsCount} director${lsCount === 1 ? 'y' : 'ies'}`)

  if (clauses.length > 0) {
    const first = clauses[0]!
    clauses[0] = first.charAt(0).toUpperCase() + first.slice(1)
  }
  const label = clauses.join(', ')

  let detail: string | undefined
  if (readPaths.length > 0) {
    const shown = readPaths.slice(0, 3).join(', ')
    const rest = readPaths.length > 3 ? `, +${readPaths.length - 3} more` : ''
    detail = shown + rest
  }

  return detail ? { label, detail } : { label }
}

export function getToolResultSummary(toolName: string, output: string | undefined, status: string): string | null {
  if (status === 'denied') return 'Denied by user'
  if (!output) return 'Done'

  // 下面这些按工具定制的成功摘要是给 happy path 用的
  //（比如 “Wrote file”、“Applied changes”）。
  // 一旦工具失败了——权限拒绝、hook 拒绝、异常——这些欢快文案就会误导用户：
  // 圆点虽然变红了，但文字仍然像成功。这里改成简短错误标签，
  // 让下面的 markdown 正文去承载真实错误信息。
  if (status === 'error') return 'Failed'

  const n = normalizeToolName(toolName)

  if (n === 'writefile' || n === 'write') {
    const m = output.match(/\((\d+) lines?\)/)
    if (m) return `Wrote ${m[1]} lines`
    return 'Wrote file'
  }

  if (n === 'edit' || n === 'update') {
    return 'Applied changes'
  }

  if (n === 'readfile' || n === 'read') {
    const lineCount = (output.match(/\n/g) || []).length + 1
    return `${lineCount} lines`
  }

  if (n === 'listdir' || n === 'ls') {
    const entries = output
      .trim()
      .split('\n')
      .filter((l) => l.trim())
    return entries.length <= 6
      ? entries.join('\n')
      : entries.slice(0, 3).join('\n') + `\n... +${entries.length - 3} items`
  }

  if (n === 'glob') {
    const files = output
      .trim()
      .split('\n')
      .filter((l) => l.trim())
    return `${files.length} file${files.length !== 1 ? 's' : ''} matched`
  }

  if (n === 'grep' || n === 'search') {
    const lines = output
      .trim()
      .split('\n')
      .filter((l) => l.trim())
    return `${lines.length} result${lines.length !== 1 ? 's' : ''}`
  }

  if (n === 'task') {
    const statsMatch = output.match(/<task_stats\s+tool_calls="(\d+)"\s+tokens="(\d+)"\s+duration_ms="(\d+)"\s*\/>/)
    const resultMatch = output.match(/<task_result>\n?([\s\S]*?)\n?<\/task_result>/)
    const body = resultMatch ? resultMatch[1]! : output.replace(/<task_stats[^/]*\/>/, '').trim()
    const lines = body
      .trim()
      .split('\n')
      .filter((l) => l.trim())

    if (statsMatch) {
      const toolCalls = parseInt(statsMatch[1]!, 10)
      const tokens = parseInt(statsMatch[2]!, 10)
      const durationMs = parseInt(statsMatch[3]!, 10)
      const toolStr = toolCalls === 1 ? '1 tool use' : `${toolCalls} tool uses`
      const tokenStr = formatTokenCount(tokens)
      const durStr = formatDuration(durationMs, { compact: true, precision: 0 })
      return `Done (${toolStr} · ${tokenStr} tokens · ${durStr})`
    }

    if (lines.length === 0) return 'Done'
    if (lines.length <= 3) return lines.join('\n')
    return lines.slice(0, 2).join('\n') + `\n... +${lines.length - 2} lines`
  }

  if (n === 'websearch') {
    return 'Did 1 search'
  }

  if (n === 'webfetch') {
    return 'Fetched page'
  }

  if (n === 'shell' || n === 'bash') {
    let text = output.trim()
    text = text.replace(/^exit code: 0\n?/, '')
    const lines = text.split('\n').filter((l) => l.trim())
    if (lines.length === 0) return 'Done'
    if (lines.length <= 4) return lines.join('\n')
    return lines.slice(0, 3).join('\n') + `\n... +${lines.length - 3} lines`
  }

  const lines = output
    .trim()
    .split('\n')
    .filter((l) => l.trim())
  if (lines.length === 0) return 'Done'
  if (lines.length <= 3) return lines.join('\n')
  return lines.slice(0, 2).join('\n') + `\n... +${lines.length - 2} lines`
}
