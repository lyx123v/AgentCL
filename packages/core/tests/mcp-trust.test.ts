import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import os from 'node:os'
import path from 'node:path'

import { buildServerPreview, isProjectTrusted, promptForTrust, trustProject } from '../src/mcp/trust.js'

/** 每个测试都会在 tmpdir 下创建独立的 ~/.x-code 临时目录，
 *  以确保不会碰到开发者真实的 trusted-projects.json。 */
function isolate(): string {
  const dir = path.join(os.tmpdir(), 'mcp-trust-test-' + Math.random().toString(36).slice(2))
  process.env.X_CODE_HOME = dir
  return dir
}

describe('trust persistence', () => {
  beforeEach(() => isolate())
  afterEach(() => {
    delete process.env.X_CODE_HOME
  })

  it('默认会报告为未信任', async () => {
    expect(await isProjectTrusted('/some/path')).toBe(false)
  })

  it('会持久化已信任路径', async () => {
    await trustProject('/foo/bar')
    expect(await isProjectTrusted('/foo/bar')).toBe(true)
  })

  it('会一致地处理绝对路径形式', async () => {
    await trustProject(path.resolve('.'))
    expect(await isProjectTrusted(path.resolve('.'))).toBe(true)
  })

  it('重复调用 trustProject 不会产生重复条目', async () => {
    await trustProject('/foo')
    await trustProject('/foo')
    // 间接验证：仍然报告为已信任，且写入过程没有抛错。
    expect(await isProjectTrusted('/foo')).toBe(true)
  })

  it('会把子目录与父目录视为不同路径', async () => {
    await trustProject('/foo')
    expect(await isProjectTrusted('/foo/sub')).toBe(false)
  })
})

describe('promptForTrust', () => {
  beforeEach(() => isolate())
  afterEach(() => {
    delete process.env.X_CODE_HOME
  })

  it('会把 "Trust this project" 映射为 "trust"', async () => {
    const choice = await promptForTrust('/p', [{ name: 's', preview: 'cmd' }], async () => 'Trust this project')
    expect(choice).toBe('trust')
  })

  it('会把 "Exit X-Code" 映射为 "exit"', async () => {
    const choice = await promptForTrust('/p', [{ name: 's', preview: 'cmd' }], async () => 'Exit X-Code')
    expect(choice).toBe('exit')
  })

  it('对其他或无法识别的回答会回退为 skip', async () => {
    const choice = await promptForTrust('/p', [{ name: 's', preview: 'cmd' }], async () => '???')
    expect(choice).toBe('skip')
  })
})

describe('buildServerPreview', () => {
  it('会把 stdio 配置渲染为 command + args', () => {
    expect(buildServerPreview({ command: 'npx', args: ['-y', 'foo'] })).toBe('npx -y foo')
  })

  it('会把 http 配置渲染为 URL', () => {
    expect(buildServerPreview({ url: 'https://x.com' })).toBe('https://x.com')
  })

  it('当 command 和 url 都不存在时会回退到占位文案', () => {
    expect(buildServerPreview({})).toBe('(invalid config)')
  })
})
