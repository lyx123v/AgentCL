import { describe, expect, it } from 'vitest'

import { parseAdd, parseAddJson, parseRemove, tokenize } from '../src/mcp/arg-parser.js'

describe('tokenize', () => {
  it('会按空白字符拆分', () => {
    expect(tokenize('a b c')).toEqual({ ok: true, tokens: ['a', 'b', 'c'] })
  })

  it('会保留双引号包裹的片段', () => {
    expect(tokenize('a "b c" d')).toEqual({ ok: true, tokens: ['a', 'b c', 'd'] })
  })

  it('会保留单引号包裹的片段', () => {
    expect(tokenize("a 'b c' d")).toEqual({ ok: true, tokens: ['a', 'b c', 'd'] })
  })

  it('在引号外可以用反斜杠转义空白', () => {
    expect(tokenize('a\\ b c')).toEqual({ ok: true, tokens: ['a b', 'c'] })
  })

  it('在引号外可以转义引号和反斜杠', () => {
    expect(tokenize('a\\"b \\\\c')).toEqual({ ok: true, tokens: ['a"b', '\\c'] })
  })

  it('会把反斜杠加普通字符保留为字面量组合（Windows 路径）', () => {
    // 回归测试：旧版按 POSIX 方式把“反斜杠可转义任意字符”应用过头，
    // 导致 Windows 路径分隔符被吃掉。`D:\res\x-code-cli\tmp` 必须完整保留。
    expect(tokenize('D:\\res\\x-code-cli\\tmp')).toEqual({
      ok: true,
      tokens: ['D:\\res\\x-code-cli\\tmp'],
    })
  })

  it('可以处理双引号内部的反斜杠转义', () => {
    expect(tokenize('"a\\"b"')).toEqual({ ok: true, tokens: ['a"b'] })
  })

  it('会拒绝未闭合的引号', () => {
    expect(tokenize('a "b')).toEqual({ ok: false, error: 'Unclosed " quote' })
  })

  it('空字符串或纯空白输入会返回空结果', () => {
    expect(tokenize('')).toEqual({ ok: true, tokens: [] })
    expect(tokenize('   ')).toEqual({ ok: true, tokens: [] })
  })
})

describe('parseAdd — stdio', () => {
  it('可以解析基础 stdio 形式：name + command + args', () => {
    const r = parseAdd('fs npx -y @modelcontextprotocol/server-filesystem /tmp')
    expect(r).toEqual({
      ok: true,
      command: {
        kind: 'add',
        name: 'fs',
        scope: 'user',
        config: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        },
      },
    })
  })

  it('接受命令前的 -- 分隔符', () => {
    const r = parseAdd('fs -- npx -y pkg')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.command.name).toBe('fs')
      expect((r.command.config as { command: string; args?: string[] }).command).toBe('npx')
      expect((r.command.config as { command: string; args?: string[] }).args).toEqual(['-y', 'pkg'])
    }
  })

  it('会把多个 --env 收集到 env 对象中', () => {
    const r = parseAdd('--env A=1 --env B=hello srv node ./s.js')
    expect(r.ok).toBe(true)
    if (r.ok) {
      const cfg = r.command.config as { env?: Record<string, string> }
      expect(cfg.env).toEqual({ A: '1', B: 'hello' })
    }
  })

  it('允许 --env 的值中包含 =', () => {
    const r = parseAdd('--env URL=https://x.com?a=1 srv node s.js')
    expect(r.ok).toBe(true)
    if (r.ok) {
      const cfg = r.command.config as { env?: Record<string, string> }
      expect(cfg.env).toEqual({ URL: 'https://x.com?a=1' })
    }
  })

  it('接受 --timeout', () => {
    const r = parseAdd('--timeout 60000 srv node s.js')
    expect(r.ok).toBe(true)
    if (r.ok) {
      const cfg = r.command.config as { timeout?: number }
      expect(cfg.timeout).toBe(60000)
    }
  })

  it('接受 --scope project', () => {
    const r = parseAdd('--scope project srv node s.js')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.command.scope).toBe('project')
  })

  it('会拒绝在 stdio 中使用 --header', () => {
    const r = parseAdd('--header "X: Y" srv node s.js')
    expect(r).toEqual({ ok: false, error: expect.stringContaining('--header is only valid for HTTP') })
  })

  it('会拒绝非法名称（单个错误 token）', () => {
    // `server!` 是单个包含标点的 token，会触发 NAME_RE 校验失败。
    // 像 "my server" 这样的多词输入会先被拆成多个参数，其中单独的 "my"
    // 本身又是合法名称，所以这里要用单 token 的失败场景。
    const r = parseAdd('server! npx pkg')
    expect(r.ok).toBe(false)
  })

  it('会拒绝格式错误的 --env', () => {
    expect(parseAdd('--env NOVAL srv cmd').ok).toBe(false)
    expect(parseAdd('--env =val srv cmd').ok).toBe(false)
  })

  it('会在参数中保留 Windows 风格反斜杠路径', () => {
    // 回归测试：之前 tokenizer 吃掉反斜杠时，
    // `D:\res\x-code-cli\tmp` 会被错误变成 `D:resx-code-clitmp`。
    const r = parseAdd('fs npx -y @modelcontextprotocol/server-filesystem D:\\res\\x-code-cli\\tmp')
    expect(r.ok).toBe(true)
    if (r.ok) {
      const cfg = r.command.config as { args: string[] }
      expect(cfg.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', 'D:\\res\\x-code-cli\\tmp'])
    }
  })

  it('会从配置中省略空的 args/env', () => {
    const r = parseAdd('srv cmd-only')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.command.config).toEqual({ command: 'cmd-only' })
    }
  })

  it('至少需要提供 name 和 command', () => {
    expect(parseAdd('').ok).toBe(false)
    expect(parseAdd('srv').ok).toBe(false)
  })
})

describe('parseAdd — http', () => {
  it('可以解析带 url 的 --http', () => {
    const r = parseAdd('--http sentry https://mcp.sentry.dev/mcp')
    expect(r).toEqual({
      ok: true,
      command: {
        kind: 'add',
        name: 'sentry',
        scope: 'user',
        config: { url: 'https://mcp.sentry.dev/mcp' },
      },
    })
  })

  it('接受 --transport http 作为别名', () => {
    const r = parseAdd('--transport http sentry https://mcp.sentry.dev/mcp')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect((r.command.config as { url: string }).url).toBe('https://mcp.sentry.dev/mcp')
    }
  })

  it('会明确拒绝 --transport sse', () => {
    const r = parseAdd('--transport sse sentry https://mcp.sentry.dev/mcp')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/only supports "http"/)
  })

  it('会收集多个 --header 参数', () => {
    const r = parseAdd('--http --header "X-A: 1" --header "X-B: 2" srv https://x.com')
    expect(r.ok).toBe(true)
    if (r.ok) {
      const cfg = r.command.config as { headers?: Record<string, string> }
      expect(cfg.headers).toEqual({ 'X-A': '1', 'X-B': '2' })
    }
  })

  it('会拒绝在 --http 下使用 --env', () => {
    const r = parseAdd('--http --env A=B srv https://x.com')
    expect(r).toEqual({ ok: false, error: expect.stringContaining('--env is only valid for stdio') })
  })

  it('会拒绝非法 url', () => {
    const r = parseAdd('--http srv ftp://x.com')
    expect(r.ok).toBe(false)
  })

  it('会拒绝 http 模式下多余的位置参数', () => {
    const r = parseAdd('--http srv https://x.com extra-token')
    expect(r.ok).toBe(false)
  })
})

describe('parseAddJson', () => {
  it('可以把 JSON 文本解析成配置', () => {
    const r = parseAddJson('myserver \'{"command":"node","args":["s.js"]}\'')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.command.name).toBe('myserver')
      expect(r.command.config).toEqual({ command: 'node', args: ['s.js'] })
    }
  })

  it('接受 --scope project', () => {
    const r = parseAddJson('--scope project srv \'{"command":"x"}\'')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.command.scope).toBe('project')
  })

  it('会拒绝非法 JSON', () => {
    const r = parseAddJson("srv 'not-json'")
    expect(r.ok).toBe(false)
  })

  it('会拒绝非对象类型的 JSON', () => {
    const r = parseAddJson('srv \'["a","b"]\'')
    expect(r.ok).toBe(false)
  })

  it('缺少 JSON 时会拒绝', () => {
    expect(parseAddJson('srv').ok).toBe(false)
    expect(parseAddJson('').ok).toBe(false)
  })

  it('会拒绝非法名称', () => {
    const r = parseAddJson('bad name! \'{"command":"x"}\'')
    expect(r.ok).toBe(false)
  })
})

describe('parseRemove', () => {
  it('可以解析裸名称', () => {
    expect(parseRemove('sentry')).toEqual({
      ok: true,
      command: { kind: 'remove', name: 'sentry', scope: undefined },
    })
  })

  it('可以解析 --scope user', () => {
    const r = parseRemove('--scope user sentry')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.command.scope).toBe('user')
  })

  it('可以解析 --scope project', () => {
    const r = parseRemove('--scope project sentry')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.command.scope).toBe('project')
  })

  it('会拒绝多余参数', () => {
    expect(parseRemove('a b').ok).toBe(false)
  })

  it('缺少名称时会拒绝', () => {
    expect(parseRemove('').ok).toBe(false)
    expect(parseRemove('--scope user').ok).toBe(false)
  })

  it('会拒绝未知标记', () => {
    expect(parseRemove('--force sentry').ok).toBe(false)
  })
})
