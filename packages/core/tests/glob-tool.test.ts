// glob 工具测试。
import { describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { glob } from '../src/tools/glob.js'

describe('glob 工具', () => {
  it('能找到匹配模式的文件', async () => {
    // 使用一个包含已知文件的临时目录。
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-glob-test-'))
    await fs.writeFile(path.join(tmpDir, 'a.ts'), 'const a = 1')
    await fs.writeFile(path.join(tmpDir, 'b.ts'), 'const b = 2')
    await fs.writeFile(path.join(tmpDir, 'c.js'), 'const c = 3')

    const result = await glob.execute!(
      { pattern: '*.ts', cwd: tmpDir },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    )
    expect(result).toContain('a.ts')
    expect(result).toContain('b.ts')
    expect(result).not.toContain('c.js')

    // 清理临时目录。
    await fs.rm(tmpDir, { recursive: true })
  })

  it('没有匹配文件时会返回提示信息', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-glob-test-'))

    const result = await glob.execute!(
      { pattern: '*.xyz', cwd: tmpDir },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    )
    expect(result).toContain('No files found')

    await fs.rm(tmpDir, { recursive: true })
  })

  it('支持使用 ** 模式匹配文件', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-glob-test-'))
    await fs.mkdir(path.join(tmpDir, 'sub'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'sub', 'deep.ts'), 'export {}')

    const result = await glob.execute!(
      { pattern: '**/*.ts', cwd: tmpDir },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    )
    expect(result).toContain('deep.ts')

    await fs.rm(tmpDir, { recursive: true })
  })

  it('结果超过上限（200）时会截断输出', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-glob-cap-'))
    const count = 210
    for (let i = 0; i < count; i++) {
      await fs.writeFile(path.join(tmpDir, `file-${String(i).padStart(4, '0')}.ts`), '')
    }

    const result = (await glob.execute!(
      { pattern: '*.ts', cwd: tmpDir },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    )) as string
    expect(result).toContain('more files not shown')
    expect(result).toContain('capped at 200')
    const lines = result.split('\n').filter((l) => l.includes('.ts') && !l.includes('...'))
    expect(lines.length).toBeLessThanOrEqual(200)

    await fs.rm(tmpDir, { recursive: true })
  })

  // 回归说明：工具描述承诺结果“按修改时间排序，最新优先”。
  // 旧实现用 globby 时没有显式排序，实际结果会按字母序返回，
  // 于是描述与行为出现偏差。现在 glob 已委托给 `rg --sortr=modified`，
  // 因此最新文件必须排在最前面。
  it('会按修改时间倒序返回文件', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-glob-sort-'))
    // 按字母顺序创建文件，但把 mtime 故意打成相反顺序，
    // 这样字母序和时间序就一定不同。
    const files = ['a.ts', 'b.ts', 'c.ts']
    for (const f of files) {
      await fs.writeFile(path.join(tmpDir, f), '')
    }
    // a.ts 最旧，c.ts 最新。
    const baseTime = Date.now()
    await fs.utimes(path.join(tmpDir, 'a.ts'), new Date(baseTime - 3000), new Date(baseTime - 3000))
    await fs.utimes(path.join(tmpDir, 'b.ts'), new Date(baseTime - 2000), new Date(baseTime - 2000))
    await fs.utimes(path.join(tmpDir, 'c.ts'), new Date(baseTime - 1000), new Date(baseTime - 1000))

    const result = (await glob.execute!(
      { pattern: '*.ts', cwd: tmpDir },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    )) as string

    const lines = result.split('\n').filter((l) => l.endsWith('.ts'))
    // 结果里最新的 c.ts 必须排在更旧文件前面。
    const cIdx = lines.findIndex((l) => l.endsWith('c.ts'))
    const bIdx = lines.findIndex((l) => l.endsWith('b.ts'))
    const aIdx = lines.findIndex((l) => l.endsWith('a.ts'))
    expect(cIdx).toBeGreaterThanOrEqual(0)
    expect(cIdx).toBeLessThan(bIdx)
    expect(bIdx).toBeLessThan(aIdx)

    await fs.rm(tmpDir, { recursive: true })
  })

  // 回归说明：ripgrep 的 `--glob "**/*"` 会被视为白名单，从而覆盖 .gitignore。
  // 如果把模型给出的兜底模式原样透传，结果会把大量 node_modules / .git 文件都带出来。
  // 现在工具会识别这种兜底模式并移除 --glob，让 ripgrep 默认的、尊重 .gitignore 的遍历接管。
  it('兜底模式（**/*）会遵守 .gitignore', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-glob-catchall-'))
    // 构造一个排除 "junk/" 的假 .gitignore。
    await fs.writeFile(path.join(tmpDir, '.gitignore'), 'junk/\n')
    await fs.writeFile(path.join(tmpDir, 'keep.ts'), '')
    await fs.mkdir(path.join(tmpDir, 'junk'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'junk', 'noise.ts'), '')
    // 需要有一个 .git 目录，ripgrep 才会把这里识别成 git 工作树，
    // 进而读取本地 .gitignore。
    await fs.mkdir(path.join(tmpDir, '.git'), { recursive: true })

    const result = (await glob.execute!(
      { pattern: '**/*', cwd: tmpDir },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    )) as string

    expect(result).toContain('keep.ts')
    // junk/ 必须被 .gitignore 排除。
    // 如果 `--glob "**/*"` 的白名单覆盖泄漏出来，junk/noise.ts 就会出现在结果中。
    expect(result).not.toContain('noise.ts')

    await fs.rm(tmpDir, { recursive: true })
  })

  // 回归说明：启用 --hidden 后会走进 .git/，因为 .gitignore 往往不会显式列它
  // （.git/ 本来就由 git 自己管理）。如果没有额外加 `--glob '!.git'`，
  // 结果里就会混进 .git/objects/<hash>、.git/HEAD、.git/config 等内部状态文件，
  // 而这些内容根本不该暴露给模型。
  it('会排除 .git/ 目录内容', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-glob-gitdir-'))
    await fs.writeFile(path.join(tmpDir, 'real.ts'), '')
    await fs.mkdir(path.join(tmpDir, '.git', 'objects'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    await fs.writeFile(path.join(tmpDir, '.git', 'config'), '[core]\n')
    await fs.writeFile(path.join(tmpDir, '.git', 'objects', 'abc123'), 'binary')

    const result = (await glob.execute!(
      { pattern: '**/*', cwd: tmpDir },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    )) as string

    expect(result).toContain('real.ts')
    // .git 的内部文件都不应泄漏出来。
    expect(result).not.toContain('HEAD')
    expect(result).not.toContain('abc123')
    // “config” 这个词本身可能被别处命中，所以这里断言路径片段而不是裸词。
    expect(result).not.toContain(`.git${path.sep}config`)

    await fs.rm(tmpDir, { recursive: true })
  })
})
