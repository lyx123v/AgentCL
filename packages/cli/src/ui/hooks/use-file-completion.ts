// @x-code-cli/cli - 用于 @-mention 补全的工作区文件索引。
//
// 挂载时我们会对 cwd 做一次 BFS 扫描，生成一份扁平的
// `{relPath, isDirectory}` 列表，供菜单里的 fuzzy ranker 使用。
// 过滤分三层，按优先级从高到低：
//
//   1. 强黑名单（node_modules、.git、dist、.next、.x-code、out、
//      build、coverage）。这基本覆盖了大家实际都会忽略的目录，
//      也能在 `.gitignore` 解析前就避免把 vendor 树塞爆条目预算。
//   2. 简化版 .gitignore（只看顶层文件 - bare names 和 `*.suffix` 模式；
//      其他语法一律静默跳过）。这是 MVP 级方案；为了一个 UI 便利功能，
//      我们不引入 `ignore` 这个 npm 依赖。复杂仓库如果真的需要完整 git 语义，
//      也还有强黑名单兜底。
//   3. 跳过 symlink - 不需要 visited-set 也能防止循环。
//
// 再加上 5000 条 / 200ms 的软上限，这样超大的 monorepo 也不会在启动时把 UI 卡死。
// 一旦触顶，就只返回已经扫描到的内容；用户看到的是 BFS 前沿那一部分的建议，
// 也就是树里更浅、通常也更接近他们真正想输入的部分。
import fs from 'node:fs/promises'
import path from 'node:path'

import { useEffect, useState } from 'react'

import type { FileEntry } from '../file-completion.js'

const HARD_BLACKLIST: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  '.next',
  '.x-code',
  'out',
  'build',
  'coverage',
  '.turbo',
  '.cache',
])

const DEFAULT_MAX_ENTRIES = 5000
const DEFAULT_MAX_MS = 200

interface SimpleIgnore {
  /** 会在树中任何位置匹配的裸名字（`node_modules`、`dist`）。 */
  names: Set<string>
  /** 带点、且已经小写化的后缀（`.log`、`.tsbuildinfo`）。 */
  suffixes: Set<string>
}

const EMPTY_IGNORE: SimpleIgnore = { names: new Set(), suffixes: new Set() }

/** 以刻意简化的语义解析 .gitignore 内容：
 *  - 跳过空行、注释（`#`）、否定项（`!…`）
 *  - `*.ext`               -> 后缀 `.ext`
 *  - `name` / `/name` / `name/`  -> 裸名字（任意深度匹配）
 *  - 任何中间带 `/`、`**`、或者 `?` / `[` 的模式都丢弃
 *
 *  这能覆盖强黑名单漏掉的 90%+ 常见情况（`*.log`、`coverage`、
 *  `.DS_Store`、`*.tsbuildinfo`），而不用引入 `ignore` 包。
 *  对于忽略规则特别复杂的仓库，它们就只能部分受益于 gitignore 过滤；
 *  但强黑名单仍然会把最糟糕的那些目录挡住。 */
export function parseSimpleGitignore(content: string): SimpleIgnore {
  const names = new Set<string>()
  const suffixes = new Set<string>()
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith('!')) continue
    if (line.startsWith('*.') && !line.slice(2).match(/[\\/*?[\]]/)) {
      suffixes.add(line.slice(1).toLowerCase())
      continue
    }
    const stripped = line.replace(/^\/+/, '').replace(/\/+$/, '')
    if (!stripped) continue
    if (/[*?[\]/]/.test(stripped)) continue
    names.add(stripped)
  }
  return { names, suffixes }
}

async function loadIgnore(rootDir: string): Promise<SimpleIgnore> {
  try {
    const content = await fs.readFile(path.join(rootDir, '.gitignore'), 'utf-8')
    return parseSimpleGitignore(content)
  } catch {
    return EMPTY_IGNORE
  }
}

export interface ScanOptions {
  rootDir: string
  signal?: AbortSignal
  maxEntries?: number
  maxMs?: number
  /** 覆盖 gitignore。测试注入点 - 生产路径总是加载 `<rootDir>/.gitignore`。 */
  ignore?: SimpleIgnore
}

/** 对 rootDir 做 BFS，并应用上面的三层过滤。
 *  即便在 Windows 上也输出 POSIX 风格的 relPath，这样它们和菜单显示、
 *  以及用户输入的前向斜杠形式都一致。
 *  file-ingest.ts:118 会在后端把两种风格都规范化。 */
export async function scanWorkspaceFiles(opts: ScanOptions): Promise<FileEntry[]> {
  const { rootDir, signal, maxEntries = DEFAULT_MAX_ENTRIES, maxMs = DEFAULT_MAX_MS } = opts
  const ignore = opts.ignore ?? (await loadIgnore(rootDir))
  const start = Date.now()
  const result: FileEntry[] = []
  const queue: string[] = [''] // relative POSIX paths; '' = root

  const matchesSuffix = (name: string): boolean => {
    if (ignore.suffixes.size === 0) return false
    const lower = name.toLowerCase()
    for (const suf of ignore.suffixes) {
      if (lower.endsWith(suf)) return true
    }
    return false
  }

  while (queue.length > 0) {
    if (signal?.aborted) break
    if (Date.now() - start > maxMs) break
    if (result.length >= maxEntries) break

    const relDir = queue.shift()!
    const absDir = relDir === '' ? rootDir : path.join(rootDir, relDir)

    let dirents
    try {
      dirents = await fs.readdir(absDir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const dirent of dirents) {
      const name = dirent.name
      if (HARD_BLACKLIST.has(name)) continue
      if (ignore.names.has(name)) continue
      if (dirent.isSymbolicLink()) continue

      const isDir = dirent.isDirectory()
      const isFile = dirent.isFile()
      if (!isDir && !isFile) continue
      if (isFile && matchesSuffix(name)) continue

      const relPath = relDir ? `${relDir}/${name}` : name
      result.push({ relPath, isDirectory: isDir })
      if (isDir) queue.push(relPath)
      if (result.length >= maxEntries) break
    }
  }

  return result
}

export interface UseFileCompletionResult {
  entries: readonly FileEntry[]
  loading: boolean
}

/** React hook：挂载时扫描一次，暴露 entries + loading 标志。
 *  cwd 会在扫描时从 `process.cwd()` 读取，之后不再重新检查——
 *  shell 工具内部如果 chdir，也不会影响这个菜单。 */
export function useFileCompletion(): UseFileCompletionResult {
  const [entries, setEntries] = useState<readonly FileEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const ac = new AbortController()
    scanWorkspaceFiles({ rootDir: process.cwd(), signal: ac.signal })
      .then((result) => {
        if (cancelled) return
        setEntries(result)
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [])

  return { entries, loading }
}
