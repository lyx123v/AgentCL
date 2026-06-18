// grep 工具测试（基于 ripgrep 的内容搜索）。
// 注意：执行类测试依赖 ripgrep 二进制，不可用时会跳过。
import { describe, expect, it } from 'vitest'

import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { grep } from '../src/tools/grep.js'

// 检查当前环境是否可用 ripgrep，逻辑与 grep 工具本身保持一致。
function isRipgrepAvailable(): boolean {
  // 先检查 @vscode/ripgrep（与 grep 工具的实际行为一致）。
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rg = require('@vscode/ripgrep') as { rgPath: string }
    execFileSync(rg.rgPath, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    /* fall through */
  }
  // 回退到系统级 rg。
  try {
    execFileSync('rg', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const hasRg = isRipgrepAvailable()

describe('grep 工具', () => {
  it.skipIf(!hasRg)('能在文件中找到匹配内容', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-grep-test-'))
    await fs.writeFile(path.join(tmpDir, 'hello.ts'), 'const greeting = "hello world"\nconst farewell = "goodbye"')
    await fs.writeFile(path.join(tmpDir, 'other.ts'), 'const x = 42')

    const result = await grep.execute!(
      { pattern: 'hello', path: tmpDir },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    )
    expect(result).toContain('hello')
    expect(result).toContain('hello.ts')

    await fs.rm(tmpDir, { recursive: true })
  })

  it.skipIf(!hasRg)('什么都没找到时会返回无匹配提示', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-grep-test-'))
    await fs.writeFile(path.join(tmpDir, 'empty.ts'), 'const x = 1')

    const result = await grep.execute!(
      { pattern: 'nonexistent_pattern_xyz', path: tmpDir },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    )
    expect(result).toContain('No matches found')

    await fs.rm(tmpDir, { recursive: true })
  })

  it.skipIf(!hasRg)('支持 glob 过滤', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-grep-test-'))
    await fs.writeFile(path.join(tmpDir, 'code.ts'), 'hello world')
    await fs.writeFile(path.join(tmpDir, 'code.js'), 'hello world')

    const result = await grep.execute!(
      { pattern: 'hello', path: tmpDir, glob: '*.ts' },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    )
    expect(result).toContain('code.ts')
    expect(result).not.toContain('code.js')

    await fs.rm(tmpDir, { recursive: true })
  })

  it.skipIf(!hasRg)('结果超过 headLimit 时会截断输出', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-grep-limit-'))
    const lines: string[] = []
    for (let i = 0; i < 30; i++) {
      lines.push(`match_target line ${i}`)
    }
    await fs.writeFile(path.join(tmpDir, 'big.txt'), lines.join('\n'))

    const result = (await grep.execute!(
      { pattern: 'match_target', path: tmpDir, headLimit: 5 },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    )) as string
    expect(result).toContain('more lines not shown')
    expect(result).toContain('capped at 5')
    const matchLines = result.split('\n').filter((l) => l.includes('match_target') && !l.includes('...'))
    expect(matchLines.length).toBeLessThanOrEqual(5)

    await fs.rm(tmpDir, { recursive: true })
  })
})
