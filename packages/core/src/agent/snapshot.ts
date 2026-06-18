// @x-code-cli/core — 文件历史快照存储（内容寻址）
//
// 这是 `/rewind` 命令背后的存储层。每个用户消息 turn 都会生成一个
// checkpoint，用来捕获 `state.filesModified` 中每个文件的当前状态。
// 文件内容按 sha256 blob 去重，因此跨 checkpoint 重复出现的内容只占一份磁盘。
// 每个 session 的目录结构如下：
//
//   blobs/<sha256>           — 按内容寻址存储的文件内容（可共享）
//   checkpoints/<id>.json    — manifest，记录 abs path -> blob hash | absent | skip
//
// 之所以用内容寻址，而不是“每个 checkpoint 一整份拷贝”：
// 在典型 agent 运行中，相邻两条用户消息之间，大多数文件其实不会变化；
// 模型每个 turn 可能只改 1 到 3 个文件，但 `filesModified` 已累计 30+ 个。
// 去重后，新 checkpoint 的边际成本只与真正变化的文件字节数有关，
// 而不是与整个跟踪集合大小成正比。
//
// 之所以不做 shadow-git（设计讨论里提过）：
// 复制文件的方案同样适用于非 git 项目，不会与 .gitignore 冲突，
// 也能避免任何误触用户真实 `.git` 索引的可能。
import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { XCODE_DIR } from '../utils.js'
import type { LoopState } from './loop-state.js'

const FILE_HISTORY_SUBDIR = 'file-history'
const BLOBS_SUBDIR = 'blobs'
const CHECKPOINTS_SUBDIR = 'checkpoints'

/** 超过该大小的文件会在 manifest 中记为 `skip: true`，恢复时保持不动。
 *  这样可以防止偶然混进来的大型构建产物（几 MB 到几 GB）把 blob 存储撑爆；
 *  agent 正常跟踪的源码文件几乎不可能有这么大。 */
const MAX_FILE_BYTES = 10 * 1024 * 1024

/** 环形缓冲区上限。超出的旧 checkpoint 会被淘汰；对应孤立 blob
 *  会在下一次 restore 或 eviction 时被 GC。100 与 Claude Code 的上限一致。 */
const MAX_CHECKPOINTS = 100

/** checkpoint 的公开内存表示。它也会镜像写入 jsonl 的 `meta:checkpoint`
 *  记录中，这样 `/rewind` 历史就能跨 `/resume` 保留下来。 */
export interface CheckpointEntry {
  /** checkpoint 唯一标识。 */
  ckptId: string
  /** 推入用户消息后立刻记录下来的 `state.messages.length`。
   *  rewind 时会把消息截断到 `messageCount - 1`，也就是删除这条用户消息
   *  以及它之后的所有内容。该值在 compaction 后并不稳定，因为
   *  markBoundaryAndReflush 会清空内存中的消息历史。 */
  messageCount: number
  /** checkpoint 创建时间。 */
  ts: string
  /** 触发该 checkpoint 的用户消息前约 200 个字符，用于选择器预览。 */
  userPrompt: string
}

interface ManifestFileEntry {
  /** 快照时该文件内容的 sha256 十六进制哈希，对应 blobs/<hash>。 */
  hash?: string
  /** 快照时文件不存在（或不是普通文件）。恢复时如果当前存在，就删除。 */
  absent?: boolean
  /** 快照时文件过大或不可读。恢复时保持现状不动，因为我们并没有成功捕获它。 */
  skip?: boolean
}

interface Manifest {
  /** checkpoint 唯一标识。 */
  ckptId: string
  /** manifest 写入时间。 */
  ts: string
  /** 对应 checkpoint 时刻的消息数量。 */
  messageCount: number
  /** 触发该 checkpoint 的用户消息预览。 */
  userPrompt: string
  /** 键是绝对路径，也就是 `state.filesModified` 内部存储的形式。 */
  files: Record<string, ManifestFileEntry>
}

/** 计算某个 session 的文件历史根目录。 */
function historyDir(sessionId: string, cwd: string): string {
  return path.join(cwd, XCODE_DIR, FILE_HISTORY_SUBDIR, sessionId)
}

/** 计算某个 session 的 blob 存储目录。 */
function blobsDir(sessionId: string, cwd: string): string {
  return path.join(historyDir(sessionId, cwd), BLOBS_SUBDIR)
}

/** 计算某个 session 的 checkpoint manifest 目录。 */
function checkpointsDir(sessionId: string, cwd: string): string {
  return path.join(historyDir(sessionId, cwd), CHECKPOINTS_SUBDIR)
}

/** 计算某个 checkpoint manifest 的完整文件路径。 */
function manifestPath(sessionId: string, ckptId: string, cwd: string): string {
  return path.join(checkpointsDir(sessionId, cwd), `${ckptId}.json`)
}

/** 计算某个 blob 文件的完整路径。 */
function blobPath(sessionId: string, hash: string, cwd: string): string {
  return path.join(blobsDir(sessionId, cwd), hash)
}

/** 生成本地时间格式的 YYYYMMDD-HHMMSS-mmm，与 sessionId 形态保持一致，
 *  这样目录里按文件名排序时天然就是时间顺序。 */
function genCkptId(now: Date = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
    `-${pad(now.getMilliseconds(), 3)}`
  )
}

/** 判断某个路径当前是否存在。 */
async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** 区分“文件真的不存在”和“因为其他原因无法 stat（如 EACCES、EPERM、
 *  EBUSY）”。如果把权限受限文件误判成 ENOENT，就会把它记成 `absent`，
 *  恢复时还会静默尝试删除它，这比保持不动更危险。 */
type StatOutcome = { kind: 'ok'; stat: Stats } | { kind: 'absent' } | { kind: 'unreadable' }

/** 对文件做安全 stat，并把“不可读”和“不存在”分成不同分支。 */
async function statSafe(p: string): Promise<StatOutcome> {
  try {
    return { kind: 'ok', stat: await fs.stat(p) }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' }
    return { kind: 'unreadable' }
  }
}

/** 如果目标 blob 还不存在，就把内容写入 blob 存储。 */
async function writeBlobIfMissing(sessionId: string, hash: string, content: Buffer, cwd: string): Promise<void> {
  const p = blobPath(sessionId, hash, cwd)
  if (await exists(p)) return
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, content)
}

/** 把 `state.filesModified` 中每个文件当前的磁盘状态采集成一个新的
 *  内容寻址 checkpoint，并把入口追加到 `state.checkpoints`。
 *  成功时返回该 checkpoint，若文件系统层面失败则返回 null；
 *  这意味着“回退到这个点”并不安全，调用方应把这次快照视为不可用，
 *  而不是悄悄忽略。
 *
 *  快照是按文件“尽力而为”的：某个路径读取失败时，只把该条目标成 `skip`
 *  然后继续，因此单个文件的临时 EACCES 不会拖垮整个 checkpoint。 */
export async function createCheckpoint(
  state: LoopState,
  userPromptPreview: string,
  cwd: string = process.cwd(),
): Promise<CheckpointEntry | null> {
  const ckptId = genCkptId()
  const ts = new Date().toISOString()
  const messageCount = state.messages.length
  const files: Record<string, ManifestFileEntry> = {}

  for (const absPath of state.filesModified) {
    const outcome = await statSafe(absPath)
    if (outcome.kind === 'absent') {
      files[absPath] = { absent: true }
      continue
    }
    if (outcome.kind === 'unreadable') {
      // 这里的 stat 失败不是“文件不存在”，更可能是权限问题。
      // 标记为 skip，这样 restore 时就不会去删除一个用户或其他进程
      // 可能正在使用的重要文件。
      files[absPath] = { skip: true }
      continue
    }
    const stat = outcome.stat
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      // 符号链接、目录、超大文件都记为 skip，让 restore 明确知道
      // 应该保持它们不动，而不是误判成 absent 后删除。
      files[absPath] = { skip: true }
      continue
    }
    try {
      const buf = await fs.readFile(absPath)
      const hash = createHash('sha256').update(buf).digest('hex')
      await writeBlobIfMissing(state.sessionId, hash, buf, cwd)
      files[absPath] = { hash }
    } catch {
      files[absPath] = { skip: true }
    }
  }

  const manifest: Manifest = {
    ckptId,
    ts,
    messageCount,
    userPrompt: userPromptPreview.slice(0, 200),
    files,
  }
  try {
    await fs.mkdir(checkpointsDir(state.sessionId, cwd), { recursive: true })
    await fs.writeFile(manifestPath(state.sessionId, ckptId, cwd), JSON.stringify(manifest, null, 2), 'utf-8')
  } catch {
    return null
  }

  const entry: CheckpointEntry = { ckptId, messageCount, ts, userPrompt: manifest.userPrompt }
  state.checkpoints.push(entry)

  // 环形缓冲淘汰：删除最旧 manifest；blob 的 GC 留给下面的摊销式清理，
  // 避免每次 eviction 都重新读取所有剩余 manifest。
  let evicted = false
  while (state.checkpoints.length > MAX_CHECKPOINTS) {
    const dropped = state.checkpoints.shift()
    if (!dropped) break
    void fs.unlink(manifestPath(state.sessionId, dropped.ckptId, cwd)).catch(() => undefined)
    evicted = true
  }
  if (evicted) {
    // 这里选择 await 而不是 fire-and-forget：
    // 一方面让测试看到稳定的 blob 数量，另一方面避免下一次 eviction
    // 与仍在运行的 sweep 竞争，导致把新 manifest 仍引用的 blob 重复删除。
    // GC 复杂度是 O(剩余 checkpoints * 每个 manifest 的文件数)，
    // 上限也只是几百次读取，而且会被摊销到很多次正常 checkpoint 之间。
    await garbageCollectBlobs(state, cwd).catch(() => undefined)
  }

  return entry
}

/** 把工作区恢复到 `ckptId` 记录的状态。算法作用于
 *  （当前 `filesModified` 与 manifest 键集合）的并集：
 *    - manifest 中是 `hash`   → 把对应 blob 内容写回文件
 *    - manifest 中是 `absent` → 如果文件当前存在，就删除
 *    - manifest 中是 `skip`   → 保持不动（因为当时没成功捕获）
 *    - manifest 中不存在      → 删除（说明它是 checkpoint 之后新建的）
 *  并集之外的文件一律不碰，也就是只回滚 agent 历史上接触过的内容。
 *
 *  restore 成功后：
 *    - `state.filesModified` 会根据 manifest 键集合重建，
 *      让 agent 对“已触及文件”的认识与恢复点保持一致。
 *    - 目标之后的 checkpoint 会从 `state.checkpoints` 中移除，
 *      它们的 manifest 也会删除；孤立 blob 会被 GC。
 *
 *  调用方（use-agent）还需要自行把 `state.messages` 截断到
 *  `entry.messageCount - 1` 并重写 session jsonl；
 *  这里的 restore 只负责工作树和 checkpoint 元数据。 */
export async function restoreCheckpoint(
  state: LoopState,
  ckptId: string,
  cwd: string = process.cwd(),
): Promise<boolean> {
  let raw: string
  try {
    raw = await fs.readFile(manifestPath(state.sessionId, ckptId, cwd), 'utf-8')
  } catch {
    return false
  }
  let manifest: Manifest
  try {
    manifest = JSON.parse(raw) as Manifest
  } catch {
    return false
  }

  const allFiles = new Set<string>([...state.filesModified, ...Object.keys(manifest.files)])
  for (const absPath of allFiles) {
    const entry = manifest.files[absPath]
    if (!entry) {
      // 这是在该 checkpoint 之后才创建的文件，删除即可回滚。
      await fs.unlink(absPath).catch(() => undefined)
      continue
    }
    if (entry.skip) continue
    if (entry.absent) {
      await fs.unlink(absPath).catch(() => undefined)
      continue
    }
    if (entry.hash) {
      try {
        const buf = await fs.readFile(blobPath(state.sessionId, entry.hash, cwd))
        await fs.mkdir(path.dirname(absPath), { recursive: true })
        await fs.writeFile(absPath, buf)
      } catch {
        // blob 丢失时，这个文件无法恢复。这里不让整个 rewind 失败，
        // 因为单个文件恢复不了，也好过其余文件全部停留在半恢复状态。
      }
    }
  }

  // 根据 manifest 重建 filesModified，让后续 checkpoint 覆盖正确集合。
  // absent/skip 也会保留，因为这些文件在历史上确实被 agent 触及过，
  // 后面仍应纳入跟踪范围。
  state.filesModified.clear()
  for (const absPath of Object.keys(manifest.files)) {
    state.filesModified.add(absPath)
  }

  // 删除目标 checkpoint 之后的所有 checkpoint，但保留目标本身，
  // 因为用户此时正“位于”这个时间点，后续仍可能再次 rewind 到这里。
  const cutoffIndex = state.checkpoints.findIndex((c) => c.ckptId === ckptId)
  if (cutoffIndex >= 0) {
    const dropped = state.checkpoints.splice(cutoffIndex + 1)
    for (const d of dropped) {
      void fs.unlink(manifestPath(state.sessionId, d.ckptId, cwd)).catch(() => undefined)
    }
  }
  await garbageCollectBlobs(state, cwd).catch(() => undefined)
  return true
}

/** 扫描 blobs/，删除所有未被剩余 manifest 引用的 blob。
 *  成本较低：复杂度约为 O(剩余 checkpoints * 每个 manifest 的文件数)
 *  再加一次目录读取。它会在 eviction 和 restore 之后运行，
 *  因为这两条路径最容易产生孤立 blob。 */
async function garbageCollectBlobs(state: LoopState, cwd: string): Promise<void> {
  const referenced = new Set<string>()
  for (const ckpt of state.checkpoints) {
    try {
      const raw = await fs.readFile(manifestPath(state.sessionId, ckpt.ckptId, cwd), 'utf-8')
      const m = JSON.parse(raw) as Manifest
      for (const entry of Object.values(m.files)) {
        if (entry.hash) referenced.add(entry.hash)
      }
    } catch {
      // manifest 已删除或不可读时直接跳过；它引用的 blob 会与其他候选项
      // 一起进入本轮回收范围。
    }
  }
  let names: string[]
  try {
    names = await fs.readdir(blobsDir(state.sessionId, cwd))
  } catch {
    return
  }
  for (const name of names) {
    if (!referenced.has(name)) {
      await fs.unlink(blobPath(state.sessionId, name, cwd)).catch(() => undefined)
    }
  }
}
