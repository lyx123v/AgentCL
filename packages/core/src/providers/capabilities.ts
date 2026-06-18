// @x-code-cli/core — 提供方多模态能力表
//
// 这里声明各家提供方的 API 是否原生支持在用户消息和工具结果中接收
// 图片 / PDF 内容片段。它会被文件摄取流程使用（决定走内联还是 OCR），
// 也会被 provider-compat 使用（在发送前移除目标提供方无法接受的二进制片段）。
//
// 这里按“提供方”建模，而不是按“具体模型”建模。有些提供方（如 alibaba、
// zhipu）会额外提供只支持视觉的模型 id；如果用户选了纯文本 Qwen/GLM
// 变体再粘贴图片，依然可能收到 API 报错。这是一个有意为之的简化，因为
// 按模型维护能力表需要为每个 id 建一份映射，而且很容易过时。

export interface ProviderCapabilities {
  image: boolean // 是否支持在用户消息中直接接收图片片段（base64 或 URL）
  pdf: boolean // 是否支持直接接收 PDF 文件片段
  filesApi: boolean // 是否提供专门的 `/files` 上传接口（通过 file_id 引用）
}

const CAPS: Record<string, ProviderCapabilities> = {
  anthropic: { image: true, pdf: true, filesApi: true },
  openai: { image: true, pdf: true, filesApi: true },
  google: { image: true, pdf: true, filesApi: true },
  xai: { image: true, pdf: true, filesApi: true },
  moonshotai: { image: true, pdf: true, filesApi: true },
  alibaba: { image: true, pdf: true, filesApi: true },
  zhipu: { image: true, pdf: true, filesApi: true },
  deepseek: { image: false, pdf: false, filesApi: false },
  // 自定义 OpenAI 兼容端点默认采用保守策略。
  // 如果以后加入环境变量覆写（例如 X_CODE_CUSTOM_SUPPORTS_IMAGE=1），
  // 熟悉自己端点能力的用户再自行开启视觉支持。
  custom: { image: false, pdf: false, filesApi: false },
}

/** 从 `provider:model` 形式的 id 中提取 provider。
 *  如果找不到分隔符，则返回 `unknown` 作为兜底保护。 */
export function providerOf(modelId: string): string {
  const idx = modelId.indexOf(':')
  return idx > 0 ? modelId.slice(0, idx) : 'unknown'
}

/** 根据模型 id 查询其所属提供方的能力。
 *  未知提供方默认按纯文本处理，比盲目假设支持视觉更安全。 */
export function capabilitiesOf(modelId: string): ProviderCapabilities {
  return CAPS[providerOf(modelId)] ?? { image: false, pdf: false, filesApi: false }
}
