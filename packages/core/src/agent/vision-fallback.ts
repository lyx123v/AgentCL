// @x-code-cli/core — 面向纯文本 provider 的视觉兜底子代理
//
// 当用户附带图片，但当前激活模型本身看不了图时（目前 DeepSeek 如此，
// custom provider 默认也是如此），系统会自动借用另一个已配置且支持视觉的
// provider，把它当成图片描述子代理来用。生成的 caption 会以 TextPart
// 注入进用户消息，因此主模型无需接收二进制图片本体，也能看到文字描述。
//
// 这个能力存在的原因是：DeepSeek 用户过去只能依赖本地 tesseract OCR，
// 它对代码截图还凑合，但对 UI mockup、图表、照片几乎没用。很多配置了
// DeepSeek 的用户，往往同时也配有至少一个免费层视觉模型的 key
// （比如 Gemini 或 GLM-4V-Flash）；自动探测并复用它们，能省掉用户每次
// 粘贴截图都手动 `/model` 切换一次的麻烦。
import fs from 'node:fs/promises'
import path from 'node:path'

import { generateText } from 'ai'

import { getAvailableProviders } from '../config/index.js'
import { createModelRegistry } from '../providers/registry.js'
import { debugLog } from '../utils.js'
import { LruCache } from '../utils/lru-cache.js'
import { mediaTypeFor } from '../utils/media-type.js'

export interface VisionProvider {
  /** provider 标识，例如 `"google"` / `"zhipu"`。 */
  provider: string
  /** 传给 AI SDK registry 的完整 `<provider>:<model>` 模型 id。 */
  modelId: string
  /** 用于 UI 提示的短标签，例如 `"Gemini 2.5 Flash"`。 */
  label: string
}

/** 每个 provider 对应的视觉模型 id 与展示标签。
 *  这里优先选择便宜或免费层模型，因为目标只是快速生成图片描述，
 *  而不是做昂贵的深度视觉分析。 */
const VISION_MODELS: Record<string, { modelId: string; label: string }> = {
  google: { modelId: 'google:gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  zhipu: { modelId: 'zhipu:glm-4v-flash', label: 'GLM-4V Flash' },
  alibaba: { modelId: 'alibaba:qwen-vl-plus', label: 'Qwen-VL Plus' },
  openai: { modelId: 'openai:gpt-4o-mini', label: 'GPT-4o Mini' },
  anthropic: { modelId: 'anthropic:claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  moonshotai: {
    modelId: 'moonshotai:moonshot-v1-32k-vision-preview',
    label: 'Moonshot Vision Preview',
  },
  xai: { modelId: 'xai:grok-4.3', label: 'Grok 4.3' },
}

/** 选择视觉子代理时的 provider 尝试顺序。
 *  免费层和单图成本低的模型排前面，昂贵旗舰模型靠后。
 *  Gemini 2.5 Flash 排第一，是因为它免费额度最宽松（1500/day），
 *  同时在免费价位里能力也最强。GLM-4V-Flash 排第二，是因为它确实免费，
 *  并且在中国无需代理也能访问。 */
const VISION_PRIORITY = ['google', 'zhipu', 'alibaba', 'openai', 'anthropic', 'moonshotai', 'xai']

/**
 * 根据用户当前已经配置的 key，挑选一个最合适的视觉子代理。
 * 如果没有任何支持视觉的 provider 可用，则返回 null，
 * 调用方应退回本地 OCR 方案。
 */
export function pickVisionProvider(): VisionProvider | null {
  const available = new Set(getAvailableProviders())
  for (const provider of VISION_PRIORITY) {
    if (!available.has(provider)) continue
    const model = VISION_MODELS[provider]
    if (!model) continue
    return { provider, modelId: model.modelId, label: model.label }
  }
  return null
}

/** 内存缓存，避免同一张图片被反复附加时（包括一个 session 内多次提交）
 *  重复消耗子代理 token。
 *  key 结构是 `${providerId}:${file size}:${first-64-bytes-base64}`，
 *  与 provider-compat.ts 在 OCR 场景里使用的低成本抗碰撞策略一致。 */
const captionCache = new LruCache<string>({ maxEntries: 50 })

/** 为图片生成缓存 key。 */
async function cacheKey(filePath: string, providerModelId: string): Promise<string> {
  const buffer = await fs.readFile(filePath)
  return `${providerModelId}:${buffer.length}:${buffer.subarray(0, 64).toString('base64')}`
}

/**
 * 使用选定的视觉子代理为图片生成文字描述。
 * 这里的提示词会同时要求“逐字转录图片文字”和“描述视觉元素”
 * （布局、颜色、组件等）；因为 OCR 只能覆盖前者，后者同样是主模型
 * 做判断时非常关键的信息，所以 caption 需要完整覆盖两类内容。
 */
export async function captionImage(filePath: string, sub: VisionProvider): Promise<string> {
  const key = await cacheKey(filePath, sub.modelId)
  const cached = captionCache.get(key)
  if (cached != null) {
    debugLog('vision-fallback.cache-hit', `${sub.modelId} ${path.basename(filePath)}`)
    return cached
  }

  const buffer = await fs.readFile(filePath)
  const registry = createModelRegistry()
  // registry.languageModel() 的类型要求是 `${string}:${string}`，
  // 但 VISION_MODELS 里的值被声明成了普通 string。这里在边界处做一次断言即可，
  // 因为两端都由我们自己维护，而且每一项都严格是 `provider:model` 形式。
  const model = registry.languageModel(sub.modelId as `${string}:${string}`)

  debugLog('vision-fallback.caption', `${sub.modelId} ${path.basename(filePath)} ${buffer.length}B`)
  const { text } = await generateText({
    model,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              'Describe this image in detail so a text-only AI can act on it. ' +
              'Include: (1) any visible text transcribed verbatim, ' +
              '(2) UI elements, layout, and visual hierarchy, ' +
              '(3) colors, icons, shapes, and other visual details, ' +
              '(4) inferred purpose or context. ' +
              'Be thorough and specific. Output plain text only — no markdown formatting.',
          },
          { type: 'image', image: buffer, mediaType: mediaTypeFor(filePath) },
        ],
      },
    ],
  })

  const caption = text.trim()
  captionCache.set(key, caption)
  return caption
}
