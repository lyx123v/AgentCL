// /rewind 功能测试：覆盖内容寻址快照存储、session-jsonl 持久化，以及 hydrate 流程。
//
// 这里真正关心的是那些会直接影响用户体验的行为：
//
//   1. 往返恢复：createCheckpoint → 修改 → restore 之后，用户看到的文件内容
//      必须回到修改前。这是 rewind 的核心能力，失效就等于功能损坏。
//   2. 去重：两个检查点里的相同内容只应占用一个 blob。否则 100 个检查点上限
//      很容易把磁盘撑到几个 GB。
//   3. 检查点之后创建的文件：如果某个文件是在检查点之后由 agent 新建的，
//      rewind 时必须删除它。否则“回到你帮我做 X 之前”的结果仍会把 X 留在磁盘上。
//   4. absent / skip：标记为 absent 的文件在恢复时要再次删除；标记为 skip
//      的文件（过大、不可读）则保持原样。skip 是安全阀，绝不能悄悄删除我们
//      当时无法完整捕获的文件。
//   5. 持久化：appendCheckpoint → loadSession → hydrateLoopState 之后，
//      必须能拿回同一组检查点。否则 /rewind 会在 /resume 之后悄悄失效。
//   6. 压缩边界语义：边界之前的检查点在 load 时应被丢弃，因为压缩后它们的
//      messageCount 锚点已经失效。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createLoopState } from '../src/agent/loop-state.js'
import {
  appendCheckpoint,
  appendHeader,
  flushPendingMessages,
  hydrateLoopState,
  loadSession,
  markBoundaryAndReflush,
} from '../src/agent/session-store.js'
import { createCheckpoint, restoreCheckpoint } from '../src/agent/snapshot.js'
import { XCODE_DIR } from '../src/utils.js'

// ── 测试准备 ────────────────────────────────────────────────────────────

let tempDir: string
let originalCwd: string

beforeEach(() => {
  // 切到全新的临时目录，保证 session-store（使用 process.cwd()）
  // 与显式传入 cwd 的 snapshot 调用都落在同一棵隔离目录树中。
  // 这里沿用 session-store.test.ts 的测试模式。
  tempDir = mkdtempSync(path.join(tmpdir(), 'xc-snapshot-'))
  originalCwd = process.cwd()
  process.chdir(tempDir)
})

afterEach(() => {
  process.chdir(originalCwd)
  rmSync(tempDir, { recursive: true, force: true })
})

// ── 辅助方法 ────────────────────────────────────────────────────────────

// 写入测试工作区文件，并返回其绝对路径，方便后续加入 filesModified。
async function writeWorkfile(rel: string, content: string): Promise<string> {
  const abs = path.join(tempDir, rel)
  await mkdir(path.dirname(abs), { recursive: true })
  await writeFile(abs, content, 'utf-8')
  return abs
}

// 计算指定会话在 file-history 下的子目录路径。
function historySubdir(sid: string, sub: 'blobs' | 'checkpoints'): string {
  return path.join(tempDir, XCODE_DIR, 'file-history', sid, sub)
}

// 列出历史目录内容；目录不存在时返回空数组，便于断言。
async function lsHistory(sid: string, sub: 'blobs' | 'checkpoints'): Promise<string[]> {
  try {
    const { readdir } = await import('node:fs/promises')
    return (await readdir(historySubdir(sid, sub))).sort()
  } catch {
    return []
  }
}

// ── 快照核心行为 ────────────────────────────────────────────────────────

describe('snapshot：往返恢复', () => {
  it('能恢复到检查点捕获时的文件内容', async () => {
    const state = createLoopState()
    const file = await writeWorkfile('src/a.ts', '初始内容')
    state.filesModified.add(file)

    const ckpt = await createCheckpoint(state, '第一次提问', tempDir)
    expect(ckpt).not.toBeNull()

    await writeFile(file, '修改后内容')
    const ok = await restoreCheckpoint(state, ckpt!.ckptId, tempDir)
    expect(ok).toBe(true)
    expect(await readFile(file, 'utf-8')).toBe('初始内容')
  })

  it('遇到未知检查点 id 时返回 false', async () => {
    const state = createLoopState()
    expect(await restoreCheckpoint(state, 'does-not-exist', tempDir)).toBe(false)
  })

  it('会以正确的 messageCount 记录到 state.checkpoints 中', async () => {
    const state = createLoopState()
    // 模拟 agentLoop 的调用现场：先 messages.push，再 createCheckpoint。
    state.messages.push({ role: 'user', content: '你好' })
    const ckpt = await createCheckpoint(state, '你好', tempDir)
    expect(ckpt).not.toBeNull()
    expect(ckpt!.messageCount).toBe(1)
    expect(state.checkpoints).toHaveLength(1)
    expect(state.checkpoints[0]!.ckptId).toBe(ckpt!.ckptId)
  })
})

describe('snapshot：内容寻址去重', () => {
  it('内容未变化时，两个检查点会复用同一个 blob', async () => {
    const state = createLoopState()
    const file = await writeWorkfile('a.ts', '共享内容')
    state.filesModified.add(file)

    await createCheckpoint(state, '消息 1', tempDir)
    await createCheckpoint(state, '消息 2', tempDir)

    expect(await lsHistory(state.sessionId, 'blobs')).toHaveLength(1)
  })

  it('内容变化后会写入新的 blob', async () => {
    const state = createLoopState()
    const file = await writeWorkfile('a.ts', '版本一')
    state.filesModified.add(file)

    await createCheckpoint(state, '消息 1', tempDir)
    await writeFile(file, '版本二')
    await createCheckpoint(state, '消息 2', tempDir)

    expect(await lsHistory(state.sessionId, 'blobs')).toHaveLength(2)
  })
})

describe('snapshot：检查点后的文件删除', () => {
  it('会删除在检查点之后新建的文件', async () => {
    const state = createLoopState()
    // 在 filesModified 为空时创建 ckpt1，表示“本次会话里 agent 尚未修改任何文件”的世界状态。
    const ckpt1 = await createCheckpoint(state, '消息 1', tempDir)
    expect(ckpt1).not.toBeNull()

    // 后续 agent “创建” newfile.ts，并将它加入追踪。
    const newfile = await writeWorkfile('newfile.ts', '之后才创建')
    state.filesModified.add(newfile)

    const ok = await restoreCheckpoint(state, ckpt1!.ckptId, tempDir)
    expect(ok).toBe(true)
    expect(existsSync(newfile)).toBe(false)
  })
})

describe('snapshot：absent 处理', () => {
  it('恢复时会删除“快照时不存在”的文件，以重建 absent 状态', async () => {
    const state = createLoopState()
    // 追踪一个在创建检查点时并不存在的文件。
    const ghost = path.join(tempDir, 'ghost.ts')
    state.filesModified.add(ghost)

    const ckpt = await createCheckpoint(state, '消息 1', tempDir)
    expect(ckpt).not.toBeNull()

    // 调用方之后才把它创建出来。
    await writeWorkfile('ghost.ts', '现在存在了')
    expect(existsSync(ghost)).toBe(true)

    await restoreCheckpoint(state, ckpt!.ckptId, tempDir)
    // manifest 记录的是 absent，因此 restore 会再次确认 absent 并删除文件。
    expect(existsSync(ghost)).toBe(false)
  })
})

describe('snapshot：过大文件 / skip', () => {
  it('不会为超大文件写 blob，恢复时也会保持其当前状态', async () => {
    const state = createLoopState()
    const big = path.join(tempDir, 'big.bin')
    // 创建一个略超 10MB 上限的稀疏文件。大多数文件系统上的 truncate() 都是瞬时的，
    // 这样不必为了测试边界真的在内存里分配 10MB 数据。
    const fh = await open(big, 'w')
    await fh.truncate(11 * 1024 * 1024)
    await fh.close()
    state.filesModified.add(big)

    const ckpt = await createCheckpoint(state, '消息 1', tempDir)
    expect(ckpt).not.toBeNull()
    // 超过大小限制，不会写入 blob。
    expect(await lsHistory(state.sessionId, 'blobs')).toHaveLength(0)

    // 在检查点之后修改它，再执行恢复。
    await writeFile(big, '现在变小了')
    const ok = await restoreCheckpoint(state, ckpt!.ckptId, tempDir)
    expect(ok).toBe(true)
    // skip 的语义是：既然当时无法完整捕获，就不能尝试回滚它。
    expect(await readFile(big, 'utf-8')).toBe('现在变小了')
  })
})

describe('snapshot：恢复后的状态整理', () => {
  it('会从 state.checkpoints 中移除被恢复检查点之后的条目', async () => {
    const state = createLoopState()
    const file = await writeWorkfile('a.ts', '版本一')
    state.filesModified.add(file)

    const c1 = await createCheckpoint(state, '消息 1', tempDir)
    await writeFile(file, '版本二')
    await createCheckpoint(state, '消息 2', tempDir)
    await writeFile(file, '版本三')
    await createCheckpoint(state, '消息 3', tempDir)
    expect(state.checkpoints).toHaveLength(3)

    await restoreCheckpoint(state, c1!.ckptId, tempDir)
    expect(state.checkpoints).toHaveLength(1)
    expect(state.checkpoints[0]!.ckptId).toBe(c1!.ckptId)
    // 磁盘上的 manifest 也应该同步裁剪。
    expect(await lsHistory(state.sessionId, 'checkpoints')).toHaveLength(1)
  })

  it('会清理不再被任何剩余 manifest 引用的 blob', async () => {
    const state = createLoopState()
    const file = await writeWorkfile('a.ts', '版本一')
    state.filesModified.add(file)

    const c1 = await createCheckpoint(state, '消息 1', tempDir)
    await writeFile(file, '版本二')
    await createCheckpoint(state, '消息 2', tempDir)
    expect(await lsHistory(state.sessionId, 'blobs')).toHaveLength(2)

    await restoreCheckpoint(state, c1!.ckptId, tempDir)
    // 版本二的 blob 已经变成孤儿数据，应被 GC 删除，只保留版本一。
    expect(await lsHistory(state.sessionId, 'blobs')).toHaveLength(1)
  })
})

// ── Session-store 集成 ─────────────────────────────────────────────────
//
// 这里覆盖的是让 /rewind 能跨 /resume 生效的 jsonl 持久化层。
// 它们不是 session-store 的单元测试（那部分在 session-store.test.ts），
// 而是专门验证 picker 依赖的端到端契约：appendCheckpoint → loadSession
// → hydrateLoopState。

describe('rewind 持久化：appendCheckpoint + loadSession 往返', () => {
  it('在 compact-boundary 之前写入的检查点，load 后仍然可见', async () => {
    const state = createLoopState()
    state.taskSlug = 'fix-bug'
    state.messages.push({ role: 'user', content: '第一条' })
    await appendHeader(state, 'anthropic:claude-x', '第一条', tempDir)
    await flushPendingMessages(state)

    const ckpt = await createCheckpoint(state, '第一条', tempDir)
    expect(ckpt).not.toBeNull()
    await appendCheckpoint(state, ckpt!)

    const sessionFile = path.join(tempDir, XCODE_DIR, 'sessions', `fix-bug-${state.sessionId}.jsonl`)
    const loaded = await loadSession(sessionFile)
    expect(loaded).not.toBeNull()
    expect(loaded!.checkpoints).toHaveLength(1)
    expect(loaded!.checkpoints[0]!.ckptId).toBe(ckpt!.ckptId)

    // hydrate 之后，检查点也要带回实时状态对象。
    const hydrated = hydrateLoopState(loaded!)
    expect(hydrated.checkpoints).toHaveLength(1)
    expect(hydrated.checkpoints[0]!.ckptId).toBe(ckpt!.ckptId)
  })

  it('compact-boundary 之前的检查点会在 load 时被丢弃', async () => {
    // 这很关键：边界之前检查点的 `messageCount` 锚点指向的是已被压缩掉的消息区间，
    // 因此“回到这里”已经没有意义。loader 必须丢弃它们，并与
    // markBoundaryAndReflush 的内存清理行为保持一致。
    const state = createLoopState()
    state.taskSlug = 'compact-test'
    state.messages.push({ role: 'user', content: '压缩前' })
    await appendHeader(state, 'anthropic:claude-x', '压缩前', tempDir)
    await flushPendingMessages(state)

    const pre = await createCheckpoint(state, '压缩前', tempDir)
    await appendCheckpoint(state, pre!)

    // 模拟一次轻量压缩：缩减消息并写入 boundary，再重新 flush。
    // markBoundaryAndReflush 会清空内存中的 state.checkpoints，
    // 磁盘上的 boundary 记录也会让 loader 把旧检查点一起丢弃。
    state.messages = []
    state.messages.push({ role: 'user', content: '压缩后' })
    await markBoundaryAndReflush(state)
    expect(state.checkpoints).toHaveLength(0)

    const post = await createCheckpoint(state, '压缩后', tempDir)
    await appendCheckpoint(state, post!)

    const sessionFile = path.join(tempDir, XCODE_DIR, 'sessions', `compact-test-${state.sessionId}.jsonl`)
    const loaded = await loadSession(sessionFile)
    expect(loaded).not.toBeNull()
    // 只应看到边界之后的新检查点。
    expect(loaded!.checkpoints).toHaveLength(1)
    expect(loaded!.checkpoints[0]!.ckptId).toBe(post!.ckptId)
  })
})
