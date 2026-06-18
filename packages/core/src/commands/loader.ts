// @x-code-cli/core — 基于文件的命令加载器
//
// 负责扫描插件贡献的 `commands/` 目录下的 `*.md` 文件，并返回可注册进
// CommandRegistry 的 CommandDefinition。
// 结构上与 sub-agents loader 基本镜像：使用同一套最小 YAML frontmatter
// 解析思路，同样遵循“单个坏文件只记录并跳过，绝不拖垮启动流程”的错误处理方式。
import fs from 'node:fs/promises'
import path from 'node:path'

import { XCODE_DIR, userXcodeDir } from '../utils.js'
import type { CommandDefinition } from './types.js'

/** 最小化 YAML frontmatter 解析器。与 skills / sub-agents loader 使用
 *  的能力子集一致：只支持字符串标量，不依赖 gray-matter。
 *  这里会把缩进续行折叠到上一行里，从而兼容真实 Claude Code 命令里
 *  常见的多行 `allowed-tools` 写法。虽然我们目前忽略这个字段，但解析阶段
 *  不能因此报错。 */
function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return null

  const yamlBlock = match[1]!
  const body = match[2]!
  const data: Record<string, unknown> = {}

  const folded: string[] = []
  for (const line of yamlBlock.split(/\r?\n/)) {
    if (/^\s/.test(line) && line.trim() && folded.length > 0) {
      folded[folded.length - 1] += ' ' + line.trim()
    } else {
      folded.push(line)
    }
  }

  for (const line of folded) {
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

/** 从指定目录加载命令定义，并为其标记来源与插件上下文。 */
async function loadCommandsFromDir(
  dir: string,
  source: CommandDefinition['source'],
  pluginId?: string,
  pluginRoot?: string,
): Promise<CommandDefinition[]> {
  const out: CommandDefinition[] = []
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return out
  }

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    const filePath = path.join(dir, entry)
    const name = entry.slice(0, -3) // strip .md

    try {
      const raw = await fs.readFile(filePath, 'utf-8')
      const parsed = parseFrontmatter(raw)
      // 没有 frontmatter 的命令依然视为合法，整个文件内容都作为 body。
      // 真实 Claude Code 命令通常都有 frontmatter，但这里保持宽容处理。
      const description = parsed?.data.description as string | undefined
      const body = (parsed ? parsed.body : raw).trim()

      const cmd: CommandDefinition = {
        name,
        description,
        body,
        source,
      }
      // pluginId / pluginRoot 只对插件来源的命令有意义。
      // 对 user / project 命令来说，expandCommandBody 会把
      // ${CLAUDE_PLUGIN_ROOT} 安全地替换为空字符串。
      if (pluginId) cmd.pluginId = pluginId
      if (pluginRoot) cmd.pluginRoot = pluginRoot
      out.push(cmd)
    } catch (err) {
      console.error(`[commands] 跳过 ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return out
}

export interface LoadCommandsOptions {
  /** 插件贡献的命令目录列表。每一项都带有所属插件 id 和根目录。
   *  顺序会影响注册表插入顺序，因此命名冲突时后者覆盖前者。 */
  extraDirs?: ReadonlyArray<{ dir: string; pluginId: string; pluginRoot: string }>
}

/** 加载来自 user（`~/.x-code/commands/*.md`）+ plugin（extraDirs）+
 *  project（`<cwd>/.x-code/commands/*.md`）三类来源的 slash command。
 *  合并顺序是 user → plugin → project，因此配合 CommandRegistry 的
 *  last-write-wins 规则，最终优先级就是 **project > plugin > user**，
 *  与 skills 和 sub-agents 保持一致。
 *
 *  `userXcodeDir()` 在加载时动态调用，因此测试里使用的 `X_CODE_HOME`
 *  也能正确重定向用户级目录。 */
export async function loadPluginCommands(opts: LoadCommandsOptions = {}): Promise<CommandDefinition[]> {
  const userDir = path.join(userXcodeDir(), 'commands')
  const projectDir = path.join(process.cwd(), XCODE_DIR, 'commands')

  const userCmds = await loadCommandsFromDir(userDir, 'user')
  const pluginCmds: CommandDefinition[] = []
  for (const { dir, pluginId, pluginRoot } of opts.extraDirs ?? []) {
    pluginCmds.push(...(await loadCommandsFromDir(dir, 'plugin', pluginId, pluginRoot)))
  }
  const projectCmds = await loadCommandsFromDir(projectDir, 'project')

  return [...userCmds, ...pluginCmds, ...projectCmds]
}
