import { describe, expect, it } from 'vitest'

import { validateFetchUrl } from '../src/tools/web-fetch.js'

describe('validateFetchUrl：SSRF 防护', () => {
  it('允许普通公网 URL', () => {
    expect(validateFetchUrl('https://example.com')).toBeNull()
    expect(validateFetchUrl('https://docs.github.com/en/rest')).toBeNull()
    expect(validateFetchUrl('http://www.example.org/path?q=1')).toBeNull()
  })

  it('拒绝非 HTTP 协议', () => {
    expect(validateFetchUrl('file:///etc/passwd')).toContain('Unsupported protocol')
    expect(validateFetchUrl('ftp://files.example.com')).toContain('Unsupported protocol')
    expect(validateFetchUrl('javascript:alert(1)')).not.toBeNull()
  })

  it('拒绝带嵌入式凭据的 URL', () => {
    expect(validateFetchUrl('https://user:pass@example.com')).toContain('credentials')
    expect(validateFetchUrl('https://admin@example.com')).toContain('credentials')
  })

  it('拒绝单段主机名，例如 localhost 或裸主机名', () => {
    expect(validateFetchUrl('http://localhost/admin')).toContain('not a public domain')
    expect(validateFetchUrl('http://intranet/secret')).toContain('not a public domain')
  })

  it('拒绝私网和回环 IPv4 地址', () => {
    expect(validateFetchUrl('http://127.0.0.1/')).toContain('blocked for security')
    expect(validateFetchUrl('http://127.0.0.99/')).toContain('blocked for security')
    expect(validateFetchUrl('http://10.0.0.1/')).toContain('blocked for security')
    expect(validateFetchUrl('http://192.168.1.1/')).toContain('blocked for security')
    expect(validateFetchUrl('http://172.16.0.1/')).toContain('blocked for security')
    expect(validateFetchUrl('http://172.31.255.255/')).toContain('blocked for security')
  })

  it('拒绝链路本地地址和元数据地址（169.254.x.x）', () => {
    expect(validateFetchUrl('http://169.254.169.254/latest/meta-data/')).toContain('blocked for security')
  })

  it('拒绝 0.x.x.x 网段', () => {
    expect(validateFetchUrl('http://0.0.0.0/')).toContain('blocked for security')
  })

  it('拒绝 .local 和 .internal 后缀', () => {
    expect(validateFetchUrl('http://myhost.local/api')).toContain('blocked for security')
    expect(validateFetchUrl('http://service.internal/health')).toContain('blocked for security')
  })

  it('拒绝超过长度限制的 URL', () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(2000)
    expect(validateFetchUrl(longUrl)).toContain('character limit')
  })

  it('拒绝非法 URL', () => {
    expect(validateFetchUrl('这根本不是一个 url')).toContain('Invalid URL')
    expect(validateFetchUrl('')).not.toBeNull()
  })

  it('允许不在私网范围内的公网 IP', () => {
    expect(validateFetchUrl('http://8.8.8.8/')).toBeNull()
    expect(validateFetchUrl('http://1.1.1.1/')).toBeNull()
    expect(validateFetchUrl('http://172.15.0.1/')).toBeNull()
    expect(validateFetchUrl('http://172.32.0.1/')).toBeNull()
  })
})
