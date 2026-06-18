#!/usr/bin/env node
// 供集成测试使用的最小化 stdio MCP 服务端。
// 它只实现了最基础的协议能力，让 McpClient 能完成握手、枚举工具，
// 并往返执行一次 callTool / readResource。
//
// 线协议格式：stdin/stdout 上按“每行一条”的方式传输 JSON-RPC 2.0，不支持批量请求。

let buf = ''

process.stdin.setEncoding('utf-8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    try {
      handle(JSON.parse(line))
    } catch (err) {
      process.stderr.write(`mock-server parse error: ${err}\n`)
    }
  }
})

// 向 stdout 发送一条 JSON-RPC 消息。
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

// 发送成功响应。
function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

// 发送错误响应。
function error(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

// 根据 method 分发收到的请求。
function handle(msg) {
  const { method, id, params } = msg

  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'mock-mcp-server', version: '1.0.0' },
      })
      return

    case 'notifications/initialized':
    case 'notifications/cancelled':
      // 通知消息没有 id，因此不需要响应。
      return

    case 'tools/list':
      reply(id, {
        tools: [
          {
            name: 'echo',
            description: 'Echo input text back to the caller',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
          {
            name: 'add',
            description: 'Add two numbers',
            inputSchema: {
              type: 'object',
              properties: { a: { type: 'number' }, b: { type: 'number' } },
              required: ['a', 'b'],
            },
          },
        ],
      })
      return

    case 'tools/call': {
      const { name, arguments: args } = params ?? {}
      if (name === 'echo') {
        reply(id, { content: [{ type: 'text', text: String(args?.text ?? '') }] })
      } else if (name === 'add') {
        const sum = Number(args?.a ?? 0) + Number(args?.b ?? 0)
        reply(id, { content: [{ type: 'text', text: String(sum) }] })
      } else if (name === 'boom') {
        reply(id, { content: [{ type: 'text', text: 'simulated error' }], isError: true })
      } else {
        error(id, -32601, `Unknown tool: ${name}`)
      }
      return
    }

    case 'resources/list':
      reply(id, {
        resources: [{ uri: 'mock://hello', name: 'hello.txt', description: 'a greeting', mimeType: 'text/plain' }],
      })
      return

    case 'resources/read': {
      const uri = params?.uri
      if (uri === 'mock://hello') {
        reply(id, { contents: [{ uri, mimeType: 'text/plain', text: 'hello world' }] })
      } else {
        error(id, -32602, `Unknown resource: ${uri}`)
      }
      return
    }

    case 'ping':
      reply(id, {})
      return

    default:
      // SDK 会探测一些可选方法（如 logging/setLevel、resources/subscribe 等）。
      // 这里返回 method-not-found，让 SDK 能优雅降级，而不是因为等不到响应而挂住。
      if (typeof id !== 'undefined') {
        error(id, -32601, `Method not found: ${method}`)
      }
  }
}
