import { describe, expect, it } from 'vitest'

import { parseServerConfig, parseServersBlock } from '../src/mcp/config-schema.js'

describe('parseServerConfig', () => {
  it('接受合法的 stdio 配置', () => {
    const cfg = parseServerConfig('filesystem', {
      command: 'npx',
      args: ['-y', 'pkg'],
      env: { FOO: 'bar' },
    })
    expect(cfg).toMatchObject({ command: 'npx', args: ['-y', 'pkg'], env: { FOO: 'bar' } })
  })

  it('接受合法的 http 配置', () => {
    const cfg = parseServerConfig('sentry', { url: 'https://mcp.example.com' })
    expect(cfg).toMatchObject({ url: 'https://mcp.example.com' })
  })

  it('既没有 command 也没有 url 的配置会被拒绝', () => {
    expect(() => parseServerConfig('bad', { timeout: 100 })).toThrow(/either `command`.*or `url`/)
  })

  it('同时包含 command 和 url 的配置会被拒绝', () => {
    expect(() => parseServerConfig('bad', { command: 'foo', url: 'https://x.com' })).toThrow(/both `command` and `url`/)
  })

  it('格式错误的 url 会被拒绝', () => {
    expect(() => parseServerConfig('bad', { url: 'not-a-url' })).toThrow()
  })

  it('错误信息中会包含服务器名称', () => {
    expect(() => parseServerConfig('myserver', {})).toThrow(/mcpServers\.myserver/)
  })
})

describe('parseServersBlock', () => {
  it('undefined 输入会返回空结果', () => {
    const r = parseServersBlock(undefined)
    expect(r.servers).toEqual({})
    expect(r.errors).toEqual([])
  })

  it('可以解析多个服务器并隔离错误', () => {
    const r = parseServersBlock({
      good: { command: 'npx' },
      bad: { timeout: 100 },
      alsoGood: { url: 'https://example.com' },
    })
    expect(Object.keys(r.servers).sort()).toEqual(['alsoGood', 'good'])
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0].name).toBe('bad')
  })
})
