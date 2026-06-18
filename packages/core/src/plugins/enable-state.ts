// @x-code-cli/core — 插件启用/禁用状态
//
// 负责从不同作用域的 settings.json 中读取 `enabledPlugins` 映射，
// 并为每个插件 id 解析最终是否启用。
//
// 当前采用双作用域模型，与 mcp / skill 子系统保持一致：
//
//   user     ~/.x-code/settings.json
//   project  <cwd>/.x-code/settings.local.json   （已加入 gitignore）
//
// 这里 `'project'` 实际读取的是 `.local.json`，命名上稍有历史包袱，
// 继承自 skills 子系统。它表示“当前仓库下的当前用户覆盖配置”，而不是
// 团队共享文件。未来如果要增加一个真正可提交的团队级作用域，也不需要
// 改动现有这两个作用域。
//
// 映射结构：`{ "name@marketplace": true | false }`
// `true` 表示启用，`false` 表示显式禁用，缺失则回退到项目级默认值
// （当前为 `true`，也就是默认启用）。
//
// 优先级：project > user。高优先级作用域只要显式写了值，就直接生效；
// 如果没写，则继续向下回退。
import fs from 'node:fs/promises'
import path from 'node:path'

import { XCODE_DIR, userXcodeDir } from '../utils.js'
import type { PluginScope } from './types.js'

/** 作用域优先级，越靠前优先级越高。最先出现显式配置的作用域获胜。 */
const SCOPE_PRECEDENCE: ReadonlyArray<PluginScope> = ['project', 'user']

/** 当所有作用域都未提到该插件时的默认启用状态。
 *  这里默认启用，保证新安装插件开箱即用；如果用户希望显式选择加入，
 *  可以再单独把对应插件关闭。 */
const DEFAULT_ENABLED = true

interface PluginSettingsFile {
  /** 各插件在当前 settings 文件中的启用状态映射。 */
  enabledPlugins?: Record<string, boolean>
}

/** 根据作用域计算对应的设置文件路径。 */
export function settingsPathForScope(scope: PluginScope, cwd: string = process.cwd()): string {
  if (scope === 'user') return path.join(userXcodeDir(), 'settings.json')
  return path.join(cwd, XCODE_DIR, 'settings.local.json')
}

/** 读取单个作用域的 settings 文件，并提取 `enabledPlugins` 配置。 */
async function readSettings(scope: PluginScope, cwd: string): Promise<PluginSettingsFile> {
  const file = settingsPathForScope(scope, cwd)
  try {
    const raw = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const obj = parsed as Record<string, unknown>
    if (obj.enabledPlugins && typeof obj.enabledPlugins === 'object' && !Array.isArray(obj.enabledPlugins)) {
      // 做一层防御性布尔值收敛：settings.json 可能被手工改过，
      // 某个字段类型写错不应该把整个加载流程搞崩。
      const out: Record<string, boolean> = {}
      for (const [k, v] of Object.entries(obj.enabledPlugins)) {
        if (typeof v === 'boolean') out[k] = v
      }
      return { enabledPlugins: out }
    }
    return {}
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    // JSON 格式损坏时直接忽略并返回空对象，避免坏掉的配置文件阻塞启动。
    // 用户修好文件后重新启动即可恢复。
    return {}
  }
}

/** 单个插件最终解析出的启用状态，以及最终由哪个作用域决定。
 *  当 `decidedBy` 为 `undefined` 时，表示没有任何作用域配置过该插件，
 *  因此套用了默认值。 */
export interface ResolvedEnableState {
  /** 插件最终是否启用。 */
  enabled: boolean
  /** 最终生效配置来自哪个作用域；未命中任何作用域时为空。 */
  decidedBy: PluginScope | undefined
}

export class EnableState {
  private constructor(private readonly perScope: Map<PluginScope, Record<string, boolean>>) {}

  /** 加载所有作用域的 settings 文件并构建一份快照。
   *  这份快照在创建后有意保持不可变；如果 settings.json 被写入更新，
   *  调用方应重新执行 `EnableState.load()` 获取最新状态。
   *  `cwd` 默认取 `process.cwd()`，用于决定 `'project'` 作用域文件
   *  应该从哪里读取。 */
  static async load(cwd: string = process.cwd()): Promise<EnableState> {
    const map = new Map<PluginScope, Record<string, boolean>>()
    for (const scope of SCOPE_PRECEDENCE) {
      const s = await readSettings(scope, cwd)
      map.set(scope, s.enabledPlugins ?? {})
    }
    return new EnableState(map)
  }

  /** 解析单个插件 id 的最终启用状态。 */
  resolve(pluginId: string): ResolvedEnableState {
    for (const scope of SCOPE_PRECEDENCE) {
      const table = this.perScope.get(scope) ?? {}
      if (pluginId in table) {
        return { enabled: table[pluginId]!, decidedBy: scope }
      }
    }
    return { enabled: DEFAULT_ENABLED, decidedBy: undefined }
  }

  /** 返回某个作用域的原始映射。
   *  `/plugin list` 会用它把各作用域下的标记和最终生效状态一起展示出来。 */
  scopeEntries(scope: PluginScope): Record<string, boolean> {
    return { ...(this.perScope.get(scope) ?? {}) }
  }
}

// ── 写入类操作（供 /plugin enable|disable|install 使用） ───────────────

/** 在指定作用域中写入单个插件的启用标记。
 *  这里采用“读出 -> 修改 -> 写回”的方式，避免把 settings.json 中
 *  不相关的字段（例如 skill 子系统的 `disabledSkills`）覆盖掉。
 *  返回值用于告诉调用方文件内容是否真的发生变化，从而区分
 *  “已经启用/禁用” 与 “刚刚启用/禁用” 这类提示文案。 */
export async function setPluginEnabled(
  pluginId: string,
  scope: PluginScope,
  enabled: boolean,
  cwd: string = process.cwd(),
): Promise<'changed' | 'noop'> {
  const file = settingsPathForScope(scope, cwd)
  await fs.mkdir(path.dirname(file), { recursive: true })

  let existing: Record<string, unknown> = {}
  try {
    const raw = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object') existing = parsed as Record<string, unknown>
  } catch {
    // 首次写入时文件可能还不存在
  }

  const currentMap =
    existing.enabledPlugins && typeof existing.enabledPlugins === 'object' && !Array.isArray(existing.enabledPlugins)
      ? { ...(existing.enabledPlugins as Record<string, boolean>) }
      : {}

  if (currentMap[pluginId] === enabled) return 'noop'
  currentMap[pluginId] = enabled
  existing.enabledPlugins = currentMap

  await fs.writeFile(file, JSON.stringify(existing, null, 2) + '\n', 'utf-8')
  return 'changed'
}

/** 从指定作用域的 `enabledPlugins` 中移除某个插件条目。
 *  供 `/plugin uninstall` 使用，用来保持 settings.json 干净整洁。 */
export async function clearPluginEntry(
  pluginId: string,
  scope: PluginScope,
  cwd: string = process.cwd(),
): Promise<'changed' | 'noop'> {
  const file = settingsPathForScope(scope, cwd)
  let existing: Record<string, unknown> = {}
  try {
    const raw = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object') existing = parsed as Record<string, unknown>
  } catch {
    return 'noop'
  }

  if (
    !existing.enabledPlugins ||
    typeof existing.enabledPlugins !== 'object' ||
    Array.isArray(existing.enabledPlugins)
  ) {
    return 'noop'
  }

  const map = { ...(existing.enabledPlugins as Record<string, boolean>) }
  if (!(pluginId in map)) return 'noop'
  delete map[pluginId]

  if (Object.keys(map).length === 0) {
    delete existing.enabledPlugins
  } else {
    existing.enabledPlugins = map
  }

  await fs.writeFile(file, JSON.stringify(existing, null, 2) + '\n', 'utf-8')
  return 'changed'
}
