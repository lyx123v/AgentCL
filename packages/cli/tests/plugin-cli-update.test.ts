// `runPluginCli(['update', ...])` 的测试，覆盖单个 id 与 --all 两条路径。
//
// 这个 CLI 子命令底层复用了 slash 形式同一套 `installPlugin` 核心逻辑，
// 因此这里不重复验证安装行为本身，而是聚焦于参数解析与 --all 聚合逻辑：
// 包括结果分类（updated / unchanged / failed）、裸调用拦截，以及出错后继续执行。
//
// 每个测试都会使用隔离的 XC_PLUGINS_DIR，这样安装产物会落到临时缓存中，
// 不会污染用户真实的 ~/.x-code。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { installPlugin, listInstalledPlugins } from '@x-code-cli/core'

import { runPluginCli } from '../src/plugin-cli.js'

let originalPluginsDir: string | undefined
let logSpy: ReturnType<typeof vi.spyOn>
let errSpy: ReturnType<typeof vi.spyOn>

// 创建一个最小可用的临时插件目录，供安装与升级测试复用。
async function makeTempPlugin(body: Record<string, unknown>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-update-src-'))
  await fs.writeFile(path.join(root, 'plugin.json'), JSON.stringify(body), 'utf-8')
  return root
}

// 合并 console.log 与 console.error，方便统一断言终端输出。
function combinedOutput(): string {
  const log = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
  const err = errSpy.mock.calls.map((c) => c.join(' ')).join('\n')
  return `${log}\n${err}`
}

beforeEach(async () => {
  originalPluginsDir = process.env.XC_PLUGINS_DIR
  process.env.XC_PLUGINS_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-update-cache-'))
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  logSpy.mockRestore()
  errSpy.mockRestore()
  if (originalPluginsDir === undefined) delete process.env.XC_PLUGINS_DIR
  else process.env.XC_PLUGINS_DIR = originalPluginsDir
})

describe('xc plugin update — argv parsing', () => {
  it('应拒绝裸调用 `update`，并给出同时包含两种调用方式的用法提示', async () => {
    const code = await runPluginCli(['update'])
    expect(code).toBe(1)
    const out = combinedOutput()
    expect(out).toMatch(/Usage:.*update.*<id>.*--all/)
  })

  it('应拒绝在同一次调用中同时传位置参数 id 和 --all', async () => {
    const code = await runPluginCli(['update', 'demo@local', '--all'])
    expect(code).toBe(1)
    expect(combinedOutput()).toMatch(/either `?--all`? or a plugin id, not both/)
  })

  it('当指定的单插件 id 尚未安装时，应返回错误', async () => {
    const code = await runPluginCli(['update', 'nope@local'])
    expect(code).toBe(1)
    expect(combinedOutput()).toMatch(/Plugin 'nope@local' not installed/)
  })
})

describe('xc plugin update --all', () => {
  it("当注册表为空时，应返回 0 并提示 'No plugins installed'", async () => {
    const code = await runPluginCli(['update', '--all'])
    expect(code).toBe(0)
    expect(combinedOutput()).toMatch(/No plugins installed/)
  })

  it("同版本重装时，应归类为 'unchanged' 并返回 0", async () => {
    const src = await makeTempPlugin({ name: 'demo', version: '1.0.0' })
    await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })

    const code = await runPluginCli(['update', '--all'])
    expect(code).toBe(0)
    const out = combinedOutput()
    expect(out).toMatch(/demo@local: reinstalled at 1\.0\.0/)
    expect(out).toMatch(/Summary: 0 updated, 1 unchanged, 0 failed/)
  })

  it("真实版本升级时，应归类为 'updated' 并返回 0", async () => {
    const src = await makeTempPlugin({ name: 'demo', version: '1.0.0' })
    await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })
    // 直接修改源 manifest 的版本号，update 从已记录的源路径重新安装时
    // 应当能拾取到这个新版本。
    await fs.writeFile(path.join(src, 'plugin.json'), JSON.stringify({ name: 'demo', version: '1.1.0' }))

    const code = await runPluginCli(['update', '--all'])
    expect(code).toBe(0)
    const out = combinedOutput()
    expect(out).toMatch(/demo@local: 1\.0\.0 → 1\.1\.0/)
    expect(out).toMatch(/Summary: 1 updated, 0 unchanged, 0 failed/)
  })

  it('单个插件失败时应跳过继续：不终止其他插件，汇总计入失败，退出码为 1', async () => {
    const goodSrc = await makeTempPlugin({ name: 'good', version: '1.0.0' })
    const badSrc = await makeTempPlugin({ name: 'bad', version: '1.0.0' })
    await installPlugin({ source: { kind: 'local', path: goodSrc }, marketplace: 'local' })
    await installPlugin({ source: { kind: 'local', path: badSrc }, marketplace: 'local' })
    // 安装完成后删掉坏插件的源目录，这样 update 路径中的 `installPlugin`
    // 就会因为目录缺失而读取失败。
    await fs.rm(badSrc, { recursive: true, force: true })

    const code = await runPluginCli(['update', '--all'])
    expect(code).toBe(1)
    const out = combinedOutput()
    expect(out).toMatch(/Updating 2 plugins/)
    expect(out).toMatch(/good@local: reinstalled at 1\.0\.0/)
    expect(out).toMatch(/bad@local: failed/)
    expect(out).toMatch(/Summary: 0 updated, 1 unchanged, 1 failed/)

    // 两个插件都应继续留在注册表中；批量更新的职责是报告失败，
    // 而不是顺手把失败项删除掉。
    const records = await listInstalledPlugins()
    expect(records.map((r) => r.id).sort()).toEqual(['bad@local', 'good@local'])
  })

  it('应接受 -a 作为 --all 的别名', async () => {
    const code = await runPluginCli(['update', '-a'])
    expect(code).toBe(0)
    expect(combinedOutput()).toMatch(/No plugins installed/)
  })
})

describe('xc plugin update <id>', () => {
  it('单个插件同版本重装时应返回 0', async () => {
    const src = await makeTempPlugin({ name: 'demo', version: '1.0.0' })
    await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })

    const code = await runPluginCli(['update', 'demo@local'])
    expect(code).toBe(0)
    expect(combinedOutput()).toMatch(/demo@local: reinstalled at 1\.0\.0/)
  })

  it('单个插件源损坏时应返回 1', async () => {
    const src = await makeTempPlugin({ name: 'demo', version: '1.0.0' })
    await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })
    await fs.rm(src, { recursive: true, force: true })

    const code = await runPluginCli(['update', 'demo@local'])
    expect(code).toBe(1)
    expect(combinedOutput()).toMatch(/demo@local: failed/)
  })
})
