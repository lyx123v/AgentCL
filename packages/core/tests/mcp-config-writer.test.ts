import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  detectScope,
  getConfigPath,
  readServerConfig,
  removeServerFromConfig,
  serverExists,
  writeServerToConfig,
} from '../src/mcp/config-writer.js'

/** 每个测试都会在 tmpdir 下创建独立的 ~/.x-code 临时目录和项目目录，
 *  确保不会触碰开发者真实的 config.json。 */
function isolate(): { home: string; project: string } {
  const home = path.join(os.tmpdir(), 'mcp-writer-home-' + Math.random().toString(36).slice(2))
  const project = path.join(os.tmpdir(), 'mcp-writer-proj-' + Math.random().toString(36).slice(2))
  process.env.X_CODE_HOME = home
  return { home, project }
}

// 读取并解析 JSON 文件，便于断言写入结果。
async function readJson(file: string): Promise<unknown> {
  const raw = await fs.readFile(file, 'utf-8')
  return JSON.parse(raw)
}

describe('config-writer: user scope', () => {
  let ctx: { home: string; project: string }
  beforeEach(() => {
    ctx = isolate()
  })
  afterEach(() => {
    delete process.env.X_CODE_HOME
  })

  it('config.json 不存在时可以写入新服务器', async () => {
    const res = await writeServerToConfig('sentry', { url: 'https://mcp.sentry.dev/mcp' }, 'user', ctx.project)
    expect(res.path).toBe(getConfigPath('user', ctx.project))
    const written = (await readJson(res.path)) as { mcpServers: Record<string, unknown> }
    expect(written.mcpServers).toEqual({ sentry: { url: 'https://mcp.sentry.dev/mcp' } })
  })

  it('会保留无关的顶层字段', async () => {
    const p = getConfigPath('user', ctx.project)
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.writeFile(p, JSON.stringify({ theme: 'dark', model: 'anthropic:foo' }), 'utf-8')
    await writeServerToConfig('fs', { command: 'node', args: ['s.js'] }, 'user', ctx.project)
    const data = (await readJson(p)) as Record<string, unknown>
    expect(data.theme).toBe('dark')
    expect(data.model).toBe('anthropic:foo')
    expect(data.mcpServers).toEqual({ fs: { command: 'node', args: ['s.js'] } })
  })

  it('新增时会保留同级的 mcpServers 条目', async () => {
    await writeServerToConfig('a', { command: 'node', args: ['a.js'] }, 'user', ctx.project)
    await writeServerToConfig('b', { url: 'https://b.com/mcp' }, 'user', ctx.project)
    const data = (await readJson(getConfigPath('user', ctx.project))) as { mcpServers: Record<string, unknown> }
    expect(Object.keys(data.mcpServers).sort()).toEqual(['a', 'b'])
  })

  it('会原位覆盖同名服务器（重复检查由调用方负责）', async () => {
    await writeServerToConfig('s', { command: 'one' }, 'user', ctx.project)
    await writeServerToConfig('s', { command: 'two' }, 'user', ctx.project)
    const data = (await readJson(getConfigPath('user', ctx.project))) as {
      mcpServers: Record<string, { command: string }>
    }
    expect(data.mcpServers.s.command).toBe('two')
  })

  it('会拒绝无效配置（写入前先做 schema 校验）', async () => {
    await expect(
      writeServerToConfig('s', { command: 'node', url: 'https://x.com' } as never, 'user', ctx.project),
    ).rejects.toThrow(/both.*command.*url/)
    // 同时不应创建任何文件。
    await expect(fs.stat(getConfigPath('user', ctx.project))).rejects.toBeTruthy()
  })

  it('遇到损坏的 config.json 会抛错而不是覆盖', async () => {
    const p = getConfigPath('user', ctx.project)
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.writeFile(p, '{this is not json', 'utf-8')
    await expect(writeServerToConfig('s', { command: 'node' }, 'user', ctx.project)).rejects.toThrow(/not valid JSON/)
  })
})

describe('config-writer: project scope', () => {
  let ctx: { home: string; project: string }
  beforeEach(() => {
    ctx = isolate()
  })
  afterEach(() => {
    delete process.env.X_CODE_HOME
  })

  it('会写入到 <project>/.x-code/config.json', async () => {
    const res = await writeServerToConfig('foo', { command: 'node', args: ['f.js'] }, 'project', ctx.project)
    expect(res.path).toContain(path.join('.x-code', 'config.json'))
    expect(res.path.startsWith(ctx.project)).toBe(true)
  })

  it('不会影响 user 作用域配置', async () => {
    await writeServerToConfig('user-srv', { command: 'a' }, 'user', ctx.project)
    await writeServerToConfig('proj-srv', { command: 'b' }, 'project', ctx.project)
    expect(await serverExists('user-srv', 'user', ctx.project)).toBe(true)
    expect(await serverExists('user-srv', 'project', ctx.project)).toBe(false)
    expect(await serverExists('proj-srv', 'project', ctx.project)).toBe(true)
    expect(await serverExists('proj-srv', 'user', ctx.project)).toBe(false)
  })
})

describe('config-writer: remove', () => {
  let ctx: { home: string; project: string }
  beforeEach(() => {
    ctx = isolate()
  })
  afterEach(() => {
    delete process.env.X_CODE_HOME
  })

  it('可以移除已存在的服务器', async () => {
    await writeServerToConfig('s', { command: 'node' }, 'user', ctx.project)
    const r = await removeServerFromConfig('s', 'user', ctx.project)
    expect(r.removed).toBe(true)
    expect(await serverExists('s', 'user', ctx.project)).toBe(false)
  })

  it('服务器不存在时具有幂等性', async () => {
    const r = await removeServerFromConfig('nope', 'user', ctx.project)
    expect(r.removed).toBe(false)
  })

  it('配置文件不存在时也具有幂等性', async () => {
    const r = await removeServerFromConfig('nope', 'project', ctx.project)
    expect(r.removed).toBe(false)
  })

  it('会保留同级条目和无关字段', async () => {
    const p = getConfigPath('user', ctx.project)
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.writeFile(
      p,
      JSON.stringify({
        theme: 'dark',
        mcpServers: { a: { command: 'a' }, b: { command: 'b' }, c: { command: 'c' } },
      }),
      'utf-8',
    )
    const r = await removeServerFromConfig('b', 'user', ctx.project)
    expect(r.removed).toBe(true)
    const data = (await readJson(p)) as { theme: string; mcpServers: Record<string, unknown> }
    expect(data.theme).toBe('dark')
    expect(Object.keys(data.mcpServers).sort()).toEqual(['a', 'c'])
  })

  it('移除最后一个条目后会保留空的 mcpServers 对象', async () => {
    await writeServerToConfig('only', { command: 'node' }, 'user', ctx.project)
    await removeServerFromConfig('only', 'user', ctx.project)
    const data = (await readJson(getConfigPath('user', ctx.project))) as {
      mcpServers: Record<string, unknown>
    }
    expect(data.mcpServers).toEqual({})
  })
})

describe('config-writer: detectScope', () => {
  let ctx: { home: string; project: string }
  beforeEach(() => {
    ctx = isolate()
  })
  afterEach(() => {
    delete process.env.X_CODE_HOME
  })

  it('各处都不存在时返回 not-found', async () => {
    expect((await detectScope('nope', ctx.project)).kind).toBe('not-found')
  })

  it('只存在于 user 作用域时返回 user', async () => {
    await writeServerToConfig('s', { command: 'x' }, 'user', ctx.project)
    expect((await detectScope('s', ctx.project)).kind).toBe('user')
  })

  it('只存在于 project 作用域时返回 project', async () => {
    await writeServerToConfig('s', { command: 'x' }, 'project', ctx.project)
    expect((await detectScope('s', ctx.project)).kind).toBe('project')
  })

  it('同时存在于两个作用域时返回 both', async () => {
    await writeServerToConfig('s', { command: 'x' }, 'user', ctx.project)
    await writeServerToConfig('s', { command: 'y' }, 'project', ctx.project)
    expect((await detectScope('s', ctx.project)).kind).toBe('both')
  })
})

describe('config-writer: readServerConfig', () => {
  let ctx: { home: string; project: string }
  beforeEach(() => {
    ctx = isolate()
  })
  afterEach(() => {
    delete process.env.X_CODE_HOME
  })

  it('会返回已存储的配置对象', async () => {
    await writeServerToConfig('s', { command: 'node', args: ['a'] }, 'user', ctx.project)
    expect(await readServerConfig('s', 'user', ctx.project)).toEqual({ command: 'node', args: ['a'] })
  })

  it('缺失的服务器会返回 null', async () => {
    expect(await readServerConfig('nope', 'user', ctx.project)).toBeNull()
  })
})
