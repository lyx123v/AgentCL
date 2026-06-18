// @x-code-cli/core — 插件文件系统布局
//
// 这里集中管理插件子系统的路径辅助函数。其他插件模块统一从这里取路径，
// 而不是各自重新拼接，这样 `XC_PLUGINS_DIR` 的测试覆写入口也只有一个。
//
// 默认布局（位于 ~/.x-code/plugins/ 下）：
//
//   known_marketplaces.json          — 已订阅 marketplace 注册表
//   marketplaces/<name>/marketplace.json
//                                    — 已缓存的 marketplace 索引
//   cache/<marketplace>/<plugin>/<version>/
//                                    — 实际安装后的插件内容
//   data/<plugin-id>/                — 插件持久化数据目录
//                                      （升级后仍保留；plugin-id 是
//                                      "name@marketplace"，并已做路径
//                                      分隔符清洗）
//   installed_plugins.json           — 已安装插件台账
import path from 'node:path'

import { XCODE_DIR, userXcodeDir } from '../utils.js'

const PLUGINS_DIR_NAME = 'plugins'

/** 返回插件子系统根目录。
 *  支持两个覆写入口，按顺序检查：
 *  - `XC_PLUGINS_DIR`：只覆写插件目录，适合测试中单独隔离插件，
 *    而不连带重定向 MCP / config / OAuth 等其他状态。
 *  - `X_CODE_HOME`：覆写整个 `~/.x-code/` 根目录（通过
 *    {@link userXcodeDir} 解析），插件、配置、MCP 状态等都会一起迁移。 */
export function pluginsRoot(): string {
  const override = process.env.XC_PLUGINS_DIR
  if (override) return override
  return path.join(userXcodeDir(), PLUGINS_DIR_NAME)
}

/** 返回 `~/.x-code/plugins/known_marketplaces.json` 路径。 */
export function knownMarketplacesPath(): string {
  return path.join(pluginsRoot(), 'known_marketplaces.json')
}

/** 返回 `~/.x-code/plugins/marketplaces/<name>/` 目录路径。 */
export function marketplaceDir(name: string): string {
  return path.join(pluginsRoot(), 'marketplaces', name)
}

/** 返回指定 marketplace 的 `marketplace.json` 缓存路径。 */
export function marketplaceIndexPath(name: string): string {
  return path.join(marketplaceDir(name), 'marketplace.json')
}

/** 返回插件缓存父目录 `~/.x-code/plugins/cache/<marketplace>/<plugin>/`。
 *  该目录下会保留多个版本；当前生效版本由 `installed_plugins.json`
 *  中最近一次记录决定。 */
export function pluginCacheParent(marketplace: string, plugin: string): string {
  return path.join(pluginsRoot(), 'cache', marketplace, plugin)
}

/** 返回某个具体插件版本的缓存目录路径。 */
export function pluginCacheDir(marketplace: string, plugin: string, version: string): string {
  return path.join(pluginCacheParent(marketplace, plugin), version)
}

/** 返回插件持久化数据目录 `~/.x-code/plugins/data/<sanitised-plugin-id>/`。
 *  该目录会跨升级保留。插件 ID（`name@marketplace`）会先做清洗，避免
 *  `@` 或意外路径分隔符在 Windows 等环境下造成问题。 */
export function pluginDataDir(pluginId: string): string {
  const safe = pluginId.replace(/[/\\:]/g, '_')
  return path.join(pluginsRoot(), 'data', safe)
}

/** 返回 `~/.x-code/plugins/installed_plugins.json` 路径。 */
export function installedPluginsPath(): string {
  return path.join(pluginsRoot(), 'installed_plugins.json')
}

/** 返回 `<cwd>/.x-code/plugins/` 路径。
 *  这是较少见的项目级插件目录，适用于仓库直接内置插件而不是从 marketplace 安装。
 *  loader 会在用户级缓存之外额外扫描这里。 */
export function projectPluginsDir(cwd: string): string {
  return path.join(cwd, XCODE_DIR, 'plugins')
}

// ── 插件根目录中的 manifest 探测 ─────────────────────────────────────

/** loader 会按优先级探测的 manifest 相对路径，找到第一个就停止。
 *  我们特意兼容 Claude Code 的路径，这样原本为 Claude Code 编写的插件
 *  无需修改即可安装到 x-code-cli 中。 */
export const MANIFEST_CANDIDATES: ReadonlyArray<{ format: 'native' | 'claude' | 'bare'; rel: string }> = [
  { format: 'native', rel: '.x-code-plugin/plugin.json' },
  { format: 'claude', rel: '.claude-plugin/plugin.json' },
  { format: 'bare', rel: 'plugin.json' },
]

/** Gemini 扩展的 manifest 文件名。
 *  这里只用于在用户尝试安装 Gemini 专属扩展时给出更明确的错误提示；
 *  installer 仍会拒绝安装，并指向设计文档说明。 */
export const GEMINI_MANIFEST_REL = 'gemini-extension.json'
