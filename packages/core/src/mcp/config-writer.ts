// @x-code-cli/core — 读写用户级 / 项目级 config.json 中的 `mcpServers`
//
// 这个模块驱动 `/mcp add` 与 `/mcp remove`，看起来工作量不大，
// 但有几个地方特别容易踩坑：
//   - 不能破坏其他顶层字段（theme、model、thinking 等）
//   - 添加或删除一个服务时，必须保留其他 mcpServers 条目
//   - 写入必须原子化，防止 Ctrl-C 中途打断把文件写坏
//   - 不能“先读一次，稍后再写”而不重读，否则可能覆盖并发修改
//
// writer 在落盘前会用与 loader 相同的 Zod schema 再校验一次，
// 这样 `/mcp add-json` 提交的无效配置会在入口处直接失败，而不是等到下次加载时才爆炸。
import fs from 'node:fs/promises'
import path from 'node:path'

import { getUserConfigPath } from '../config/index.js'
import { XCODE_DIR } from '../utils.js'
import { parseServerConfig } from './config-schema.js'
import { type McpServerConfig } from './types.js'

export type ConfigScope = 'user' | 'project'

/** 计算指定作用域下 config.json 的绝对路径。
 *  这里和 loader 读配置使用的是同一路径规则，因此写入结果一定能被后续加载拾取到。 */
export function getConfigPath(scope: ConfigScope, cwd: string): string {
  if (scope === 'user') return getUserConfigPath()
  return path.join(cwd, XCODE_DIR, 'config.json')
}

/** 读取并解析指定作用域下的 JSON 对象。
 *  文件不存在、为空或尚未初始化时返回 `{}`；
 *  但若文件存在且 JSON 非法，则抛错，避免误把损坏文件覆盖掉。 */
async function readConfigObject(scope: ConfigScope, cwd: string): Promise<Record<string, unknown>> {
  const file = getConfigPath(scope, cwd)
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf-8')
  } catch {
    return {}
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // JSON 已损坏时，明确要求用户先修复，而不是静默覆盖。
    throw new Error(`配置文件 ${file} 不是合法 JSON。请先手动修复，再执行 /mcp add 或 /mcp remove。`)
  }
  return {}
}

/** 以原子方式写回 JSON：先写临时文件，再 rename。
 *  结尾保留换行，缩进使用 2 空格，与项目里其他配置写法一致。 */
async function writeConfigObject(scope: ConfigScope, cwd: string, obj: Record<string, unknown>): Promise<void> {
  const file = getConfigPath(scope, cwd)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf-8')
  await fs.rename(tmp, file)
}

/** 检测某个服务名当前位于哪个配置作用域。
 *  `/mcp remove` 会用它做自动定位，并识别用户级和项目级同时存在时的歧义情况。 */
export type DetectScopeResult = { kind: 'not-found' } | { kind: 'user' } | { kind: 'project' } | { kind: 'both' }

/** 判断某个服务名目前存在于用户级、项目级还是两者都存在。 */
export async function detectScope(name: string, cwd: string): Promise<DetectScopeResult> {
  const [user, project] = await Promise.all([serverExists(name, 'user', cwd), serverExists(name, 'project', cwd)])
  if (user && project) return { kind: 'both' }
  if (user) return { kind: 'user' }
  if (project) return { kind: 'project' }
  return { kind: 'not-found' }
}

/** 判断某个服务名在指定作用域的配置中是否存在。 */
export async function serverExists(name: string, scope: ConfigScope, cwd: string): Promise<boolean> {
  const obj = await readConfigObject(scope, cwd)
  const servers = obj.mcpServers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return false
  return Object.prototype.hasOwnProperty.call(servers, name)
}

/** 把服务写入指定作用域的 config.json。
 *  不负责覆盖已存在条目；调用方应先通过 `serverExists` 做重复检查。 */
export async function writeServerToConfig(
  name: string,
  config: McpServerConfig,
  scope: ConfigScope,
  cwd: string,
): Promise<{ path: string }> {
  // 先做 schema 校验，避免无效配置落盘后等到下次启动才失败。
  const validated = parseServerConfig(name, config)

  const obj = await readConfigObject(scope, cwd)
  const existing = obj.mcpServers
  const servers =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {}
  servers[name] = validated
  obj.mcpServers = servers
  await writeConfigObject(scope, cwd, obj)
  return { path: getConfigPath(scope, cwd) }
}

/** 从指定作用域移除一个服务。
 *  这是幂等操作：如果名称不存在，返回 `removed: false` 而不是报错。
 *  即使删空了，也会保留 `mcpServers: {}`，避免字段来回消失造成 git diff 噪音。 */
export async function removeServerFromConfig(
  name: string,
  scope: ConfigScope,
  cwd: string,
): Promise<{ path: string; removed: boolean }> {
  const file = getConfigPath(scope, cwd)
  const obj = await readConfigObject(scope, cwd)
  const existing = obj.mcpServers
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    return { path: file, removed: false }
  }
  const servers = existing as Record<string, unknown>
  if (!Object.prototype.hasOwnProperty.call(servers, name)) {
    return { path: file, removed: false }
  }
  const next: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(servers)) {
    if (k !== name) next[k] = v
  }
  obj.mcpServers = next
  await writeConfigObject(scope, cwd, obj)
  return { path: file, removed: true }
}

/** 读取指定作用域下某个服务当前的配置内容。
 *  主要用于 `/mcp add` 的“已存在，展示现有配置”路径。
 *  如果配置损坏，这里会尽量返回 null，而不是让重复检查流程直接崩掉。 */
export async function readServerConfig(name: string, scope: ConfigScope, cwd: string): Promise<unknown | null> {
  try {
    const obj = await readConfigObject(scope, cwd)
    const servers = obj.mcpServers
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return null
    const value = (servers as Record<string, unknown>)[name]
    return value ?? null
  } catch {
    return null
  }
}
