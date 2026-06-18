// 技能设置 —— 按作用域保存 disabledSkills 列表。
//
// 用户级： ~/.x-code/settings.json
// 项目级： <repo-root>/.x-code/settings.local.json（已加入 gitignore）
//
// 两个文件都使用同一种结构：`{ disabledSkills?: string[] }`。
// 只要某个技能名称出现在任意一个作用域的列表中，它就会被视为禁用；
// 这里取的是并集，不是覆盖关系。若想取消“用户级禁用”但仍保留别处的禁用，
// 只需把该名称从用户级列表中移除。
// 这些设置在单个会话期间视为不可变：SkillRegistry 只会在启动时根据它做一次过滤，
// 因此启用、禁用、删除的效果都要到下次启动后才体现。
import fs from 'node:fs/promises'
import path from 'node:path'

import { USER_XCODE_DIR, XCODE_DIR } from '../utils.js'

export type SkillSettingsScope = 'user' | 'project'

export interface SkillSettings {
  /** 当前作用域下被禁用的技能名称列表。 */
  disabledSkills?: string[]
}

/** 根据作用域返回对应的技能设置文件路径。 */
export function skillSettingsPath(scope: SkillSettingsScope): string {
  if (scope === 'user') return path.join(USER_XCODE_DIR, 'settings.json')
  return path.join(process.cwd(), XCODE_DIR, 'settings.local.json')
}

/** 读取指定作用域的技能设置；若文件不存在或内容损坏，则回退为空设置。 */
async function readSettings(scope: SkillSettingsScope): Promise<SkillSettings> {
  const file = skillSettingsPath(scope)
  try {
    const raw = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const obj = parsed as Record<string, unknown>
    const list = Array.isArray(obj.disabledSkills)
      ? obj.disabledSkills.filter((s): s is string => typeof s === 'string')
      : []
    return { disabledSkills: list }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    // JSON 格式损坏时直接忽略并返回空设置，避免一个坏掉的设置文件阻塞启动。
    // 用户修好文件后重新启动即可生效。
    return {}
  }
}

/** 写回指定作用域的技能设置，并尽量保留未来可能出现的其他字段。 */
async function writeSettings(scope: SkillSettingsScope, settings: SkillSettings): Promise<void> {
  const file = skillSettingsPath(scope)
  await fs.mkdir(path.dirname(file), { recursive: true })
  // 采用“读 -> 改 -> 写”方式，是因为 settings.json 未来可能会承载其他字段。
  // 这里先重新读取原对象，再把更新后的 `disabledSkills` 合并回去，
  // 避免未来扩展字段被整文件覆盖掉。
  let existing: Record<string, unknown> = {}
  try {
    const raw = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object') existing = parsed as Record<string, unknown>
  } catch {
    // ignore — first write
  }
  const list = settings.disabledSkills ?? []
  if (list.length === 0) {
    delete existing.disabledSkills
  } else {
    existing.disabledSkills = list
  }
  await fs.writeFile(file, JSON.stringify(existing, null, 2) + '\n', 'utf-8')
}

/** 读取用户级与项目级禁用列表，并返回两者并集。 */
export async function loadDisabledSkillsSet(): Promise<Set<string>> {
  const [u, p] = await Promise.all([readSettings('user'), readSettings('project')])
  const merged = new Set<string>()
  for (const name of u.disabledSkills ?? []) merged.add(name)
  for (const name of p.disabledSkills ?? []) merged.add(name)
  return merged
}

/** 在指定作用域中切换技能禁用状态。
 *  `disable=true` 表示加入禁用列表，`disable=false` 表示从禁用列表移除。
 *  返回值会告诉调用方这次是否真的发生了变化，便于渲染准确提示
 *  （例如“已经禁用”与“已禁用”的区别）。 */
export async function setSkillDisabled(
  name: string,
  scope: SkillSettingsScope,
  disable: boolean,
): Promise<'changed' | 'noop'> {
  const current = await readSettings(scope)
  const list = new Set(current.disabledSkills ?? [])
  const had = list.has(name)
  if (disable) {
    if (had) return 'noop'
    list.add(name)
  } else {
    if (!had) return 'noop'
    list.delete(name)
  }
  await writeSettings(scope, { disabledSkills: [...list].sort() })
  return 'changed'
}

/** 获取指定作用域下显式写入设置文件的禁用技能列表。 */
export async function getScopedDisabledSkills(scope: SkillSettingsScope): Promise<string[]> {
  const s = await readSettings(scope)
  return s.disabledSkills ?? []
}
