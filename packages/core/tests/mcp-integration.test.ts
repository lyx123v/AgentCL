// MCP 整体链路的集成测试。
// 这里会把 McpClient 连接到一个真实子进程，该子进程实现了最小可用的 stdio MCP 服务器，
// 然后端到端覆盖 connect → listTools → callTool → readResource → close。
//
// 为什么用自定义 mock，而不是 `@modelcontextprotocol/server-filesystem`：
//   - 官方服务器首次运行会通过 npx 安装数百 KB 依赖，在 CI 冷缓存下容易不稳定
//   - 我们希望断言使用完全可预测的 tool/resource 结构
//   - 整个 mock 只有约 100 行，且与测试文件放在一起，便于维护
import { describe, expect, it } from 'vitest'

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { McpClient } from '../src/mcp/client.js'
import { loadMcpServers } from '../src/mcp/loader.js'
import { buildCallableName } from '../src/mcp/name-mangling.js'
import { McpRegistry } from '../src/mcp/registry.js'
import type { McpServerConfig } from '../src/mcp/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MOCK_SERVER = path.join(__dirname, 'fixtures', 'mock-mcp-server.mjs')

describe('MCP integration (stdio)', () => {
  it('可以完成 connect → list tools → call tool → close', async () => {
    const client = new McpClient('mock', {
      command: process.execPath,
      args: [MOCK_SERVER],
    })
    try {
      const info = await client.connect()
      expect(info.toolCount).toBe(2)
      const tools = client.tools()
      expect(tools.map((t) => t.name).sort()).toEqual(['add', 'echo'])

      const echoed = await client.callTool('echo', { text: 'hello' })
      expect(echoed.isError).toBe(false)
      expect(echoed.text).toBe('hello')

      const summed = await client.callTool('add', { a: 2, b: 3 })
      expect(summed.text).toBe('5')
    } finally {
      await client.close()
    }
  }, 15_000)

  it('可以端到端读取资源', async () => {
    const client = new McpClient('mock', { command: process.execPath, args: [MOCK_SERVER] })
    try {
      await client.connect()
      const resources = client.resources()
      expect(resources).toHaveLength(1)
      expect(resources[0].uri).toBe('mock://hello')

      const content = await client.readResource('mock://hello')
      expect(content.text).toBe('hello world')
      expect(content.mimeType).toBe('text/plain')
    } finally {
      await client.close()
    }
  }, 15_000)

  it('会通过 isError 暴露服务器上报的错误', async () => {
    const client = new McpClient('mock', { command: process.execPath, args: [MOCK_SERVER] })
    try {
      await client.connect()
      const r = await client.callTool('boom', {})
      expect(r.isError).toBe(true)
    } finally {
      await client.close()
    }
  }, 15_000)

  it('restartServer 会在原地重连 stdio 服务器', async () => {
    // 通过 loader 启动一个真实 registry，这样配置加载和 oauthFactory 的接线
    // 都能被端到端覆盖。loader 会启动 mock server，枚举出 `echo` 和 `add`，
    // 然后返回 registry；其中 configs map 会记住启动配置，restartServer()
    // 正是从这里读取配置重新拉起服务器。
    const { registry } = await loadMcpServers({
      userServers: {
        mock: { command: process.execPath, args: [MOCK_SERVER] },
      },
      projectServers: undefined,
      projectPath: process.cwd(),
      askUser: async () => 'skip',
    })
    try {
      const before = registry
        .list()
        .map((t) => t.callableName)
        .sort()
      expect(before).toContain('mock__echo')

      const restarted = await registry.restartServer('mock')
      expect(restarted.status.kind).toBe('connected')

      // 对同一台服务器重连后，工具列表应保持一致。
      // 这里验证的是 registry 是否被干净重建，而不是服务器表面是否发生变化。
      const after = registry
        .list()
        .map((t) => t.callableName)
        .sort()
      expect(after).toEqual(before)

      // 验证新的 client（而不是已经关闭的旧 client）能够正常处理调用。
      const r = await registry.callTool('mock__echo', { text: 'after-restart' })
      expect(r.text).toBe('after-restart')
    } finally {
      await registry.shutdown()
    }
  }, 20_000)

  it('restartAll 会正确区分新增、删除和变更的服务器', async () => {
    // 先用一台服务器启动，再用不同配置集合执行 restartAll：
    //   - `mock` 保持不变（配置相同）           → unchanged
    //   - `mock-b` 是新增项                    → added
    //   - `mock-old` 本来可能存在但未启动      → 不适用
    // 然后第二次 restartAll 再移除 `mock-b`，覆盖 removed 路径。
    const { registry } = await loadMcpServers({
      userServers: {
        mock: { command: process.execPath, args: [MOCK_SERVER] },
      },
      projectServers: undefined,
      projectPath: process.cwd(),
      askUser: async () => 'skip',
    })
    try {
      // 使用“`mock` 不变 + 新增 `mock-b`”的配置执行 restartAll。
      const configs1 = new Map<string, McpServerConfig>([
        ['mock', { command: process.execPath, args: [MOCK_SERVER] }],
        ['mock-b', { command: process.execPath, args: [MOCK_SERVER] }],
      ])
      const summary1 = await registry.restartAll(configs1)
      expect(summary1.added).toEqual(['mock-b'])
      expect(summary1.removed).toEqual([])
      expect(summary1.unchanged).toEqual(['mock'])

      // 此时两台服务器都已连接，工具列表应覆盖两者。
      const names = registry
        .list()
        .map((t) => t.callableName)
        .sort()
      expect(names).toContain('mock__echo')
      expect(names).toContain('mock_b__echo')

      // 第二次 restartAll：移除 mock-b，并轻微调整 mock 的参数。
      const configs2 = new Map<string, McpServerConfig>([
        ['mock', { command: process.execPath, args: [MOCK_SERVER], timeout: 15_000 }],
      ])
      const summary2 = await registry.restartAll(configs2)
      expect(summary2.added).toEqual([])
      expect(summary2.removed).toEqual(['mock-b'])
      expect(summary2.changed).toEqual(['mock'])

      // mock-b 不应再出现在工具列表中。
      const afterRemoval = registry
        .list()
        .map((t) => t.callableName)
        .sort()
      expect(afterRemoval).not.toContain('mock_b__echo')
      expect(afterRemoval).toContain('mock__echo')
    } finally {
      await registry.shutdown()
    }
  }, 30_000)

  it('authenticateServer 会拒绝 stdio 服务器', async () => {
    const { registry } = await loadMcpServers({
      userServers: {
        mock: { command: process.execPath, args: [MOCK_SERVER] },
      },
      projectServers: undefined,
      projectPath: process.cwd(),
      askUser: async () => 'skip',
    })
    try {
      await expect(registry.authenticateServer('mock')).rejects.toThrow(/stdio/i)
    } finally {
      await registry.shutdown()
    }
  }, 15_000)

  it('registry 会按 callable name 分发调用', async () => {
    const client = new McpClient('mock', { command: process.execPath, args: [MOCK_SERVER] })
    try {
      await client.connect()
      const taken = new Set<string>()
      const tools = client.tools().map((t) => ({
        callableName: buildCallableName('mock', t.name, taken),
        rawName: t.name,
        serverName: 'mock',
        description: t.description ?? '',
        inputSchema: t.inputSchema,
      }))
      for (const t of tools) taken.add(t.callableName)

      const registry = new McpRegistry({
        servers: [{ name: 'mock', client, status: { kind: 'connected', toolCount: 2, resourceCount: 1 } }],
        tools,
        resources: [],
      })

      // 验证调用分发确实经过 registry 的 callTool 包装层。
      const callable = tools.find((t) => t.rawName === 'echo')!.callableName
      const result = await registry.callTool(callable, { text: 'via registry' })
      expect(result.text).toBe('via registry')
    } finally {
      await client.close()
    }
  }, 15_000)
})
