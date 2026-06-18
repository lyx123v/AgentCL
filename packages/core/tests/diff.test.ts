import { describe, expect, it } from 'vitest'

import { computeEditDiff } from '../src/agent/diff.js'

describe('computeEditDiff', () => {
  it('新文件场景（oldContent = null）会返回 create payload', () => {
    const result = computeEditDiff('test.ts', null, 'line1\nline2\nline3\n')
    expect(result).not.toBeNull()
    expect(result!.isCreate).toBe(true)
    expect(result!.additions).toBe(3)
    expect(result!.removals).toBe(0)
    expect(result!.hunks).toEqual([])
    expect(result!.content).toBe('line1\nline2\nline3\n')
  })

  it('内容完全一致时返回 null', () => {
    const content = 'const x = 1\n'
    const result = computeEditDiff('test.ts', content, content)
    expect(result).toBeNull()
  })

  it('简单编辑时会返回 diff hunks', () => {
    const old = 'line1\nline2\nline3\n'
    const new_ = 'line1\nmodified\nline3\n'
    const result = computeEditDiff('test.ts', old, new_)
    expect(result).not.toBeNull()
    expect(result!.isCreate).toBe(false)
    expect(result!.hunks.length).toBeGreaterThan(0)
    expect(result!.additions).toBeGreaterThan(0)
    expect(result!.removals).toBeGreaterThan(0)
  })

  it('追加行时会正确统计 additions', () => {
    const old = 'line1\n'
    const new_ = 'line1\nline2\nline3\n'
    const result = computeEditDiff('test.ts', old, new_)
    expect(result).not.toBeNull()
    expect(result!.additions).toBe(2)
    expect(result!.removals).toBe(0)
  })

  it('删除行时会正确统计 removals', () => {
    const old = 'line1\nline2\nline3\n'
    const new_ = 'line1\n'
    const result = computeEditDiff('test.ts', old, new_)
    expect(result).not.toBeNull()
    expect(result!.removals).toBe(2)
    expect(result!.additions).toBe(0)
  })

  it('能处理创建空新文件的场景', () => {
    const result = computeEditDiff('empty.ts', null, '')
    expect(result).not.toBeNull()
    expect(result!.isCreate).toBe(true)
    expect(result!.additions).toBe(0)
  })
})
