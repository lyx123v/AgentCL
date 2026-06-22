// @x-code-cli/core — 插件启动加载器
//
// 这是 CLI 入口处调用的一次性编排流程，共分两轮：
//
//   第 1 轮：从 installed_plugins.json 加载用户作用域已安装插件。
//           每条记录都指向一个带版本号的缓存目录，我们按记录指定的版本加载。
//           如果记录存在但缓存目录缺失，则作为 PluginLoadError 上报。
//
//   第 2 轮：扫描 <cwd>/.x-code/plugins/<name>/ 下的项目本地插件。
//           这些插件不会记录进 installed_plugins.json，而是直接作为仓库
//           内插件存在。它们的 marketplace 名始终视为 "local"。
//
// 对用户作用域安装而言，`installed_plugins.json` 是唯一事实来源。
// 反过来，孤儿缓存目录（有缓存、无记录）会被静默忽略，下次执行
// `/plugin uninstall` 时自然会清理。
//
// 单个损坏插件（坏 JSON、缺失 manifest、schema 违规）不会中断整个启动，
// 错误会收集进 `PluginLoadError[]` 供 `/plugin doctor` 展示。
//
// 返回的 `PluginRegistry` 预期在整个会话期间保持冻结
//（与 MCP / skills 一样受字节稳定性约束，见 CLAUDE.md）。
// CLI 启动时会调用一次 `loadAllPlugins()` 并把结果挂到 `AgentOptions`。
// `/plugin refresh` 则通过 `registry.reload(...)` 替换内存态，并让
// `systemPromptCache` 失效。
import fs from 'node:fs/promises'
import path from 'node:path'

import { EnableState } from './enable-state.js'
import { listInstalledPlugins } from './installer.js'
import { ManifestParseError, discoverManifest, parseManifest } from './manifest.js'
import { pluginCacheDir, projectPluginsDir } from './paths.js'
import { PluginRegistry } from './registry.js'
import type {
  InlineHookConfig,
  InlineMcpServers,
  LoadedPlugin,
  PluginLoadError,
  PluginManifest,
  PluginScope,
  PluginSource,
} from './types.js'

export interface LoadOptions {
  cwd: string // 当前工作目录，用于查找项目本地插件
  disabled?: boolean // 是否完全跳过插件加载；对应启动参数 `--no-plugins`
}

export interface LoadResult {
  registry: PluginRegistry // 已加载完成的插件注册表
  contributions: Map<string, ResolvedContributions> // 每个插件解析后的贡献路径信息，键为插件 id
}

/** 插件 manifest 中贡献项的解析结果，所有相对路径都会基于 `rootDir`
 *  展开。`mcpServers` 和 `hooks` 使用 `path` / `inline` 区分，
 *  对应 manifest 允许“指向文件”或“直接内联配置”两种写法。 */
export interface ResolvedContributions {
  skillsDir?: string // 插件 skills 目录的绝对路径（如果存在）
  agentsDir?: string // 插件 sub-agent `.md` 文件目录的绝对路径
  commandsDir?: string // 插件 slash command `.md` 文件目录的绝对路径
  mcpServers?: { kind: 'path'; path: string } | { kind: 'inline'; data: InlineMcpServers } // mcpServers 贡献内容
  hooks?: { kind: 'path'; path: string } | { kind: 'inline'; data: InlineHookConfig } // hooks 贡献内容
}

/** 按当前启动上下文加载所有可见插件。 */
export async function loadAllPlugins(opts: LoadOptions): Promise<LoadResult> {
  if (opts.disabled) {
    return { registry: new PluginRegistry([], []), contributions: new Map() }
  }

  const enableState = await EnableState.load(opts.cwd)
  const plugins: LoadedPlugin[] = []
  const errors: PluginLoadError[] = []
  const contributions = new Map<string, ResolvedContributions>()

  // ── 第 1 轮：用户作用域安装插件 ───────────────────────────────────────
  const installed = await listInstalledPlugins()
  for (const record of installed) {
    const rootDir = pluginCacheDir(record.marketplace, record.name, record.version)
    await loadOnePlugin({
      rootDir,
      fallbackId: record.id,
      marketplace: record.marketplace,
      scope: record.installScope,
      source: record.source,
      enableState,
      plugins,
      errors,
      contributions,
    })
  }

  // ── 第 2 轮：项目本地插件 ────────────────────────────────────────────
  const projectRoot = projectPluginsDir(opts.cwd)
  let projectEntries: import('node:fs').Dirent[] = []
  try {
    projectEntries = await fs.readdir(projectRoot, { withFileTypes: true })
  } catch {
    /* 没有项目插件目录属于常见情况 */
  }
  for (const entry of projectEntries) {
    if (!entry.isDirectory()) continue
    const pluginRoot = path.join(projectRoot, entry.name)
    await loadOnePlugin({
      rootDir: pluginRoot,
      // 先用目录名生成临时 id，真正解析 manifest 后会被 manifest.name 覆盖。
      fallbackId: `${entry.name}@local`,
      marketplace: 'local',
      scope: 'project',
      source: undefined,
      enableState,
      plugins,
      errors,
      contributions,
    })
  }

  return { registry: new PluginRegistry(plugins, errors), contributions }
}

interface LoadOneArgs {
  rootDir: string // 插件根目录
  fallbackId: string // manifest 尚未解析成功前使用的兜底插件 id
  marketplace: string // 插件所属 marketplace 名称
  scope: PluginScope // 插件所属作用域
  source: PluginSource | undefined // 插件来源；项目内插件时可能为空
  enableState: EnableState // 已加载好的启用状态快照
  plugins: LoadedPlugin[] // 成功加载出的插件集合
  errors: PluginLoadError[] // 失败信息收集数组
  contributions: Map<string, ResolvedContributions> // 每个插件的贡献解析结果映射
}

/** 加载单个插件，并把成功结果或错误写入共享收集容器。 */
async function loadOnePlugin(args: LoadOneArgs): Promise<void> {
  try {
    const discovery = await discoverManifest(args.rootDir)
    if (!discovery) {
      args.errors.push({
        id: args.fallbackId,
        path: args.rootDir,
        message:
          '未找到插件 manifest（已检查 .x-code-plugin/plugin.json、.claude-plugin/plugin.json、plugin.json）',
      })
      return
    }
    if (discovery.format === 'gemini') {
      args.errors.push({
        id: args.fallbackId,
        path: args.rootDir,
        message: '暂不支持 Gemini 扩展（检测到 gemini-extension.json），详见 docs/plugins.md',
      })
      return
    }

    let manifest: PluginManifest
    try {
      manifest = await parseManifest(discovery.manifestPath)
    } catch (err) {
      args.errors.push({
        id: args.fallbackId,
        path: args.rootDir,
        message: err instanceof ManifestParseError ? err.message : String(err),
      })
      return
    }

    // 规范插件 id 永远以 manifest 为准，而不是缓存目录名。
    // 对已安装插件来说它通常与记录中的 id 一致；对项目本地插件来说，
    // 它可能与目录名不同，此时以 manifest 为最终准绳。
    const id = `${manifest.name}@${args.marketplace}`
    const enableResolution = args.enableState.resolve(id)

    const plugin: LoadedPlugin = {
      id,
      manifest,
      rootDir: args.rootDir,
      manifestPath: discovery.manifestPath,
      manifestFormat: discovery.format,
      source: args.source,
      marketplace: args.marketplace,
      scope: args.scope,
      enabled: enableResolution.enabled,
    }
    args.plugins.push(plugin)
    args.contributions.set(id, await resolveContributions(plugin))
  } catch (err) {
    args.errors.push({
      id: args.fallbackId,
      path: args.rootDir,
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

/** 把插件 manifest 中的贡献字段解析为绝对路径或内联对象。
 *  导出它是因为某些调用方偶尔需要为单个插件重新计算结果，
 *  例如 `/plugin info`。
 *
 *  **每类贡献都会经历两轮发现：**
 *
 *  1. **manifest 显式声明优先**：如果 manifest 指定了路径
 *     （例如 `"skills": "./my-skills"`），就直接使用。
 *  2. **约定式回退探测**：如果没有显式声明，则探测约定目录
 *     （`skills/`、`agents/`、`commands/`）和约定文件
 *     （`hooks/hooks.json`、`.mcp.json`、`mcp.json`）。
 *     真实的 Claude Code 插件经常采用这种布局：manifest 里只写
 *     `name` / `version` / `description`，实际贡献内容直接放在旁边。
 *
 *  这里必须是异步函数，因为约定式探测需要对磁盘路径执行 stat。 */
export async function resolveContributions(plugin: LoadedPlugin): Promise<ResolvedContributions> {
  const m = plugin.manifest
  const root = plugin.rootDir
  const result: ResolvedContributions = {}

  // skills / agents / commands：目录类贡献
  if (m.skills) {
    result.skillsDir = path.resolve(root, m.skills)
  } else if (await isDir(path.join(root, 'skills'))) {
    result.skillsDir = path.join(root, 'skills')
  }
  if (m.agents) {
    result.agentsDir = path.resolve(root, m.agents)
  } else if (await isDir(path.join(root, 'agents'))) {
    result.agentsDir = path.join(root, 'agents')
  }
  if (m.commands) {
    result.commandsDir = path.resolve(root, m.commands)
  } else if (await isDir(path.join(root, 'commands'))) {
    result.commandsDir = path.join(root, 'commands')
  }

  // mcpServers：既可显式声明（路径 / 内联），也可从约定文件自动发现
  if (m.mcpServers !== undefined) {
    if (typeof m.mcpServers === 'string') {
      result.mcpServers = { kind: 'path', path: path.resolve(root, m.mcpServers) }
    } else {
      result.mcpServers = { kind: 'inline', data: m.mcpServers }
    }
  } else {
    // Claude Code 习惯在插件根目录使用 `.mcp.json`。
    // 这里也接受不带点前缀的 `mcp.json` 作为务实回退，
    // 因为有些作者会采用这个更直观的命名。
    for (const conv of ['.mcp.json', 'mcp.json']) {
      const p = path.join(root, conv)
      if (await isFile(p)) {
        result.mcpServers = { kind: 'path', path: p }
        break
      }
    }
  }

  // hooks：同样的规则，约定文件为 `hooks/hooks.json`
  if (m.hooks !== undefined) {
    if (typeof m.hooks === 'string') {
      result.hooks = { kind: 'path', path: path.resolve(root, m.hooks) }
    } else {
      result.hooks = { kind: 'inline', data: m.hooks }
    }
  } else {
    const conv = path.join(root, 'hooks', 'hooks.json')
    if (await isFile(conv)) {
      result.hooks = { kind: 'path', path: conv }
    }
  }

  return result
}

/** 判断给定路径是否为目录。 */
async function isDir(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p)
    return s.isDirectory()
  } catch {
    return false
  }
}

/** 判断给定路径是否为文件。 */
async function isFile(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p)
    return s.isFile()
  } catch {
    return false
  }
}
