// plugin 与现有 loader 的集成测试
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { installPlugin } from '../src/plugins/installer.js'
import { buildPluginIntegration } from '../src/plugins/integration.js'
import { loadAllPlugins } from '../src/plugins/loader.js'

let originalPluginsDir: string | undefined

// 以 UTF-8 写入文件，并自动创建父目录。
async function writeFileAt(file: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, body, 'utf-8')
}

beforeEach(async () => {
  originalPluginsDir = process.env.XC_PLUGINS_DIR
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-plugins-int-test-'))
  process.env.XC_PLUGINS_DIR = tmp
})

afterEach(() => {
  if (originalPluginsDir === undefined) delete process.env.XC_PLUGINS_DIR
  else process.env.XC_PLUGINS_DIR = originalPluginsDir
})

describe('buildPluginIntegration', () => {
  it('会列出每个启用插件的 skill 与 agent 目录（解析为绝对路径）', async () => {
    // 构造一个带有 skills/ 与 agents/ 目录的插件树。
    const src = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-plugin-src-'))
    await writeFileAt(
      path.join(src, 'plugin.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0', skills: './skills', agents: './agents' }),
    )
    await fs.mkdir(path.join(src, 'skills'), { recursive: true })
    await fs.mkdir(path.join(src, 'agents'), { recursive: true })

    await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-cwd-'))
    const load = await loadAllPlugins({ cwd })
    const out = await buildPluginIntegration(load)

    expect(out.skillsDirs).toHaveLength(1)
    expect(out.skillsDirs[0]!.pluginId).toBe('demo@local')
    expect(path.isAbsolute(out.skillsDirs[0]!.dir)).toBe(true)
    expect(out.agentsDirs[0]!.dir).toContain('agents')
  })

  it('会暴露拥有 commands/ 贡献的插件 commandsDirs', async () => {
    const src = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-plugin-src-'))
    await writeFileAt(
      path.join(src, 'plugin.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0', commands: './cmds' }),
    )
    await fs.mkdir(path.join(src, 'cmds'), { recursive: true })

    await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-cwd-'))
    const out = await buildPluginIntegration(await loadAllPlugins({ cwd }))

    expect(out.commandsDirs).toHaveLength(1)
    expect(out.commandsDirs[0]!.pluginId).toBe('demo@local')
    expect(out.commandsDirs[0]!.pluginRoot).toBeDefined()
  })

  it('会根据内联 hooks 贡献构建 HookRegistry', async () => {
    const src = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-plugin-src-'))
    await writeFileAt(
      path.join(src, 'plugin.json'),
      JSON.stringify({
        name: 'demo',
        version: '1.0.0',
        hooks: { PreToolUse: [{ command: 'lint.sh' }] },
      }),
    )
    await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-cwd-'))
    const out = await buildPluginIntegration(await loadAllPlugins({ cwd }))

    expect(out.pluginHooks).toHaveLength(1)
    expect(out.pluginHooks[0]!.events).toEqual(['PreToolUse'])
    expect(out.hookRegistry.has('PreToolUse')).toBe(true)
    expect(out.hookRegistry.get('PreToolUse')).toHaveLength(1)
    expect(out.hookRegistry.get('PreToolUse')[0]!.pluginId).toBe('demo@local')
    expect(out.hookErrors).toEqual([])
  })

  it('会按插件记录 hook 配置解析错误，而不会拖垮其他插件', async () => {
    const bad = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-plugin-bad-'))
    await writeFileAt(
      path.join(bad, 'plugin.json'),
      JSON.stringify({
        name: 'badhook',
        version: '1.0.0',
        // 缺少 command，schema 应该拒绝。
        hooks: { PreToolUse: [{ matcher: 'edit_file' }] },
      }),
    )
    await installPlugin({ source: { kind: 'local', path: bad }, marketplace: 'local' })

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-cwd-'))
    const out = await buildPluginIntegration(await loadAllPlugins({ cwd }))

    expect(out.hookErrors).toHaveLength(1)
    expect(out.hookErrors[0]!.pluginId).toBe('badhook@local')
    expect(out.hookRegistry.list()).toHaveLength(0)
  })

  it('会从插件根目录的 JSON 文件解析路径式 mcpServers', async () => {
    const src = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-plugin-src-'))
    await writeFileAt(
      path.join(src, 'plugin.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0', mcpServers: './mcp.json' }),
    )
    await writeFileAt(path.join(src, 'mcp.json'), JSON.stringify({ mcpServers: { gh: { command: 'gh-mcp' } } }))
    await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-cwd-'))
    const out = await buildPluginIntegration(await loadAllPlugins({ cwd }))

    expect(out.mcpServers.gh).toBeDefined()
    expect((out.mcpServers.gh as { command?: string }).command).toBe('gh-mcp')
  })

  it('会接受扁平 `.mcp.json`（没有 `mcpServers` 包装），兼容 Claude Code 官方插件形态', async () => {
    // linear@anthropic-marketplace 的 .mcp.json 是扁平的 `name -> cfg`
    // 映射，没有 `mcpServers` 包装层。我们以前会悄悄把它丢掉。
    const src = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-plugin-flat-mcp-'))
    await writeFileAt(path.join(src, 'plugin.json'), JSON.stringify({ name: 'linearish', version: '1.0.0' }))
    await writeFileAt(
      path.join(src, '.mcp.json'),
      JSON.stringify({ linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } }),
    )
    await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-cwd-'))
    const out = await buildPluginIntegration(await loadAllPlugins({ cwd }))

    expect(out.mcpErrors).toEqual([])
    expect(out.mcpServers.linear).toBeDefined()
    expect((out.mcpServers.linear as { url?: string }).url).toBe('https://mcp.linear.app/mcp')
  })

  it('遇到 mcpServers 同名冲突时会采用先到先得，并记录被丢弃的一方', async () => {
    // 两个插件都贡献了名为 "gh" 的服务。
    const srcA = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-plugin-srcA-'))
    await writeFileAt(
      path.join(srcA, 'plugin.json'),
      JSON.stringify({
        name: 'aaa-first',
        version: '1.0.0',
        mcpServers: { gh: { command: 'first-cmd' } },
      }),
    )
    await installPlugin({ source: { kind: 'local', path: srcA }, marketplace: 'local' })

    const srcB = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-plugin-srcB-'))
    await writeFileAt(
      path.join(srcB, 'plugin.json'),
      JSON.stringify({
        name: 'bbb-second',
        version: '1.0.0',
        mcpServers: { gh: { command: 'second-cmd' } },
      }),
    )
    await installPlugin({ source: { kind: 'local', path: srcB }, marketplace: 'local' })

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-cwd-'))
    const out = await buildPluginIntegration(await loadAllPlugins({ cwd }))

    // 先安装的插件获胜（按 installed_plugins.json 顺序）。
    expect((out.mcpServers.gh as { command?: string }).command).toBe('first-cmd')
    expect(out.mcpCollisions).toHaveLength(1)
    expect(out.mcpCollisions[0]).toEqual({
      name: 'gh',
      droppedFrom: 'bbb-second@local',
      keptFrom: 'aaa-first@local',
    })
  })

  it('会按插件记录 mcp 解析错误，而不会影响其他插件', async () => {
    const bad = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-plugin-bad-'))
    await writeFileAt(
      path.join(bad, 'plugin.json'),
      JSON.stringify({
        name: 'badmcp',
        version: '1.0.0',
        // 既没有 command 也没有 url，mcp 配置 schema 必须拒绝这个条目。
        mcpServers: { broken: { args: ['x'] } },
      }),
    )
    await installPlugin({ source: { kind: 'local', path: bad }, marketplace: 'local' })

    const good = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-plugin-good-'))
    await writeFileAt(
      path.join(good, 'plugin.json'),
      JSON.stringify({
        name: 'goodmcp',
        version: '1.0.0',
        mcpServers: { ok: { command: 'echo' } },
      }),
    )
    await installPlugin({ source: { kind: 'local', path: good }, marketplace: 'local' })

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-cwd-'))
    const out = await buildPluginIntegration(await loadAllPlugins({ cwd }))

    expect(out.mcpErrors).toHaveLength(1)
    expect(out.mcpErrors[0]!.pluginId).toBe('badmcp@local')
    // 正常插件的服务仍应成功进入结果。
    expect(out.mcpServers.ok).toBeDefined()
  })

  it('会跳过来自已禁用插件的贡献', async () => {
    const src = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-plugin-src-'))
    await writeFileAt(
      path.join(src, 'plugin.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0', mcpServers: { gh: { command: 'gh-mcp' } } }),
    )
    await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-cwd-'))
    // 通过项目设置禁用该插件。
    await writeFileAt(
      path.join(cwd, '.x-code', 'settings.local.json'),
      JSON.stringify({ enabledPlugins: { 'demo@local': false } }),
    )

    const out = await buildPluginIntegration(await loadAllPlugins({ cwd }))
    expect(out.mcpServers).toEqual({})
  })
})
