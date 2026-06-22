// @x-code-cli/core — 安装阶段的用户同意预览
//
// 在插件内容真正写入缓存之前，安装器会构建一份 `ConsentPreview`，
// 用来概览这个插件会带来哪些能力（hooks、MCP 服务、作用域等），再把
// 它交给调用方传入的 consent 回调。如果回调返回 false，则安装中止，
// 并清理临时目录。
//
// 这份预览建立在“已经成功解析过的 manifest”之上，因此到真正询问用户
// “是否接受” 时，我们已经知道这个插件能否被正确解析，以及它打算对
// 当前系统产生哪些影响。
//
// 它有意不包含以下信息：
//
//   - skill / agent / command 的数量（这些内容藏在子目录里；
//     如果为了做预览还要提前深度扫描，会拖慢每一次安装，而这份预览
//     的目标是快速浏览，不是完整审计）
//   - LICENSE 文件正文，只展示许可证名称；真正条款应通过 homepage
//     或源码地址查看
//
// 它重点包含的是那些真正涉及安全影响面的内容：
// hooks（可执行任意 shell）、MCP 服务（可启动任意子进程）、以及
// source（让用户知道来源是可信市场还是随便一个 GitHub 仓库）。
import fs from 'node:fs/promises'
import path from 'node:path'

import { parseHookConfig } from '../hooks/config-schema.js'
import type { HookEventName } from '../hooks/types.js'
import { parseServersBlock } from '../mcp/config-schema.js'
import { extractMcpServersBlock } from './integration.js'
import type { PluginManifest, PluginSource } from './types.js'

export interface ConsentPreview {
  pluginId: string // 插件完整 id，格式通常为 `name@marketplace`
  version: string // 插件版本号
  description?: string // 插件描述
  source: PluginSource // 插件安装来源
  marketplace: string // 插件所属 marketplace 名称
  verified: boolean // 是否来自被标记为 `verified` 的 marketplace 条目
  fromReservedMarketplace: boolean // marketplace 名称是否属于 `RESERVED_MARKETPLACE_NAMES` 保留名单
  hookEvents: HookEventName[] // 插件注册的 hook 事件名列表；为空表示没有 hooks
  inlineMcpServerNames: string[] // 以内联形式贡献的 MCP 服务名称；路径形式不会在这里展开预览
  hasSkillsDir: boolean // 是否存在 skills 目录贡献
  hasAgentsDir: boolean // 是否存在 agents 目录贡献
  hasCommandsDir: boolean // 是否存在 commands 目录贡献
  hasPathMcpServers: boolean // manifest 是否以文件路径方式声明了 `mcpServers`
  hasPathHooks: boolean // hooks 是否也是以路径形式声明，而不是内联对象
  author?: string // 作者名称
  license?: string // 许可证名称
  homepage?: string // 项目主页地址
}

/** 插件根目录在文件系统层面的探测结果。
 *  这些信息单看 manifest 是拿不到的。它由 [[probePluginRoot]] 填充，
 *  再传给 [[buildConsentPreview]]，这样安装阶段的“将贡献内容”一栏
 *  就能反映那些自动发现的贡献（例如 Claude Code 常见的约定：
 *  直接在 plugin.json 旁边放一个 `.mcp.json`，而不是写进 manifest）。 */
export interface RootProbe {
  hasSkillsDir: boolean // 是否存在 skills 目录
  hasAgentsDir: boolean // 是否存在 agents 目录
  hasCommandsDir: boolean // 是否存在 commands 目录
  rootMcpServerNames: string[] // 从根目录 `.mcp.json` / `mcp.json` 中解析出的服务名列表
  hasRootMcpFile: boolean // 根目录下是否存在 mcp 配置文件
  rootHookEvents: HookEventName[] // 若根目录存在 `hooks/hooks.json`，这里记录解析出的 hook 事件名
  hasRootHooksFile: boolean // `hooks/hooks.json` 是否存在，不受解析是否成功影响
}

export interface BuildPreviewInput {
  pluginId: string // 插件完整 id
  manifest: PluginManifest // 已解析完成的插件 manifest
  source: PluginSource // 插件来源
  marketplace: string // marketplace 名称
  verified?: boolean // marketplace 条目是否标记为 verified
  fromReservedMarketplace?: boolean // 是否来自保留 marketplace 名称
  rootProbe?: RootProbe // 可选的插件根目录探测结果
}

/** 探测插件根目录里那些遵循约定的贡献文件和目录。
 *  这些内容会在运行时被 loader 的 `resolveContributions` 自动拾取。
 *  同意界面依赖它，是为了避免插件明明在根目录放了 `skills/`、
 *  `.mcp.json` 等内容，却因为没写进 manifest 而让“将贡献内容”这一栏
 *  显示失真。
 *  这个方法可以安全地对任意目录调用：所有探测都属于尽力而为的
 *  stat / read，缺失或不可读统一按“不存在”处理。 */
export async function probePluginRoot(rootDir: string): Promise<RootProbe> {
  const [hasSkillsDir, hasAgentsDir, hasCommandsDir] = await Promise.all([
    isDir(path.join(rootDir, 'skills')),
    isDir(path.join(rootDir, 'agents')),
    isDir(path.join(rootDir, 'commands')),
  ])

  let rootMcpServerNames: string[] = []
  let hasRootMcpFile = false
  for (const conv of ['.mcp.json', 'mcp.json']) {
    const p = path.join(rootDir, conv)
    if (!(await isFile(p))) continue
    hasRootMcpFile = true
    try {
      const raw = await fs.readFile(p, 'utf-8')
      const parsed = JSON.parse(raw) as unknown
      const block = extractMcpServersBlock(parsed)
      const { servers } = parseServersBlock(block)
      rootMcpServerNames = Object.keys(servers)
    } catch {
      // 解析错误在这里故意吞掉，后续加载阶段会给出更精确的报错。
      // 同意预览阶段只需要知道这个文件存在即可。
    }
    break
  }

  let rootHookEvents: HookEventName[] = []
  let hasRootHooksFile = false
  const hooksPath = path.join(rootDir, 'hooks', 'hooks.json')
  if (await isFile(hooksPath)) {
    hasRootHooksFile = true
    try {
      const raw = await fs.readFile(hooksPath, 'utf-8')
      const parsed = JSON.parse(raw)
      const cfg = parseHookConfig(parsed, rootDir)
      rootHookEvents = Object.keys(cfg) as HookEventName[]
    } catch {
      // 与 mcp 探测同理，以加载阶段的正式错误为准。
    }
  }

  return {
    hasSkillsDir,
    hasAgentsDir,
    hasCommandsDir,
    rootMcpServerNames,
    hasRootMcpFile,
    rootHookEvents,
    hasRootHooksFile,
  }
}

/** 判断指定路径是否为目录。 */
async function isDir(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p)
    return s.isDirectory()
  } catch {
    return false
  }
}

/** 判断指定路径是否为文件。 */
async function isFile(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p)
    return s.isFile()
  } catch {
    return false
  }
}

/** 基于已解析的 manifest 构建 `ConsentPreview`。
 *  hook 与 mcp 字段只会在“内联对象”形式下直接展开；如果是“路径形式”，
 *  则只通过 `has*` 布尔字段反映其存在，让同意界面至少能提醒用户
 *  “这个插件会贡献 MCP 服务”，即使当下还不知道具体服务名。
 *
 *  当传入 `input.rootProbe` 时，还会把根目录下按约定自动发现到的贡献
 * （例如未在 manifest 中声明的 `.mcp.json`、`hooks/hooks.json`、
 *  `skills/` 等）一并合入，因为运行时 loader 会拾取这些内容，
 *  所以同意界面现在也必须提前知道。 */
export function buildConsentPreview(input: BuildPreviewInput): ConsentPreview {
  const m = input.manifest
  const probe = input.rootProbe

  let hookEvents: HookEventName[] = []
  let hasPathHooks = false
  if (m.hooks !== undefined) {
    if (typeof m.hooks === 'string') {
      hasPathHooks = true
    } else {
      try {
        const cfg = parseHookConfig(m.hooks, input.pluginId)
        hookEvents = Object.keys(cfg) as HookEventName[]
      } catch {
        // 不要因为 hook 解析失败就让同意流程直接失败，正式安装路径会
        // 更准确地把错误暴露出来。这里保持 hookEvents 为空，避免预览
        // 对“已注册了什么”给出错误信息。
      }
    }
  } else if (probe?.hasRootHooksFile) {
    hookEvents = probe.rootHookEvents
    hasPathHooks = true
  }

  let inlineMcpServerNames: string[] = []
  let hasPathMcpServers = false
  if (m.mcpServers !== undefined) {
    if (typeof m.mcpServers === 'string') {
      hasPathMcpServers = true
    } else {
      const { servers } = parseServersBlock(m.mcpServers)
      inlineMcpServerNames = Object.keys(servers)
    }
  } else if (probe?.hasRootMcpFile) {
    // 这是按约定在插件根目录发现的 `.mcp.json`，其影响面与 manifest
    // 中显式声明路径形式的 mcpServers 一样。能解析出名字就展示名字，
    // 解析不出时至少也要标记“这个文件存在”。
    inlineMcpServerNames = probe.rootMcpServerNames
    hasPathMcpServers = true
  }

  return {
    pluginId: input.pluginId,
    version: m.version,
    description: m.description,
    source: input.source,
    marketplace: input.marketplace,
    verified: input.verified ?? false,
    fromReservedMarketplace: input.fromReservedMarketplace ?? false,
    hookEvents,
    inlineMcpServerNames,
    hasSkillsDir: !!m.skills || !!probe?.hasSkillsDir,
    hasAgentsDir: !!m.agents || !!probe?.hasAgentsDir,
    hasCommandsDir: !!m.commands || !!probe?.hasCommandsDir,
    hasPathMcpServers,
    hasPathHooks,
    author: m.author?.name,
    license: m.license,
    homepage: m.homepage,
  }
}
