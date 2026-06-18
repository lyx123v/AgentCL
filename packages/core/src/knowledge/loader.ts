// @x-code-cli/core — Knowledge 加载器
//
// 负责按层次加载项目上下文。数据源如下（同一段内部按 root → leaf 决定优先级；
// 最终各段会按照下面顺序拼接）：
//
//   1. 用户级 AGENTS.md（~/.x-code/）——缺失时回退到 CLAUDE.md
//   2. 用户自动记忆（~/.x-code/memory/auto.md）——由回合结束后的提取器写入
//   3. 项目 AGENTS.md 链——每一层目录都可回退到 CLAUDE.md
//   4. 项目自动记忆（.x-code/memory/auto.md）——由回合结束后的提取器写入
//   5. 项目根目录下的 AGENTS.local.md——个人偏好，且通常被 gitignore
//
// 越靠后的分段，对模型来说权重越高：例如 monorepo 的子包目录
// （链路中更深的节点）会覆盖共享上下文，而本地个人偏好又会覆盖团队共享
// 的知识文件。
//
// 文件名策略采用“只读回退”：每一级目录都先找 `AGENTS.md`
// （我们的约定，也是 `/init` 默认创建的文件），只有它不存在时才回退到
// `CLAUDE.md`（兼容 Claude Code，让已有 CLAUDE.md 的用户无需重命名）。
// 如果同一目录下两者同时存在，则 AGENTS.md 直接胜出，CLAUDE.md 会被忽略。
// 所有写入路径（`/init`、未来工具）始终都只写 AGENTS.md。
import path from 'node:path'

import { USER_XCODE_DIR, fileExists, readFileSafe } from '../utils.js'
import { getAutoMemory } from './auto-memory.js'

const USER_DIR = USER_XCODE_DIR

/** 每级目录中会识别的文件名，按顺序尝试。某个目录里先找到的那个就生效，其余候选会被跳过。AGENTS.md 是主约定；CLAUDE.md 只是兼容性的只读回退。 */
const KNOWLEDGE_FILENAMES = ['AGENTS.md', 'CLAUDE.md'] as const

/** 读取 `dir` 中存在的 AGENTS.md / CLAUDE.md，优先前者；如果两者都不存在，则返回 null。 */
async function readKnowledgeFile(dir: string): Promise<{ fileName: string; content: string } | null> {
  for (const fileName of KNOWLEDGE_FILENAMES) {
    const content = await readFileSafe(path.join(dir, fileName))
    if (content) return { fileName, content }
  }
  return null
}

/**
 * 从 `startDir` 向上逐层遍历，每个目录最多收集一个知识文件。
 * 这与 Codex 的约定一致：仓库根目录文件适用于整个项目，而包级文件
 * （在 monorepo 中）会以更具体的上下文覆盖它。遍历会在第一个包含 `.git`
 * 的目录（包含该目录本身）或文件系统根目录处停止。
 *
 * 返回结果会按 root → leaf 排序，这样最深层的文件会最后追加。
 * 每个目录最多贡献一个条目：优先 AGENTS.md，其次 CLAUDE.md，否则跳过。
 */
async function collectProjectKnowledgeChain(
  startDir: string,
): Promise<Array<{ dir: string; fileName: string; content: string }>> {
  const dirs: string[] = []
  let dir = path.resolve(startDir)
  const fsRoot = path.parse(dir).root

  while (true) {
    dirs.push(dir)
    if (await fileExists(path.join(dir, '.git'))) break
    if (dir === fsRoot) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  const entries: Array<{ dir: string; fileName: string; content: string }> = []
  for (const d of dirs.reverse()) {
    const found = await readKnowledgeFile(d)
    if (found) entries.push({ dir: d, fileName: found.fileName, content: found.content })
  }
  return entries
}

/** 构建完整的知识上下文，用于注入到 system prompt。 */
export async function buildKnowledgeContext(options?: { sessionContext?: string }): Promise<string> {
  const sections: string[] = []

  // 用户级人工偏好文件：优先 AGENTS.md；如果没有，再回退到 CLAUDE.md。
  // 这样已有 `~/.x-code/CLAUDE.md`（或从 Claude Code 家目录拷来的文件）
  // 的用户就不需要重命名也能被正常识别。
  const userKnowledge = await readKnowledgeFile(USER_DIR)
  if (userKnowledge) {
    sections.push(`### 用户偏好（~/.x-code/${userKnowledge.fileName}）\n${userKnowledge.content}`)
  }

  const userMemory = getAutoMemory('user')
  const userMemoryContent = userMemory.getPromptContent()
  if (userMemoryContent) {
    sections.push('### 用户自动记忆\n' + userMemoryContent)
  }

  const cwd = process.cwd()
  const projectKnowledge = await collectProjectKnowledgeChain(cwd)
  for (const entry of projectKnowledge) {
    const relPath = path.relative(cwd, entry.dir) || '.'
    sections.push(`### 项目 ${entry.fileName}（${relPath}）\n${entry.content}`)
  }

  const projectMemory = getAutoMemory('project')
  const projectMemoryContent = projectMemory.getPromptContent()
  if (projectMemoryContent) {
    sections.push('### 项目自动记忆\n' + projectMemoryContent)
  }

  const localPrefs = await readFileSafe(path.join(cwd, 'AGENTS.local.md'))
  if (localPrefs) {
    sections.push('### 本地偏好（AGENTS.local.md）\n' + localPrefs)
  }

  if (options?.sessionContext) {
    sections.push(options.sessionContext)
  }

  if (sections.length === 0) return ''
  return '## 项目知识\n\n' + sections.join('\n\n')
}
