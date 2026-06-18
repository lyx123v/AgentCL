// @x-code-cli/core — glob 工具（基于模式搜索文件，底层使用 ripgrep）
//
// 我们把实际的文件遍历交给 ripgrep（`rg --files --glob ...`），
// 而不是使用 Node 的 glob 库，原因有三：
//   1. `grep` 工具本来就依赖 ripgrep，复用它可以减少跨工具依赖面。
//   2. ripgrep 遍历超大目录树很快（Rust + 并行目录遍历），
//      并且默认遵守 .gitignore。
//   3. ripgrep 的 `--sortr=modified` 可以提供确定性的“最近修改优先”排序。
//      当结果被截断时，最相关、最近的文件更容易保留下来。
//
// 这样也让 glob 的实际行为真正与其描述一致。此前描述里承诺按 mtime 排序，
// 但底层却依赖库默认顺序（globby 的字母序）。
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

import { tool } from 'ai'

import { z } from 'zod'

import { formatToolError } from '../utils/tool-errors.js'
import { reportProgress } from './progress.js'
import { getRipgrepPath } from './utils.js'

const execFileAsync = promisify(execFile)

const MAX_GLOB_RESULTS = 200
const RG_MAX_BUFFER = 20 * 1024 * 1024

export const glob = tool({
  description:
    `查找匹配 glob 模式的文件。返回按修改时间排序的绝对路径，最新修改的文件排在最前面。` +
    `结果最多返回 ${MAX_GLOB_RESULTS} 个文件；如果被截断，请使用更具体的模式。`,
  inputSchema: z.object({
    pattern: z.string().describe('Glob 模式（例如 `"**/*.ts"`、`"src/**/*.tsx"`）'),
    cwd: z.string().optional().describe('要搜索的目录（默认为当前工作目录）'),
  }),
  /** 执行 glob 搜索，并返回按最近修改时间排序后的绝对路径列表。 */
  execute: async ({ pattern, cwd }, { toolCallId }) => {
    try {
      const searchDir = cwd ?? process.cwd()
      reportProgress(toolCallId, `正在匹配 ${pattern}`)
      // ripgrep 参数说明：
      //   --files          — 列出文件，而不是搜索文件内容
      //   --sortr=modified — 按修改时间排序，最近修改排前面
      //   --hidden         — 包含 .eslintrc / .prettierrc 这类隐藏文件
      //   --glob '!.git'   — 显式排除 git 元数据目录。
      //                      .gitignore 通常不会列出 .git/（git 自己管理它），
      //                      所以如果没有这个参数，`--hidden` 会直接深入
      //                      .git/objects 并返回大量内部哈希文件。
      //   --glob <pattern> — 用户提供的 glob 过滤条件（相对于搜索目录）
      //
      // 有两类模式需要特殊处理，因为它们和 ripgrep 的白名单式 `--glob`
      // 语义配合时容易产生反直觉结果：
      //
      //   • 全量匹配模式（"**/*"、"**"、"*"）会被直接忽略：
      //     `--glob "**/*"` 会被当成显式白名单，并覆盖 .gitignore，
      //     从而把 node_modules / dist 等目录也都带进来，通常会产生
      //     成千上万条纯噪音结果。这里我们干脆不传用户的 `--glob`，
      //     让 ripgrep 走默认文件遍历逻辑（也就是继续遵守 .gitignore）。
      const isCatchAll = /^(\*\*\/?\*?|\*)$/.test(pattern.trim())
      const args = ['--files', '--sortr=modified', '--hidden', '--glob', '!.git']
      if (!isCatchAll) {
        args.push('--glob', pattern)
      }
      const { stdout } = await execFileAsync(getRipgrepPath(), args, {
        cwd: searchDir,
        maxBuffer: RG_MAX_BUFFER,
        timeout: 30000,
      })
      const out = stdout.trim()
      if (!out) return '没有找到匹配该模式的文件。'
      const relatives = out.split('\n')
      const absolutes = relatives.map((p) => (path.isAbsolute(p) ? p : path.join(searchDir, p)))
      const truncated = absolutes.length > MAX_GLOB_RESULTS
      const result = absolutes.slice(0, MAX_GLOB_RESULTS).join('\n')
      if (truncated) {
        return `${result}\n\n... [还有 ${absolutes.length - MAX_GLOB_RESULTS} 个文件未显示，共匹配 ${absolutes.length} 个，结果上限为 ${MAX_GLOB_RESULTS}。请使用更具体的模式来缩小范围。]`
      }
      return result
    } catch (err) {
      // 当没有文件匹配时，ripgrep 会以退出码 1 结束。
      // 这里把它当作正常的“空结果”而不是错误返回，避免模型误以为工具失败并重复重试。
      if (err && typeof err === 'object' && 'code' in err && err.code === 1) {
        return '没有找到匹配该模式的文件。'
      }
      return formatToolError('搜索文件', err)
    }
  },
})
