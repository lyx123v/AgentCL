// @x-code-cli/core — 由 LLM 生成的会话摘要（供 agent loop 的深度压缩路径使用）
//
// 这里过去曾经放过：`saveSessionSummary` 与 `loadLatestSession`，
// 它们会把 `<sessionId>.json` 和 `latest.json` 写入 `.x-code/sessions/`。
// 现在它们都已经移除——完整会话记录改为每个会话一个 `.jsonl`
// （见 `agent/session-store.ts`），而压缩摘要则以内嵌的
// `compact-boundary` 元数据行形式保存在同一个 jsonl 里。
// 也就是说，现在是“一次会话一个文件”，不再有额外的旁路兄弟文件。
//
// 这里现在保留下来的只有 `generateSessionSummary`：这是一个独立且很小的
// `generateText` 调用，会在上下文溢出、需要把旧内容压缩成一段摘要时由
// loop 触发。结果会被送进 `markBoundaryAndReflush`（位于 session-store），
// 同时也会包装成一条 `"[Previous conversation summary]"` 用户消息，
// 用来替换 `state.messages` 中被丢弃的那段前缀内容。
import { generateText } from 'ai'
import type { LanguageModel, ModelMessage } from 'ai'

import type { SessionSummary } from '../types/index.js'

/** 生成会话摘要时要纳入的最近消息数量。 */
const SESSION_SUMMARY_MESSAGE_COUNT = 20

/** 使用模型基于消息生成会话摘要。返回完整结构化的 `SessionSummary`（title + status + keyResults + pendingWork + decisions）；调用方通常会把 `summary` 用于上下文替换，而其余字段则用于选择器或展示层。 */
export async function generateSessionSummary(
  messages: ModelMessage[],
  model: LanguageModel,
  sessionId: string,
  startedAt: string,
  filesModified: string[],
  signal?: AbortSignal,
): Promise<SessionSummary> {
  const { text } = await generateText({
    model,
    abortSignal: signal,
    messages: [
      {
        role: 'system',
        content: `请将这段对话总结为一个结构化 JSON 对象，字段如下：
- title: 简短且有描述性的标题（string）
- summary: 2-3 句概述（string）
- keyResults: 已完成的结果（string[]）
- pendingWork: 尚未完成的工作（string[]）
- decisions: 已做出的重要决策（string[]）
- status: "completed" | "in_progress" | "abandoned"

只返回合法 JSON，不要使用 markdown 代码块围栏。`,
      },
      ...messages.slice(-SESSION_SUMMARY_MESSAGE_COUNT),
    ],
  })

  try {
    const parsed = JSON.parse(text) as Partial<SessionSummary>
    return {
      id: sessionId,
      startedAt,
      endedAt: new Date().toISOString(),
      filesModified,
      title: parsed.title ?? '未命名会话',
      summary: parsed.summary ?? '',
      keyResults: parsed.keyResults ?? [],
      pendingWork: parsed.pendingWork ?? [],
      decisions: parsed.decisions ?? [],
      status: parsed.status ?? 'completed',
    }
  } catch {
    return {
      id: sessionId,
      startedAt,
      endedAt: new Date().toISOString(),
      title: '会话',
      summary: text.slice(0, 200),
      keyResults: [],
      pendingWork: [],
      filesModified,
      decisions: [],
      status: 'completed',
    }
  }
}
