// @x-code-cli/core — MCP 对外公共类型
//
// 这里放的是 mcp/ 子系统中跨模块共享的数据结构。
// 它们保持零依赖，这样 loader / registry / UI 等层都能直接引用，
// 不会反向绕回 agent loop 或 CLI，避免形成循环依赖。

/** 基于 stdio 的 MCP 服务（本地子进程）。 */
export interface McpStdioServerConfig {
  command: string // 启动服务的命令
  args?: string[] // 启动命令的参数列表
  env?: Record<string, string> // 传给子进程的环境变量
  cwd?: string // 启动子进程时使用的工作目录
  /** 首次连接超时时间，单位毫秒，默认 30_000。 */
  timeout?: number // 首次连接超时时间
  /** 默认为 true。设为 false 时会完全跳过该服务。 */
  enabled?: boolean // 是否启用该服务
}

/** 可流式通信的 HTTP MCP 服务（远程服务）。 */
export interface McpHttpServerConfig {
  url: string // MCP HTTP 服务地址
  /** 附加到每个请求上的静态请求头（例如 `X-Custom: foo`）。
   *  OAuth 的 `Authorization: Bearer ...` 会自动注入，
   *  不要把访问令牌直接写在这里，应通过 OAuth 流程存储。 */
  headers?: Record<string, string> // 固定请求头
  timeout?: number // 请求超时时间
  enabled?: boolean // 是否启用该服务
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig

/** 运行时类型守卫：区分 stdio 服务与 HTTP 服务。 */
export function isStdioConfig(c: McpServerConfig): c is McpStdioServerConfig {
  return 'command' in c
}
export function isHttpConfig(c: McpServerConfig): c is McpHttpServerConfig {
  return 'url' in c
}

/** 单个服务在运行时的状态，UI 会通过 `/mcp list` 读取它。 */
export type McpServerStatus =
  | { kind: 'disabled' }
  | { kind: 'connecting' }
  | { kind: 'connected'; toolCount: number; resourceCount: number }
  | { kind: 'needs_auth'; authUrl?: string }
  | { kind: 'failed'; error: string }

/** 一个完成名称改写后的 MCP 工具。
 *
 *  callableName 是面向模型的名字（`<server>__<tool>`）；
 *  rawName 是回传给 client.callTool 的原始名字，MCP 服务本身并不知道我们的前缀规则。 */
export interface McpToolEntry {
  callableName: string // 面向模型暴露的工具名
  rawName: string // MCP 服务原始工具名
  serverName: string // 该工具所属的服务名
  description: string // 工具描述
  /** 服务端返回的原始 JSON Schema。
   *  我们会通过 `jsonSchema(...)` 直接传给 AI SDK，不做 zod 转换。 */
  inputSchema: Record<string, unknown> // 工具输入参数的 JSON Schema
}

/** 一个 MCP 资源条目，即服务器允许我们主动拉取的数据。 */
export interface McpResourceEntry {
  uri: string // 资源 URI
  name: string // 资源名称
  description?: string // 资源描述
  mimeType?: string // 资源 MIME 类型
  serverName: string // 提供该资源的服务名
}

/** 调用 MCP 工具后的结果。
 *  这里会把 MCP 的内容块结果拍平成更适合塞进 `tool_result` 消息的形式；
 *  原始块数据则保留在旁路，供未来 UI 处理图片、音频等场景。 */
export interface McpCallResult {
  /** 适合直接写进 tool_result 的文本表示。 */
  text: string // 文本结果
  /** 当且仅当服务端把本次调用标记为错误（MCP `isError`）时为 true。 */
  isError: boolean // 是否为错误结果
}
