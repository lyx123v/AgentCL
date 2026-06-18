// @x-code-cli/core — 本地 OAuth 回调接收器
//
// 在 127.0.0.1:<随机端口>/callback 上临时起一个 HTTP 服务，
// 等待授权服务器回跳，把拿到的 `code` + `state`（或错误）返回出来。
// 在首次请求完成后，或超时后，会自动关闭。
//
// 为什么使用随机临时端口：
//   - 固定端口会在两个 CLI 同时运行时产生冲突
//   - 随机端口意味着必须在监听成功后，才能把真实回调地址告诉 OAuth provider
//
// 安全性：
//   - 只绑定 127.0.0.1，不绑定 0.0.0.0，避免被局域网其他机器访问
//   - 只接受第一个匹配请求；后续命中会看到“授权已完成”的友好页面
//   - 这里不校验 `state`，那是 SDK 的职责；本模块只负责原样转发回调参数
import http from 'node:http'
import { AddressInfo } from 'node:net'

import { debugLog } from '../../utils.js'

export interface CallbackResult {
  /** OAuth 回调返回的授权码 */
  code: string
  /** OAuth 回调中携带的 state，可能为空 */
  state?: string
}

export interface RunningCallbackServer {
  /** 要告知授权服务器的完整 redirect URL */
  url: string
  /** 等待首次有效回调，并返回 code/state；超时或 OAuth 错误时会 reject */
  waitForCallback: () => Promise<CallbackResult>
  /** 停止接受新连接并释放端口，可重复调用 */
  close: () => void
}

export interface StartOptions {
  /** 最长等待时间（毫秒），默认 5 分钟 */
  timeoutMs?: number
  /** 授权服务器回跳的路径，默认 `/callback` */
  path?: string
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_PATH = '/callback'

/** 启动本地回调监听器。
 *  启动完成后立即把控制权还给调用方，真正等待回调则通过
 *  返回对象里的 `waitForCallback()` 完成。 */
export async function startCallbackServer(options: StartOptions = {}): Promise<RunningCallbackServer> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const expectedPath = options.path ?? DEFAULT_PATH

  let resolveOnce: ((r: CallbackResult) => void) | null = null
  let rejectOnce: ((e: Error) => void) | null = null

  const waiter = new Promise<CallbackResult>((res, rej) => {
    resolveOnce = res
    rejectOnce = rej
  })

  const server = http.createServer((req, response) => {
    if (!req.url) {
      response.writeHead(400).end('缺少 URL')
      return
    }
    // 这里用一个虚拟 base 做解析，我们只关心 pathname 和 query 参数。
    const u = new URL(req.url, 'http://localhost')
    if (u.pathname !== expectedPath) {
      response.writeHead(404).end('未找到')
      return
    }

    const err = u.searchParams.get('error')
    if (err) {
      const desc = u.searchParams.get('error_description') ?? ''
      response
        .writeHead(400, { 'Content-Type': 'text/html' })
        .end(`<html><body><h1>授权失败</h1><p>${escapeHtml(err)}: ${escapeHtml(desc)}</p></body></html>`)
      rejectOnce?.(new Error(`OAuth 回调错误：${err} ${desc}`.trim()))
      resolveOnce = null
      rejectOnce = null
      return
    }

    const code = u.searchParams.get('code')
    if (!code) {
      response.writeHead(400).end('缺少 code')
      rejectOnce?.(new Error('OAuth 回调缺少 `code` 参数'))
      resolveOnce = null
      rejectOnce = null
      return
    }

    const state = u.searchParams.get('state') ?? undefined
    response
      .writeHead(200, { 'Content-Type': 'text/html' })
      .end(
        `<html><body style="font-family:system-ui;padding:2rem;max-width:40rem;margin:auto;">` +
          `<h1>授权完成</h1>` +
          `<p>你现在可以关闭此标签页，并返回 X-Code CLI。</p>` +
          `</body></html>`,
      )
    resolveOnce?.({ code, state })
    resolveOnce = null
    rejectOnce = null
  })

  // 监听 socket 级错误，避免在 Windows 上常见的 ECONNRESET 直接让 CLI 崩掉。
  server.on('error', (err) => {
    debugLog('mcp.callback-server-error', String(err))
    rejectOnce?.(err)
    resolveOnce = null
    rejectOnce = null
  })

  // 绑定到随机空闲端口，再从 address() 里读出真实端口号。
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const addr = server.address() as AddressInfo
  const url = `http://127.0.0.1:${addr.port}${expectedPath}`

  const timeoutHandle = setTimeout(() => {
    rejectOnce?.(new Error(`OAuth 回调等待超时：${timeoutMs}ms`))
    resolveOnce = null
    rejectOnce = null
  }, timeoutMs)
  void waiter.finally(() => clearTimeout(timeoutHandle))

  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    server.close()
  }
  void waiter.finally(close)

  return { url, waitForCallback: () => waiter, close }
}

/** 对 HTML 特殊字符做转义，避免把回调参数原样插进页面时破坏结构。 */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  )
}
