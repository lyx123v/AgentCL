// marketplace 解析与 known_marketplaces.json 注册表测试
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  MarketplaceParseError,
  RESERVED_MARKETPLACE_NAMES,
  addKnownMarketplace,
  parseMarketplace,
  readAllCachedMarketplaces,
  readKnownMarketplaces,
  removeKnownMarketplace,
  resolveCloneUrl,
} from '../src/plugins/marketplace.js'
import { knownMarketplacesPath, marketplaceIndexPath } from '../src/plugins/paths.js'

let originalPluginsDir: string | undefined

beforeEach(async () => {
  originalPluginsDir = process.env.XC_PLUGINS_DIR
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-plugins-mp-test-'))
  process.env.XC_PLUGINS_DIR = tmp
})

afterEach(() => {
  if (originalPluginsDir === undefined) delete process.env.XC_PLUGINS_DIR
  else process.env.XC_PLUGINS_DIR = originalPluginsDir
})

describe('parseMarketplace', () => {
  it('可以解析最小可用的 marketplace（旧版 {kind} source 形式）', () => {
    const raw = JSON.stringify({
      name: 'official',
      plugins: [{ name: 'linear', source: { kind: 'github', owner: 'foo', repo: 'linear' } }],
    })
    const m = parseMarketplace(raw, 'official')
    expect(m.schemaVersion).toBe('1')
    expect(m.plugins).toHaveLength(1)
    expect(m.plugins[0]!.name).toBe('linear')
  })

  it('会规范化所有真实存在的 Claude Code source 变体', () => {
    // 这是针对 v0.x 回归问题的测试：当时我们的 schema
    // 只接受 {kind: 'git'|'github'|'local'} 对象，
    // 导致真实世界里的 Claude Code marketplace 几乎全部被拒绝。
    // 下面这些线上的 wire-format 样例采自
    // 2026 年 4 月的 anthropics/claude-code 与
    // anthropics/claude-plugins-official。
    const raw = JSON.stringify({
      name: 'mixed',
      plugins: [
        { name: 'rel', source: './plugins/rel-one' },
        { name: 'github-short', source: 'github:foo/bar' },
        { name: 'http-git', source: 'https://gitlab.example/x.git' },
        {
          name: 'git-subdir',
          source: {
            source: 'git-subdir',
            url: 'https://github.com/42Crunch-AI/claude-plugins.git',
            path: 'plugins/api',
            ref: 'v1.5.5',
            sha: 'a175b24',
          },
        },
        { name: 'url-form', source: { source: 'url', url: 'https://example.com/x.git', sha: '5ddccc3' } },
        { name: 'github-form', source: { source: 'github', owner: 'foo', repo: 'bar', ref: 'main' } },
        {
          name: 'github-combined',
          source: { source: 'github', repo: 'fullstorydev/fullstory-skills', commit: '1ec5865' },
        },
      ],
    })
    const m = parseMarketplace(raw, 'mixed', {
      marketplaceCloneUrl: 'https://github.com/foo/mixed.git',
    })
    expect(m.plugins).toHaveLength(7)
    expect(m.plugins[0]!.source).toEqual({
      kind: 'git',
      url: 'https://github.com/foo/mixed.git',
      subdir: 'plugins/rel-one',
    })
    expect(m.plugins[1]!.source).toEqual({ kind: 'github', owner: 'foo', repo: 'bar' })
    expect(m.plugins[3]!.source).toEqual({
      kind: 'git',
      url: 'https://github.com/42Crunch-AI/claude-plugins.git',
      subdir: 'plugins/api',
      ref: 'v1.5.5',
      expectedSha: 'a175b24',
    })
    expect(m.plugins[6]!.source).toEqual({
      kind: 'github',
      owner: 'fullstorydev',
      repo: 'fullstory-skills',
      ref: '1ec5865',
    })
  })

  it('当相对 source 缺少 marketplaceCloneUrl 上下文时，会给出友好的错误', () => {
    // 如果 marketplace 是从一个原始 HTTPS URL 拉下来的，
    // 没有可供 subdir 解析的仓库上下文，但 JSON 里又包含
    // "./plugins/foo" 这种相对路径条目，那么单条错误里就应该明确指出
    // 缺少上下文；同时因为没有任何插件条目成功，整体解析仍应抛错。
    const raw = JSON.stringify({
      name: 'no-ctx',
      plugins: [{ name: 'rel', source: './plugins/foo' }],
    })
    expect(() => parseMarketplace(raw, 'no-ctx')).toThrow(/marketplaceCloneUrl|requires.*clone URL/)
  })

  it('当其他条目可用时，会跳过单个损坏的 source 条目', () => {
    // 真实世界的 marketplace 偶尔会混入某个 schema 不认识的怪异条目，
    // 这种情况下应该只丢掉那一条，而不是让整个目录失效。
    const raw = JSON.stringify({
      name: 'mixed-bad',
      plugins: [
        { name: 'good', source: 'github:foo/bar' },
        { name: 'bad', source: { source: 'mysterious-future-form', whatever: 1 } },
      ],
    })
    const m = parseMarketplace(raw, 'mixed-bad')
    expect(m.plugins.map((p) => p.name)).toEqual(['good'])
  })

  it('会以带字段路径的错误信息拒绝 schema 违规内容', () => {
    const raw = JSON.stringify({ name: 'official', plugins: [{ name: 'foo' }] }) // missing source
    try {
      parseMarketplace(raw, 'official')
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(MarketplaceParseError)
      expect((err as Error).message).toContain('plugins.0.source')
    }
  })

  it('会从各种 git source 形态中提取可选的 `sha` 完整性钉子', () => {
    const raw = JSON.stringify({
      name: 'mixed-sha',
      plugins: [
        {
          name: 'p-git-subdir',
          source: {
            source: 'git-subdir',
            url: 'https://github.com/foo/bar.git',
            path: 'plugins/p',
            ref: 'v1',
            sha: 'a175b24f7b34852b70c78c21545cce8037eb3112',
          },
        },
        {
          name: 'p-git',
          source: { source: 'git', url: 'https://example.com/x.git', sha: '5ddccc3aa1' },
        },
        {
          name: 'p-github',
          source: { source: 'github', owner: 'foo', repo: 'bar', ref: 'main', sha: '1ec5865abc' },
        },
        // 没有 sha 时必须保持 undefined，不能被强行补成别的值。
        { name: 'p-no-sha', source: 'github:foo/baz' },
        // 垃圾 sha 必须被丢弃，不能悄悄传给 installer。
        { name: 'p-bad-sha', source: { source: 'github', owner: 'foo', repo: 'qux', sha: 'not-a-hash' } },
      ],
    })
    const m = parseMarketplace(raw, 'mixed-sha')
    expect(m.plugins).toHaveLength(5)
    expect(m.plugins.find((p) => p.name === 'p-git-subdir')!.source).toMatchObject({
      kind: 'git',
      expectedSha: 'a175b24f7b34852b70c78c21545cce8037eb3112',
    })
    expect(m.plugins.find((p) => p.name === 'p-git')!.source).toMatchObject({
      kind: 'git',
      expectedSha: '5ddccc3aa1',
    })
    expect(m.plugins.find((p) => p.name === 'p-github')!.source).toMatchObject({
      kind: 'github',
      expectedSha: '1ec5865abc',
    })
    const noSha = m.plugins.find((p) => p.name === 'p-no-sha')!.source as { expectedSha?: string }
    expect(noSha.expectedSha).toBeUndefined()
    const badSha = m.plugins.find((p) => p.name === 'p-bad-sha')!.source as { expectedSha?: string }
    expect(badSha.expectedSha).toBeUndefined()
  })

  it('Marketplace.name 应该是订阅别名（sourceLabel），而不是上游 `name`', () => {
    // 回归问题：v0.x 时 `parseMarketplace` 会把上游 marketplace.json
    // 里的 `name` 当成 `Marketplace.name` 返回，导致
    // `plugin marketplace info <订阅别名>` 失效，也让
    // `plugin search` 显示成上游名字而非用户输入的别名。
    // 存储路径、安装 id 与查找逻辑都依赖订阅别名，因此返回值也必须一致。
    const raw = JSON.stringify({
      name: 'claude-plugins-official',
      plugins: [{ name: 'linear', source: 'github:foo/linear' }],
    })
    const m = parseMarketplace(raw, 'anthropic-marketplace')
    expect(m.name).toBe('anthropic-marketplace')
    expect(m.upstreamName).toBe('claude-plugins-official')
  })

  it('当订阅别名与上游名称一致时，upstreamName 应为 undefined', () => {
    const raw = JSON.stringify({
      name: 'community',
      plugins: [{ name: 'foo', source: 'github:foo/bar' }],
    })
    const m = parseMarketplace(raw, 'community')
    expect(m.name).toBe('community')
    expect(m.upstreamName).toBeUndefined()
  })
})

describe('addKnownMarketplace + removeKnownMarketplace', () => {
  it('会把新条目写入 known_marketplaces.json', async () => {
    await addKnownMarketplace({ name: 'community', source: 'github:foo/community' })
    const km = await readKnownMarketplaces()
    expect(km.marketplaces).toHaveLength(1)
    expect(km.marketplaces[0]!.name).toBe('community')
  })

  it('具备幂等性，重复添加时会原地更新 source', async () => {
    await addKnownMarketplace({ name: 'community', source: 'github:foo/community' })
    await addKnownMarketplace({ name: 'community', source: 'github:bar/community' })
    const km = await readKnownMarketplaces()
    expect(km.marketplaces).toHaveLength(1)
    expect(km.marketplaces[0]!.source).toBe('github:bar/community')
  })

  it('会拒绝把保留名称指向非官方 source', async () => {
    await expect(
      addKnownMarketplace({ name: 'anthropic-marketplace', source: 'github:malicious/marketplace' }),
    ).rejects.toThrow(/reserved/)
  })

  it('会接受把保留名称指向官方组织的 source', async () => {
    const expectedOrg = RESERVED_MARKETPLACE_NAMES['anthropic-marketplace']!
    await addKnownMarketplace({
      name: 'anthropic-marketplace',
      source: `github:${expectedOrg}/claude-plugins-official`,
    })
    const km = await readKnownMarketplaces()
    expect(km.marketplaces[0]!.reservedName).toBe(true)
    expect(km.marketplaces[0]!.officialSource).toBe(expectedOrg)
  })

  it('可以移除条目', async () => {
    await addKnownMarketplace({ name: 'community', source: 'github:foo/community' })
    expect(await removeKnownMarketplace('community')).toBe('removed')
    expect(await removeKnownMarketplace('community')).toBe('noop')
    const km = await readKnownMarketplaces()
    expect(km.marketplaces).toEqual([])
  })

  it('写入时会保留 known_marketplaces.json 中的无关字段', async () => {
    // 预先写入一些 loader 完全不认识的附加字段。
    const file = knownMarketplacesPath()
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(
      file,
      JSON.stringify({ marketplaces: [], strictKnownMarketplaces: true, futureField: 42 }, null, 2),
    )
    await addKnownMarketplace({ name: 'community', source: 'github:foo/community' })
    const after = JSON.parse(await fs.readFile(file, 'utf-8')) as Record<string, unknown>
    expect(after.futureField).toBe(42)
    expect(after.strictKnownMarketplaces).toBe(true)
  })
})

describe('readAllCachedMarketplaces', () => {
  it('会读取每个已订阅 marketplace 的缓存 marketplace.json', async () => {
    await addKnownMarketplace({ name: 'community', source: 'github:foo/community' })

    // 手工放置一个缓存的 marketplace.json。
    const cached = JSON.stringify({
      name: 'community',
      plugins: [{ name: 'foo', source: { kind: 'local', path: '/tmp/foo' } }],
    })
    const idx = marketplaceIndexPath('community')
    await fs.mkdir(path.dirname(idx), { recursive: true })
    await fs.writeFile(idx, cached, 'utf-8')

    const all = await readAllCachedMarketplaces()
    expect(all).toHaveLength(1)
    expect(all[0]!.plugins[0]!.name).toBe('foo')
  })

  it('会跳过缓存索引损坏的 marketplace，而不会影响其他项', async () => {
    await addKnownMarketplace({ name: 'good', source: 'github:foo/good' })
    await addKnownMarketplace({ name: 'broken', source: 'github:foo/broken' })

    const goodIdx = marketplaceIndexPath('good')
    await fs.mkdir(path.dirname(goodIdx), { recursive: true })
    await fs.writeFile(goodIdx, JSON.stringify({ name: 'good', plugins: [] }))

    const brokenIdx = marketplaceIndexPath('broken')
    await fs.mkdir(path.dirname(brokenIdx), { recursive: true })
    await fs.writeFile(brokenIdx, '{ not json', 'utf-8')

    const all = await readAllCachedMarketplaces()
    expect(all.map((m) => m.name)).toEqual(['good'])
  })
})

describe('resolveCloneUrl', () => {
  it('会把 github:owner/repo 转成 https URL', () => {
    expect(resolveCloneUrl('github:foo/bar')).toBe('https://github.com/foo/bar.git')
  })

  it('会保留现有的 .git 后缀，避免重复追加', () => {
    // github:foo/bar.git 结尾依旧应该是单个 .git，而不是双重后缀。
    expect(resolveCloneUrl('github:foo/bar.git')).toBe('https://github.com/foo/bar.git')
  })
})
