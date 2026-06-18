import { describe, expect, it } from 'vitest'

import { MCP_MAX_NAME_LEN, buildCallableName } from '../src/mcp/name-mangling.js'

describe('buildCallableName', () => {
  it('对于干净输入会生成 <server>__<tool>', () => {
    const name = buildCallableName('filesystem', 'read_file', new Set())
    expect(name).toBe('filesystem__read_file')
  })

  it('会把不允许的字符清洗成下划线', () => {
    const name = buildCallableName('my-server.v2', 'foo:bar', new Set())
    // 连字符、点号、冒号都会变成 `_`，连续片段会折叠成一个下划线。
    expect(name).toBe('my_server_v2__foo_bar')
  })

  it('当清洗后某一段为空时会退回到哈希', () => {
    // 纯中文服务器名不包含 [A-Za-z0-9_] 字符，
    // 但仍必须生成合法且唯一的标识符，而不是 `__tool`。
    const name = buildCallableName('文件系统', 'read', new Set())
    expect(name).toMatch(/^[a-f0-9]{6}__read$/)
  })

  it('会通过截断哈希控制在 64 字符上限内', () => {
    const longServer = 'x'.repeat(40)
    const longTool = 'y'.repeat(40)
    const name = buildCallableName(longServer, longTool, new Set())
    expect(name.length).toBeLessThanOrEqual(MCP_MAX_NAME_LEN)
    // 截断形式会以 `_<6-char hash>` 结尾，
    // 避免两个很长且相似的名字收敛成同一个字符串。
    expect(name).toMatch(/_[a-f0-9]{6}$/)
  })

  it('会对冲突名称做消歧', () => {
    const taken = new Set<string>()
    const a = buildCallableName('serverA', 'read', taken)
    taken.add(a)
    // “不同”服务器清洗后如果得到相同标识，也必须继续消歧。
    const b = buildCallableName('serverA', 'read', taken)
    expect(a).not.toBe(b)
    expect(b.startsWith(a)).toBe(true) // 已追加冲突后缀
  })

  it('即使重复发生冲突也始终能生成唯一名称', () => {
    const taken = new Set<string>()
    for (let i = 0; i < 5; i++) {
      const name = buildCallableName('s', 't', taken)
      expect(taken.has(name)).toBe(false)
      taken.add(name)
    }
    expect(taken.size).toBe(5)
  })
})
