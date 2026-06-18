// @x-code-cli/core — 循环调用熔断器
//
// 这里用于检测模型是否在反复用完全相同的参数调用同一个工具。
// 常见场景是上一次调用失败后，模型没换思路，原样重试多次，持续往上下文里
// 塞入重复报错。
//
// 分两级：
//   第 1 级（软阻断，默认阈值 3）：注入一条合成 tool-result，提示模型
//   “这次相同调用已经失败 3 次，请换个思路”。
//   第 2 级（硬阻断，默认阈值 5）：直接终止当前轮次并提示用户。
//
// 检测方式是对 `{toolName, stableInputJson}` 做 SHA256。stable stringify
// 会先对对象键排序，因此 `{a:1,b:2}` 和 `{b:2,a:1}` 会得到同一个哈希。
//
// 这里不使用“必须连续 3 次完全相同”的判断，因为模型可能会在两次相同调用之间
// 插入一次 readFile 等无关操作。我们只看最近 N 次同名工具调用里，有多少条
// 共享同一个哈希。
import crypto from 'node:crypto'

import type { LoopState } from './loop-state.js'
import { toolResultMessage } from './messages.js'

/** 在滚动窗口内达到该次数后，触发软阻断提示。 */
export const SOFT_LOOP_THRESHOLD = 3

/** 在滚动窗口内达到该次数后，直接硬阻断当前轮次。 */
export const HARD_LOOP_THRESHOLD = 5

/** 用于扫描重复调用的滚动窗口大小。 */
export const LOOP_WINDOW_SIZE = 8

/** 稳定版 JSON stringify。
 *  通过固定对象键顺序，保证语义相同的输入即使键顺序不同也会得到同一字符串。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + stableStringify(v)).join(',') + '}'
}

/** 为工具调用生成用于去重检测的哈希值。
 *  截断为 16 位十六进制已经足够覆盖当前窗口规模。 */
export function hashToolCall(toolName: string, input: unknown): string {
  const payload = toolName + '\x00' + stableStringify(input)
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16)
}

/** 循环检测结果的公共基类，携带预先算好的调用哈希。 */
interface LoopCheckBase {
  /** 当前工具调用的稳定哈希。 */
  hash: string
}

export type LoopCheck =
  /** 未检测到循环，可正常执行工具。 */
  | (LoopCheckBase & { kind: 'ok' })
  /** 达到软阻断阈值。
   *  本轮不再真正执行工具，而是插入一条合成 tool-result 提示模型换思路。 */
  | (LoopCheckBase & { kind: 'soft-block'; toolCallId: string; message: string })
  /** 达到硬阻断阈值，直接终止当前轮次。 */
  | (LoopCheckBase & { kind: 'hard-block'; toolName: string; message: string })

/**
 * 检查当前工具调用是否和最近窗口中的历史调用重复，并告知调用方下一步该怎么做。
 * 该函数本身不会修改 state；真正执行后应由 `recordToolCall` 记录结果。
 */
export function checkForLoop(state: LoopState, toolName: string, input: unknown, toolCallId: string): LoopCheck {
  const hash = hashToolCall(toolName, input)
  const window = state.recentToolCalls.slice(-LOOP_WINDOW_SIZE)

  let priorMatches = 0
  for (const entry of window) {
    if (entry.toolName === toolName && entry.hash === hash) priorMatches++
  }

  // 当前这次调用本身会把计数推高，所以这里比较的是历史命中数 + 1。

  if (priorMatches + 1 >= HARD_LOOP_THRESHOLD) {
    return {
      kind: 'hard-block',
      hash,
      toolName,
      message: `工具 ${toolName} 已用完全相同的参数重复调用 ${priorMatches + 1} 次，模型正在循环，本轮将被中止。`,
    }
  }

  if (priorMatches + 1 >= SOFT_LOOP_THRESHOLD) {
    return {
      kind: 'soft-block',
      hash,
      toolCallId,
      message:
        `当前会话中，这个完全相同的 ${toolName} 调用（参数一致）已经尝试了 ${priorMatches + 1} 次，且结果没有变化。` +
        '请不要继续原样重试。请改用新的思路，例如实质性修改参数、换一个工具，或直接询问用户下一步该怎么做。',
    }
  }

  return { kind: 'ok', hash }
}

/** 把一次工具调用记录到滚动窗口中。
 *  会限制数组长度，避免长会话里无限增长。 */
export function recordToolCall(state: LoopState, toolName: string, input: unknown, hash?: string): void {
  const h = hash ?? hashToolCall(toolName, input)
  state.recentToolCalls.push({ toolName, hash: h })
  // 保留 2 倍窗口大小，既能给检测逻辑留出更多历史，又不会让持久化体积失控。
  const cap = LOOP_WINDOW_SIZE * 2
  if (state.recentToolCalls.length > cap) {
    state.recentToolCalls.splice(0, state.recentToolCalls.length - cap)
  }
}

/** 构造一条合成 tool-result，告诉模型本次调用被 loop guard 拦截了。
 *  模型会把它当作工具返回结果来理解，并通常在下一轮调整策略。 */
export function syntheticLoopBlockResult(toolName: string, toolCallId: string, message: string) {
  return toolResultMessage(toolCallId, toolName, `[loop-guard] ${message}`)
}
