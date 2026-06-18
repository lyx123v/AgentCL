import { describe, expect, it } from 'vitest'

import { UnsafeEnvError, assertSafeEnv } from '../src/mcp/env-safety.js'

describe('assertSafeEnv', () => {
  it('接受 undefined 和空 env', () => {
    expect(() => assertSafeEnv(undefined)).not.toThrow()
    expect(() => assertSafeEnv({})).not.toThrow()
  })

  it('接受任意业务层环境变量 key', () => {
    expect(() =>
      assertSafeEnv({
        OPENAI_API_KEY: 'sk-...',
        LOG_LEVEL: 'debug',
        MY_PLUGIN_TOKEN: 'xyz',
      }),
    ).not.toThrow()
  })

  it('会拒绝 NODE_OPTIONS', () => {
    expect(() => assertSafeEnv({ NODE_OPTIONS: '--require ./evil.js' })).toThrow(UnsafeEnvError)
  })

  it('会拒绝 LD_PRELOAD 类环境变量', () => {
    for (const k of ['LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT']) {
      expect(() => assertSafeEnv({ [k]: '/tmp/x.so' })).toThrow(UnsafeEnvError)
    }
  })

  it('会拒绝 DYLD_* 环境变量（macOS）', () => {
    for (const k of [
      'DYLD_INSERT_LIBRARIES',
      'DYLD_LIBRARY_PATH',
      'DYLD_FRAMEWORK_PATH',
      'DYLD_FALLBACK_LIBRARY_PATH',
      'DYLD_FALLBACK_FRAMEWORK_PATH',
    ]) {
      expect(() => assertSafeEnv({ [k]: '/tmp/x.dylib' })).toThrow(UnsafeEnvError)
    }
  })

  it('会拒绝 shell 初始化钩子', () => {
    for (const k of ['BASH_ENV', 'ENV', 'PROMPT_COMMAND']) {
      expect(() => assertSafeEnv({ [k]: '/tmp/x.sh' })).toThrow(UnsafeEnvError)
    }
  })

  it('会拒绝脚本运行时注入钩子', () => {
    for (const k of ['PYTHONSTARTUP', 'PYTHONPATH', 'PERL5OPT', 'PERL5LIB', 'RUBYOPT', 'RUBYLIB']) {
      expect(() => assertSafeEnv({ [k]: '/tmp/x' })).toThrow(UnsafeEnvError)
    }
  })

  it('大小写不敏感，符合 Windows 环境变量的行为', () => {
    // Windows 在操作系统层面对环境变量名大小写不敏感且通常规范化为大写，
    // 但 Node 仍可能把我们传给 spawn 的任意大小写原样带过去。
    // 如果只拦截大写形式，`node_options:` 这类配置就会漏网。
    expect(() => assertSafeEnv({ Node_Options: '--require ./x.js' })).toThrow(UnsafeEnvError)
    expect(() => assertSafeEnv({ ld_preload: '/tmp/x.so' })).toThrow(UnsafeEnvError)
  })

  it('错误中会指出违规的 key', () => {
    try {
      assertSafeEnv({ NODE_OPTIONS: 'x' })
      expect.fail('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(UnsafeEnvError)
      expect((err as UnsafeEnvError).key).toBe('NODE_OPTIONS')
    }
  })
})
