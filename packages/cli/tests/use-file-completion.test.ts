import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { parseSimpleGitignore, scanWorkspaceFiles } from '../src/ui/hooks/use-file-completion.js'

describe('parseSimpleGitignore', () => {
  it('应提取普通名称规则', () => {
    const ig = parseSimpleGitignore('node_modules\ndist\n')
    expect(ig.names.has('node_modules')).toBe(true)
    expect(ig.names.has('dist')).toBe(true)
  })

  it('应提取后缀模式规则', () => {
    const ig = parseSimpleGitignore('*.log\n*.tsbuildinfo\n')
    expect(ig.suffixes.has('.log')).toBe(true)
    expect(ig.suffixes.has('.tsbuildinfo')).toBe(true)
  })

  it('应跳过注释、空行和取反规则', () => {
    const ig = parseSimpleGitignore('# a comment\n\n!important.log\n')
    expect(ig.names.size).toBe(0)
    expect(ig.suffixes.size).toBe(0)
  })

  it('应去掉首尾斜杠', () => {
    const ig = parseSimpleGitignore('/foo\nbar/\n')
    expect(ig.names.has('foo')).toBe(true)
    expect(ig.names.has('bar')).toBe(true)
  })

  it('应丢弃当前不支持的复合模式（中间斜杠、glob、? 等）', () => {
    const ig = parseSimpleGitignore('foo/bar\n**/baz\nx?.log\n[abc].txt\n')
    expect(ig.names.size).toBe(0)
    expect(ig.suffixes.size).toBe(0)
  })

  it('应把后缀模式统一转成小写', () => {
    const ig = parseSimpleGitignore('*.LOG\n')
    expect(ig.suffixes.has('.log')).toBe(true)
  })
})

describe('scanWorkspaceFiles', () => {
  let root: string

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcc-scan-'))
    // 目录布局：
    //   top.ts
    //   src/ChatInput.tsx
    //   src/foo.ts
    //   node_modules/some-pkg/index.js   （必须跳过：硬编码黑名单）
    //   .git/HEAD                        （必须跳过：硬编码黑名单）
    //   build.log                        （只有在 gitignore 忽略 *.log 时才跳过）
    //   .hidden                          （会保留，是否展示交给菜单评分层处理）
    await fs.writeFile(path.join(root, 'top.ts'), '')
    await fs.mkdir(path.join(root, 'src'))
    await fs.writeFile(path.join(root, 'src', 'ChatInput.tsx'), '')
    await fs.writeFile(path.join(root, 'src', 'foo.ts'), '')
    await fs.mkdir(path.join(root, 'node_modules', 'some-pkg'), { recursive: true })
    await fs.writeFile(path.join(root, 'node_modules', 'some-pkg', 'index.js'), '')
    await fs.mkdir(path.join(root, '.git'))
    await fs.writeFile(path.join(root, '.git', 'HEAD'), '')
    await fs.writeFile(path.join(root, 'build.log'), '')
    await fs.writeFile(path.join(root, '.hidden'), '')
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('应遍历目录树并生成 POSIX 风格的相对路径', async () => {
    const entries = await scanWorkspaceFiles({ rootDir: root, ignore: { names: new Set(), suffixes: new Set() } })
    const paths = entries.map((e) => e.relPath).sort()
    expect(paths).toContain('top.ts')
    expect(paths).toContain('src/ChatInput.tsx')
    expect(paths).toContain('src/foo.ts')
    expect(paths).toContain('build.log')
    expect(paths).toContain('.hidden')
    expect(paths).toContain('src')
  })

  it('应跳过硬编码黑名单目录（node_modules、.git）', async () => {
    const entries = await scanWorkspaceFiles({ rootDir: root, ignore: { names: new Set(), suffixes: new Set() } })
    expect(entries.find((e) => e.relPath.includes('node_modules'))).toBeUndefined()
    expect(entries.find((e) => e.relPath.includes('.git'))).toBeUndefined()
  })

  it('应遵守简化版 gitignore 的后缀忽略规则', async () => {
    const entries = await scanWorkspaceFiles({
      rootDir: root,
      ignore: { names: new Set(), suffixes: new Set(['.log']) },
    })
    expect(entries.find((e) => e.relPath === 'build.log')).toBeUndefined()
  })

  it('应遵守 gitignore 的名称忽略规则', async () => {
    const entries = await scanWorkspaceFiles({
      rootDir: root,
      ignore: { names: new Set(['src']), suffixes: new Set() },
    })
    expect(entries.find((e) => e.relPath.startsWith('src'))).toBeUndefined()
  })

  it('应显式标记目录条目', async () => {
    const entries = await scanWorkspaceFiles({ rootDir: root, ignore: { names: new Set(), suffixes: new Set() } })
    const srcEntry = entries.find((e) => e.relPath === 'src')
    expect(srcEntry?.isDirectory).toBe(true)
    const fileEntry = entries.find((e) => e.relPath === 'top.ts')
    expect(fileEntry?.isDirectory).toBe(false)
  })

  it('应在达到 maxEntries 后停止继续收集', async () => {
    const entries = await scanWorkspaceFiles({
      rootDir: root,
      maxEntries: 2,
      ignore: { names: new Set(), suffixes: new Set() },
    })
    expect(entries.length).toBeLessThanOrEqual(2)
  })

  it('若在第一次 readdir 前已中止，应返回空结果', async () => {
    const ac = new AbortController()
    ac.abort()
    const entries = await scanWorkspaceFiles({
      rootDir: root,
      signal: ac.signal,
      ignore: { names: new Set(), suffixes: new Set() },
    })
    expect(entries).toEqual([])
  })
})
