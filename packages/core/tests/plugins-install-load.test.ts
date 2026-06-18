// installer（本地来源路径）与 loader 集成测试
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  InstallError,
  findInstalledPlugin,
  installPlugin,
  listInstalledPlugins,
  uninstallPlugin,
} from '../src/plugins/installer.js'
import { loadAllPlugins, resolveContributions } from '../src/plugins/loader.js'
import { pluginCacheDir } from '../src/plugins/paths.js'

let originalPluginsDir: string | undefined

// 生成一个临时插件目录，并把给定内容写入指定相对路径的清单文件。
async function makeTempPlugin(body: Record<string, unknown>, rel = 'plugin.json'): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-plugin-src-'))
  const file = path.join(root, rel)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(body, null, 2), 'utf-8')
  return root
}

beforeEach(async () => {
  originalPluginsDir = process.env.XC_PLUGINS_DIR
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-plugins-cache-test-'))
  process.env.XC_PLUGINS_DIR = tmp
})

afterEach(() => {
  if (originalPluginsDir === undefined) delete process.env.XC_PLUGINS_DIR
  else process.env.XC_PLUGINS_DIR = originalPluginsDir
})

// ── installer ──────────────────────────────────────────────────────────

describe('installPlugin (local source)', () => {
  it('会把本地插件复制进缓存并写入安装记录', async () => {
    const src = await makeTempPlugin({ name: 'demo', version: '1.0.0', description: 'd' })

    const result = await installPlugin({
      source: { kind: 'local', path: src },
      marketplace: 'local',
    })

    expect(result.pluginId).toBe('demo@local')
    expect(result.manifest.name).toBe('demo')
    expect(result.rootDir).toBe(pluginCacheDir('local', 'demo', '1.0.0'))

    // 缓存中的 manifest 应该存在。
    expect(
      await fs
        .access(path.join(result.rootDir, 'plugin.json'))
        .then(() => true)
        .catch(() => false),
    ).toBe(true)

    // 安装记录也应该成功落盘。
    const installed = await listInstalledPlugins()
    expect(installed).toHaveLength(1)
    expect(installed[0]!.id).toBe('demo@local')
    expect(installed[0]!.version).toBe('1.0.0')
  })

  it('会用友好的错误拒绝仅支持 Gemini 的来源', async () => {
    const src = await makeTempPlugin({ name: 'demo', version: '1.0.0' }, 'gemini-extension.json')

    await expect(installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })).rejects.toThrow(
      /Gemini extension/,
    )
  })

  it('会拒绝缺少 manifest 的来源目录', async () => {
    const src = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-plugin-empty-'))
    await expect(installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })).rejects.toBeInstanceOf(
      InstallError,
    )
  })

  it('在设置 expectedName 时会强制校验插件名', async () => {
    const src = await makeTempPlugin({ name: 'actually-this', version: '1.0.0' })
    await expect(
      installPlugin({
        source: { kind: 'local', path: src },
        marketplace: 'local',
        expectedName: 'something-else',
      }),
    ).rejects.toThrow(/does not match/)
  })

  it('重新安装同版本插件时会先清空旧目录再覆盖', async () => {
    const src1 = await makeTempPlugin({ name: 'demo', version: '1.0.0' })
    await installPlugin({ source: { kind: 'local', path: src1 }, marketplace: 'local' })

    // 先在缓存目录放一个标记文件。
    const dir = pluginCacheDir('local', 'demo', '1.0.0')
    await fs.writeFile(path.join(dir, 'stale.txt'), 'should not survive')

    const src2 = await makeTempPlugin({ name: 'demo', version: '1.0.0', description: 'updated' })
    await installPlugin({ source: { kind: 'local', path: src2 }, marketplace: 'local' })

    // 擦除并替换后，陈旧文件应该消失。
    const staleExists = await fs
      .access(path.join(dir, 'stale.txt'))
      .then(() => true)
      .catch(() => false)
    expect(staleExists).toBe(false)
  })

  it('也会把非 manifest 文件（skills/、agents/ 等）复制进缓存', async () => {
    const src = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-plugin-rich-'))
    await fs.writeFile(
      path.join(src, 'plugin.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0', skills: './skills' }),
    )
    await fs.mkdir(path.join(src, 'skills', 'foo'), { recursive: true })
    await fs.writeFile(path.join(src, 'skills', 'foo', 'SKILL.md'), '---\nname: foo\ndescription: d\n---\n')

    const result = await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })
    const skillFile = path.join(result.rootDir, 'skills', 'foo', 'SKILL.md')
    expect(
      await fs
        .access(skillFile)
        .then(() => true)
        .catch(() => false),
    ).toBe(true)
  })
})

describe('install policy gates (strictKnownMarketplaces + blockedPlugins)', () => {
  // known_marketplaces.json 里的这两个字段用于给管理员提供
  // 可执行的安装控制。它们以前虽然会被解析，但从未真正生效，
  // 这里用测试把新行为固定下来。

  it('strictKnownMarketplaces 会拒绝来自未订阅 marketplace 的安装', async () => {
    const file = path.join(process.env.XC_PLUGINS_DIR!, 'known_marketplaces.json')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ marketplaces: [], strictKnownMarketplaces: true }))

    const src = await makeTempPlugin({ name: 'demo', version: '1.0.0' })
    await expect(installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })).rejects.toThrow(
      /strict marketplace mode/,
    )
  })

  it('strictKnownMarketplaces 会接受来自已订阅 marketplace 的安装', async () => {
    const file = path.join(process.env.XC_PLUGINS_DIR!, 'known_marketplaces.json')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(
      file,
      JSON.stringify({
        marketplaces: [{ name: 'official', source: 'github:foo/official' }],
        strictKnownMarketplaces: true,
      }),
    )

    const src = await makeTempPlugin({ name: 'demo', version: '1.0.0' })
    const result = await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'official' })
    expect(result.pluginId).toBe('demo@official')
  })

  it('blockedPlugins 会无视 marketplace 与 consent，直接拒绝匹配的插件 id', async () => {
    const file = path.join(process.env.XC_PLUGINS_DIR!, 'known_marketplaces.json')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ marketplaces: [], blockedPlugins: ['demo@local'] }))

    const src = await makeTempPlugin({ name: 'demo', version: '1.0.0' })
    await expect(installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })).rejects.toThrow(
      /blockedPlugins/,
    )
  })

  it('blockedPlugins 也支持仅按裸插件名匹配（全局封禁快捷写法）', async () => {
    // 管理员通常会合理地期待 `blockedPlugins: ['demo']`
    // 能像 npm-ignore 一样一把拦住所有 marketplace 中名为 demo 的插件。
    // 当然，精确场景下依旧支持全限定写法。
    const file = path.join(process.env.XC_PLUGINS_DIR!, 'known_marketplaces.json')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ marketplaces: [], blockedPlugins: ['demo'] }))

    const src = await makeTempPlugin({ name: 'demo', version: '1.0.0' })
    await expect(
      installPlugin({ source: { kind: 'local', path: src }, marketplace: 'some-other-marketplace' }),
    ).rejects.toThrow(/blockedPlugins/)
  })

  it('blockedPlugins 不会误伤只是共享前缀的其他插件', async () => {
    // 裸名称匹配必须是严格相等，而不是子串匹配；
    // 封禁 "demo" 不应顺带封禁 "demo-extra"。
    const file = path.join(process.env.XC_PLUGINS_DIR!, 'known_marketplaces.json')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ marketplaces: [], blockedPlugins: ['demo'] }))

    const src = await makeTempPlugin({ name: 'demo-extra', version: '1.0.0' })
    const result = await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })
    expect(result.pluginId).toBe('demo-extra@local')
  })
})

describe('uninstallPlugin', () => {
  it('会删除缓存与记录，并返回清理掉的版本号', async () => {
    const src = await makeTempPlugin({ name: 'demo', version: '1.0.0' })
    await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })

    const result = await uninstallPlugin('demo@local')
    expect(result.removedRecord).toBe(true)
    expect(result.removedVersions).toEqual(['1.0.0'])

    expect(await findInstalledPlugin('demo@local')).toBeUndefined()
  })

  it('面对未知插件时是无操作', async () => {
    const result = await uninstallPlugin('ghost@local')
    expect(result).toEqual({ removedRecord: false, removedVersions: [] })
  })
})

// ── loader ─────────────────────────────────────────────────────────────

describe('loadAllPlugins', () => {
  it('禁用时会返回空注册表', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-loader-cwd-'))
    const result = await loadAllPlugins({ cwd, disabled: true })
    expect(result.registry.list()).toEqual([])
    expect(result.contributions.size).toBe(0)
  })

  it('会从 installed_plugins.json 加载用户范围内已安装的插件', async () => {
    const src = await makeTempPlugin({ name: 'demo', version: '1.0.0', skills: './skills' })
    await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-loader-cwd-'))
    const result = await loadAllPlugins({ cwd })

    const list = result.registry.listAll()
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe('demo@local')
    expect(list[0]!.enabled).toBe(true) // 默认启用

    const contrib = result.contributions.get('demo@local')
    expect(contrib?.skillsDir).toBe(path.resolve(list[0]!.rootDir, './skills'))
  })

  it('会从 <cwd>/.x-code/plugins/<name>/ 加载项目本地插件', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-loader-cwd-'))
    const pluginDir = path.join(cwd, '.x-code', 'plugins', 'inhouse')
    await fs.mkdir(pluginDir, { recursive: true })
    await fs.writeFile(path.join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'inhouse', version: '0.1.0' }))

    const result = await loadAllPlugins({ cwd })
    const list = result.registry.listAll()
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe('inhouse@local')
    expect(list[0]!.scope).toBe('project')
  })

  it('遇到损坏的 manifest 时会记录加载错误，但不会中断整体加载', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-loader-cwd-'))
    const broken = path.join(cwd, '.x-code', 'plugins', 'broken')
    await fs.mkdir(broken, { recursive: true })
    await fs.writeFile(path.join(broken, 'plugin.json'), '{ not json', 'utf-8')

    const good = path.join(cwd, '.x-code', 'plugins', 'good')
    await fs.mkdir(good, { recursive: true })
    await fs.writeFile(path.join(good, 'plugin.json'), JSON.stringify({ name: 'good', version: '1.0.0' }))

    const result = await loadAllPlugins({ cwd })
    expect(result.registry.listAll()).toHaveLength(1)
    expect(result.registry.listAll()[0]!.id).toBe('good@local')
    expect(result.registry.loadErrors()).toHaveLength(1)
    expect(result.registry.loadErrors()[0]!.path).toBe(broken)
  })

  it('遇到 Gemini extension 加载错误时会记录下来，而不会崩溃', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-loader-cwd-'))
    const gemini = path.join(cwd, '.x-code', 'plugins', 'gemini-plugin')
    await fs.mkdir(gemini, { recursive: true })
    await fs.writeFile(
      path.join(gemini, 'gemini-extension.json'),
      JSON.stringify({ name: 'gemini-plugin', version: '1.0.0' }),
    )

    const result = await loadAllPlugins({ cwd })
    expect(result.registry.listAll()).toHaveLength(0)
    expect(result.registry.loadErrors()).toHaveLength(1)
    expect(result.registry.loadErrors()[0]!.message).toMatch(/Gemini/)
  })

  it('会遵循 <cwd>/.x-code/settings.local.json 中的启用开关', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-loader-cwd-'))
    const pluginDir = path.join(cwd, '.x-code', 'plugins', 'disabled-one')
    await fs.mkdir(pluginDir, { recursive: true })
    await fs.writeFile(path.join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'disabled-one', version: '1.0.0' }))

    await fs.writeFile(
      path.join(cwd, '.x-code', 'settings.local.json'),
      JSON.stringify({ enabledPlugins: { 'disabled-one@local': false } }),
    )

    const result = await loadAllPlugins({ cwd })
    const list = result.registry.listAll()
    expect(list).toHaveLength(1)
    expect(list[0]!.enabled).toBe(false)
    expect(result.registry.list()).toHaveLength(0) // 会被 .list() 过滤掉
  })
})

describe('resolveContributions', () => {
  it('会基于 rootDir 解析 manifest 中声明的路径', async () => {
    const plugin = {
      id: 'demo@local',
      manifest: {
        schemaVersion: '1',
        name: 'demo',
        version: '1.0.0',
        skills: './skills',
        agents: './agents',
        mcpServers: './mcp.json',
      },
      rootDir: '/abs/root',
      manifestPath: '/abs/root/plugin.json',
      manifestFormat: 'bare' as const,
      source: undefined,
      marketplace: 'local',
      scope: 'project' as const,
      enabled: true,
    }
    const c = await resolveContributions(plugin)
    expect(c.skillsDir).toBe(path.resolve('/abs/root', './skills'))
    expect(c.agentsDir).toBe(path.resolve('/abs/root', './agents'))
    expect(c.mcpServers).toEqual({ kind: 'path', path: path.resolve('/abs/root', './mcp.json') })
  })

  it('当 manifest 省略 commands/agents/skills/ 时会按 Claude Code 约定自动发现', async () => {
    // 这里构造一个真实落盘的插件目录，让基于约定的 fs.stat 探测
    // 真正能探测到东西。
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-resolve-conv-'))
    await fs.writeFile(path.join(root, 'plugin.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }))
    await fs.mkdir(path.join(root, 'commands'), { recursive: true })
    await fs.mkdir(path.join(root, 'agents'), { recursive: true })
    await fs.writeFile(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: {} }))

    const plugin = {
      id: 'demo@local',
      manifest: { schemaVersion: '1', name: 'demo', version: '1.0.0' },
      rootDir: root,
      manifestPath: path.join(root, 'plugin.json'),
      manifestFormat: 'bare' as const,
      source: undefined,
      marketplace: 'local',
      scope: 'project' as const,
      enabled: true,
    }
    const c = await resolveContributions(plugin)
    expect(c.commandsDir).toBe(path.join(root, 'commands'))
    expect(c.agentsDir).toBe(path.join(root, 'agents'))
    expect(c.skillsDir).toBeUndefined() // 没有 skills/ 目录时应为 undefined
    expect(c.mcpServers).toEqual({ kind: 'path', path: path.join(root, '.mcp.json') })
  })
})

// ── userConfig 安装时提示 ─────────────────────────────────────

describe('installPlugin (userConfig prompt)', () => {
  it('会把 manifest 的 userConfig 字段传给回调，并持久化回调返回值', async () => {
    const { getPluginUserConfig } = await import('../src/plugins/user-config.js')
    const src = await makeTempPlugin({
      name: 'cfg-demo',
      version: '1.0.0',
      userConfig: [
        { key: 'API_KEY', type: 'string', sensitive: true, prompt: 'Enter the key' },
        { key: 'BASE_URL', type: 'string', default: 'https://api.example.com' },
      ],
    })

    let receivedFields: unknown
    const result = await installPlugin({
      source: { kind: 'local', path: src },
      marketplace: 'local',
      userConfigPrompt: async (fields) => {
        receivedFields = fields
        return { API_KEY: 'sk-test', BASE_URL: 'https://override' }
      },
    })

    // 回调应该原样看到两个字段。
    expect(Array.isArray(receivedFields)).toBe(true)
    expect((receivedFields as Array<{ key: string }>).map((f) => f.key)).toEqual(['API_KEY', 'BASE_URL'])

    // 应该以插件 id 为键落盘到 user-config.json。
    const stored = await getPluginUserConfig(result.pluginId)
    expect(stored).toEqual({ API_KEY: 'sk-test', BASE_URL: 'https://override' })
  })

  it('当 userConfig 提示返回 null 时会中止安装', async () => {
    const src = await makeTempPlugin({
      name: 'aborted',
      version: '1.0.0',
      userConfig: [{ key: 'TOKEN', type: 'string', required: true }],
    })

    await expect(
      installPlugin({
        source: { kind: 'local', path: src },
        marketplace: 'local',
        userConfigPrompt: async () => null,
      }),
    ).rejects.toThrow(/userConfig/)

    // 在移动前就中止，因此不应创建任何缓存记录。
    const installed = await listInstalledPlugins()
    expect(installed).toHaveLength(0)
  })

  it('当 manifest 未声明 userConfig 时会完全跳过提示', async () => {
    const src = await makeTempPlugin({ name: 'no-cfg', version: '1.0.0' })
    let calls = 0
    await installPlugin({
      source: { kind: 'local', path: src },
      marketplace: 'local',
      userConfigPrompt: async () => {
        calls++
        return {}
      },
    })
    expect(calls).toBe(0)
  })
})

// ── /plugin refresh 热重载 ─────────────────────────────────────────

describe('refreshPluginContributions', () => {
  it('会在两次扫描之间发现新增插件，并把它合并进技能注册表', async () => {
    const { refreshPluginContributions } = await import('../src/plugins/refresh.js')
    const { createSkillRegistry } = await import('../src/skills/registry.js')

    // 先安装一个带 skill 的插件，并基于这个快照构建注册表。
    const src1 = await makeTempPlugin({ name: 'p1', version: '1.0.0' })
    // 添加一个 skill 目录，便于 resolveContributions 自动发现。
    await fs.mkdir(path.join(src1, 'skills', 'hello'), { recursive: true })
    await fs.writeFile(
      path.join(src1, 'skills', 'hello', 'SKILL.md'),
      '---\nname: hello\ndescription: greet\n---\nBody',
      'utf-8',
    )
    await installPlugin({ source: { kind: 'local', path: src1 }, marketplace: 'local' })

    const initialLoad = await loadAllPlugins({ cwd: process.cwd() })
    const { buildPluginIntegration } = await import('../src/plugins/integration.js')
    const initialIntegration = await buildPluginIntegration(initialLoad)
    const skillRegistry = await createSkillRegistry({ extraDirs: initialIntegration.skillsDirs })
    expect(skillRegistry.get('hello')).toBeDefined()

    // 在初次加载之后再安装第二个插件。新 skill 不应立刻出现，
    // 而是要等到 /plugin refresh 才会被纳入。
    const src2 = await makeTempPlugin({ name: 'p2', version: '1.0.0' })
    await fs.mkdir(path.join(src2, 'skills', 'world'), { recursive: true })
    await fs.writeFile(
      path.join(src2, 'skills', 'world', 'SKILL.md'),
      '---\nname: world\ndescription: w\n---\nBody',
      'utf-8',
    )
    await installPlugin({ source: { kind: 'local', path: src2 }, marketplace: 'local' })
    expect(skillRegistry.get('world')).toBeUndefined()

    // refresh 会重建插件注册表，并把新技能折叠进来。
    const summary = await refreshPluginContributions({
      pluginRegistry: initialLoad.registry,
      skillRegistry,
    })
    expect(summary.plugins.added).toContain('p2@local')
    expect(skillRegistry.get('world')).toBeDefined()
    // 已有插件仍然应该保持加载状态。
    expect(skillRegistry.get('hello')).toBeDefined()
  })

  it('当接入 mcpRegistry 时会在刷新后重启 MCP 服务', async () => {
    const { refreshPluginContributions } = await import('../src/plugins/refresh.js')
    const { McpRegistry } = await import('../src/mcp/registry.js')

    // 安装一个声明了内联 mcpServer 的插件。这里故意使用一个无法真正连通的
    // stdio 命令，让服务启动失败也没关系，因为我们只需要验证
    // restartAll 是否用合并后的插件服务配置被调用过。
    const src = await makeTempPlugin({
      name: 'mcp-bringing-plugin',
      version: '1.0.0',
      mcpServers: {
        'plugin-mcp': { command: 'node', args: ['-e', 'process.exit(0)'] },
      },
    })
    await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })

    const initialLoad = await loadAllPlugins({ cwd: process.cwd() })
    // 构造一个假的 McpRegistry，让 restartAll 只记录收到的配置，
    // 这样测试就不依赖真实 MCP 子进程是否能成功拉起。
    const seenConfigs: Array<Map<string, unknown>> = []
    const stub = Object.create(McpRegistry.prototype)
    stub.restartAll = async (configs: Map<string, unknown>) => {
      seenConfigs.push(configs)
      return { added: [...configs.keys()], removed: [], changed: [], unchanged: [] }
    }

    const summary = await refreshPluginContributions({
      pluginRegistry: initialLoad.registry,
      mcpRegistry: stub,
      // 这里实际上不该触发 askUser，因为测试里没有需要确认的项目级 MCP 配置。
      // 所以提供一个若被调用就直接抛错的 stub。
      askUser: async () => {
        throw new Error('askUser should not be invoked when project mcpServers is empty')
      },
    })

    expect(seenConfigs.length).toBe(1)
    expect(seenConfigs[0]!.has('plugin-mcp')).toBe(true)
    expect(summary.mcp).toBeDefined()
    expect(summary.mcp!.added).toContain('plugin-mcp')
  })

  it('当未传入 mcpRegistry 时会跳过 MCP 重启（保持向后兼容的默认行为）', async () => {
    const { refreshPluginContributions } = await import('../src/plugins/refresh.js')

    const src = await makeTempPlugin({ name: 'no-mcp-pass', version: '1.0.0' })
    await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })

    const initialLoad = await loadAllPlugins({ cwd: process.cwd() })
    const summary = await refreshPluginContributions({
      pluginRegistry: initialLoad.registry,
    })
    expect(summary.mcp).toBeUndefined()
  })
})

/**
 * 创建一个仅含一个提交的本地 git 仓库，并返回它的路径
 *（可直接作为 `kind: 'git'` 的 source URL，`git clone /path` 可用）
 * 以及当前 HEAD 的 sha。这样我们就能在不依赖网络和真实 GitHub 仓库的
 * 情况下测试 sha 校验逻辑。
 */
async function makeLocalGitRepo(manifest: Record<string, unknown>): Promise<{ url: string; sha: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-git-src-'))
  await execa('git', ['init', '-q', '-b', 'main'], { cwd: root })
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  await execa('git', ['config', 'user.name', 'test'], { cwd: root })
  await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: root })
  await fs.writeFile(path.join(root, 'plugin.json'), JSON.stringify(manifest))
  await execa('git', ['add', '-A'], { cwd: root })
  await execa('git', ['commit', '-q', '-m', 'init'], { cwd: root })
  const sha = (await execa('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
  return { url: root, sha }
}

describe('install sha integrity check (marketplace.json `sha` field)', () => {
  it('当声明的 sha 与克隆结果的 HEAD 匹配时会接受安装', async () => {
    const { url, sha } = await makeLocalGitRepo({ name: 'demo', version: '1.0.0' })
    const result = await installPlugin({
      source: { kind: 'git', url, expectedSha: sha },
      marketplace: 'local',
    })
    expect(result.pluginId).toBe('demo@local')
  })

  it('当声明的 sha 不匹配时会拒绝安装', async () => {
    const { url } = await makeLocalGitRepo({ name: 'demo', version: '1.0.0' })
    const fakeSha = '0000000000000000000000000000000000000000'
    await expect(
      installPlugin({
        source: { kind: 'git', url, expectedSha: fakeSha },
        marketplace: 'local',
      }),
    ).rejects.toThrow(/sha integrity check failed/)
  })

  it('当未声明 sha 时会完全跳过校验（兼容无 sha 的 marketplace）', async () => {
    const { url } = await makeLocalGitRepo({ name: 'demo', version: '1.0.0' })
    const result = await installPlugin({
      source: { kind: 'git', url }, // 没有 expectedSha
      marketplace: 'local',
    })
    expect(result.pluginId).toBe('demo@local')
  })

  it('会接受与完整 HEAD 前缀匹配的短 sha（至少 7 位），容忍度与 `git checkout <short>` 一致', async () => {
    const { url, sha } = await makeLocalGitRepo({ name: 'demo', version: '1.0.0' })
    const shortSha = sha.slice(0, 7)
    const result = await installPlugin({
      source: { kind: 'git', url, expectedSha: shortSha },
      marketplace: 'local',
    })
    expect(result.pluginId).toBe('demo@local')
  })
})
