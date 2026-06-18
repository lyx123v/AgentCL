// 从环境变量（以及可选的 .env）中识别 API Key，并映射成可供 e2e 套件使用的模型列表。
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..')

export const DEFAULT_MODEL = 'deepseek:deepseek-v4-flash'

/** 提供商环境变量 -> 当该 Key 存在时可选择的模型 ID 列表。
 *  需要与 `packages/core/src/types/index.ts::PROVIDER_DETECTION_ORDER` 保持一致。 */
const PROVIDER_MODELS: Record<string, string[]> = {
  DEEPSEEK_API_KEY: ['deepseek:deepseek-v4-flash', 'deepseek:deepseek-v4-pro'],
  ANTHROPIC_API_KEY: [
    'anthropic:claude-fable-5',
    'anthropic:claude-opus-4-8',
    'anthropic:claude-sonnet-4-6',
    'anthropic:claude-haiku-4-5',
  ],
  OPENAI_API_KEY: [
    'openai:gpt-5.5',
    'openai:gpt-5.4-mini',
    'openai:gpt-4.1',
    'openai:gpt-4.1-mini',
    'openai:o3',
    'openai:o4-mini',
  ],
  GOOGLE_GENERATIVE_AI_API_KEY: ['google:gemini-3.5-flash', 'google:gemini-2.5-pro', 'google:gemini-2.5-flash'],
  XAI_API_KEY: ['xai:grok-4.3', 'xai:grok-3'],
  ALIBABA_API_KEY: [
    'alibaba:qwen3.7-max',
    'alibaba:qwen3-coder-plus',
    'alibaba:qwq-plus',
    'alibaba:qwen3-max',
    'alibaba:qwen-plus',
    'alibaba:qwen-turbo',
  ],
  ZHIPU_API_KEY: ['zhipu:glm-5.1', 'zhipu:glm-5', 'zhipu:glm-4-plus'],
  MOONSHOT_API_KEY: ['moonshotai:kimi-k2.6', 'moonshotai:kimi-k2.5'],
}

/** 简短别名，可直接用于 CLI 的 `--model` 参数。
 *  需与产品中的 `MODEL_ALIASES` 表保持同步。 */
export const ALIASES: Record<string, string> = {
  fable: 'anthropic:claude-fable-5',
  sonnet: 'anthropic:claude-sonnet-4-6',
  opus: 'anthropic:claude-opus-4-8',
  haiku: 'anthropic:claude-haiku-4-5',
  gpt5: 'openai:gpt-5.5',
  gpt4: 'openai:gpt-4.1',
  gemini: 'google:gemini-3.5-flash',
  deepseek: 'deepseek:deepseek-v4-flash',
  'deepseek-pro': 'deepseek:deepseek-v4-pro',
  qwen: 'alibaba:qwen3.7-max',
  glm: 'zhipu:glm-5.1',
  kimi: 'moonshotai:kimi-k2.6',
}

// 将用户输入的模型别名解析为完整模型 ID。
export function resolveModelArg(input: string): string {
  return ALIASES[input] ?? input
}

/** 尽力加载 .env，但不会覆盖 process.env 中已经存在的值。
 *  返回加载后的合并环境变量结果。 */
export async function loadDotenv(): Promise<Record<string, string>> {
  const envPath = path.join(REPO_ROOT, '.env')
  let parsed: Record<string, string> = {}
  try {
    const raw = await fs.readFile(envPath, 'utf-8')
    for (const rawLine of raw.split('\n')) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq < 0) continue
      const key = line.slice(0, eq).trim()
      let value = line.slice(eq + 1).trim()
      // 去掉可选的包裹引号。
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      parsed[key] = value
    }
  } catch {
    // 没有 .env 也没关系。
  }
  // 不覆盖 process.env 中已经显式设置的值。
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] == null) process.env[k] = v
  }
  // 构造只包含字符串值的返回对象。
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v
  }
  return env
}

export interface ModelOption {
  modelId: string
  providerEnvKey: string
}

/** 根据当前环境变量，返回用户可选的 `(modelId, sourceEnvKey)` 扁平列表。 */
export function availableModels(env: Record<string, string>): ModelOption[] {
  const out: ModelOption[] = []
  for (const [envKey, models] of Object.entries(PROVIDER_MODELS)) {
    if (env[envKey]) {
      for (const modelId of models) out.push({ modelId, providerEnvKey: envKey })
    }
  }
  // OpenAI 兼容协议的自定义端点。
  if (env.OPENAI_COMPATIBLE_API_KEY && env.OPENAI_COMPATIBLE_BASE_URL) {
    out.push({ modelId: 'custom:default', providerEnvKey: 'OPENAI_COMPATIBLE_API_KEY' })
  }
  return out
}

/** 生成人类可读的已检测 Key 摘要，返回可直接打印的文本行。 */
export function describeDetectedKeys(env: Record<string, string>): string[] {
  const lines: string[] = []
  for (const [envKey, models] of Object.entries(PROVIDER_MODELS)) {
    if (env[envKey]) {
      const family = envKey.replace(/_API_KEY|_GENERATIVE_AI_API_KEY/, '').toLowerCase()
      lines.push(`  ${envKey}  ->  ${family}：${models.map((m) => m.split(':')[1]).join(' / ')}`)
    }
  }
  if (env.OPENAI_COMPATIBLE_API_KEY && env.OPENAI_COMPATIBLE_BASE_URL) {
    lines.push(`  OPENAI_COMPATIBLE_API_KEY  ->  自定义端点 @ ${env.OPENAI_COMPATIBLE_BASE_URL}`)
  }
  return lines
}
