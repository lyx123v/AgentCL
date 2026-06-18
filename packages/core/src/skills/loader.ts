// @x-code-cli/core — 技能加载器
//
// 会扫描 ~/.x-code/skills/*/SKILL.md 和 <repo-root>/.x-code/skills/*/SKILL.md，
// 读取带 YAML frontmatter 的用户自定义技能。这里采用子目录布局，
// 与 Gemini CLI、Opencode、Codex 等主流方案一致，也方便未来在 SKILL.md
// 旁边放置引用资料、脚本、资源文件等支持内容。
//
// 优先级规则：项目级技能会覆盖同名的用户级技能。
// 如果某个文件损坏，会打印警告并跳过；单个坏掉的 SKILL.md 绝不能拖垮整个 CLI。
import fs from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import { USER_XCODE_DIR, XCODE_DIR } from '../utils.js'
import type { SkillDefinition } from './registry.js'

const SKILL_FILENAME = 'SKILL.md'

/** 每个技能最多列出的文件数量上限。
 *  这样即使某个技能自带了大量引用资料、资源或脚本，激活载荷也不会无限膨胀。
 *  超出上限时会附加截断提示，让模型知道这不是完整列表。 */
const MAX_LISTED_FILES = 50

/** 在列举技能附带文件时要跳过的目录名。
 *  主要是隐藏目录和一些明显很重、几乎不会放技能资源的目录。
 *  这里按 basename 匹配，而不是按 glob。 */
const SKILL_FILE_LIST_SKIP_DIRS = new Set([
  'node_modules',
  '__pycache__',
  '.git',
  '.venv',
  'venv',
  'dist',
  'build',
  'target',
])

const frontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
})

/** 遍历技能目录，返回其中非隐藏文件的相对路径（不包含 SKILL.md 本身）。
 *  这里在加载阶段就完成列举，让 SkillRegistry 可以直接拿到可注入的资源列表。
 *  Opencode 和 Gemini CLI 通常是在激活阶段才做这件事，但 X-Code 的注册表本来
 *  就在一个会话内保持冻结（除非 `/skill refresh` 重建），所以提前缓存更划算。 */
async function listSkillFiles(skillDir: string): Promise<string[]> {
  const out: string[] = []

  /** 递归扫描目录，把符合条件的文件相对路径收集到 out 中。 */
  async function walk(currentDir: string): Promise<void> {
    if (out.length >= MAX_LISTED_FILES) return

    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (out.length >= MAX_LISTED_FILES) return
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        if (SKILL_FILE_LIST_SKIP_DIRS.has(entry.name)) continue
        await walk(path.join(currentDir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      const fullPath = path.join(currentDir, entry.name)
      const rel = path.relative(skillDir, fullPath).split(path.sep).join('/')
      if (rel === SKILL_FILENAME) continue
      out.push(rel)
    }
  }

  await walk(skillDir)
  return out.sort()
}

/** 最小可用的 YAML frontmatter 解析器。
 *  这里复用了 sub-agent loader 的同类子集逻辑：只支持字符串标量，
 *  不引入 gray-matter 之类的额外依赖。 */
function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return null

  const yamlBlock = match[1]!
  const body = match[2]!
  const data: Record<string, unknown> = {}

  // 折叠 YAML 的续行：如果某一行是带缩进的非空行，就把它用一个空格
  // 拼接到上一行后面。这与技能 SKILL.md 里常见的 folded-scalar 写法一致，
  // 也就是长 `description:` 会通过两个空格缩进的续行来换行书写。
  const foldedLines: string[] = []
  for (const line of yamlBlock.split(/\r?\n/)) {
    if (/^\s/.test(line) && line.trim() && foldedLines.length > 0) {
      foldedLines[foldedLines.length - 1] += ' ' + line.trim()
    } else {
      foldedLines.push(line)
    }
  }

  for (const line of foldedLines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const colonIdx = trimmed.indexOf(':')
    if (colonIdx < 1) continue

    const key = trimmed.slice(0, colonIdx).trim()
    let value: string = trimmed.slice(colonIdx + 1).trim()

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }

    data[key] = value
  }

  return { data, body }
}

async function loadSkillsFromDir(
  dir: string,
  source: SkillDefinition['source'],
  pluginId?: string,
): Promise<SkillDefinition[]> {
  const skills: SkillDefinition[] = []

  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return skills
  }

  for (const entry of entries) {
    const skillDir = path.join(dir, entry)
    const skillFile = path.join(skillDir, SKILL_FILENAME)

    try {
      await fs.access(skillFile)
    } catch {
      continue
    }

    try {
      const raw = await fs.readFile(skillFile, 'utf-8')
      const parsed = parseFrontmatter(raw)
      if (!parsed) {
        console.error(`[skills] 跳过 ${skillFile}：未找到有效的 YAML frontmatter`)
        continue
      }

      const result = frontmatterSchema.safeParse(parsed.data)
      if (!result.success) {
        console.error(
          `[skills] 跳过 ${skillFile}：frontmatter 无效 —— ${result.error.issues.map((i) => i.message).join(', ')}`,
        )
        continue
      }

      const files = await listSkillFiles(skillDir)

      skills.push({
        name: result.data.name,
        description: result.data.description,
        content: parsed.body.trim(),
        source,
        dir: skillDir,
        files,
        ...(pluginId ? { pluginId } : {}),
      })
    } catch (err) {
      console.error(`[skills] 跳过 ${skillFile}：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return skills
}

export interface ExtraSkillDir {
  /** 要扫描的技能目录绝对路径。 */
  dir: string
  /** 贡献这些技能的插件 ID，用于保留来源信息。 */
  pluginId: string
}

export interface LoadSkillsOptions {
  /** 额外要扫描的技能目录列表。
   *  用于把插件贡献的 `skills/` 目录合并到同一个注册表中，
   *  见 `packages/core/src/plugins/integration.ts`。
   *  顺序有意义：后出现的同名技能会覆盖前面的。
   *  插件技能会先于项目技能扫描，这样项目里自定义的同名技能仍可覆盖插件技能。 */
  extraDirs?: ReadonlyArray<ExtraSkillDir>
}

/** 从用户目录、项目目录以及额外目录中加载技能。
 *  额外目录主要由插件系统提供，用来合并插件贡献的技能目录。
 *  测试场景下可以通过环境变量 `XC_SKILLS_DIR` 覆盖内置路径，
 *  但额外目录仍然会继续生效。 */
export async function loadSkills(opts: LoadSkillsOptions = {}): Promise<SkillDefinition[]> {
  const override = process.env.XC_SKILLS_DIR
  if (override) {
    const overrideSkills = await loadSkillsFromDir(override, 'project')
    return [...overrideSkills, ...(await loadFromExtras(opts.extraDirs))]
  }

  const userDir = path.join(USER_XCODE_DIR, 'skills')
  const projectDir = path.join(process.cwd(), XCODE_DIR, 'skills')

  const userSkills = await loadSkillsFromDir(userDir, 'user')
  const pluginSkills = await loadFromExtras(opts.extraDirs)
  const projectSkills = await loadSkillsFromDir(projectDir, 'project')

  // 合并顺序遵循“后者覆盖前者”：project > plugin > user。
  // 这也与对用户承诺的优先级一致：项目级技能始终能覆盖插件技能。
  return [...userSkills, ...pluginSkills, ...projectSkills]
}

/** 加载额外目录中的技能，通常用于插件贡献的 skills/ 目录。 */
async function loadFromExtras(extras: LoadSkillsOptions['extraDirs']): Promise<SkillDefinition[]> {
  if (!extras || extras.length === 0) return []
  const out: SkillDefinition[] = []
  for (const { dir, pluginId } of extras) {
    // 插件提供的技能在文件系统中的来源，技术上属于 ~/.x-code/plugins/cache/... 下的缓存目录，
    // 因此 source 填 'user' 最接近实际语义（用户级安装，而不是项目级安装）。
    // 真正的来源信息仍由 `pluginId` 传给 UI 展示。
    out.push(...(await loadSkillsFromDir(dir, 'user', pluginId)))
  }
  return out
}
