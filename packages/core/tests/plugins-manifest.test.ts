// 插件 manifest 发现与解析测试
import { describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { ManifestParseError, discoverManifest, parseManifest } from '../src/plugins/manifest.js'

// 创建一个临时插件目录，供 manifest 相关测试复用。
async function makeTempPluginDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'xc-plugin-test-'))
}

// 把给定 manifest 内容写入临时插件目录中的指定相对路径。
async function writeManifest(rootDir: string, rel: string, body: unknown): Promise<string> {
  const full = path.join(rootDir, rel)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, JSON.stringify(body, null, 2), 'utf-8')
  return full
}

describe('discoverManifest', () => {
  it('当不存在 manifest 时返回 null', async () => {
    const root = await makeTempPluginDir()
    expect(await discoverManifest(root)).toBeNull()
  })

  it('会优先找到 .x-code-plugin/plugin.json（原生格式，优先级最高）', async () => {
    const root = await makeTempPluginDir()
    const expected = await writeManifest(root, '.x-code-plugin/plugin.json', { name: 'foo', version: '1.0.0' })
    // 同时写入一个 Claude manifest，原生格式仍然必须优先获胜。
    await writeManifest(root, '.claude-plugin/plugin.json', { name: 'foo', version: '1.0.0' })

    const result = await discoverManifest(root)
    expect(result).toEqual({ manifestPath: expected, format: 'native' })
  })

  it('可以找到 .claude-plugin/plugin.json（兼容 Claude Code）', async () => {
    const root = await makeTempPluginDir()
    const expected = await writeManifest(root, '.claude-plugin/plugin.json', { name: 'foo', version: '1.0.0' })

    const result = await discoverManifest(root)
    expect(result).toEqual({ manifestPath: expected, format: 'claude' })
  })

  it('会把 gemini-extension.json 标记为不受支持，而不是静默忽略', async () => {
    const root = await makeTempPluginDir()
    const expected = await writeManifest(root, 'gemini-extension.json', { name: 'foo', version: '1.0.0' })

    const result = await discoverManifest(root)
    expect(result).toEqual({ manifestPath: expected, format: 'gemini' })
  })
})

describe('parseManifest', () => {
  it('可以解析最小可用的 manifest', async () => {
    const root = await makeTempPluginDir()
    const file = await writeManifest(root, 'plugin.json', { name: 'foo', version: '1.0.0' })

    const manifest = await parseManifest(file)
    expect(manifest).toMatchObject({
      schemaVersion: '1',
      name: 'foo',
      version: '1.0.0',
    })
  })

  it('接受内联的 mcpServers 与 hooks 对象', async () => {
    const root = await makeTempPluginDir()
    const file = await writeManifest(root, 'plugin.json', {
      name: 'foo',
      version: '1.0.0',
      mcpServers: { my_server: { command: 'node', args: ['server.js'] } },
      hooks: { PreToolUse: [{ command: 'lint.sh' }] },
    })

    const manifest = await parseManifest(file)
    expect(typeof manifest.mcpServers).toBe('object')
    expect(typeof manifest.hooks).toBe('object')
  })

  it('会把字符串形式的 author 规范化为对象形式', async () => {
    const root = await makeTempPluginDir()
    const file = await writeManifest(root, 'plugin.json', {
      name: 'foo',
      version: '1.0.0',
      author: 'Some Author',
    })

    const manifest = await parseManifest(file)
    expect(manifest.author).toEqual({ name: 'Some Author' })
  })

  it('会静默剥离未知的顶层字段，以保持前向兼容', async () => {
    const root = await makeTempPluginDir()
    const file = await writeManifest(root, 'plugin.json', {
      name: 'foo',
      version: '1.0.0',
      // 这些是我们尚未实现的 Claude Code 专属字段，但也不应该因此拒绝整个 manifest。
      'output-styles': './styles',
      lspServers: { foo: { command: 'lsp' } },
      unknownFutureField: 42,
    })

    const manifest = await parseManifest(file)
    expect(manifest.name).toBe('foo')
    // 未知字段应被丢弃。
    expect((manifest as Record<string, unknown>)['output-styles']).toBeUndefined()
    expect((manifest as Record<string, unknown>).lspServers).toBeUndefined()
  })

  it('会拒绝非法名称（如含大写字母）', async () => {
    const root = await makeTempPluginDir()
    const file = await writeManifest(root, 'plugin.json', { name: 'Foo', version: '1.0.0' })

    await expect(parseManifest(file)).rejects.toBeInstanceOf(ManifestParseError)
  })

  it('会以带路径信息的错误拒绝格式损坏的 JSON', async () => {
    const root = await makeTempPluginDir()
    const file = path.join(root, 'plugin.json')
    await fs.writeFile(file, '{ not json', 'utf-8')

    await expect(parseManifest(file)).rejects.toBeInstanceOf(ManifestParseError)
  })
})
