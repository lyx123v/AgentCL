// @x-code-cli/core — 以两个内建工具形式暴露 MCP 资源
//
// MCP 的 “resources” 是服务器暴露出来、模型可能需要主动拉取的数据，
// 例如 filesystem-server 暴露的文件、日志条目、数据库行导出等。
// 我们不会把所有资源自动塞进对话上下文，因为那样既浪费 token，
// 也经常与当前问题无关；因此这里改为提供两个工具：
//
//   - listMcpResources({ server? })  —— 枚举模型可读取的资源 URI
//   - readMcpResource({ uri })       —— 按 URI 读取单个资源
//
// 这两个工具都故意不提供 `execute` 函数，因此会由 agent loop 的
// processToolCalls 分发器统一处理，见 tool-execution.ts 中的
// BYPASS_LOOP_GUARD_HANDLERS。只有在配置了 MCP 注册表时，它们才会进入
// system prompt（是否注入由 buildTools 控制）。
import { tool } from 'ai'

import { z } from 'zod'

export const listMcpResources = tool({
  description: `列出已连接 MCP 服务器暴露的资源。

每行输出一个资源，格式为 "<uri>\t[<server>] <name> (<mimeType>)"；如果资源带有描述，则会在下一行以缩进形式展示。

通常应先调用本工具，再调用 readMcpResource，这样你才能拿到可读取的 URI。如果模型已经知道 URI（例如来自前一次列表结果），也可以直接调用 readMcpResource。`,
  inputSchema: z.object({
    server: z
      .string()
      .optional()
      .describe('可选的服务器名称，用于按服务过滤；省略时会列出所有服务器的资源。'),
  }),
  // 不提供 execute，统一由 tool-execution.ts 里的 BYPASS_LOOP_GUARD_HANDLERS 处理。
})

export const readMcpResource = tool({
  description: `按 URI 读取 MCP 资源内容。

URI 通常来自 listMcpResources。文本资源会直接返回文本内容；二进制资源则返回一行提示，说明内容已省略。`,
  inputSchema: z.object({
    uri: z.string().describe('要读取的资源 URI，通常来自 listMcpResources 的返回结果。'),
  }),
})
