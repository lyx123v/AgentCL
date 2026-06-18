// 安装期 consent 预览与默认 marketplace 种子数据测试
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { buildConsentPreview, probePluginRoot } from '../src/plugins/consent.js'
import { installPlugin } from '../src/plugins/installer.js'
import { ensureDefaultMarketplaces, readKnownMarketplaces } from '../src/plugins/marketplace.js'

let originalPluginsDir: string | undefined

// 以 UTF-8 写入测试文件，并确保父目录存在。
async function writeFileAt(file: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, body, 'utf-8')
}

beforeEach(async () => {
  originalPluginsDir = process.env.XC_PLUGINS_DIR
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-plugin-consent-test-'))
  process.env.XC_PLUGINS_DIR = tmp
})

afterEach(() => {
  if (originalPluginsDir === undefined) delete process.env.XC_PLUGINS_DIR
  else process.env.XC_PLUGINS_DIR = originalPluginsDir
})

describe('buildConsentPreview', () => {
  it('可以从内联 hook 配置中提取事件名', () => {
    const preview = buildConsentPreview({
      pluginId: 'demo@local',
      marketplace: 'local',
      source: { kind: 'local', path: '/p' },
      manifest: {
        schemaVersion: '1',
        name: 'demo',
        version: '1.0.0',
        hooks: { PreToolUse: [{ command: 'lint.sh' }], TurnComplete: [{ command: 'notify.sh' }] },
      },
    })
    expect(preview.hookEvents).toEqual(['PreToolUse', 'TurnComplete'])
    expect(preview.hasPathHooks).toBe(false)
  })

  it('可以提取内联 mcpServer 名称', () => {
    const preview = buildConsentPreview({
      pluginId: 'demo@local',
      marketplace: 'local',
      source: { kind: 'local', path: '/p' },
      manifest: {
        schemaVersion: '1',
        name: 'demo',
        version: '1.0.0',
        mcpServers: { gh: { command: 'gh-mcp' }, lin: { command: 'linear-mcp' } },
      },
    })
    expect(preview.inlineMcpServerNames.sort()).toEqual(['gh', 'lin'])
    expect(preview.hasPathMcpServers).toBe(false)
  })

  it('会通过 rootProbe 暴露自动发现的根目录 .mcp.json（扁平结构）', async () => {
    // 复现 linear@anthropic-marketplace 的目录结构：
    // manifest 只有元数据，根目录存在扁平的 .mcp.json
    //（没有 `mcpServers` 包装层）。
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-consent-probe-flat-'))
    await fs.writeFile(
      path.join(root, '.mcp.json'),
      JSON.stringify({ linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } }),
    )
    const rootProbe = await probePluginRoot(root)

    const preview = buildConsentPreview({
      pluginId: 'linear@anthropic-marketplace',
      marketplace: 'anthropic-marketplace',
      source: { kind: 'local', path: root },
      manifest: { schemaVersion: '1', name: 'linear', version: '0.0.0' },
      rootProbe,
    })
    expect(preview.inlineMcpServerNames).toEqual(['linear'])
    expect(preview.hasPathMcpServers).toBe(true)
  })

  it('会通过 rootProbe 暴露自动发现的根目录 .mcp.json（包裹结构）', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-consent-probe-wrapped-'))
    await fs.writeFile(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { gh: { command: 'gh-mcp' } } }))
    const rootProbe = await probePluginRoot(root)

    const preview = buildConsentPreview({
      pluginId: 'gh@local',
      marketplace: 'local',
      source: { kind: 'local', path: root },
      manifest: { schemaVersion: '1', name: 'gh', version: '1.0.0' },
      rootProbe,
    })
    expect(preview.inlineMcpServerNames).toEqual(['gh'])
    expect(preview.hasPathMcpServers).toBe(true)
  })

  it('会通过 rootProbe 暴露自动发现的 skills/agents/commands 目录', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-consent-probe-dirs-'))
    await fs.mkdir(path.join(root, 'skills'))
    await fs.mkdir(path.join(root, 'agents'))
    await fs.mkdir(path.join(root, 'commands'))
    const rootProbe = await probePluginRoot(root)

    const preview = buildConsentPreview({
      pluginId: 'demo@local',
      marketplace: 'local',
      source: { kind: 'local', path: root },
      manifest: { schemaVersion: '1', name: 'demo', version: '1.0.0' },
      rootProbe,
    })
    expect(preview.hasSkillsDir).toBe(true)
    expect(preview.hasAgentsDir).toBe(true)
    expect(preview.hasCommandsDir).toBe(true)
  })
})

describe('installPlugin + consent', () => {
  // 构造一个本地插件目录，供 consent 与安装流程测试复用。
  async function makeLocalPlugin(): Promise<string> {
    const src = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-consent-src-'))
    await writeFileAt(
      path.join(src, 'plugin.json'),
      JSON.stringify({
        name: 'demo',
        version: '1.0.0',
        hooks: { PreToolUse: [{ command: 'x' }] },
        mcpServers: { gh: { command: 'gh' } },
      }),
    )
    return src
  }

  it('会把反映 manifest 内容的预览传给 consent 回调', async () => {
    const src = await makeLocalPlugin()
    let received: { pluginId: string; hookEvents: string[]; mcpNames: string[] } | null = null
    await installPlugin({
      source: { kind: 'local', path: src },
      marketplace: 'local',
      consent: async (preview) => {
        received = {
          pluginId: preview.pluginId,
          hookEvents: preview.hookEvents,
          mcpNames: preview.inlineMcpServerNames,
        }
        return true
      },
    })
    expect(received).toEqual({
      pluginId: 'demo@local',
      hookEvents: ['PreToolUse'],
      mcpNames: ['gh'],
    })
  })

  it('当 consent 返回 false 时会中止安装并清理缓存', async () => {
    const src = await makeLocalPlugin()
    await expect(
      installPlugin({
        source: { kind: 'local', path: src },
        marketplace: 'local',
        consent: async () => false,
      }),
    ).rejects.toThrow(/consent/)

    // installed_plugins.json 中不应留下任何记录。
    const { listInstalledPlugins } = await import('../src/plugins/installer.js')
    expect(await listInstalledPlugins()).toEqual([])
  })

  it('未提供 consent 回调时会直接继续，不进行提示', async () => {
    const src = await makeLocalPlugin()
    const result = await installPlugin({
      source: { kind: 'local', path: src },
      marketplace: 'local',
    })
    expect(result.pluginId).toBe('demo@local')
  })
})

describe('ensureDefaultMarketplaces', () => {
  it('首次运行时会写入 anthropic-marketplace', async () => {
    await ensureDefaultMarketplaces()
    const km = await readKnownMarketplaces()
    expect(km.marketplaces.map((m) => m.name)).toEqual(['anthropic-marketplace'])
    expect(km.marketplaces[0]!.reservedName).toBe(true)
    expect(km.marketplaces[0]!.officialSource).toBe('anthropics')
  })

  it('重复运行具备幂等性', async () => {
    await ensureDefaultMarketplaces()
    await ensureDefaultMarketplaces()
    await ensureDefaultMarketplaces()
    const km = await readKnownMarketplaces()
    expect(km.marketplaces).toHaveLength(1)
  })

  it('当用户显式移除订阅后，当前行为仍会重新补回默认 marketplace', async () => {
    await ensureDefaultMarketplaces()
    const { removeKnownMarketplace } = await import('../src/plugins/marketplace.js')
    await removeKnownMarketplace('anthropic-marketplace')

    await ensureDefaultMarketplaces()

    // ensureDefaultMarketplaces 在条目缺失时会重新添加，因此这里再次运行
    // 的确会重新订阅。这是有意为之：为了保持初始化逻辑简单，
    // “缺失”与“首次运行”被视为同一种状态。
    // 这里把当前行为固定下来，避免将来无意识地改坏它。
    const km = await readKnownMarketplaces()
    expect(km.marketplaces).toHaveLength(1)
  })
})
