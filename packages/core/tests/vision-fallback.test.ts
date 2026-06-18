// vision-fallback 模块测试，重点覆盖 pickVisionProvider() 的优先级逻辑。
// 这里不直接测试 captionImage()，因为它会发起真实 API 调用；
// 集成测试由 scripts/ 下的脚本单独负责。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { pickVisionProvider } from '../src/agent/vision-fallback.js'

const VISION_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'XAI_API_KEY',
  'ALIBABA_API_KEY',
  'ZHIPU_API_KEY',
  'MOONSHOT_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENAI_COMPATIBLE_API_KEY',
  'OPENAI_COMPATIBLE_BASE_URL',
]

// 清空所有视觉相关环境变量，避免测试之间相互污染。
function clearAllKeys(): void {
  for (const k of VISION_KEYS) delete process.env[k]
}

describe('pickVisionProvider', () => {
  beforeEach(clearAllKeys)
  afterEach(clearAllKeys)

  it('仅配置自定义 OpenAI-compatible 端点时会返回 null', () => {
    // 自定义兼容端点默认仍按纯文本模型处理，即使两个环境变量都设置了，
    // 也不代表用户显式开启了视觉能力。
    process.env.OPENAI_COMPATIBLE_API_KEY = 'test'
    process.env.OPENAI_COMPATIBLE_BASE_URL = 'https://example.com'
    expect(pickVisionProvider()).toBeNull()
  })

  it('只配置 Google key 时会选择 Gemini', () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'test'
    const sub = pickVisionProvider()
    expect(sub?.provider).toBe('google')
    expect(sub?.modelId).toBe('google:gemini-2.5-flash')
  })

  it('只配置 Zhipu key 时会选择 GLM-4V', () => {
    process.env.ZHIPU_API_KEY = 'test'
    const sub = pickVisionProvider()
    expect(sub?.provider).toBe('zhipu')
    expect(sub?.modelId).toBe('zhipu:glm-4v-flash')
  })

  it('同时配置 Google 和 Zhipu 时优先选择 Google', () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'test'
    process.env.ZHIPU_API_KEY = 'test'
    expect(pickVisionProvider()?.provider).toBe('google')
  })

  it('同时配置 Zhipu 和 Alibaba 时优先选择 Zhipu', () => {
    process.env.ZHIPU_API_KEY = 'test'
    process.env.ALIBABA_API_KEY = 'test'
    expect(pickVisionProvider()?.provider).toBe('zhipu')
  })

  it('只配置 xAI key 时会顺延选择 xAI', () => {
    process.env.XAI_API_KEY = 'test'
    expect(pickVisionProvider()?.provider).toBe('xai')
  })

  it('选择视觉 provider 时会忽略 DeepSeek key，并继续选择可用视觉模型', () => {
    process.env.DEEPSEEK_API_KEY = 'test'
    process.env.ANTHROPIC_API_KEY = 'test'
    expect(pickVisionProvider()?.provider).toBe('anthropic')
  })
})
