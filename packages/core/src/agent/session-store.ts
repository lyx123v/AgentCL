// @x-code-cli/core — 按会话存储的 JSONL 对话记录
//
// 每个 session 对应一个文件：`.x-code/sessions/<slug>-<sessionId>.jsonl`。
// 其中 slug 与 plan 文件使用相同的人类可读标识；如果用户首条消息不含 ASCII，
// 就会退化为仅时间戳命名。
// 文件采用只追加模式；一个 session 中我们记录的所有内容——header、
// 每条 ModelMessage、周期性的 token 用量快照、压缩边界、打断标记——
// 都以“每行一个 JSON 对象”的形式落盘。
//
// 之所以用 JSONL，而不是反复重写单个大 JSON 文档：
//   - 更抗崩溃。进程被杀或磁盘写满时，最多损失当前正在写的那一行，
//     之前内容仍然完好。
//   - 追加成本低。每个 turn 只追加几百字节，不需要整文件重写。
//   - 与 Claude Code 的 `~/.claude/<project>/<uuid>.jsonl` 形态完全对齐，
//     包括 `compact_boundary` 的语义（见下方 `loadSession`）。
//
// 这个模块取代了旧的按会话存储 `<id>.usage.json` 和 `<id>.json`
// （LLM summary）文件；它们现在都变成 jsonl 里的 meta 记录。
// `/usage` 历史与 `/resume` 都读取同一份文件。
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { ModelMessage } from 'ai'

import type { PermissionMode, TokenUsage } from '../types/index.js'
import { XCODE_DIR } from '../utils.js'
import { createLoopState } from './loop-state.js'
import type { LoopState } from './loop-state.js'
import type { CheckpointEntry } from './snapshot.js'

const SESSIONS_SUBDIR = 'sessions'

/** 计算会话目录路径。 */
function sessionsDir(cwd: string = process.cwd()): string {
  return path.join(cwd, XCODE_DIR, SESSIONS_SUBDIR)
}

/** 计算某个 session 在磁盘上的文件路径。命名形态与 plan 文件一致，
 *  即 `<slug>-<id>.<ext>`，这样 `ls .x-code/sessions/` 和
 *  `ls .x-code/plans/` 的观感保持统一。空 slug（例如首条消息全是 CJK）
 *  会退化为纯时间戳命名，与 plan 文件的兜底策略一致。 */
export function getSessionFilePath(
  state: { sessionId: string; taskSlug: string },
  cwd: string = process.cwd(),
): string {
  const base = state.taskSlug ? `${state.taskSlug}-${state.sessionId}` : state.sessionId
  return path.join(sessionsDir(cwd), `${base}.jsonl`)
}

// ── 写入 jsonl 的记录类型 ───────────────────────────────────────────

interface HeaderEntry {
  /** 固定为 meta，表示这是元数据行。 */
  t: 'meta'
  /** 元数据子类型，这里是 header。 */
  kind: 'header'
  /** 会话当时的工作目录。 */
  cwd: string
  /** 会话开始时的 git 分支名。 */
  gitBranch?: string
  /** 会话使用的模型 id。 */
  modelId: string
  /** 会话启动时间。 */
  startedAt: string
  /** 截断到约 500 个字符，让选择器能展示足够可辨识的预览，
   *  同时避免为此把首条用户消息完整读回内存。 */
  firstPrompt: string
  /** 人类可读的任务 slug。 */
  taskSlug: string
  /** session 唯一标识。 */
  sessionId: string
}

interface MsgEntry {
  /** 固定为 msg，表示这是一条消息记录。 */
  t: 'msg'
  /** 真正的模型消息内容。 */
  message: ModelMessage
  /** 记录写入时间。 */
  ts: string
}

interface UsageEntry {
  /** 固定为 meta，表示这是元数据行。 */
  t: 'meta'
  /** 元数据子类型，这里是 usage。 */
  kind: 'usage'
  /** 当时累计的 token 使用统计。 */
  usage: TokenUsage
  /** 产生这份统计时对应的模型 id。 */
  modelId: string
  /** 快照时间。 */
  ts: string
}

interface CompactBoundaryEntry {
  /** 固定为 meta，表示这是元数据行。 */
  t: 'meta'
  /** 元数据子类型，这里是 compact-boundary。 */
  kind: 'compact-boundary'
  /** 深压缩（LLM summary）时会写入；轻压缩（loop-guard 裁剪）时省略。
   *  summary 文本也会嵌入到后续重新刷写的下一条 msg 记录中，
   *  因此这里主要是信息性字段，方便 `listSessions` 在不重新读取
   *  边界后消息内容的前提下，于选择器里展示“已压缩”的提示。 */
  summary?: string
  /** 写入时间。 */
  ts: string
}

interface InterruptedEntry {
  /** 固定为 meta，表示这是元数据行。 */
  t: 'meta'
  /** 元数据子类型，这里是 interrupted。 */
  kind: 'interrupted'
  /** 中断标记写入时间。 */
  ts: string
}

/** rewind 检查点指针。`loadSession` 会把它读出来，这样 `/resume`
 *  后仍能保留同一份 `/rewind` 历史。真正的文件备份内容单独存放在
 *  `.x-code/file-history/<sessionId>/` 下面。 */
interface CheckpointJsonlEntry {
  /** 固定为 meta，表示这是元数据行。 */
  t: 'meta'
  /** 元数据子类型，这里是 checkpoint。 */
  kind: 'checkpoint'
  /** checkpoint 唯一标识。 */
  ckptId: string
  /** 创建检查点时对应的消息数量。 */
  messageCount: number
  /** 检查点时间戳。 */
  ts: string
  /** 触发该检查点的用户消息预览。 */
  userPrompt: string
}

type Entry = HeaderEntry | MsgEntry | UsageEntry | CompactBoundaryEntry | InterruptedEntry | CheckpointJsonlEntry

// ── 追加写辅助函数（尽力而为，不向外抛错）─────────────────────────

/** 向 jsonl 文件追加一条结构化记录。 */
async function appendLine(filePath: string, entry: Entry): Promise<void> {
  await appendRawLines(filePath, [JSON.stringify(entry)])
}

/** 批量追加已经序列化好的 jsonl 行。返回值表示是否写入成功，
 *  这样调用方就能遵守“只有磁盘写成功才推进内存状态”的原则；
 *  例如 `markBoundaryAndReflush` 只有在 boundary 真正落盘后，
 *  才应该清空内存中的 checkpoint 列表。 */
async function appendRawLines(filePath: string, lines: string[]): Promise<boolean> {
  if (lines.length === 0) return true
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.appendFile(filePath, lines.join('\n') + '\n', 'utf-8')
    return true
  } catch {
    // 持久化是尽力而为的，不能因为文件系统异常阻塞 agent loop。
    return false
  }
}

/** 尝试从 `.git/HEAD` 读取当前分支名。这个操作很轻量；
 *  如果目录不是 git 仓库、处于 detached HEAD，或文件不存在，
 *  都会静默返回 undefined。 */
async function readGitBranch(cwd: string): Promise<string | undefined> {
  try {
    const head = await readFile(path.join(cwd, '.git', 'HEAD'), 'utf-8')
    const m = head.match(/^ref: refs\/heads\/(.+)$/m)
    return m ? m[1].trim() : undefined
  } catch {
    return undefined
  }
}

/** 写入 session header。该操作是幂等的：如果文件已经存在
 *  （通常是 resume 场景），就直接跳过，保留原始 header，
 *  让选择器读取到的元信息在多次恢复后仍然稳定。 */
export async function appendHeader(
  state: LoopState,
  modelId: string,
  firstPrompt: string,
  cwd: string = process.cwd(),
): Promise<void> {
  const filePath = getSessionFilePath(state, cwd)
  try {
    await fs.access(filePath)
    return // 文件已存在，保留原始 header
  } catch {
    // 文件不存在，继续往下写入 header。
  }
  const gitBranch = await readGitBranch(cwd)
  const entry: HeaderEntry = {
    t: 'meta',
    kind: 'header',
    cwd,
    gitBranch,
    modelId,
    startedAt: state.startedAt,
    firstPrompt: firstPrompt.slice(0, 500),
    taskSlug: state.taskSlug,
    sessionId: state.sessionId,
  }
  await appendLine(filePath, entry)
}

/** 将 `state.messages` 中 `state.persistedMessageCount` 之后的新消息
 *  批量刷入 jsonl 文件。这里采用差量刷写设计，是为了让写入逻辑与 agent loop
 *  中那些会直接修改 `state.messages` 的位置保持解耦
 *  （如 collectTurnResponse、processToolCalls、length-finish nudge 等）；
 *  统一在 turn 边界做一次 sweep，就能兜住所有变更来源。
 *
 *  发生深压缩或轻压缩后，内存数组会缩短。这时调用方必须改用下面的
 *  `markBoundaryAndReflush`，因为那条路径会先写 compact-boundary，
 *  让 loader 在加载时知道该从何处截断，然后再把裁剪后的消息重新追加，
 *  保证边界后的 jsonl 内容与当前内存状态完全一致。 */
export async function flushPendingMessages(state: LoopState): Promise<void> {
  if (state.persistedMessageCount >= state.messages.length) return
  const filePath = getSessionFilePath(state)
  const ts = new Date().toISOString()
  const lines: string[] = []
  for (let i = state.persistedMessageCount; i < state.messages.length; i++) {
    const message = state.messages[i]
    if (!message) continue
    const entry: MsgEntry = { t: 'msg', message, ts }
    lines.push(JSON.stringify(entry))
  }
  // 保留重构前的提前返回语义：如果这次 loop 实际没有产出任何可写消息
  // （所有未持久化槽位都因为防御性的 `!message` 被跳过），就不要推进
  // persistedMessageCount，避免未来真正有消息时误以为这段区间已刷盘。
  if (lines.length === 0) return
  if (await appendRawLines(filePath, lines)) {
    state.persistedMessageCount = state.messages.length
  }
}

/** 为当前 turn 追加一条 usage 快照。它会在 agent loop 中
 *  `collectTurnResponse` 接受 provider 返回的 `usage` 对象后调用。
 *  选择器只需通过尾部扫描读取最后一条 usage 记录，就能显示会话总量，
 *  因此没必要为更早快照额外优化存储结构。 */
export async function appendUsage(state: LoopState, modelId: string): Promise<void> {
  const filePath = getSessionFilePath(state)
  const entry: UsageEntry = {
    t: 'meta',
    kind: 'usage',
    usage: { ...state.tokenUsage },
    modelId,
    ts: new Date().toISOString(),
  }
  await appendLine(filePath, entry)
}

/** 标记一次压缩事件，并把刚刚缩短后的消息数组重新刷盘。
 *  当它返回后，jsonl 中“最后一个 boundary 之后”的内容会与 `state.messages`
 *  完全一致，因此 `loadSession` 在 resume 时能重建出相同的内存状态。
 *
 *  之所以要重新追加，而不是依赖 boundary 之前的历史消息，是因为
 *  `compressMessages` 会原样保留一个 `recent N` 切片，但这些消息在 boundary
 *  之前其实已经写入过；若只依赖 loader 的“最后一个 boundary 之后内容生效”
 *  规则，这些保留片段反而会被丢掉。磁盘上多重复 6 条左右消息代价很低，
 *  却能让加载逻辑非常简单。
 *
 *  轻压缩（loop-guard pruning）会以 `summary=undefined` 调用这里。
 *  即便没有 summary，被裁掉的消息仍然需要一个 boundary，
 *  否则 loader 会把那些已删除的 loop-guard 成对消息重新复活。 */
export async function markBoundaryAndReflush(state: LoopState, summary?: string): Promise<void> {
  const filePath = getSessionFilePath(state)
  const ts = new Date().toISOString()
  const boundary: CompactBoundaryEntry = { t: 'meta', kind: 'compact-boundary', ts }
  if (summary !== undefined) boundary.summary = summary
  const lines = [JSON.stringify(boundary)]
  for (const message of state.messages) {
    const entry: MsgEntry = { t: 'msg', message, ts }
    lines.push(JSON.stringify(entry))
  }
  if (!(await appendRawLines(filePath, lines))) return
  state.persistedMessageCount = state.messages.length
  // 压缩会缩短并重写 messages 数组，因此所有旧 checkpoint 的
  // `messageCount` 都可能越过新的数组末尾。这里同步清空内存列表，
  // 与 loader 的行为保持一致（resume 时也会丢弃 boundary 之前的
  // checkpoint 记录）。
  state.checkpoints = []
}

/** 追加一条 rewind checkpoint 标记。与其他追加辅助函数一样，
 *  采用尽力而为策略。resume 时，`loadSession` 会把它们收集到
 *  `LoadedSession.checkpoints` 中，从而让 CLI 重启后仍能看到同样的
 *  rewind 节点。按照 loader 的“最后一个 boundary 之后内容生效”规则，
 *  那些被压缩后使 `messageCount` 失效的 checkpoint 会自然被丢弃。 */
export async function appendCheckpoint(state: LoopState, entry: CheckpointEntry): Promise<void> {
  if (!state.sessionId) return
  const filePath = getSessionFilePath(state)
  const jsonl: CheckpointJsonlEntry = {
    t: 'meta',
    kind: 'checkpoint',
    ckptId: entry.ckptId,
    messageCount: entry.messageCount,
    ts: entry.ts,
    userPrompt: entry.userPrompt,
  }
  await appendLine(filePath, jsonl)
}

/** 追加一条 `interrupted` 标记。它纯粹是信息性记录：
 *  loader 在恢复状态时会忽略它，但选择器可以据此在那些中途被打断的
 *  session 旁边显示“已中断”，让用户知道自己将恢复到什么状态。 */
export async function appendInterrupted(state: LoopState): Promise<void> {
  if (!state.sessionId) return
  const filePath = getSessionFilePath(state)
  const entry: InterruptedEntry = { t: 'meta', kind: 'interrupted', ts: new Date().toISOString() }
  await appendLine(filePath, entry)
}

// ── 读取路径：加载与列举 ───────────────────────────────────────────

export interface LoadedSession {
  /** session 唯一标识。 */
  sessionId: string
  /** 任务 slug，用于生成更易读的文件名。 */
  taskSlug: string
  /** 会话启动时间。 */
  startedAt: string
  /** 当时使用的模型 id。 */
  modelId: string
  /** 该会话运行时的工作目录。 */
  cwd: string
  /** 会话启动时的 git 分支名。 */
  gitBranch?: string
  /** 首条用户消息的预览文本。 */
  firstPrompt: string
  /** 从 jsonl 恢复出的消息数组。 */
  messages: ModelMessage[]
  /** 最近一次 usage 快照。 */
  tokenUsage: TokenUsage
  /** 最后一个 compact-boundary 之后仍然有效的 rewind checkpoint 列表。
   *  对应的文件 manifest 存放在 `.x-code/file-history/<sid>/` 下。 */
  checkpoints: CheckpointEntry[]
  /** jsonl 文件路径，resume 后 agent loop 会继续向这同一个文件追加内容。 */
  filePath: string
}

const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  currentContextTokens: 0,
}

/** 遍历某个 session 的 jsonl 文件，并重建出一个 LoadedSession。
 *
 *  compact-boundary 的语义与 Claude Code 一致：每遇到一条
 *  `compact-boundary` 记录，就清空一次消息累积器。因此最终返回的
 *  `messages` 只反映“最后一个 boundary 之后”的内容，而这正好与压缩时
 *  的内存状态一致（见 `markBoundaryAndReflush`）。
 *
 *  尾部孤立的 tool_call / tool_result 会被裁掉，否则下一次 API 请求
 *  会因为消息数组非法而被拒绝。具体规则见 `sanitizeMessageTail`。 */
export async function loadSession(filePath: string): Promise<LoadedSession | null> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf-8')
  } catch {
    return null
  }
  let header: HeaderEntry | null = null
  let lastUsage: UsageEntry | null = null
  let messages: ModelMessage[] = []
  let checkpoints: CheckpointEntry[] = []

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let entry: Entry
    try {
      entry = JSON.parse(line) as Entry
    } catch {
      continue // 静默跳过损坏的行
    }
    if (entry.t === 'meta') {
      if (entry.kind === 'header') {
        header = entry
      } else if (entry.kind === 'usage') {
        lastUsage = entry
      } else if (entry.kind === 'compact-boundary') {
        messages = []
        // 压缩前 messageCount 对应的 checkpoint 现在已失去意义，
        // 因为 messages 数组已经缩短，所以与消息一起丢弃。
        checkpoints = []
      } else if (entry.kind === 'checkpoint') {
        checkpoints.push({
          ckptId: entry.ckptId,
          messageCount: entry.messageCount,
          ts: entry.ts,
          userPrompt: entry.userPrompt,
        })
      }
      // 'interrupted' 仅作信息展示，不参与状态恢复
    } else if (entry.t === 'msg') {
      messages.push(entry.message)
    }
  }
  if (!header) return null

  return {
    sessionId: header.sessionId,
    taskSlug: header.taskSlug,
    startedAt: header.startedAt,
    modelId: header.modelId,
    cwd: header.cwd,
    gitBranch: header.gitBranch,
    firstPrompt: header.firstPrompt,
    messages: sanitizeMessageTail(messages),
    tokenUsage: lastUsage?.usage ?? EMPTY_USAGE,
    checkpoints,
    filePath,
  }
}

type ToolCallPart = { type?: string; toolCallId?: string }

/** 裁掉尾部那些没有对应 tool_result 的 assistant tool_call。
 *  provider 会把这类孤儿记录视为非法，报出类似
 *  “tool_use without tool_result”，所以当 session 在工具执行中途结束时，
 *  恢复前必须回退到最后一个完整闭合的边界。
 *
 *  算法是：先收集所有已经拥有 tool_result 的 toolCallId，
 *  再从尾部反向遍历消息，删除任何包含“未解决 tool_call id”的
 *  assistant 消息；一旦遇到第一条干净消息（纯文本 assistant，
 *  或所有 tool_call 都已闭合的 assistant）就停止。 */
function sanitizeMessageTail(messages: ModelMessage[]): ModelMessage[] {
  const resolvedIds = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) continue
    for (const part of msg.content as ToolCallPart[]) {
      if (part?.type === 'tool-result' && typeof part.toolCallId === 'string') {
        resolvedIds.add(part.toolCallId)
      }
    }
  }
  let cutAt = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg) {
      cutAt = i
      continue
    }
    if (msg.role !== 'assistant') {
      // 尾部如果是裸露的 'tool' 或 'user'，即便上游没有 tool_call，
      // 也是允许存在的；继续往前检查，裁剪条件只由孤立 tool_call 决定。
      break
    }
    const content = msg.content
    if (typeof content === 'string') break // 纯文本 assistant，说明尾部是干净的
    if (!Array.isArray(content)) break
    const hasOrphan = (content as ToolCallPart[]).some(
      (p) => p?.type === 'tool-call' && typeof p.toolCallId === 'string' && !resolvedIds.has(p.toolCallId),
    )
    if (hasOrphan) {
      cutAt = i
      continue
    }
    break
  }
  return cutAt < messages.length ? messages.slice(0, cutAt) : messages
}

// ── 供选择器列举会话 ───────────────────────────────────────────────

export interface SessionListEntry {
  /** 会话文件绝对路径。 */
  filePath: string
  /** session 唯一标识。 */
  sessionId: string
  /** 任务 slug。 */
  taskSlug: string
  /** 首条用户消息预览。 */
  firstPrompt: string
  /** 会话开始时间。 */
  startedAt: string
  /** 会话使用的模型 id。 */
  modelId: string
  /** 文件修改时间（epoch 毫秒），供选择器排序使用。 */
  mtime: number
  /** 尾部扫描得到的最后一份 token 使用统计。 */
  tokenUsage: TokenUsage | null
}

/** 列出当前项目下的全部 session jsonl，按最新优先排序。
 *  为了保证即便历史会话很多时选择器也足够流畅，这里只读取每个文件的
 *  头部约 8KB（找 header）和尾部约 4KB（找最后一条 usage），
 *  不会把整个文件完整加载进来。没有可解析 header 的文件会被静默忽略。 */
export async function listSessions(cwd: string = process.cwd()): Promise<SessionListEntry[]> {
  const dir = sessionsDir(cwd)
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return []
  }
  const jsonlFiles = entries.filter((f) => f.endsWith('.jsonl'))
  const results = await Promise.all(
    jsonlFiles.map(async (f) => {
      const filePath = path.join(dir, f)
      try {
        const stat = await fs.stat(filePath)
        const head = await readRange(filePath, 0, Math.min(8 * 1024, stat.size))
        const headerLine = head.split('\n').find((l) => l.includes('"kind":"header"'))
        if (!headerLine) return null
        let header: HeaderEntry
        try {
          header = JSON.parse(headerLine) as HeaderEntry
        } catch {
          return null
        }
        const tailStart = Math.max(0, stat.size - 4 * 1024)
        const tail = await readRange(filePath, tailStart, stat.size - tailStart)
        let tokenUsage: TokenUsage | null = null
        const tailLines = tail.split('\n').reverse()
        for (const l of tailLines) {
          if (!l.trim()) continue
          if (l.includes('"kind":"usage"')) {
            try {
              const e = JSON.parse(l) as UsageEntry
              tokenUsage = e.usage
              break
            } catch {
              // 当前行损坏了，就继续往更早的行扫描。
            }
          }
        }
        return {
          filePath,
          sessionId: header.sessionId,
          taskSlug: header.taskSlug,
          firstPrompt: header.firstPrompt,
          startedAt: header.startedAt,
          modelId: header.modelId,
          mtime: stat.mtimeMs,
          tokenUsage,
        } satisfies SessionListEntry
      } catch {
        return null
      }
    }),
  )
  return results.filter((r): r is SessionListEntry => r !== null).sort((a, b) => b.mtime - a.mtime)
}

/** 以 utf-8 读取文件中 [offset, offset+length) 这段字节。
 *  `listSessions` 用它来抓取头尾片段，避免把整个文件读入内存。 */
async function readRange(filePath: string, offset: number, length: number): Promise<string> {
  if (length <= 0) return ''
  const fh = await fs.open(filePath, 'r')
  try {
    const buf = Buffer.alloc(length)
    const { bytesRead } = await fh.read(buf, 0, length, offset)
    return buf.subarray(0, bytesRead).toString('utf-8')
  } finally {
    await fh.close()
  }
}

/** 返回当前项目下最近一次修改的 session 文件；如果不存在则返回 null。
 *  `xc --continue` / `-c` 会用它跳过选择器，直接恢复最新会话。 */
export async function pickLatestSession(cwd: string = process.cwd()): Promise<SessionListEntry | null> {
  const all = await listSessions(cwd)
  return all[0] ?? null
}

/** 为选择器 UI 生成稳定的 session 短标识。
 *  不能直接用文件名，因为多个 session 可能共享 slug 而视觉上撞名；
 *  也不能只用 sessionId，因为重命名后它本身不反映文件唯一路径。
 *  文件路径天然唯一，因此这里对路径做哈希，再截短成紧凑标签。 */
export function shortIdFor(filePath: string): string {
  return createHash('sha1').update(filePath).digest('hex').slice(0, 8)
}

/** 基于已保存的 session 构建一个可继续使用的 LoopState。
 *  agent loop 支持接收 `existingState`，并继续向同一份 jsonl 文件追加，
 *  因为文件名依赖的 `sessionId` 和 `taskSlug` 都会在这里保留下来。
 *  同时把 `persistedMessageCount` 设为已加载消息长度，这样下次用户提交后
 *  的首次 flush 只会追加新消息，不会重复写入已经在磁盘上的尾部内容。 */
export function hydrateLoopState(loaded: LoadedSession, initialMode: PermissionMode = 'default'): LoopState {
  const state = createLoopState(initialMode)
  state.sessionId = loaded.sessionId
  state.taskSlug = loaded.taskSlug
  state.startedAt = loaded.startedAt
  state.messages = loaded.messages.slice()
  state.tokenUsage = { ...loaded.tokenUsage }
  state.lastInputTokens = loaded.tokenUsage.inputTokens
  state.persistedMessageCount = loaded.messages.length
  state.checkpoints = loaded.checkpoints.slice()
  return state
}
