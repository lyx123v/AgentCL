import { describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { listDir } from '../src/tools/list-dir.js'

// 执行 listDir 工具，统一传入测试所需的最小上下文。
const exec = (input: Record<string, unknown>) =>
  listDir.execute!(input as any, { toolCallId: 'test', messages: [], abortSignal: undefined as any })

describe('listDir tool', () => {
  it('可以列出文件和目录', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-ld-'))
    await fs.writeFile(path.join(tmpDir, 'file.ts'), 'content')
    await fs.mkdir(path.join(tmpDir, 'subdir'))

    const result = (await exec({ dirPath: tmpDir })) as string
    expect(result).toContain('file.ts')
    expect(result).toContain('subdir/')

    await fs.rm(tmpDir, { recursive: true })
  })

  it('只会给目录追加 "/" 后缀', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-ld-'))
    await fs.writeFile(path.join(tmpDir, 'readme.md'), '')
    await fs.mkdir(path.join(tmpDir, 'src'))

    const result = (await exec({ dirPath: tmpDir })) as string
    const lines = result.split('\n')
    const dirLine = lines.find((l) => l.includes('src'))
    const fileLine = lines.find((l) => l.includes('readme'))
    expect(dirLine).toBe('src/')
    expect(fileLine).toBe('readme.md')

    await fs.rm(tmpDir, { recursive: true })
  })

  it('空目录会返回 "(empty directory)"', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-ld-'))

    const result = (await exec({ dirPath: tmpDir })) as string
    expect(result).toBe('(empty directory)')

    await fs.rm(tmpDir, { recursive: true })
  })

  it('不存在的目录会返回错误', async () => {
    const result = (await exec({ dirPath: '/tmp/nonexistent-xc-dir-test' })) as string
    expect(result).toContain('Error')
  })
})
