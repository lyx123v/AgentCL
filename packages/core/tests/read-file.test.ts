import { describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { readFile } from '../src/tools/read-file.js'

// 执行 readFile 工具，简化各测试中的调用样板。
const exec = (input: Record<string, unknown>) =>
  readFile.execute!(input as any, { toolCallId: 'test', messages: [], abortSignal: undefined as any })

describe('readFile tool', () => {
  it('会读取文本文件并附带行号', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-rf-'))
    const filePath = path.join(tmpDir, 'hello.ts')
    await fs.writeFile(filePath, 'const a = 1\nconst b = 2\nconst c = 3\n')

    const result = (await exec({ filePath })) as string
    expect(result).toContain('1\tconst a = 1')
    expect(result).toContain('2\tconst b = 2')
    expect(result).toContain('3\tconst c = 3')

    await fs.rm(tmpDir, { recursive: true })
  })

  it('支持 offset 与 limit 参数', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-rf-'))
    const filePath = path.join(tmpDir, 'lines.txt')
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`)
    await fs.writeFile(filePath, lines.join('\n'))

    const result = (await exec({ filePath, offset: 3, limit: 2 })) as string
    expect(result).toContain('3\tline 3')
    expect(result).toContain('4\tline 4')
    expect(result).not.toContain('2\tline 2')
    expect(result).not.toContain('5\tline 5')

    await fs.rm(tmpDir, { recursive: true })
  })

  it('会截断大文件，并提示可继续读取的范围', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-rf-'))
    const filePath = path.join(tmpDir, 'big.ts')
    // 阈值是 2000 行（从 500 提升而来，以对齐 Claude Code）。
    const lines = Array.from({ length: 2500 }, (_, i) => `// line ${i + 1}`)
    await fs.writeFile(filePath, lines.join('\n'))

    const result = (await exec({ filePath })) as string
    expect(result).toContain('showing first 2000')
    expect(result).toContain('2500')
    expect(result).not.toContain('2001\t')

    await fs.rm(tmpDir, { recursive: true })
  })

  it('当显式指定 offset/limit 时，不会再做默认的头部截断', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-rf-'))
    const filePath = path.join(tmpDir, 'big2.ts')
    // 2500 行 × 每行约 12 字节 ≈ 30 KB，明显低于 256 KB 上限，
    // 因此整个请求区间都应该原样返回，不再额外裁剪。
    const lines = Array.from({ length: 2500 }, (_, i) => `// line ${i + 1}`)
    await fs.writeFile(filePath, lines.join('\n'))

    const result = (await exec({ filePath, offset: 1, limit: 2500 })) as string
    expect(result).not.toContain('showing first')
    expect(result).toContain('2500\t')

    await fs.rm(tmpDir, { recursive: true })
  })

  // 回归测试：模型如果请求一个巨大的显式范围，过去会把整段内容全塞进上下文，
  // 导致下一轮直接冲爆上下文窗口。现在我们把显式范围读取硬限制在
  // MAX_READ_BYTES（256 KB），并明确告诉模型该从哪里继续读。
  it('会把显式范围读取限制在 256 KB，并指明下一次继续读取的 offset', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-rf-'))
    const filePath = path.join(tmpDir, 'huge.txt')
    // 4000 行 × 每行约 100 字节 ≈ 400 KB，已经超过 256 KB 上限。
    const lines = Array.from({ length: 4000 }, (_, i) => `${i + 1}: ${'x'.repeat(95)}`)
    await fs.writeFile(filePath, lines.join('\n'))

    const result = (await exec({ filePath, offset: 1, limit: 4000 })) as string
    expect(result).toContain('output capped at 256 KB')
    expect(result).toMatch(/Call readFile again with offset=\d+/)
    // 基本 sanity check：字节上限确实生效了，即便加上尾部提示，
    // 输出也应明显低于 300 KB。
    expect(Buffer.byteLength(result, 'utf-8')).toBeLessThan(300 * 1024)

    await fs.rm(tmpDir, { recursive: true })
  })

  it('遇到不存在的文件时会返回错误', async () => {
    const result = (await exec({ filePath: '/tmp/nonexistent-xc-test-file.ts' })) as string
    expect(result).toContain('Error')
  })
})
