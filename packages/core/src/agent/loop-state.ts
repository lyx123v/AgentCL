// @x-code-cli/core — 共享的 agent 循环状态
import type { ModelMessage } from 'ai'

import type { PermissionMode, TodoItem, TokenUsage } from '../types/index.js'
import type { CheckpointEntry } from './snapshot.js'

export interface LoopState {
  /** 当前会话累计的消息列表。 */
  messages: ModelMessage[]
  /** 当前会话累计的 token 用量统计。 */
  tokenUsage: TokenUsage
  /** 最近一次 API 响应返回的真实输入 token 数，用于判断是否触发压缩。 */
  lastInputTokens: number
  /** 当前会话 id。 */
  sessionId: string
  /** 会话启动时间（ISO 字符串）。 */
  startedAt: string
  /** 本会话中被修改过的文件集合。 */
  filesModified: Set<string>
  /** 最近执行过的工具调用滚动记录。
   *  用于 loop guard 检测模型是否在重复同一失败调用。 */
  recentToolCalls: Array<{ toolName: string; hash: string }>
  /** 缓存后的 system prompt 文本。
   *  设计目标是保持跨轮次字节级稳定，以便兼容 OpenAI 风格前缀缓存。 */
  systemPromptCache: string | null
  /** 当前权限模式。
   *  会在默认模式、计划模式和接受编辑模式之间切换。 */
  permissionMode: PermissionMode
  /** 当前计划文件路径。
   *  仅在计划模式下存在，退出计划模式后会被清空。 */
  currentPlanPath: string | null
  /** 从用户首条消息派生出的任务 slug。
   *  用于生成更易读的会话与计划文件名。 */
  taskSlug: string
  /** 当前待办清单。
   *  由 `todoWrite` 全量改写，仅保存在内存中。 */
  todos: TodoItem[]
  /** `/rewind` 命令依赖的检查点列表。
   *  每次用户消息进入 `messages` 后会追加一个快照。 */
  checkpoints: CheckpointEntry[]
  /** 已经持久化到会话 jsonl 文件中的消息数量。 */
  persistedMessageCount: number

  // ── 缓存命中异常检测 ──

  /** 上一轮的 cache-read token 数，用于检测意外 cache miss。 */
  prevTurnCacheRead: number
  /** 标记下一轮 cache miss 是否属于预期行为。 */
  expectCacheMiss: boolean

  // ── Sub-agent 支持字段（在 agentLoop 中设置，由 tool-execution 读取） ──

  /** 缓存后的知识上下文，供 sub-agent 的 system prompt 复用。 */
  knowledgeContext?: string
  /** 当前工作目录是否是 git 仓库。 */
  isGitRepo?: boolean
}

/** 生成更易读的会话 id：`YYYYMMDD-HHMMSS-mmm`。 */
function generateSessionId(now: Date = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
    `-${pad(now.getMilliseconds(), 3)}`
  )
}

/** 创建一份全新的循环状态对象，作为 agent 会话的初始内存。 */
export function createLoopState(initialMode: PermissionMode = 'default'): LoopState {
  return {
    messages: [],
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      currentContextTokens: 0,
    },
    lastInputTokens: 0,
    sessionId: generateSessionId(),
    startedAt: new Date().toISOString(),
    filesModified: new Set(),
    recentToolCalls: [],
    systemPromptCache: null,
    permissionMode: initialMode,
    // 计划文件路径会在真正拿到用户任务文本后再惰性推导，
    // 因为创建 LoopState 时还看不到用户意图。
    currentPlanPath: null,
    taskSlug: '',
    todos: [],
    checkpoints: [],
    persistedMessageCount: 0,
    prevTurnCacheRead: 0,
    expectCacheMiss: false,
  }
}
