// @x-code-cli/core — MCP 工具与 AI SDK 之间的适配层
//
// 这里主要负责两件事：
//   1. 把每个 McpToolEntry 转成 AI SDK 的 `tool({...})` 定义，
//      这样 streamText() 就能像内建工具一样把它们暴露给模型。
//   2. 裁剪服务端给出的超长描述，避免把 system prompt / 工具列表撑得过大。
//
// 这些工具会故意定义成“不带 `execute` 函数”。
// 这样 AI SDK 会把模型发起的 tool_call 放进 `result.toolCalls`，
// 再由我们自己的 `processToolCalls` 分发器手动处理，路径与
// shell / writeFile / edit 一致。这样每一次 MCP 调用都能经过
// 权限控制与 loop-guard 机制。
import { jsonSchema, tool } from 'ai'

import type { McpToolEntry } from './types.js'

/** 模型可见的单个工具描述长度上限。
 *  - 200 个字符已经足够表达“这个工具是做什么的”；
 *  - 现实中有些 MCP 服务会把多段文档直接塞进 description，
 *    如果不限制，会让 system prompt 过大并挤占 prompt cache 窗口；
 *  - 截断按字符数计算，并附带省略标记，让模型知道文本被裁剪过，
 *    同时也能提醒服务作者在 `/mcp tools` 中看到自己的描述被截断了。 */
const DESCRIPTION_MAX_CHARS = 200

/** 将工具描述裁剪到模型可接受的长度上限内。 */
export function truncateDescription(input: string): string {
  if (input.length <= DESCRIPTION_MAX_CHARS) return input
  // 给省略标记预留一个字符，确保最终长度仍然不超过上限。
  return input.slice(0, DESCRIPTION_MAX_CHARS - 1) + '…'
}

/** 将单个 MCP 工具适配成 AI SDK Tool。
 *  这里不提供 execute，实际调用由 tool-execution 手动分发。
 *  schema 会以原始 JSON Schema 形式直传，因为 SDK 已经通过
 *  `jsonSchema(...)` 提供了一等支持，不需要额外转成 zod。 */
export function bridgeMcpTool(entry: McpToolEntry) {
  return tool({
    description: truncateDescription(entry.description || `来自 ${entry.serverName} 的 MCP 工具`),
    // SDK 的 jsonSchema() 助手会把 JSON Schema 对象包装成与 `tool()`
    // 兼容的 Schema 实例。按规范 MCP 服务返回的就是合法 JSON Schema，
    // 因此这里无需预处理。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inputSchema: jsonSchema(entry.inputSchema as any),
    // 不提供 execute，转由 tool-execution.ts 手动分发，
    // 让调用统一经过权限与 loop-guard 控制。
  })
}

/** 构造适合写入 system prompt 的 MCP 工具视图。
 *  只保留简短描述与模型可见名称，供 `system-prompt.ts` 渲染
 *  `## MCP Tools` 区块。 */
export function toSystemPromptEntries(entries: readonly McpToolEntry[]) {
  return entries.map((e) => ({
    callableName: e.callableName,
    serverName: e.serverName,
    description: truncateDescription(e.description),
  }))
}
