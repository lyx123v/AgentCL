import path from 'node:path'

import type { Scenario } from '../framework/types.js'

// 一个最小可用的 stdio MCP 服务端，直接以内联源码的方式放进场景里，
// 这样测试可以完全自包含，不需要跨包引用额外文件。
// 它只实现 McpClient.connect → listTools → callTool 这条链路真正需要的少量方法；
// 其他方法统一返回 method-not-found，让 SDK 走自己的降级逻辑。
// `greet` 工具会把一个不透明标记打进返回值里，便于我们从 assistant 文本中断言
// 这次调用真的完成了往返，而不是模型自己脑补一句“Hello, World!”。
const MOCK_SERVER_SRC = String.raw`#!/usr/bin/env node
let buf = ''
process.stdin.setEncoding('utf-8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (line.trim()) try { handle(JSON.parse(line)) } catch (e) { process.stderr.write(String(e) + '\n') }
  }
})
// 向 stdout 回写一条 JSON-RPC 消息。
function send(m) { process.stdout.write(JSON.stringify(m) + '\n') }
// 根据客户端请求分发不同的 MCP 方法。
function handle(msg) {
  const { method, id, params } = msg
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock-e2e', version: '1.0.0' } } })
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [
      { name: 'greet', description: '按名字向某人打招呼，并返回一句友好的问候。', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } }
    ] } })
  } else if (method === 'tools/call') {
    const name = params && params.name
    const args = (params && params.arguments) || {}
    if (name === 'greet') {
      const who = typeof args.name === 'string' ? args.name : 'stranger'
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '你好，' + who + '！ [MCP_MARKER_AB12CD34]' }] } })
    } else if (typeof id !== 'undefined') {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: '未知工具：' + name } })
    }
  } else if (method === 'resources/list') {
    send({ jsonrpc: '2.0', id, result: { resources: [] } })
  } else if (typeof id !== 'undefined') {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: '未找到方法：' + method } })
  }
}
`

const scenario: Scenario = {
  id: '24-mcp-stdio',
  name: 'MCP stdio：模型调用 mock__greet 并引用服务端盖章标记',
  // 执行 MCP stdio 场景：挂载一个内联 mock 服务，并验证模型能真实调用其工具。
  async run(ctx) {
    // 1. 把内联 mock MCP 服务写进 tmpDir，同时生成指向它的用户配置。
    //    harness 已经把 X_CODE_HOME 隔离到 <tmpDir>/.x-code-home，
    //    因此同一个场景可以并行运行，而不会污染真实的 ~/.x-code。
    await ctx.writeFile('mock-server.mjs', MOCK_SERVER_SRC)
    const serverPath = path.join(ctx.tmpDir, 'mock-server.mjs')

    await ctx.mkdir('.x-code-home')
    await ctx.writeFile(
      '.x-code-home/config.json',
      JSON.stringify(
        {
          // X_CODE_MODEL 由 harness 负责注入，所以这里不用显式写 `model`。
          mcpServers: {
            mock: {
              command: process.execPath,
              args: [serverPath],
            },
          },
        },
        null,
        2,
      ),
    )

    // 2. 运行 CLI。--trust 会短路逐工具的询问流程，这样模型调用 mock__greet 时，
    //    就不会因为 onAskPermission 在 print 模式下卡住（print 模式没有 UI 可供确认）。
    const r = await ctx.runCli(
      [
        '当前已经连接了一个名为 "mock" 的 MCP 服务。它暴露了一个工具',
        'mock__greet，参数是 { name: string }，返回值是一段问候文本。',
        '请用 name="World" 调用它，然后在你的回复里逐字引用工具返回的',
        '完整文本。',
      ].join(' '),
      { args: ['--trust', '--max-turns', '5'] },
    )

    ctx.expect.exitCode(r, 0)
    ctx.expect.toolCalled(r, 'mock__greet', { name: 'World' })
    // 这个标记是服务端主动盖上去的随机感 token；没有真的等到工具结果的模型很难复现它。
    ctx.expect.assistantMentions(r, /MCP_MARKER_AB12CD34/)
    ctx.expect.noToolErrors(r)
  },
}

export default scenario
