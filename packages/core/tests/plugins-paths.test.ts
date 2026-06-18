import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import path from 'node:path'

import {
  installedPluginsPath,
  knownMarketplacesPath,
  marketplaceDir,
  pluginCacheDir,
  pluginDataDir,
  pluginsRoot,
} from '../src/plugins/paths.js'

describe('plugins/paths honors X_CODE_HOME', () => {
  const originalHome = process.env.X_CODE_HOME
  const originalPluginsDir = process.env.XC_PLUGINS_DIR

  beforeEach(() => {
    delete process.env.X_CODE_HOME
    delete process.env.XC_PLUGINS_DIR
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.X_CODE_HOME
    else process.env.X_CODE_HOME = originalHome
    if (originalPluginsDir === undefined) delete process.env.XC_PLUGINS_DIR
    else process.env.XC_PLUGINS_DIR = originalPluginsDir
  })

  it('设置 X_CODE_HOME 时，pluginsRoot 会改走该目录', () => {
    process.env.X_CODE_HOME = '/tmp/xc-sandbox'
    expect(pluginsRoot()).toBe(path.join('/tmp/xc-sandbox', 'plugins'))
  })

  it('XC_PLUGINS_DIR 仍然优先于 X_CODE_HOME（插件专属配置更具体）', () => {
    process.env.X_CODE_HOME = '/tmp/home'
    process.env.XC_PLUGINS_DIR = '/tmp/just-plugins'
    expect(pluginsRoot()).toBe('/tmp/just-plugins')
  })

  it('下游路径辅助函数也会继承 X_CODE_HOME 的重定向', () => {
    // 真实发现的问题是：在 X_CODE_HOME=tmp 下执行 `xc plugin list`
    // 时，代码仍在读取 ~/.x-code/plugins/installed_plugins.json，
    // 因为 pluginsRoot() 调用了被冻结的 USER_XCODE_DIR 常量。
    process.env.X_CODE_HOME = '/tmp/xc-sandbox'
    const root = '/tmp/xc-sandbox/plugins'
    expect(knownMarketplacesPath()).toBe(path.join(root, 'known_marketplaces.json'))
    expect(installedPluginsPath()).toBe(path.join(root, 'installed_plugins.json'))
    expect(marketplaceDir('anthropic')).toBe(path.join(root, 'marketplaces', 'anthropic'))
    expect(pluginCacheDir('m', 'p', '1.0.0')).toBe(path.join(root, 'cache', 'm', 'p', '1.0.0'))
    expect(pluginDataDir('foo@bar')).toBe(path.join(root, 'data', 'foo@bar'))
  })

  it('未设置覆盖项时会回落到 ~/.x-code/plugins', () => {
    // 不要把完整路径写死（不同机器上的 HOME 会变化），
    // 这里只断言后缀正确，并确认没有意外吃到覆盖配置。
    expect(pluginsRoot().endsWith(path.join('.x-code', 'plugins'))).toBe(true)
  })
})
