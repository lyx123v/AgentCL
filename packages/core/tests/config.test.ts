// config 模块测试。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import os from 'node:os'
import path from 'node:path'

import { getAvailableProviders, resolveModelId } from '../src/config/index.js'

/** config 模块会读取的所有 provider 环境变量。
 *  这里与 `src/config/index.ts` 里的 `ENV_MAP` 保持同步，
 *  同时补上 `getAvailableProviders` 使用的 `OPENAI_COMPATIBLE_*`。
 *  之所以完整列出，是为了避免开发者本地 shell 中残留任一 provider 的 key
 *  （例如 Gemini 的 Google key、Qwen 的 Alibaba key 等）泄漏到测试环境，
 *  进而破坏“未配置 provider”相关断言。
 *  新增 provider 时也要同步更新这里。 */
const PROVIDER_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'XAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'ALIBABA_API_KEY',
  'ZHIPU_API_KEY',
  'MOONSHOT_API_KEY',
  'OPENAI_COMPATIBLE_API_KEY',
  'OPENAI_COMPATIBLE_BASE_URL',
] as const

// 清理所有 provider 相关环境变量，保证测试环境纯净。
function clearProviderEnvVars(): void {
  for (const key of PROVIDER_ENV_VARS) delete process.env[key]
}

/** 把 config.json 的读取重定向到一个空临时目录，
 *  避免用户真实的 ~/.x-code/config.json
 *  （例如刚被 /model 切换写入过）污染这些断言。 */
function isolateUserConfig(): void {
  const tmp = path.join(os.tmpdir(), 'x-code-config-test-' + Math.random().toString(36).slice(2))
  process.env.X_CODE_HOME = tmp
}

describe('resolveModelId', () => {
  beforeEach(() => {
    isolateUserConfig()
    delete process.env.X_CODE_MODEL
    clearProviderEnvVars()
  })

  afterEach(() => {
    delete process.env.X_CODE_HOME
    delete process.env.X_CODE_MODEL
    clearProviderEnvVars()
  })

  it('会优先从 CLI 参数解析模型', () => {
    expect(resolveModelId('anthropic:claude-sonnet-4-6')).toBe('anthropic:claude-sonnet-4-6')
  })

  it('能从 CLI 参数里的别名解析模型', () => {
    expect(resolveModelId('sonnet')).toBe('anthropic:claude-sonnet-4-6')
    expect(resolveModelId('opus')).toBe('anthropic:claude-opus-4-8')
    expect(resolveModelId('deepseek')).toBe('deepseek:deepseek-v4-flash')
  })

  it('会回退到环境变量 X_CODE_MODEL', () => {
    process.env.X_CODE_MODEL = 'openai:gpt-4.1'
    expect(resolveModelId()).toBe('openai:gpt-4.1')
  })

  it('能从 X_CODE_MODEL 中的别名解析模型', () => {
    process.env.X_CODE_MODEL = 'sonnet'
    expect(resolveModelId()).toBe('anthropic:claude-sonnet-4-6')
  })

  it('CLI 参数优先级高于 X_CODE_MODEL', () => {
    process.env.X_CODE_MODEL = 'openai:gpt-4.1'
    expect(resolveModelId('sonnet')).toBe('anthropic:claude-sonnet-4-6')
  })

  it('会根据环境变量中的 API key 回退到智能默认模型', () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    expect(resolveModelId()).toBe('anthropic:claude-sonnet-4-6')
  })

  it('会遵循 provider 检测顺序', () => {
    process.env.OPENAI_API_KEY = 'test-key'
    expect(resolveModelId()).toBe('openai:gpt-5.5')
  })

  it('未配置任何 provider 时返回 null', () => {
    expect(resolveModelId()).toBeNull()
  })

  it('显式指定模型时，即使缺少 provider key 也会返回模型', () => {
    expect(resolveModelId('deepseek')).toBe('deepseek:deepseek-v4-flash')
  })
})

describe('getAvailableProviders', () => {
  beforeEach(() => {
    clearProviderEnvVars()
  })

  afterEach(() => {
    clearProviderEnvVars()
  })

  it('未设置环境变量时返回空数组', () => {
    expect(getAvailableProviders()).toEqual([])
  })

  it('能从环境变量检测出可用 provider', () => {
    process.env.ANTHROPIC_API_KEY = 'test'
    process.env.OPENAI_API_KEY = 'test'
    const providers = getAvailableProviders()
    expect(providers).toContain('anthropic')
    expect(providers).toContain('openai')
  })
})
