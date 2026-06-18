// @x-code-cli/core — 自定义子代理加载器
//
// 扫描 ~/.x-code/agents/*.md 和 <repo-root>/.x-code/agents/*.md，
// 读取带 YAML frontmatter 的用户自定义子代理。坏文件会被跳过，
// 并向 stderr 打印警告，单个损坏的 agent 文件绝不能让 CLI 崩溃。
import fs from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import { USER_XCODE_DIR, XCODE_DIR } from '../../utils.js'
import type { SubAgentDefinition } from './types.js'

const frontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  tools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  model: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  shellRestrictions: z.array(z.string()).optional(),
})

/** 轻量级 YAML frontmatter 解析器，只处理我们需要的子集：
 *  字符串标量、数字标量，以及内联 / flow 数组。
 *  不依赖 gray-matter，用来保持安装体积精简。 */
function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return null

  const yamlBlock = match[1]!
  const body = match[2]!
  const data: Record<string, unknown> = {}

  // 折叠 YAML 延续行：如果一行带缩进且非空，就用一个空格把它拼到上一行末尾。
  // 这对应 frontmatter 里常见的折叠标量写法，尤其适合较长的 `description:`。
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
    let value: string | number | string[] = trimmed.slice(colonIdx + 1).trim()

    // 内联数组：[a, b, c]
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1)
      data[key] = inner
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean)
      continue
    }

    // 去掉首尾引号
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }

    // 数字
    if (/^\d+$/.test(value)) {
      data[key] = parseInt(value, 10)
      continue
    }

    data[key] = value
  }

  return { data, body }
}

/** 从指定目录加载 `.md` 子代理定义。 */
async function loadAgentsFromDir(
  dir: string,
  source: SubAgentDefinition['source'],
  pluginId?: string,
): Promise<SubAgentDefinition[]> {
  const agents: SubAgentDefinition[] = []

  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return agents
  }

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    const filePath = path.join(dir, entry)

    try {
      const raw = await fs.readFile(filePath, 'utf-8')
      const parsed = parseFrontmatter(raw)
      if (!parsed) {
        console.error(`[sub-agents] 跳过 ${filePath}：未找到有效的 YAML frontmatter`)
        continue
      }

      const result = frontmatterSchema.safeParse(parsed.data)
      if (!result.success) {
        console.error(
          `[sub-agents] 跳过 ${filePath}：frontmatter 无效 —— ${result.error.issues.map((i) => i.message).join(', ')}`,
        )
        continue
      }

      const fm = result.data
      agents.push({
        name: fm.name,
        description: fm.description,
        prompt: parsed.body.trim(),
        tools: fm.tools,
        disallowedTools: fm.disallowedTools,
        model: fm.model,
        maxTurns: fm.maxTurns ?? 30,
        shellRestrictions: fm.shellRestrictions,
        source,
        ...(pluginId ? { pluginId } : {}),
      })
    } catch (err) {
      console.error(`[sub-agents] 跳过 ${filePath}：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return agents
}

export interface LoadCustomAgentsOptions {
  /** 插件贡献的额外目录项。 */
  /** 额外要扫描的子代理目录，以及它们所属的插件 id。
   *  这些结构由插件贡献转换而来，转换逻辑见
   *  packages/core/src/plugins/integration.ts。 */
  extraDirs?: ReadonlyArray<{
    dir: string // 要扫描的目录绝对路径
    pluginId: string // 该目录所属的插件 id
  }> // 插件贡献的额外扫描目录
}

/** 从用户目录、项目目录以及额外目录（插件贡献）中加载自定义子代理。
 *  测试时如果设置了环境变量 `XC_AGENTS_DIR`，会覆盖内置扫描路径，
 *  但额外目录依然会继续加载。 */
export async function loadCustomAgents(opts: LoadCustomAgentsOptions = {}): Promise<SubAgentDefinition[]> {
  const override = process.env.XC_AGENTS_DIR
  if (override) {
    const overrideAgents = await loadAgentsFromDir(override, 'project')
    return [...overrideAgents, ...(await loadAgentsFromExtras(opts.extraDirs))]
  }

  const userDir = path.join(USER_XCODE_DIR, 'agents')
  const projectDir = path.join(process.cwd(), XCODE_DIR, 'agents')

  const userAgents = await loadAgentsFromDir(userDir, 'user')
  const pluginAgents = await loadAgentsFromExtras(opts.extraDirs)
  const projectAgents = await loadAgentsFromDir(projectDir, 'project')

  // user → plugin → project。SubAgentRegistry 的 Map.set 在名称重复时会覆盖，
  // 因此后面的条目优先生效，这和 skills 的优先级规则一致。
  return [...userAgents, ...pluginAgents, ...projectAgents]
}

/** 加载插件额外贡献的子代理目录。 */
async function loadAgentsFromExtras(extras: LoadCustomAgentsOptions['extraDirs']): Promise<SubAgentDefinition[]> {
  if (!extras || extras.length === 0) return []
  const out: SubAgentDefinition[] = []
  for (const { dir, pluginId } of extras) {
    out.push(...(await loadAgentsFromDir(dir, 'user', pluginId)))
  }
  return out
}
