// @x-code-cli/core — grep 工具（基于 ripgrep 的内容搜索）
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { tool } from 'ai'

import { z } from 'zod'

import { formatToolError } from '../utils/tool-errors.js'
import { reportProgress } from './progress.js'
import { getRipgrepPath } from './utils.js'

const execFileAsync = promisify(execFile)

const DEFAULT_HEAD_LIMIT = 250
const MAX_COLUMNS = 500
const RG_MAX_BUFFER = 20 * 1024 * 1024

export const grep = tool({
  description: `一个基于 ripgrep 的高性能搜索工具。

使用说明：
- 只要是搜索文件内容，就始终优先使用这个 `grep` 工具。不要把 `grep` 或 `rg` 当作 shell 命令来调用，这个工具已经针对权限和访问路径做了优化。
- 支持完整正则语法（例如 `"log.*Error"`、`"function\\\\s+\\\\w+"`）。
- 可以用 `glob` 参数过滤文件（例如 `"*.ts"`、`"*.{ts,tsx}"`）。
- 模式语法遵循 ripgrep：如果要匹配字面量花括号，需要转义（例如在 Go 代码里搜索 `interface{}` 时要写 `interface\\\\{\\\\}`）。
- 返回结果最多保留 `headLimit` 行（默认 ${DEFAULT_HEAD_LIMIT} 行），超长行会在 ${MAX_COLUMNS} 个字符处截断。`,
  inputSchema: z.object({
    pattern: z.string().describe('要搜索的正则表达式模式'),
    path: z.string().optional().describe('要搜索的文件或目录（默认为当前工作目录）'),
    glob: z.string().optional().describe('用于过滤文件的 glob 模式（例如 `"*.ts"`、`"*.{ts,tsx}"`）'),
    headLimit: z.number().optional().describe(`输出结果最多保留多少行（默认：${DEFAULT_HEAD_LIMIT}）`),
  }),
  /** 执行正则内容搜索，并在结果过多时按 headLimit 截断输出。 */
  execute: async ({ pattern, path: searchPath, glob: globPattern, headLimit }, { toolCallId }) => {
    try {
      const rgPath = getRipgrepPath()
      const limit = headLimit ?? DEFAULT_HEAD_LIMIT
      const args = [
        '--no-heading',
        '--line-number',
        '--color',
        'never',
        '--max-columns',
        String(MAX_COLUMNS),
        '--max-columns-preview',
      ]
      if (globPattern) {
        args.push('--glob', globPattern)
      }
      args.push(pattern)
      args.push(searchPath ?? process.cwd())

      reportProgress(toolCallId, `正在搜索 /${pattern}/`)
      const { stdout } = await execFileAsync(rgPath, args, {
        maxBuffer: RG_MAX_BUFFER,
        timeout: 30000,
      })
      const out = stdout.trim()
      if (!out) return '没有找到匹配内容。'

      const lines = out.split('\n')
      if (lines.length <= limit) return out
      const truncated = lines.slice(0, limit).join('\n')
      return `${truncated}\n\n... [还有 ${lines.length - limit} 行未显示，至少匹配到 ${lines.length} 行，结果上限为 ${limit}。请缩小搜索模式，或配合 glob 减少结果。]`
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 1) {
        return '没有找到匹配内容。'
      }
      return formatToolError('搜索内容', err)
    }
  },
})
