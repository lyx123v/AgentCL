// @x-code-cli/core — 计划模式文件存储
//
// 计划文件保存在项目内的 `.x-code/plans/<slug>-<YYYYMMDD-HHMMSS>.md`
// 中，而不是用户级别的 `~/.x-code/`。这与 `.x-code/sessions/`、
// `.x-code/memory/` 的作用域一致：按项目隔离、默认 gitignore、
// 不跨仓库共享。
//
// 与全局随机 slug 相比，这里采用“项目内 + 任务派生 slug”的形式，
// 更方便后续回看，也能让计划文件跟着仓库一起走。
import fs from 'node:fs/promises'
import path from 'node:path'

import { generateText } from 'ai'
import type { LanguageModel } from 'ai'

import { getThinkingProviderOptions } from '../providers/thinking.js'
import { XCODE_DIR, debugLog } from '../utils.js'

const PLANS_SUBDIR = 'plans'
const SLUG_MAX_LEN = 40

/** 把任意任务描述转换成适合文件系统的 slug。
 *  输出为小写、短横线分隔，且只保留 `[a-z0-9 -]` 范围内字符。 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LEN)
    .replace(/-+$/g, '')
}

/** 把日期格式化成 `YYYYMMDD-HHMMSS`。 */
function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  )
}

/** 返回当前项目下的计划目录路径。 */
function plansDir(): string {
  return path.join(process.cwd(), XCODE_DIR, PLANS_SUBDIR)
}

/** 根据任务描述构造计划文件路径。
 *  这是纯函数，不做 I/O，因此调用方可以在文件真正创建前先把路径存进状态里。 */
export function makePlanFilePath(taskText: string, opts?: { slug?: string; now?: Date }): string {
  const slug = opts?.slug ?? slugify(taskText)
  const ts = formatTimestamp(opts?.now ?? new Date())
  const name = slug ? `${slug}-${ts}` : ts
  return path.join(plansDir(), `${name}.md`)
}

/** 触发本地快速路径所需的最小 slug 长度。 */
const ASCII_FAST_PATH_MIN_LEN = 6

/** 发送给 slug 生成模型的原始用户文本最大长度。 */
const TASK_TEXT_TRUNCATE = 500

/** slug 生成请求允许的最大输出 token 数。 */
const SLUG_MAX_OUTPUT_TOKENS = 256

/** 为当前会话生成一个更易读的文件名 slug。
 *  英文内容优先走本地快速路径；中文或过短输入则回退到一次独立的 LLM 生成。 */
export async function generateTaskSlug(
  taskText: string,
  model: LanguageModel,
  modelId: string,
  signal?: AbortSignal,
): Promise<string> {
  const localSlug = slugify(taskText)
  if (localSlug.length >= ASCII_FAST_PATH_MIN_LEN) {
    debugLog('slug.fast-path', `len=${localSlug.length} slug="${localSlug}"`)
    return localSlug
  }

  debugLog('slug.llm-start', `taskTextLen=${taskText.length} modelId=${modelId}`)
  try {
    const { text, usage, finishReason } = await generateText({
      model,
      abortSignal: signal,
      providerOptions: getThinkingProviderOptions(modelId, false) as Parameters<
        typeof generateText
      >[0]['providerOptions'],
      system:
        '你负责把用户任务描述转换成简短的英文文件名 slug。' +
        '请只回复 2 到 4 个小写英文单词，用空格分隔。' +
        '不要加标点、引号、解释，也不要加类似 "slug:" 的前缀。' +
        '如果输入不是英文，请先把核心含义翻译成英文再输出。',
      prompt: taskText.slice(0, TASK_TEXT_TRUNCATE),
      maxOutputTokens: SLUG_MAX_OUTPUT_TOKENS,
    })
    const slug = slugify(text)
    debugLog(
      'slug.llm-result',
      `finishReason=${finishReason} rawText="${(text ?? '').slice(0, 80)}" slug="${slug}" tokens=${usage?.outputTokens ?? '?'}`,
    )
    return slug
  } catch (err) {
    debugLog('slug.llm-error', err instanceof Error ? err.message : String(err))
    return ''
  }
}

/** 确保计划目录存在。 */
export async function ensurePlanDir(): Promise<void> {
  await fs.mkdir(plansDir(), { recursive: true })
}

/** 读取指定计划文件内容；文件不存在时返回空字符串。 */
export async function readPlan(planPath: string): Promise<string> {
  try {
    return await fs.readFile(planPath, 'utf-8')
  } catch {
    return ''
  }
}

/** 把计划内容写入指定路径，并返回写入路径。 */
export async function writePlan(planPath: string, body: string): Promise<string> {
  await ensurePlanDir()
  await fs.writeFile(planPath, body, 'utf-8')
  return planPath
}
