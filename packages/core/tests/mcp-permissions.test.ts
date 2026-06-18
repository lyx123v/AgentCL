import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { McpPermissionStore, classifyDecision } from '../src/mcp/permissions.js'

// 为每个测试创建隔离的 X_CODE_HOME，避免污染本地权限文件。
function isolate(): string {
  const dir = path.join(os.tmpdir(), 'mcp-perms-test-' + Math.random().toString(36).slice(2))
  process.env.X_CODE_HOME = dir
  return dir
}

describe('McpPermissionStore', () => {
  let home: string
  beforeEach(() => {
    home = isolate()
  })
  afterEach(() => {
    delete process.env.X_CODE_HOME
  })

  it('初始状态为空', async () => {
    const store = new McpPermissionStore()
    expect(await store.isApproved('foo__bar')).toBe(false)
  })

  it('仅会话授权不会持久化', async () => {
    const store = new McpPermissionStore()
    store.approveForSession('foo__bar')
    expect(await store.isApproved('foo__bar')).toBe(true)

    // 新实例中仍应是未授权状态，因为之前只是会话级授权。
    const store2 = new McpPermissionStore()
    expect(await store2.isApproved('foo__bar')).toBe(false)
  })

  it('approvePermanently 会跨实例持久生效', async () => {
    const store = new McpPermissionStore()
    await store.approvePermanently('foo__bar')

    const store2 = new McpPermissionStore()
    expect(await store2.isApproved('foo__bar')).toBe(true)
  })

  it('会写入权限为 0600 且条目有序的文件', async () => {
    const store = new McpPermissionStore()
    await store.approvePermanently('zeta__b')
    await store.approvePermanently('alpha__a')

    const filePath = path.join(home, 'mcp-permissions.json')
    const raw = await fs.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as { alwaysAllow: string[] }
    expect(parsed.alwaysAllow).toEqual(['alpha__a', 'zeta__b'])
  })

  it('重复永久授权同一条目时会忽略重复写入', async () => {
    const store = new McpPermissionStore()
    await store.approvePermanently('foo__bar')
    await store.approvePermanently('foo__bar')
    expect(await store.isApproved('foo__bar')).toBe(true)
  })
})

describe('classifyDecision', () => {
  it('会把回调字符串映射为结构化选择', () => {
    expect(classifyDecision('yes')).toBe('allow-once')
    expect(classifyDecision('always')).toBe('allow-always')
    expect(classifyDecision('no')).toBe('deny')
  })
})
