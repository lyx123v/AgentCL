// @x-code-cli/core — 插件 manifest 发现与 zod 校验
//
// 这个模块只做一件事：给定磁盘上的插件根目录，按优先级探测 manifest
// 文件（在三个受支持的相对路径中查找），解析并校验 JSON，最后返回
// `PluginManifest`。至于贡献路径解析、作用域判断和启用状态解析，交给
// 调用方处理。
//
// manifest 顶层的未知字段会被静默剥离（这是 zod 对 `z.object`
// 的默认行为）。这是有意为之：这样即便遇到我们暂时不认识的新字段
//（例如 `output-styles`、`lspServers`），较新的 Claude Code
// manifest 依然可以被解析，只是我们不会对这些字段采取动作。
// 后续 `/plugin doctor` 会把它们提示为“已加载，但含有 X 个暂不支持的
// 字段”，方便用户理解当前只是部分生效。
import fs from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import { GEMINI_MANIFEST_REL, MANIFEST_CANDIDATES } from './paths.js'
import type { ManifestFormat, PluginManifest } from './types.js'

// ── Zod Schema 定义 ────────────────────────────────────────────────────

const authorSchema = z.union([
  z.string(),
  z.object({
    name: z.string().optional(),
    email: z.string().optional(),
    url: z.string().optional(),
  }),
])

const userConfigItemSchema = z.object({
  key: z.string().min(1),
  type: z.enum(['string', 'number', 'boolean']),
  sensitive: z.boolean().optional(),
  prompt: z.string().optional(),
  required: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  description: z.string().optional(),
})

/** 某些贡献字段既支持相对路径（字符串），也支持内联对象。
 *  Claude Code 的 `mcpServers` 和 `hooks` 就采用这种形式。
 *  这里不校验内联对象的具体结构，结构校验交给各自的 mcp / hooks
 *  子系统处理，它们本身已经拥有对应 schema。 */
const pathOrInline = z.union([z.string().min(1), z.record(z.string(), z.unknown())])

/** 插件名规则：仅允许小写字母、数字和中划线，且必须以字母或数字开头。
 *  这样可以同时兼容 Claude Code / Codex / Gemini 的命名约束，
 *  也能保证在 Windows 上作为路径片段时足够安全。 */
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/

const manifestSchema = z.object({
  schemaVersion: z.string().optional(),
  name: z
    .string()
    .min(1)
    .regex(NAME_RE, 'name 只能包含小写字母、数字和中划线（例如 "linear-issues"）'),
  // 真实的 Claude Code 插件里 version 经常是可选的
  //（参考 anthropics/claude-plugins-official，很多插件都没写，
  // 包括 amplitude 这类主流第三方插件）。这里默认补成 "0.0.0"，
  // 这样缓存路径和 installed_plugins.json 里仍然会有一个可用版本号。
  version: z.string().min(1).optional(),
  description: z.string().optional(),
  author: authorSchema.optional(),
  keywords: z.array(z.string()).optional(),
  homepage: z.string().optional(),
  license: z.string().optional(),

  skills: z.string().min(1).optional(),
  agents: z.string().min(1).optional(),
  commands: z.string().min(1).optional(),
  mcpServers: pathOrInline.optional(),
  hooks: pathOrInline.optional(),

  userConfig: z.array(userConfigItemSchema).optional(),
  dependencies: z.array(z.string().min(1)).optional(),
  engines: z.object({ 'x-code': z.string().optional() }).optional(),
})

// ── Manifest 探测 ──────────────────────────────────────────────────────

export interface ManifestDiscovery {
  /** manifest 文件的绝对路径。 */
  manifestPath: string
  /** 当前识别到的 manifest 格式。 */
  format: ManifestFormat
}

/** 在插件根目录中探测 manifest 文件，并返回优先级最高的命中结果。
 *  如果只存在 Gemini manifest，则返回 `{ format: 'gemini', ... }`，
 *  这样安装器就能给出“暂不支持 Gemini 扩展”的明确提示，而不是模糊地说
 *  “没有找到 manifest”。 */
export async function discoverManifest(rootDir: string): Promise<ManifestDiscovery | null> {
  for (const candidate of MANIFEST_CANDIDATES) {
    const full = path.join(rootDir, candidate.rel)
    if (await fileExists(full)) {
      return { manifestPath: full, format: candidate.format }
    }
  }
  const gemini = path.join(rootDir, GEMINI_MANIFEST_REL)
  if (await fileExists(gemini)) {
    return { manifestPath: gemini, format: 'gemini' }
  }
  return null
}

// ── 解析 ────────────────────────────────────────────────────────────────

export class ManifestParseError extends Error {
  constructor(
    message: string,
    /** 触发错误的 manifest 文件路径。 */
    public readonly manifestPath: string,
  ) {
    super(message)
    this.name = 'ManifestParseError'
  }
}

/** 解析并校验 manifest JSON 文件。
 *  当 `schemaVersion` 缺失时，自动补成 `1` 作为隐式默认值
 * （大多数现有 Claude Code 插件都不会显式写这个字段）。
 *  发生错误时抛出带路径信息的 `ManifestParseError`，这样加载器可以把
 *  它收集进 doctor 诊断项里，而不会中断整个启动流程。 */
export async function parseManifest(manifestPath: string): Promise<PluginManifest> {
  let raw: string
  try {
    raw = await fs.readFile(manifestPath, 'utf-8')
  } catch (err) {
    throw new ManifestParseError(
      `读取 manifest 失败：${err instanceof Error ? err.message : String(err)}`,
      manifestPath,
    )
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    throw new ManifestParseError(
      `manifest 不是合法的 JSON：${err instanceof Error ? err.message : String(err)}`,
      manifestPath,
    )
  }

  const result = manifestSchema.safeParse(json)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new ManifestParseError(`manifest 无效：${issues}`, manifestPath)
  }

  const data = result.data
  return {
    ...data,
    schemaVersion: data.schemaVersion ?? '1',
    version: data.version ?? '0.0.0',
    // 统一 author 的联合类型，方便内部调用方只处理对象形式。
    // 如果原始值是字符串，这里会转换成 `{ name: <string> }`。
    author: typeof data.author === 'string' ? { name: data.author } : data.author,
  }
}

// ── 辅助函数 ────────────────────────────────────────────────────────────

/** 判断指定路径上的文件是否存在。 */
async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}
