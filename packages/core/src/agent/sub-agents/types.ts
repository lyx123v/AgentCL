// @x-code-cli/core — 子代理类型定义
import type { TokenUsage } from '../../types/index.js'

export interface SubAgentDefinition {
  name: string // 子代理名称
  description: string // 子代理描述
  /** Markdown 正文会作为子代理的 system prompt */
  prompt: string // 子代理提示词正文
  /** 允许使用的工具；省略时使用默认只读工具集 */
  tools?: string[] // 工具白名单
  /** 明确禁止的工具，会在 `tools` 过滤之后继续生效 */
  disallowedTools?: string[] // 工具黑名单
  /** 模型覆盖配置（例如 "anthropic:claude-sonnet-4-6"）；省略时继承父代理 */
  model?: string // 子代理专用模型
  /** 触发强制停止前允许的最大 agentic 轮数 */
  maxTurns: number // 最大轮数
  /** 需要拒绝的 shell 命令关键字；仅在 tools 包含 shell 时生效 */
  shellRestrictions?: string[] // Shell 限制关键字
  /** 该定义的来源 */
  source: 'built-in' | 'user' | 'project' // 子代理来源
  /** 当该子代理来自插件贡献时，记录所属插件的 id（`name@marketplace`） */
  pluginId?: string // 插件 id
}

export interface SubAgentTrace {
  /** 子代理执行过程中产生的工具调用轨迹 */
  toolCalls: Array<{
    toolName: string // 工具名称
    input: unknown // 工具输入参数
    result: string // 工具返回结果文本
    durationMs: number // 本次调用耗时（毫秒）
    isError: boolean // 是否为错误结果
  }> // 工具调用明细
  finalText: string // 子代理最终返回的文本
  tokenUsage: TokenUsage // Token 使用统计
  turnCount: number // 实际执行轮数
}

export type SubAgentEvent =
  | { kind: 'start'; toolCallId: string; agentName: string; description: string; prompt: string }
  | { kind: 'tool-call'; toolCallId: string; subToolName: string; subInput: unknown }
  | {
      kind: 'tool-result'
      toolCallId: string
      subToolName: string
      resultPreview: string
      durationMs: number
      isError: boolean
    }
  | { kind: 'text-delta'; toolCallId: string; delta: string }
  | {
      kind: 'end'
      toolCallId: string
      finalText: string
      tokenUsage: TokenUsage
      turnCount: number
      durationMs: number
      aborted: boolean
    }
