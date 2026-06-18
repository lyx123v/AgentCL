import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import os from 'node:os'
import path from 'node:path'

import { McpOAuthProvider } from '../src/mcp/oauth/provider.js'
import { McpTokenStorage } from '../src/mcp/oauth/token-storage.js'

/** 将测试环境与开发者真实的 ~/.x-code/mcp-auth.json 隔离开。 */
function isolate(): string {
  const dir = path.join(os.tmpdir(), 'mcp-oauth-test-' + Math.random().toString(36).slice(2))
  process.env.X_CODE_HOME = dir
  return dir
}

// 创建一个最小可用的 OAuth provider，供测试复用。
function makeProvider(): McpOAuthProvider {
  return new McpOAuthProvider({
    serverName: 'test-server',
    serverUrl: 'https://example.com/mcp',
    storage: new McpTokenStorage(),
  })
}

describe('McpOAuthProvider.redirectUrl', () => {
  beforeEach(() => {
    isolate()
  })
  afterEach(() => {
    delete process.env.X_CODE_HOME
  })

  it('未启动回调服务器时会返回回环地址占位符', () => {
    // 回归测试：旧版本这里会抛错，导致 HTTP MCP 服务器在首次启动时
    // 被标记为 `failed`，而不是 `needs_auth`。
    // 原因是 SDK 在构造 authorize URL 时，会先读取 redirectUrl，
    // 这一刻 redirectToAuthorization 还没触发，也就还没启动回调服务器。
    const provider = makeProvider()
    const url = provider.redirectUrl
    expect(typeof url).toBe('string')
    // 必须是回环地址。根据 RFC 8252，认证服务器应接受该主机上的任意端口，
    // 因此这里没有具体端口号也是合理的。
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1/)
  })

  it('会保持 clientMetadata.redirect_uris 与 redirectUrl 一致', () => {
    // 两个 getter 使用的占位地址必须一致。
    // 否则动态注册请求里是一套 URL，而 SDK 构造 authorize URL 时又是另一套，
    // 最终认证服务器会返回 redirect_uri_mismatch。
    const provider = makeProvider()
    expect(provider.clientMetadata.redirect_uris).toContain(provider.redirectUrl)
  })
})

describe('McpOAuthProvider.redirectToAuthorization (passive vs interactive)', () => {
  beforeEach(() => {
    isolate()
  })
  afterEach(() => {
    delete process.env.X_CODE_HOME
  })

  it('默认不会打开浏览器（被动模式）', async () => {
    // 回归测试：旧版本这里会无条件打开浏览器，
    // 只要某个 HTTP MCP 服务器没有已存储 token，CLI 启动时就会触发。
    // 主流 CLI 都不会这样做，而是等待用户明确发起操作。
    // 这里通过“回调服务器未启动且 onOpenBrowser 未触发”来验证。
    let opened: string | null = null
    const provider = new McpOAuthProvider({
      serverName: 'test-server',
      serverUrl: 'https://example.com/mcp',
      storage: new McpTokenStorage(),
      onOpenBrowser: (url) => {
        opened = url
      },
    })

    const before = provider.redirectUrl
    await provider.redirectToAuthorization(new URL('https://auth.example.com/authorize'))
    const after = provider.redirectUrl

    expect(opened).toBeNull()
    // 前后都是同一个占位地址，说明回调服务器从未启动，
    // URL 也就不会变成带真实端口的地址。
    expect(after).toBe(before)
  })

  // 这里刻意不测试 interactive（setInteractive(true)）路径。
  // 该路径会走 openInBrowser → child_process.spawn，
  // 每次执行 `pnpm test` 都真的拉起开发者浏览器，影响太大。
  // 交互式流程由手动 /mcp 鉴权测试和现有 connectWithOAuth 接线来覆盖。
})
