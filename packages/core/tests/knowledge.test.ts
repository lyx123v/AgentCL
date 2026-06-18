// 自动记忆系统的测试
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { AutoMemory } from '../src/knowledge/auto-memory.js'
import type { KnowledgeFact } from '../src/types/index.js'

// 创建隔离的测试记忆文件，避免不同用例之间互相影响。
function createTestMemory() {
  return new AutoMemory(path.join(os.tmpdir(), 'x-code-test-memory-' + Date.now() + Math.random() + '.md'))
}

describe('AutoMemory', () => {
  let memory: AutoMemory

  beforeEach(() => {
    memory = createTestMemory()
  })

  it('可以添加一条事实', () => {
    const fact: KnowledgeFact = {
      key: 'user-role',
      fact: '资深 Go 工程师，刚接触 React',
      category: 'user',
      date: '2026-04-18',
    }
    memory.add(fact)
    expect(memory.getAll()).toHaveLength(1)
    expect(memory.getAll()[0]).toMatchObject(fact)
  })

  it('相同分类和 key 的事实会被替换（冲突检测）', () => {
    memory.add({ key: 'release-freeze', fact: '从 2026-03-05 开始', category: 'project', date: '2026-03-01' })
    memory.add({ key: 'release-freeze', fact: '延长到 2026-03-12', category: 'project', date: '2026-03-08' })

    expect(memory.getAll()).toHaveLength(1)
    expect(memory.getAll()[0].fact).toBe('延长到 2026-03-12')
  })

  it('允许不同分类使用相同 key', () => {
    memory.add({ key: 'testing', fact: '集成测试连接真实数据库', category: 'feedback', date: '2026-04-01' })
    memory.add({
      key: 'testing',
      fact: 'Grafana 测试看板位于 internal/test',
      category: 'reference',
      date: '2026-04-01',
    })

    expect(memory.getAll()).toHaveLength(2)
  })

  it('可以按 key 查找事实', () => {
    memory.add({ key: 'user-role', fact: '数据科学家', category: 'user', date: '2026-04-01' })
    const found = memory.find('user-role')
    expect(found).toBeDefined()
    expect(found!.fact).toBe('数据科学家')
  })

  it('可以按 key 和分类查找事实', () => {
    memory.add({ key: 'testing', fact: '不要使用 mock', category: 'feedback', date: '2026-04-01' })
    memory.add({ key: 'testing', fact: 'Grafana 看板', category: 'reference', date: '2026-04-01' })

    const found = memory.find('testing', 'feedback')
    expect(found).toBeDefined()
    expect(found!.fact).toBe('不要使用 mock')
  })

  it('可以按 key 删除事实', () => {
    memory.add({ key: 'user-role', fact: '资深 Go 工程师', category: 'user', date: '2026-04-01' })
    memory.delete('user-role')
    expect(memory.getAll()).toHaveLength(0)
  })

  it('可以按 key 和分类删除事实（保留其他分类）', () => {
    memory.add({ key: 'testing', fact: '不要使用 mock', category: 'feedback', date: '2026-04-01' })
    memory.add({ key: 'testing', fact: 'Grafana 看板', category: 'reference', date: '2026-04-01' })

    memory.delete('testing', 'feedback')
    expect(memory.getAll()).toHaveLength(1)
    expect(memory.getAll()[0].category).toBe('reference')
  })

  it('会清理超过 maxAgeDays 的旧事实', () => {
    const oldDate = '2020-01-01'
    const newDate = new Date().toISOString().split('T')[0]

    memory.add({ key: 'old', fact: '旧事实', category: 'project', date: oldDate })
    memory.add({ key: 'new', fact: '新事实', category: 'project', date: newDate })

    memory.evict(90)
    expect(memory.getAll()).toHaveLength(1)
    expect(memory.getAll()[0].key).toBe('new')
  })

  it('会拒绝无效分类的写入（纵深防御）', () => {
    memory.add({
      key: 'bogus',
      fact: '这条应被丢弃',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      category: 'tech-stack' as any,
      date: '2026-04-20',
    })
    expect(memory.getAll()).toHaveLength(0)
  })

  it('加载时会丢弃未知分类下的旧条目', async () => {
    const tmp = path.join(os.tmpdir(), 'x-code-legacy-mem-' + Date.now() + Math.random() + '.md')
    await fs.writeFile(
      tmp,
      `## Auto Memory

### context
- [2026-04-05] junk-task: 用户想要一个贪吃蛇游戏

### tech-stack
- [2026-04-05] package-manager: pnpm

### user
- [2026-04-05] user-role: 资深 Go 工程师
`,
      'utf-8',
    )
    const mem = new AutoMemory(tmp)
    await mem.load()
    const all = mem.getAll()
    expect(all).toHaveLength(1)
    expect(all[0].category).toBe('user')
    await fs.rm(tmp, { force: true })
  })

  it('getPromptContent 会按分类分组', () => {
    memory.add({ key: 'user-role', fact: '资深 Go 工程师', category: 'user', date: '2026-04-01' })
    memory.add({ key: 'user-lang', fact: '请用中文回复', category: 'user', date: '2026-04-01' })
    memory.add({ key: 'testing-policy', fact: '不要使用 mock', category: 'feedback', date: '2026-04-01' })

    const content = memory.getPromptContent()
    expect(content).toContain('## Auto Memory')
    expect(content).toContain('### user')
    expect(content).toContain('### feedback')
    expect(content).toContain('user-role: 资深 Go 工程师')
    expect(content).toContain('testing-policy: 不要使用 mock')
  })
})
