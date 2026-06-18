// @x-code-cli/core — AutoMemory 类（基于 key 的增删改查 + 冲突检测 + TTL 淘汰）
import fs from 'node:fs/promises'
import path from 'node:path'

import type { KnowledgeCategory, KnowledgeFact } from '../types/index.js'
import { USER_XCODE_DIR, XCODE_DIR } from '../utils.js'

const MAX_LOAD_LINES = 200

/** 合法分类白名单——需要与 types/index.ts 中的 `KnowledgeCategory` 保持同步。
 *  任何不在集合中的分类，都会在写入和解析两个阶段被拒绝，这样旧版无 schema
 *  时代写出的遗留条目（`context`、`tech-stack`、`commands` 等）就不会在多个会话间悄悄残留。 */
const VALID_CATEGORIES: ReadonlySet<KnowledgeCategory> = new Set(['user', 'feedback', 'project', 'reference'])

/** 判断给定字符串是否是允许的知识分类。 */
function isValidCategory(c: string): c is KnowledgeCategory {
  return VALID_CATEGORIES.has(c as KnowledgeCategory)
}

/**
 * 折叠换行并裁掉首尾空白，即使调用方传入多行内容，也能保持
 * “一条 fact 对应一行序列化结果”的约束。若输入为空值，会返回空字符串，
 * 这样调用方就不需要额外做空判断。
 */
function sanitizeLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

class AutoMemory {
  private facts: KnowledgeFact[] = []
  private filePath: string
  /** 串行化保存任务的 Promise，用来避免并发写入。 */
  private saveQueue: Promise<void> = Promise.resolve()

  constructor(filePath: string) {
    this.filePath = filePath
  }

  /** 从 Markdown 文件中加载记忆内容。 */
  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8')
      this.facts = parseMemoryFile(content)
    } catch {
      this.facts = []
    }
  }

  /** 新增或更新记忆：同一分类 + 同一 key 会被替换；未知分类会被拒绝。 */
  add(newFact: KnowledgeFact): void {
    if (!isValidCategory(newFact.category)) {
      // 纵深防御：按理说工具 schema 应该已经拦住这里，但如果有调用方绕过了
      // 校验，我们也宁可丢弃这次写入，而不是污染持久化文件。
      return
    }
    // 做一次清洗，避免内嵌换行破坏 markdown 的单行格式。
    const fact: KnowledgeFact = {
      ...newFact,
      key: sanitizeLine(newFact.key),
      fact: sanitizeLine(newFact.fact),
    }
    const conflictIndex = this.facts.findIndex(
      (existing) => existing.category === fact.category && existing.key === fact.key,
    )
    if (conflictIndex >= 0) {
      this.facts[conflictIndex] = fact
    } else {
      this.facts.push(fact)
    }
    this.enqueueSave()
  }

  /** 按 key 删除记忆，也可以额外限定分类范围。 */
  delete(key: string, category?: string): void {
    this.facts = this.facts.filter((f) => !(f.key === key && (!category || f.category === category)))
    this.enqueueSave()
  }

  /** 根据 key 查找记忆，也可以额外限定分类。 */
  find(key: string, category?: string): KnowledgeFact | undefined {
    return this.facts.find((f) => f.key === key && (!category || f.category === category))
  }

  /** 淘汰超过 `maxAgeDays` 的旧记忆。 */
  evict(maxAgeDays: number = 90): void {
    const cutoff = Date.now() - maxAgeDays * 86400_000
    const before = this.facts.length
    this.facts = this.facts.filter((f) => new Date(f.date).getTime() > cutoff)
    if (this.facts.length < before) this.save()
  }

  /** 获取全部记忆条目。 */
  getAll(): KnowledgeFact[] {
    return [...this.facts]
  }

  /** 获取用于注入 system prompt 的内容（最多取前 `MAX_LOAD_LINES` 行）。 */
  getPromptContent(): string {
    const content = this.serialize()
    const lines = content.split('\n')
    if (lines.length > MAX_LOAD_LINES) {
      return lines.slice(0, MAX_LOAD_LINES).join('\n') + '\n...（已截断）'
    }
    return content
  }

  /** 序列化为 Markdown 格式。 */
  private serialize(): string {
    if (this.facts.length === 0) return ''

    const categories = new Map<string, KnowledgeFact[]>()
    for (const fact of this.facts) {
      const list = categories.get(fact.category) ?? []
      list.push(fact)
      categories.set(fact.category, list)
    }

    const sections: string[] = ['## 自动记忆', '']
    for (const [category, facts] of categories) {
      sections.push(`### ${category}`)
      for (const f of facts) {
        sections.push(`- [${f.date}] ${f.key}: ${f.fact}`)
      }
      sections.push('')
    }

    return sections.join('\n')
  }

  /**
   * 把一次保存动作排队，确保并发的 add/delete 调用会被串行化。
   * 每次保存都会等待前一次完成后再写盘。
   */
  private enqueueSave(): void {
    this.saveQueue = this.saveQueue.then(() => this.save())
  }

  /** 将当前记忆保存到文件。 */
  private async save(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      await fs.writeFile(this.filePath, this.serialize(), 'utf-8')
    } catch {
      // 静默失败——记忆写入失败时不要让 agent 崩掉
    }
  }
}

/** 将 Markdown 记忆文件解析回事实列表。未知分类下的条目会被丢弃，这样遗留分区（`context`、`tech-stack`、`commands` 等）会在下次保存时自然清除，而不是继续被重新序列化。 */
function parseMemoryFile(content: string): KnowledgeFact[] {
  const facts: KnowledgeFact[] = []
  let currentCategory = ''

  for (const line of content.split('\n')) {
    const categoryMatch = line.match(/^### (.+)$/)
    if (categoryMatch) {
      currentCategory = categoryMatch[1].trim()
      continue
    }

    const factMatch = line.match(/^- \[(\d{4}-\d{2}-\d{2})\] (.+?):\s*(.+)$/)
    if (factMatch && isValidCategory(currentCategory)) {
      facts.push({
        date: factMatch[1],
        key: factMatch[2].trim(),
        fact: factMatch[3].trim(),
        category: currentCategory,
      })
    }
  }

  return facts
}

// ─── 单例实例 ───
//
// 项目级记忆会以 cwd 作为 key，这样如果进程后续切换了工作目录
// （例如被嵌入到 daemon 或测试宿主中），我们会拿到绑定到正确文件的
// 新实例，而不是悄悄复用一个已经过时的实例。用户级记忆则是真正的单例，
// 因为它的路径由 USER_XCODE_DIR 固定决定。

const projectMemories = new Map<string, AutoMemory>()
let userMemory: AutoMemory | null = null

/** 计算项目级自动记忆文件的存储路径。 */
function projectMemoryPath(cwd: string): string {
  return path.join(cwd, XCODE_DIR, 'memory', 'auto.md')
}

/** 获取指定作用域的自动记忆实例。 */
export function getAutoMemory(scope: 'project' | 'user'): AutoMemory {
  if (scope === 'project') {
    const filePath = projectMemoryPath(process.cwd())
    let mem = projectMemories.get(filePath)
    if (!mem) {
      mem = new AutoMemory(filePath)
      projectMemories.set(filePath, mem)
    }
    return mem
  }
  if (!userMemory) {
    userMemory = new AutoMemory(path.join(USER_XCODE_DIR, 'memory', 'auto.md'))
  }
  return userMemory
}

/** 初始化自动记忆（从磁盘加载并清理过期条目）。 */
export async function initMemories(): Promise<void> {
  const project = getAutoMemory('project')
  const user = getAutoMemory('user')
  await Promise.all([project.load(), user.load()])
  project.evict(90)
  user.evict(90)
}

export { AutoMemory }
