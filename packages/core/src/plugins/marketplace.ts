// @x-code-cli/core — Marketplace 订阅与索引解析
//
// marketplace 是一个经过整理的插件目录（其 `marketplace.json` 本质上就是
// 一组 `{ name, source, ... }` 条目的列表）。CLI 本身不维护官方 marketplace，
// 而是支持“订阅外部 marketplace”；原因可见 [[plugin-marketplace-design]] §7.1。
// 本模块主要负责：
//
//   1. 读写 `known_marketplaces.json`（用户订阅列表），并对保留名称做保护。
//   2. 从 HTTPS 原始 `marketplace.json` 地址，或 git 地址中拉取并缓存
//      marketplace 索引（git 场景下会浅克隆仓库并读取
//      `.claude-plugin/marketplace.json`，这是实际 Claude Code
//      marketplace 常见的发布路径）。
//   3. 把 marketplace.json 解析为强类型 `Marketplace`，并把其中每个插件条目的
//      `source` 从落盘线格式（字符串简写、`git-subdir`、`url` 等）统一归一化
//      为内部 `PluginSource`，让 installer 只处理一种结构。
//   4. 根据 `name@marketplace` 形式的插件 id 反查实际安装来源。
//
// 线格式与内部 `PluginSource` 的差异：
// 真正的 Claude Code 规范使用 `source` 作为判别字段，取值可能是
// `'git-subdir'`、`'url'` 等，也支持用字符串简写 monorepo 子目录
// （如 `"./plugins/foo"`）。这里会把它们全部映射成 `PluginSource`，
// 保证系统其余部分只面对一种内部结构。转换规则见
// [[normalizeMarketplaceSource]]。
//
// 所有磁盘与网络 IO 都接收 AbortSignal，这样 agent loop 中按 Esc 的取消操作
// 就能顺畅向下传递。
import { execa } from 'execa'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { z } from 'zod'

import { debugLog } from '../utils.js'
import { knownMarketplacesPath, marketplaceDir, marketplaceIndexPath } from './paths.js'
import type { KnownMarketplace, KnownMarketplaces, Marketplace, MarketplaceEntry, PluginSource } from './types.js'

// ── 保留的 marketplace 名称 ───────────────────────────────────────────

/** 只能在来源匹配官方上游时才允许注册的 marketplace 名称。
 *  这样可以防止恶意方在自己的仓库里伪造 `anthropic-marketplace`
 *  之类的名称来冒充官方来源。值为期望的 GitHub 组织名。 */
export const RESERVED_MARKETPLACE_NAMES: Readonly<Record<string, string>> = {
  'anthropic-marketplace': 'anthropics',
  'claude-plugins': 'anthropics',
  'x-code-official': 'woai3c',
}

// ── 来源归一化（线格式 → 内部 PluginSource） ──────────────────────────

/** 把 marketplace 中的 `source` 字段（落盘线格式）转换为内部 `PluginSource`。
 *  支持我们在真实 Claude Code marketplace 中见过的各种形态：
 *
 *  | Wire form                                                   | Normalised PluginSource                          |
 *  |-------------------------------------------------------------|--------------------------------------------------|
 *  | `"./plugins/foo"` or `"../shared/x"`                        | `{kind:'git', url:<marketplace-clone-url>, subdir:'plugins/foo'}` |
 *  | `"github:owner/repo[#ref]"`                                 | `{kind:'github', owner, repo, ref?}`             |
 *  | `"https://…"` or `"git@…"`                                  | `{kind:'git', url}`                              |
 *  | `{source:'git-subdir', url, path, ref?, sha?}`              | `{kind:'git', url, ref?, subdir:path}`           |
 *  | `{source:'url', url, sha?}`                                 | `{kind:'git', url}`                              |
 *  | `{source:'git', url, ref?, subdir?}`                        | `{kind:'git', url, ref?, subdir?}`               |
 *  | `{source:'github', owner, repo, ref?, subdir?}`             | `{kind:'github', owner, repo, ref?, subdir?}`    |
 *  | `{source:'local', path}`                                    | `{kind:'local', path}`                           |
 *  | `{kind:'git'\|'github'\|'local', …}` (our legacy form)       | passes through                                   |
 *
 *  相对路径字符串（如 `./plugins/foo`）需要依赖 marketplace 自身的 clone URL，
 *  因为最终要进入的是该仓库的某个子目录。这个值通过 `ctx.marketplaceCloneUrl`
 *  传入。如果 source 是相对路径但上下文里没有 clone URL，则会抛错；
 *  从原始 HTTPS 地址直接拉取的 marketplace 天然无法承载相对路径插件。
 *
 *  `git-subdir` / `url` / `github` 里的 `sha` 字段会被提取为
 *  `PluginSource.expectedSha`（要求 7-40 位十六进制，并在下方校验格式），
 *  供 installer 在克隆后通过 `git rev-parse HEAD` 做完整性检查。
 *  非十六进制或格式错误的值会被静默忽略，避免把单纯的拼写错误误当成真实篡改。 */
export function normalizeMarketplaceSource(raw: unknown, ctx: { marketplaceCloneUrl?: string } = {}): PluginSource {
  if (typeof raw === 'string') {
    if (raw.startsWith('./') || raw.startsWith('../')) {
      const cloneUrl = ctx.marketplaceCloneUrl
      if (!cloneUrl) {
        throw new Error(
          `relative source "${raw}" requires the marketplace's own clone URL, but the marketplace was fetched without one (typically because it was loaded from a raw HTTPS URL rather than a git repo)`,
        )
      }
      const subdir = raw.replace(/^\.\//, '')
      return { kind: 'git', url: cloneUrl, subdir }
    }
    if (raw.startsWith('github:')) {
      const m = raw.match(/^github:([^/]+)\/(.+?)(?:#(.+))?$/i)
      if (!m) throw new Error(`invalid github source: ${raw}`)
      return { kind: 'github', owner: m[1]!, repo: m[2]!, ref: m[3] }
    }
    if (/^https?:\/\//i.test(raw) || raw.startsWith('git@')) {
      return { kind: 'git', url: raw }
    }
    throw new Error(`unrecognised source string: ${raw}`)
  }

  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    const disc = (typeof o.source === 'string' ? o.source : (o.kind as string | undefined)) as string | undefined

    // 提取可选的 `sha` 完整性钉住值。这里接受长度不少于 7 的十六进制字符串，
    // 与 Git 对短 sha 的容忍度一致；installer 会做前缀比较，因此短 sha 也可用。
    // 对非十六进制内容尽早拒绝，避免一个拼错的值掩盖真实攻击。
    const rawSha = typeof o.sha === 'string' ? o.sha.trim().toLowerCase() : undefined
    const expectedSha = rawSha && /^[0-9a-f]{7,40}$/.test(rawSha) ? rawSha : undefined

    if (disc === 'git-subdir') {
      if (typeof o.url !== 'string' || typeof o.path !== 'string') {
        throw new Error('git-subdir source requires `url` and `path`')
      }
      return {
        kind: 'git',
        url: o.url,
        subdir: o.path,
        ref: typeof o.ref === 'string' ? o.ref : undefined,
        expectedSha,
      }
    }
    if (disc === 'url') {
      if (typeof o.url !== 'string') throw new Error('url source requires `url`')
      return { kind: 'git', url: o.url, expectedSha }
    }
    if (disc === 'git') {
      if (typeof o.url !== 'string') throw new Error('git source requires `url`')
      return {
        kind: 'git',
        url: o.url,
        ref: typeof o.ref === 'string' ? o.ref : undefined,
        subdir: typeof o.subdir === 'string' ? o.subdir : undefined,
        expectedSha,
      }
    }
    if (disc === 'github') {
      // github 来源在真实世界里常见两种形态：
      //   { owner, repo, ref?, subdir? }：owner / repo 分字段
      //   { repo: "owner/repo" }：合并成斜杠形式
      let owner = typeof o.owner === 'string' ? o.owner : undefined
      let repo = typeof o.repo === 'string' ? o.repo : undefined
      if (!owner && repo && repo.includes('/')) {
        const slash = repo.indexOf('/')
        owner = repo.slice(0, slash)
        repo = repo.slice(slash + 1)
      }
      if (!owner || !repo) {
        throw new Error('github source requires `owner` + `repo` or `repo: "owner/repo"`')
      }
      const ref = typeof o.ref === 'string' ? o.ref : typeof o.commit === 'string' ? o.commit : undefined
      return {
        kind: 'github',
        owner,
        repo,
        ref,
        subdir: typeof o.subdir === 'string' ? o.subdir : undefined,
        expectedSha,
      }
    }
    if (disc === 'local') {
      if (typeof o.path !== 'string') throw new Error('local source requires `path`')
      return { kind: 'local', path: o.path }
    }
    throw new Error(
      `unknown source discriminator: ${disc ?? '(missing)'} — accepted: git-subdir, url, git, github, local`,
    )
  }

  throw new Error('source must be a string or object')
}

// ── marketplace.json 的 Zod schema ────────────────────────────────────

// 在 zod 层，`source` 只会先校验成“字符串或对象”；
// 真正的结构识别交给 `normalizeMarketplaceSource`，因为这个联合类型的判别形式太多：
// 有的用 `source`，有的用 `kind`，不适合直接用 zod 的 discriminated union。
const wireSourceSchema = z.union([z.string().min(1), z.record(z.string(), z.unknown())])

const wireEntrySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  category: z.string().optional(),
  verified: z.boolean().optional(),
  source: wireSourceSchema,
  version: z.string().optional(),
  homepage: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  // 真实的 Claude Code 插件条目还可能带顶层 `author`。
  // 它暂时不属于 MarketplaceEntry，但这里依然接受，避免因额外字段而拒绝解析。
  author: z.unknown().optional(),
})

const wireMarketplaceSchema = z.object({
  schemaVersion: z.string().optional(),
  name: z.string().min(1),
  displayName: z.string().optional(),
  description: z.string().optional(),
  owner: z
    .object({
      name: z.string().optional(),
      url: z.string().optional(),
      email: z.string().optional(),
    })
    .optional(),
  plugins: z.array(wireEntrySchema),
})

export class MarketplaceParseError extends Error {
  constructor(
    message: string,
    public readonly sourceLabel: string, // 发生解析错误的 marketplace 标识，通常是订阅别名
  ) {
    super(message)
    this.name = 'MarketplaceParseError'
  }
}

export interface ParseMarketplaceContext {
  marketplaceCloneUrl?: string // marketplace 自身仓库的 git clone URL；用于解析 `./plugins/foo` 这类相对来源
}

/** 解析并校验 marketplace.json 字符串，同时把每个插件的 `source`
 *  归一化成内部 `PluginSource`。`sourceLabel` 会写进错误信息，
 *  便于用户知道是哪一个 marketplace 解析失败。 */
export function parseMarketplace(raw: string, sourceLabel: string, ctx: ParseMarketplaceContext = {}): Marketplace {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    throw new MarketplaceParseError(`not valid JSON: ${err instanceof Error ? err.message : String(err)}`, sourceLabel)
  }
  const result = wireMarketplaceSchema.safeParse(json)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new MarketplaceParseError(`invalid marketplace.json — ${issues}`, sourceLabel)
  }

  const normalised: MarketplaceEntry[] = []
  const sourceErrors: string[] = []
  for (let i = 0; i < result.data.plugins.length; i++) {
    const entry = result.data.plugins[i]!
    try {
      const source = normalizeMarketplaceSource(entry.source, ctx)
      normalised.push({
        name: entry.name,
        description: entry.description,
        category: entry.category,
        verified: entry.verified,
        version: entry.version,
        homepage: entry.homepage,
        keywords: entry.keywords,
        source,
      })
    } catch (err) {
      // 单个坏掉的插件条目不应该拖垮整个 marketplace，
      // 因为大多数用户依然关心目录中的其他插件。这里先收集错误，等所有条目都尝试完再统一上报。
      sourceErrors.push(`plugins.${i} (${entry.name}): ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (normalised.length === 0 && sourceErrors.length > 0) {
    throw new MarketplaceParseError(`no plugin entries parsed — ${sourceErrors.join('; ')}`, sourceLabel)
  }
  if (sourceErrors.length > 0) {
    debugLog('plugins.marketplace-source-errors', `${sourceLabel}: ${sourceErrors.join(' | ')}`)
  }

  // 这里的 `name` 必须是调用方传入的订阅别名（sourceLabel），而不是上游
  // marketplace.json 自己声明的 `name`。因为存储路径、安装 id、查找逻辑
  // 全都以“别名”为准。如果把上游名字泄漏进来，就会导致
  // `plugin marketplace info <alias>` 失败，`plugin search` 也会给插件打上错误 marketplace。
  // 为了兼顾展示，我们把上游自报名称保存在 `upstreamName` 中。
  return {
    schemaVersion: result.data.schemaVersion ?? '1',
    name: sourceLabel,
    upstreamName: result.data.name !== sourceLabel ? result.data.name : undefined,
    displayName: result.data.displayName,
    description: result.data.description,
    owner: result.data.owner ? { name: result.data.owner.name, url: result.data.owner.url } : undefined,
    plugins: normalised,
  }
}

// ── known_marketplaces.json：读 / 写 ──────────────────────────────────

/** 返回一个全新的空状态。
 *  之所以写成函数而不是常量，是为了保证每次都得到新的 `marketplaces: []`，
 *  避免某个调用方的修改意外污染下一次的“空结果”。 */
function freshKnown(): KnownMarketplaces {
  return { marketplaces: [] }
}

/** 读取已知 marketplace 订阅列表；文件不存在或损坏时返回空状态。 */
export async function readKnownMarketplaces(): Promise<KnownMarketplaces> {
  const file = knownMarketplacesPath()
  try {
    const raw = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return freshKnown()
    const obj = parsed as Record<string, unknown>
    const list = Array.isArray(obj.marketplaces) ? (obj.marketplaces as KnownMarketplace[]) : []
    return {
      marketplaces: list.filter((m) => m && typeof m.name === 'string' && typeof m.source === 'string'),
      strictKnownMarketplaces:
        typeof obj.strictKnownMarketplaces === 'boolean' ? obj.strictKnownMarketplaces : undefined,
      blockedPlugins: Array.isArray(obj.blockedPlugins)
        ? (obj.blockedPlugins as unknown[]).filter((s): s is string => typeof s === 'string')
        : undefined,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return freshKnown()
    debugLog('plugins.known-marketplaces-read-failed', String(err))
    return freshKnown()
  }
}

/** 把已知 marketplace 订阅列表写回磁盘，并尽量保留文件中本模块不认识的其他字段。 */
async function writeKnownMarketplaces(km: KnownMarketplaces): Promise<void> {
  const file = knownMarketplacesPath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  // 采用“先读再改再写”，避免把未来新增但当前模块不认识的字段直接覆盖掉。
  let existing: Record<string, unknown> = {}
  try {
    const raw = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object') existing = parsed as Record<string, unknown>
  } catch {
    // 首次写入时文件还不存在
  }
  existing.marketplaces = km.marketplaces
  if (km.strictKnownMarketplaces !== undefined) existing.strictKnownMarketplaces = km.strictKnownMarketplaces
  if (km.blockedPlugins !== undefined) existing.blockedPlugins = km.blockedPlugins
  await fs.writeFile(file, JSON.stringify(existing, null, 2) + '\n', 'utf-8')
}

/** 确保默认 marketplace 订阅存在。
 *  该函数会在 CLI 启动时调用，使全新安装默认预订阅 Anthropic 官方 marketplace，
 *  这样用户不手动添加也能直接通过 `/plugin search` 搜到结果。
 *  该操作是幂等的，不会覆盖已有条目；如果用户自己删掉过订阅，也不会被强行补回。
 *
 *  默认目标是 `anthropics/claude-plugins-official`，而不是
 *  `anthropics/claude-code` 仓库里较小的内置 marketplace，因为前者才是官方主发现入口。 */
export async function ensureDefaultMarketplaces(): Promise<void> {
  const km = await readKnownMarketplaces()
  const haveAnthropic = km.marketplaces.some((m) => m.name === 'anthropic-marketplace')
  if (haveAnthropic) return

  // 通过 addKnownMarketplace 进入，这样保留名称校验也会一起触发，
  // 并自动补上 `reservedName: true` 与 `officialSource: 'anthropics'`。
  try {
    await addKnownMarketplace({
      name: 'anthropic-marketplace',
      source: 'github:anthropics/claude-plugins-official',
    })
  } catch (err) {
    debugLog('plugins.default-marketplace-add-failed', String(err))
  }
}

/** 注册一个新的 marketplace 订阅。
 *  如果命中了保留名称，但来源并非其官方上游，就会拒绝注册。
 *  该操作是幂等的：重复添加相同名称时会更新其来源。 */
export async function addKnownMarketplace(entry: KnownMarketplace): Promise<void> {
  const reservedOrg = RESERVED_MARKETPLACE_NAMES[entry.name]
  if (reservedOrg !== undefined) {
    if (!sourceMatchesOrg(entry.source, reservedOrg)) {
      throw new Error(
        `Marketplace name "${entry.name}" is reserved; only sources under github:${reservedOrg}/* may use it. ` +
          `Got: ${entry.source}`,
      )
    }
    entry.reservedName = true
    entry.officialSource = reservedOrg
  }

  const km = await readKnownMarketplaces()
  const idx = km.marketplaces.findIndex((m) => m.name === entry.name)
  if (idx >= 0) {
    km.marketplaces[idx] = entry
  } else {
    km.marketplaces.push(entry)
  }
  await writeKnownMarketplaces(km)
}

/** 删除一个 marketplace 订阅；若不存在则返回 `noop`。 */
export async function removeKnownMarketplace(name: string): Promise<'removed' | 'noop'> {
  const km = await readKnownMarketplaces()
  const before = km.marketplaces.length
  km.marketplaces = km.marketplaces.filter((m) => m.name !== name)
  if (km.marketplaces.length === before) return 'noop'
  await writeKnownMarketplaces(km)
  return 'removed'
}

/** 判断 marketplace 来源是否属于期望的 GitHub 组织。 */
function sourceMatchesOrg(source: string, expectedOrg: string): boolean {
  // 支持 `github:org/repo[...]` 与 `https://github.com/org/repo[...]` 两种形式。
  const ghShort = source.match(/^github:([^/]+)\//i)
  if (ghShort) return ghShort[1]!.toLowerCase() === expectedOrg.toLowerCase()
  const ghHttps = source.match(/^https?:\/\/github\.com\/([^/]+)\//i)
  if (ghHttps) return ghHttps[1]!.toLowerCase() === expectedOrg.toLowerCase()
  return false
}

// ── 拉取 / 刷新 marketplace 索引 ──────────────────────────────────────

export interface FetchOptions {
  signal?: AbortSignal // 用于取消网络和子进程 IO 的 AbortSignal
  maxAgeMs?: number // 如果本地缓存存在且足够新，则跳过网络请求
}

/** 拉取最新 marketplace.json，写入本地缓存，并完成解析。
 *  支持两种来源形式：
 *
 *    - `https://...` 或 `http://...`：直接指向 marketplace.json 的地址
 *    - 其他形式（`github:owner/repo`、git URL）：先浅克隆，再读取
 *      `.claude-plugin/marketplace.json`
 *
 *  返回前还会把原始文件写入
 *  `~/.x-code/plugins/marketplaces/<name>/marketplace.json`。 */
export async function fetchMarketplace(entry: KnownMarketplace, opts: FetchOptions = {}): Promise<Marketplace> {
  const cachedPath = marketplaceIndexPath(entry.name)

  if (opts.maxAgeMs !== undefined) {
    const fresh = await isFreshEnough(cachedPath, opts.maxAgeMs)
    if (fresh) {
      const raw = await fs.readFile(cachedPath, 'utf-8')
      return parseMarketplace(raw, entry.name, contextForKnownEntry(entry))
    }
  }

  const isHttp = /^https?:\/\//i.test(entry.source) && /\.json($|\?)/i.test(entry.source)
  const rawJson = isHttp
    ? await fetchHttpJson(entry.source, opts.signal)
    : await fetchViaShallowClone(entry.source, opts.signal)

  const marketplace = parseMarketplace(rawJson, entry.name, contextForKnownEntry(entry))

  await fs.mkdir(marketplaceDir(entry.name), { recursive: true })
  await fs.writeFile(cachedPath, rawJson, 'utf-8')

  return marketplace
}

/** 根据已知 marketplace 条目构造 `ParseMarketplaceContext`。
 *  对 git 克隆型 marketplace，会提供 clone URL，便于将
 *  `"./plugins/foo"` 这类相对来源解析为其自身仓库中的子目录。
 *  对原始 HTTPS marketplace，则不存在 clone URL，因此相对来源会正确地解析失败。 */
function contextForKnownEntry(entry: KnownMarketplace): ParseMarketplaceContext {
  const isRawHttps = /^https?:\/\//i.test(entry.source) && /\.json($|\?)/i.test(entry.source)
  if (isRawHttps) return {}
  return { marketplaceCloneUrl: resolveCloneUrl(entry.source) }
}

/** 判断某个缓存文件是否仍在有效期内。 */
async function isFreshEnough(filePath: string, maxAgeMs: number): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath)
    return Date.now() - stat.mtimeMs <= maxAgeMs
  } catch {
    return false
  }
}

/** 通过 HTTP 拉取 marketplace.json 文本。 */
async function fetchHttpJson(url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, { signal })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} fetching ${url}`)
  }
  return res.text()
}

/** 把指定来源的仓库浅克隆到临时目录，并返回 marketplace 索引内容。
 *  会优先探测标准路径 `.claude-plugin/marketplace.json`，若不存在，
 *  再回退到根目录 `marketplace.json`。无论成功失败，返回前都会删除临时克隆目录。 */
async function fetchViaShallowClone(source: string, signal?: AbortSignal): Promise<string> {
  const cloneUrl = resolveCloneUrl(source)
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-marketplace-'))
  try {
    await execa('git', ['clone', '--depth', '1', cloneUrl, tempDir], { signal, stdio: 'pipe' })
    const candidates = [
      path.join(tempDir, '.claude-plugin', 'marketplace.json'),
      path.join(tempDir, 'marketplace.json'),
    ]
    for (const candidate of candidates) {
      try {
        return await fs.readFile(candidate, 'utf-8')
      } catch {
        // 继续尝试下一个候选路径
      }
    }
    throw new Error(
      `marketplace repo ${cloneUrl} has no .claude-plugin/marketplace.json (also tried root marketplace.json)`,
    )
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {
      /* 尽力清理 */
    })
  }
}

/** 把来源字符串转换成 `git clone` 可直接理解的地址。
 *  例如 `github:owner/repo` 会变成 `https://github.com/owner/repo.git`；
 *  其他形式（真实 git URL、ssh 等）则原样透传。 */
export function resolveCloneUrl(source: string): string {
  const m = source.match(/^github:([^/]+)\/(.+?)(?:\.git)?$/i)
  if (m) {
    return `https://github.com/${m[1]}/${m[2]}.git`
  }
  return source
}

// ── 查找辅助函数 ──────────────────────────────────────────────────────

/** 读取所有已缓存的 marketplace 索引。
 *  供 `/plugin search` 与 `/plugin install <name@marketplace>` 查找使用。
 *  如果某个 marketplace 的缓存损坏，会跳过并记录日志，而不会影响其他 marketplace。 */
export async function readAllCachedMarketplaces(): Promise<Marketplace[]> {
  const km = await readKnownMarketplaces()
  const out: Marketplace[] = []
  for (const entry of km.marketplaces) {
    try {
      const raw = await fs.readFile(marketplaceIndexPath(entry.name), 'utf-8')
      out.push(parseMarketplace(raw, entry.name, contextForKnownEntry(entry)))
    } catch (err) {
      debugLog('plugins.marketplace-cache-read-failed', `${entry.name}: ${String(err)}`)
    }
  }
  return out
}

/** 根据 `name@marketplace` id 查找单个插件条目。
 *  当 marketplace 未订阅，或插件不在其列表中时，返回 `undefined`。 */
export async function lookupPlugin(
  pluginId: string,
): Promise<{ marketplace: Marketplace; entry: MarketplaceEntry } | undefined> {
  const at = pluginId.lastIndexOf('@')
  if (at <= 0) return undefined
  const pluginName = pluginId.slice(0, at)
  const marketplaceName = pluginId.slice(at + 1)

  const km = await readKnownMarketplaces()
  const known = km.marketplaces.find((m) => m.name === marketplaceName)

  try {
    const raw = await fs.readFile(marketplaceIndexPath(marketplaceName), 'utf-8')
    const m = parseMarketplace(raw, marketplaceName, known ? contextForKnownEntry(known) : {})
    const entry = m.plugins.find((p) => p.name === pluginName)
    if (!entry) return undefined
    return { marketplace: m, entry }
  } catch {
    return undefined
  }
}
