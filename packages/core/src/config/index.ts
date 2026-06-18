// @x-code-cli/core — 配置解析
//
// API Key 始终来自环境变量（例如 ANTHROPIC_API_KEY / ALIBABA_API_KEY
// 这类 provider 专属变量），绝不会持久化到磁盘。
//
// 默认 **model** 一共可能来自四个来源，优先级从高到低如下：
//   1. `--model` CLI 参数（显式传入的 `input`）
//   2. `~/.x-code/config.json` 中的 `model` 字段，由 `/model` 选择器写入
//   3. `X_CODE_MODEL` 环境变量
//   4. 智能默认值：按 PROVIDER_DETECTION_ORDER 顺序找到第一个已配置 key 的 provider
//
// 之所以让选择器结果优先于环境变量，是为了让 `/model` 在重启后仍然“记住”
// 上次选择；否则如果用户在 shell 或 `.env` 里设置了 `X_CODE_MODEL`，
// 下一次启动时 `/model` 的选择会被悄悄恢复掉（这是一个已报告过的 bug）。
import fsSync from 'node:fs'
import path from 'node:path'

import { MODEL_ALIASES, PROVIDER_DETECTION_ORDER } from '../types/index.js'
import { userXcodeDir } from '../utils.js'

/** provider 到环境变量名的映射表 */
const ENV_MAP: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  xai: 'XAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  alibaba: 'ALIBABA_API_KEY',
  zhipu: 'ZHIPU_API_KEY',
  moonshotai: 'MOONSHOT_API_KEY',
}

/** 获取指定 provider 的 API Key，只会从环境变量中读取 */
function getApiKey(provider: string): string | undefined {
  const envKey = ENV_MAP[provider]
  return envKey ? process.env[envKey] : undefined
}

/** 获取指定 provider 对应的环境变量名 */
export function getEnvVarName(provider: string): string | undefined {
  return ENV_MAP[provider]
}

/** 检查哪些 provider 已配置 API Key（仅检查环境变量） */
export function getAvailableProviders(): string[] {
  const providers = Object.keys(ENV_MAP).filter((p) => getApiKey(p))
  if (process.env.OPENAI_COMPATIBLE_API_KEY && process.env.OPENAI_COMPATIBLE_BASE_URL) {
    providers.push('custom')
  }
  return providers
}

/**
 * 按四层优先级解析最终的模型 ID：
 *   1. 显式传入的 `input`（例如 CLI 的 `--model` 参数）
 *   2. `~/.x-code/config.json` 的 `model` 字段（由 `/model` 选择器写入）
 *   3. `X_CODE_MODEL` 环境变量
 *   4. 智能默认值：按 PROVIDER_DETECTION_ORDER 顺序找到第一个有 API Key 的 provider
 *
 * MODEL_ALIASES 中的别名（例如 `"sonnet"` → `"anthropic:claude-sonnet-4-5"`）
 * 会在所有层级统一展开。如果当前没有任何可用 provider，则返回 null。
 */
export function resolveModelId(input?: string): string | null {
  const explicit = input ?? loadUserConfig().model ?? process.env.X_CODE_MODEL
  if (explicit) {
    return MODEL_ALIASES[explicit] ?? explicit
  }

  for (const { envKey, defaultModel } of PROVIDER_DETECTION_ORDER) {
    if (process.env[envKey]) return defaultModel
  }

  return null
}

// ── 用户配置文件（~/.x-code/config.json）────────────────────────────
//
// 持久化偏好包括：
//   model    — `/model` 选择器最近一次确认的模型 id
//   thinking — `/thinking` 写入的 extended-thinking / reasoning 开关。
//              会统一应用到所有支持 thinking 开关的 provider
//              （见 providers/thinking.ts）。默认值为 undefined，
//              视为关闭，避免普通启动时在默认关闭该特性的 provider
//              （如 Sonnet、DeepSeek、Qwen）上悄悄带来 2-10 倍延迟，
//              与此功能出现前的行为保持一致。
//
// API Key 有意不存放在这里（仅走环境变量，见文件头部注释）。

export interface UserConfig {
  /** 持久化保存的默认模型 id。 */
  model?: string
  /** 是否开启 thinking / reasoning 模式。 */
  thinking?: boolean
  /** 持久化的 UI 主题名。它会同时驱动 diff 背景色和对应的语法高亮配色。
   *  CLI 会在加载时通过 `parseThemeName` 校验；这里仍保留宽松的 `string`
   *  类型，因为 core 不依赖 CLI 的主题列表。未知值会静默回退到默认值 `dark`。 */
  theme?: string
  /** MCP 服务声明。这里故意保持宽松类型，因为真正的 schema 校验发生在
   *  `mcp/config-schema.ts`，不希望把 Zod 类型引入 config 模块的公开接口。
   *  loader 会在构建客户端前通过 `parseServersBlock` 做校验。 */
  mcpServers?: Record<string, unknown>
}

/** 获取用户配置文件路径。之所以导出，是为了让其他也要读取这份 JSON
 *  的模块（例如读取 `mcpServers` 的 MCP loader）能自动遵守
 *  `X_CODE_HOME` 的重定向逻辑。 */
export function getUserConfigPath(): string {
  return userConfigPath()
}

/** 计算用户配置文件在磁盘上的实际路径。 */
function userConfigPath(): string {
  return path.join(userXcodeDir(), 'config.json')
}

/** 读取用户配置。若遇到任何失败（文件不存在、JSON 解析失败、结构不合法）
 *  都返回空对象，这样调用方就不需要额外做 null 判断。 */
export function loadUserConfig(): UserConfig {
  try {
    const raw = fsSync.readFileSync(userConfigPath(), 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as UserConfig
    }
  } catch {
    // 文件可能还不存在，也可能内容已损坏；两种情况都统一回落到 {}。
  }
  return {}
}

/** 将局部更新写回用户配置，同时保留其他已有字段。 */
export function saveUserConfig(update: Partial<UserConfig>): void {
  const merged: UserConfig = { ...loadUserConfig(), ...update }
  try {
    // 必须对 userConfigPath() 所在的同一根目录执行 mkdir；否则在
    // X_CODE_HOME 被重定向时，可能创建的是 `~/.x-code/`，但写入目标
    // 却在 override 目录下，最终因为父目录不存在而静默写失败。
    fsSync.mkdirSync(userXcodeDir(), { recursive: true })
    fsSync.writeFileSync(userConfigPath(), JSON.stringify(merged, null, 2) + '\n', 'utf-8')
  } catch {
    // 尽力而为：配置目录只读时不要让 UI 直接崩掉。
  }
}

/** 使用环境变量中的 API Key 构建 provider 配置对象 */
export function getProviderOptions() {
  return {
    anthropic: getApiKey('anthropic'),
    openai: getApiKey('openai'),
    google: getApiKey('google'),
    xai: getApiKey('xai'),
    deepseek: getApiKey('deepseek'),
    alibaba: getApiKey('alibaba'),
    zhipu: getApiKey('zhipu'),
    moonshotai: getApiKey('moonshotai'),
    custom: {
      apiKey: process.env.OPENAI_COMPATIBLE_API_KEY,
      baseURL: process.env.OPENAI_COMPATIBLE_BASE_URL,
    },
  }
}
