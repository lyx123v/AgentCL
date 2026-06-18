// @x-code-cli/core — 插件 userConfig 存储
//
// 每个插件都可以在 manifest 中声明一个 `userConfig` 块，用来描述它向用户索取的
// 配置项（例如 API Key、账户 ID、工作目录等）。安装时 CLI 会逐项提示用户输入，
// 而本模块负责这些值在磁盘上的持久化。
//
// 布局：
//
//   ~/.x-code/plugins/user-config.json    →  {
//                                              [pluginId]: { [key]: <value> }
//                                            }
//
// 存储格式是普通 JSON 映射；文件会以 0600 权限创建，仅允许拥有者读写，
// 以避免同机其他用户会话下的进程直接读取敏感值。它并不能替代真正的系统钥匙串
// （macOS Keychain / Windows Credential Manager / Linux libsecret），
// 只是一个避免引入原生构建复杂度的务实 v1 方案。`sensitive: true`
// 目前仍只影响“输入时是否遮罩”；落盘时依旧共用同一个文件。
//
// 后续可以把 `sensitive` 条目迁移到真正的钥匙串中。读取端会同时合并两处来源，
// 因此将来加这层能力不会构成破坏性变更。
//
// 之所以不把敏感配置和非敏感配置拆成两个文件，是因为这样只会增加文件 IO，
// 却不会真正提升安全性（它们仍位于同一目录，权限也相同）。真实防护依赖真实钥匙串；
// 在此之前，使用单文件方案反而更诚实。
import fs from 'node:fs/promises'
import path from 'node:path'

import { debugLog } from '../utils.js'
import { pluginsRoot } from './paths.js'

/** 单个配置字段允许的值类型。
 *  manifest 中声明的 `type`（string / number / boolean）会在提示输入时校验，
 *  而经过 JSON 往返后本来也只会保留这三类原始值。 */
export type UserConfigValue = string | number | boolean

/** 单个插件的 user-config 映射，key 来自 manifest 中定义的 `key` 字段。 */
export type PluginUserConfig = Record<string, UserConfigValue>

/** 整个 user-config 文件的结构：`{ [pluginId]: PluginUserConfig }`。 */
type UserConfigFile = Record<string, PluginUserConfig>

/** 返回插件 user-config 文件路径。 */
function userConfigPath(): string {
  return path.join(pluginsRoot(), 'user-config.json')
}

/** 读取完整的 user-config 文件；文件不存在或损坏时返回空对象。 */
async function readFile(): Promise<UserConfigFile> {
  try {
    const raw = await fs.readFile(userConfigPath(), 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as UserConfigFile
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    debugLog('plugins.user-config-read-error', String(err))
    return {}
  }
}

/** 把完整 user-config 数据写回磁盘。 */
async function writeFile(data: UserConfigFile): Promise<void> {
  const p = userConfigPath()
  await fs.mkdir(path.dirname(p), { recursive: true })
  // 0600 让文件只对拥有者可读写。Windows 上这基本等于空操作
  // （fs.chmod 不会等价映射到 ACL）；在不额外调用 icacls 的前提下，
  // 我们很难做得更好。后续接入系统钥匙串后会更妥善地解决 Windows 场景。
  await fs.writeFile(p, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
}

/** 读取某个插件已保存的配置。
 *  如果该插件还没有任何配置，则返回空对象，调用方可再按 manifest 默认值补全。 */
export async function getPluginUserConfig(pluginId: string): Promise<PluginUserConfig> {
  const all = await readFile()
  return all[pluginId] ?? {}
}

/** 写入某个插件的配置。
 *  这里会与已有字段合并，而不是整体替换，因此调用方可以按字段逐次写入。 */
export async function setPluginUserConfig(pluginId: string, values: PluginUserConfig): Promise<void> {
  const all = await readFile()
  all[pluginId] = { ...(all[pluginId] ?? {}), ...values }
  await writeFile(all)
}

/** 删除某个插件的配置，例如卸载插件时调用。 */
export async function clearPluginUserConfig(pluginId: string): Promise<void> {
  const all = await readFile()
  if (!(pluginId in all)) return
  delete all[pluginId]
  await writeFile(all)
}

/** 把插件的 user-config 映射展开成可注入子进程环境变量的对象。
 *  manifest 中的每个 key 都会变成同名环境变量；数字与布尔值会转成字符串。
 *  未设置的字段会被跳过，不会覆写现有环境变量。 */
export async function getPluginUserConfigEnv(pluginId: string): Promise<Record<string, string>> {
  const cfg = await getPluginUserConfig(pluginId)
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(cfg)) {
    env[k] = String(v)
  }
  return env
}
