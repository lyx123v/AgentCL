// @x-code-cli/core — 技能注册表
//
// 在 CLI 启动时构建一次，并在整个会话中复用。技能列表会嵌入两个必须保持字节稳定的面：
// system prompt 中的 `## Available Skills` 区块，以及 `activateSkill`
// 工具的描述文本；两者都会缓存到 `LoopState.systemPromptCache` 中。
// 因此，新增、删除、启用或禁用技能时，要么
// (a) 在下一次 `streamText` 调用前完成，并让缓存失效；
// 要么
// (b) 等待 CLI 重启。
//
// `/skill disable|enable|remove` 采用的是方案 (b)：把设置写盘，并提示用户
// “重启 CLI 后生效”。
// `/skill refresh` 采用的是方案 (a)：对当前对象调用 `reloadSkillRegistry()`，
// 原地重建内部映射，然后让 systemPromptCache 失效，这样下一轮对话就能读到新内容。
//
// 刷新时保持同一个 SkillRegistry 对象引用不变，有一个好处：其他已经捕获
// `options.skillRegistry` 的路径（例如 agent loop 的 buildTools、App.tsx
// 里的 slash 命令补全等）都会继续指向正确对象，不需要重新接线。
import { type LoadSkillsOptions, loadSkills } from './loader.js'
import { loadDisabledSkillsSet } from './settings.js'

export interface SkillDefinition {
  /** 技能名称，也是查找和激活时使用的唯一键。 */
  name: string
  /** 技能的简短描述，用于列表展示和匹配判断。 */
  description: string
  /** 技能正文内容，即实际要注入给模型遵循的说明。 */
  content: string
  /** 技能来源：用户级或项目级。 */
  source: 'user' | 'project'
  /** 技能目录的绝对路径（也就是包含 SKILL.md 的那个目录）。
   *  激活时会把它告诉模型，用于解析脚本、参考资料、资源文件等相对路径。 */
  dir: string
  /** 技能目录中文件的相对路径列表。
   *  不包含 SKILL.md 本身，也会跳过隐藏目录和较重目录。
   *  激活时会和正文一起展示，让模型无需额外 glob 就知道技能附带了哪些资源。
   *  列表长度受 MAX_LISTED_FILES 限制，超出时会显示截断提示。 */
  files: string[]
  /** 当技能来自插件贡献时，这里记录所属插件的 ID（`name@marketplace`）。
   *  UI 会把它展示成“来自插件：…”，并让 `/skill uninstall` 转发到 `/plugin uninstall`。 */
  pluginId?: string
}

export interface SkillEntry extends SkillDefinition {
  /** 当前技能是否被禁用。 */
  disabled: boolean
}

/** `reloadSkillRegistry()` 返回的摘要。
 *  `/skill refresh` 会基于它构造提示信息，例如“新增：a, b”、
 *  “移除：c”、“未变化：d, e”，与 `/mcp refresh` 的展示方式保持一致。 */
export interface SkillReloadSummary {
  /** 本次重载后新出现的技能名称列表。 */
  added: string[]
  /** 本次重载后消失的技能名称列表。 */
  removed: string[]
  /** 名称未变但内容、描述、来源或禁用状态发生变化的技能。 */
  changed: string[]
  /** 与上一版相比完全没有变化的技能。 */
  unchanged: string[]
}

export class SkillRegistry {
  private byName: Map<string, SkillEntry>

  constructor(skills: SkillDefinition[], disabled: ReadonlySet<string> = new Set()) {
    this.byName = new Map()
    // 同名技能遵循后写覆盖前写：loadSkills() 先返回 user，再返回 project，
    // 所以项目级技能会覆盖用户级技能。
    for (const skill of skills) {
      this.byName.set(skill.name, { ...skill, disabled: disabled.has(skill.name) })
    }
  }

  /** 用最新加载结果替换内存中的技能列表。
   *  主要供 `/skill refresh` 使用，会保留同一个 SkillRegistry 对象身份，
   *  让所有缓存了 `options.skillRegistry` 引用的地方都自动看到新数据。
   *  返回值会给出与上一版相比的差异摘要，便于调用方渲染“新增 / 删除 / 变化 / 未变化”的提示。 */
  reload(skills: SkillDefinition[], disabled: ReadonlySet<string>): SkillReloadSummary {
    const previous = this.byName
    const next = new Map<string, SkillEntry>()
    for (const skill of skills) {
      next.set(skill.name, { ...skill, disabled: disabled.has(skill.name) })
    }

    const summary: SkillReloadSummary = { added: [], removed: [], changed: [], unchanged: [] }
    for (const [name, entry] of next) {
      const prev = previous.get(name)
      if (!prev) {
        summary.added.push(name)
      } else if (
        prev.description !== entry.description ||
        prev.content !== entry.content ||
        prev.source !== entry.source ||
        prev.disabled !== entry.disabled
      ) {
        summary.changed.push(name)
      } else {
        summary.unchanged.push(name)
      }
    }
    for (const name of previous.keys()) {
      if (!next.has(name)) summary.removed.push(name)
    }

    this.byName = next
    return summary
  }

  /** 按名称获取已启用技能。
   *  被禁用的技能会对 agent loop 和 slash 命令分发隐藏；
   *  如果你需要连同禁用状态一起查看，请改用 `getEntry()`。 */
  get(name: string): SkillDefinition | undefined {
    const entry = this.byName.get(name)
    if (!entry || entry.disabled) return undefined
    return entry
  }

  /** 返回所有已启用技能。 */
  list(): SkillDefinition[] {
    return [...this.byName.values()].filter((s) => !s.disabled)
  }

  /** 返回所有已启用技能的名称。 */
  names(): string[] {
    return [...this.byName.values()].filter((s) => !s.disabled).map((s) => s.name)
  }

  /** 返回所有已加载技能，并保留 `disabled` 标记。
   *  `/skill list` 以及 disable/enable/remove 相关处理器都会用它，
   *  因为它们需要看到被禁用的技能。 */
  listAll(): SkillEntry[] {
    return [...this.byName.values()]
  }

  /** 按名称获取原始技能条目，无论它当前是否被禁用。 */
  getEntry(name: string): SkillEntry | undefined {
    return this.byName.get(name)
  }
}

/** 与 loader 里的 MAX_LISTED_FILES 保持一致的渲染上限。
 *  这样注入格式化器与加载阶段的截断规则可以对齐。
 *  loader 已经先做过排序和截断，这里把 `skill.files` 视为已受控输入。 */
const MAX_RENDERED_FILES = 50

/** 构造 `<activated_skill name="...">...</activated_skill>` 内部的精确正文。
 *  这个格式会同时服务于两条激活路径：模型自行通过 `activateSkill` 调用，
 *  以及用户显式触发 `/<skillname>`。
 *  格式沿用 Opencode 的习惯：先放技能正文，再附上基础目录、相对路径说明和文件列表。
 *  两个入口共用同一个格式化器，可以保证模型看到的字节流完全一致，不受触发方式影响。 */
export function formatSkillActivationBody(skill: SkillDefinition): string {
  const lines: string[] = [skill.content.trim(), '']
  lines.push(`此技能的基础目录：${skill.dir}`)
  lines.push(
    '此技能中的相对路径（例如 scripts/foo.sh、references/api.md）都应相对于上面的基础目录解析。',
  )
  if (skill.files.length > 0) {
    lines.push('', '此技能目录中的文件：')
    const shown = skill.files.slice(0, MAX_RENDERED_FILES)
    for (const f of shown) lines.push(`- ${f}`)
    if (skill.files.length > MAX_RENDERED_FILES) {
      lines.push(`- ... 另有 ${skill.files.length - MAX_RENDERED_FILES} 个文件未显示`)
    }
  }
  return lines.join('\n')
}

/** 把技能激活正文包裹进 `<activated_skill name="X">` 这个 XML 外壳中。
 *  两条激活路径共用它，可以保证包裹格式完全一致。 */
export function wrapActivatedSkill(skill: SkillDefinition): string {
  return `<activated_skill name="${skill.name}">\n${formatSkillActivationBody(skill)}\n</activated_skill>`
}

/** 创建技能注册表，并在启动阶段同时加载技能定义与禁用列表。 */
export async function createSkillRegistry(opts: LoadSkillsOptions = {}): Promise<SkillRegistry> {
  const [skills, disabled] = await Promise.all([loadSkills(opts), loadDisabledSkillsSet()])
  return new SkillRegistry(skills, disabled)
}

/** 重新扫描技能目录与 settings.json，并原地更新给定注册表。
 *  调用方需要自己让引用旧技能列表的 systemPromptCache 失效，
 *  `/skill refresh` 的处理器就是这么做的。 */
export async function reloadSkillRegistry(
  registry: SkillRegistry,
  opts: LoadSkillsOptions = {},
): Promise<SkillReloadSummary> {
  const [skills, disabled] = await Promise.all([loadSkills(opts), loadDisabledSkillsSet()])
  return registry.reload(skills, disabled)
}
