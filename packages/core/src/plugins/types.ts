// @x-code-cli/core — 插件系统核心类型
//
// 插件通过一个统一的 manifest 和命名空间，打包 skills / sub-agents /
// slash commands / MCP servers / hooks 等能力。插件会在 CLI 启动时被发现，
// 并在当前会话中保持冻结（与 skills、sub-agents 一样，受 systemPromptCache
// 字节稳定性约束影响）；只有显式执行 `/plugin refresh` 时才会重载，并同步使
// prompt cache 失效。
//
// manifest 格式刻意与 Claude Code 的 `.claude-plugin/plugin.json`
// 保持字节兼容，这样同一个插件包既可以安装到 Claude Code，也可以安装到本 CLI。
// 同时也接受原生 `.x-code-plugin/plugin.json` 路径（更适合全新编写的 x-code 专属插件），
// 以及根目录裸放的 `plugin.json`。

// ── 插件来源（它从哪里安装而来） ──────────────────────────────────────

/** 插件安装来源的内部标准表示。
 *  installer 会使用它，并把它写入 `installed_plugins.json`。
 *  marketplace 条目最初的落盘结构可能是字符串简写、`git-subdir`、`url`
 *  等不同形态，都会先通过 [[normalizeMarketplaceSource]] 归一化成这里的结构。
 *  `subdir` 在 git 与 github 两种来源上都支持，因此 monorepo 发布的插件
 *  也能被正确安装。
 *
 *  `expectedSha` 是一个可选的完整性钉住值，来源于 git 类 source 在
 *  marketplace.json 中声明的 `sha`。如果设置了它，installer 会在克隆后执行
 *  `git rev-parse HEAD`，并在不匹配时以 `InstallError` 中止安装。
 *  这样可以防止上游 ref 被强推，或者 marketplace 作者审阅之后仓库再被篡改。
 *  如果没设置该字段，则跳过此检查。 */
export type PluginSource =
  | { kind: 'git'; url: string; ref?: string; subdir?: string; expectedSha?: string }
  | { kind: 'github'; owner: string; repo: string; ref?: string; subdir?: string; expectedSha?: string }
  | { kind: 'local'; path: string }

/** 插件启用状态支持两个作用域，与 mcp 和 skill 的约定保持一致：
 *
 *    'user'     →  ~/.x-code/settings.json
 *    'project'  →  <cwd>/.x-code/settings.local.json  (gitignored)
 *
 *  这里 `'project'` 对应的是 `.local.json` 文件，这个命名习惯沿袭自 skills：
 *  它其实是“限定在某个仓库里的个人覆写”，并不是团队共享配置。
 *  如果未来要加入可提交的团队级作用域，也可以在不破坏这个联合类型的前提下扩展。 */
export type PluginScope = 'user' | 'project'

// ── Manifest（插件作者编写的契约） ────────────────────────────────────

export interface PluginAuthor {
  name?: string // 作者名称
  email?: string // 作者邮箱
  url?: string // 作者主页或资料链接
}

/** 单个需要向用户询问的配置项（如 API Key、Base URL 等）。
 *  结构尽量与 Claude Code 保持一致，这样同一插件无需为两个 CLI 分别写配置块。 */
export interface UserConfigItem {
  key: string // 配置项键名，同时也是后续环境变量展开时使用的键
  type: 'string' | 'number' | 'boolean' // 配置项类型
  sensitive?: boolean // 是否视为敏感信息；用于决定输入时是否遮罩等处理
  prompt?: string // 向用户展示的提问文案
  required?: boolean // 是否必填
  default?: string | number | boolean // 默认值
  description?: string // 配置项说明文字
}

/** 内联 hook 配置（作为 hooks 文件路径的替代方案）。
 *  这里故意保持宽松，完整校验放在 hooks 自己的 config-schema 中，
 *  这样 hooks 层的变更就不必反向侵入插件层。 */
export type InlineHookConfig = Record<string, unknown>

/** 内联 mcpServers 配置（作为文件路径字符串的替代方案）。
 *  它与 `~/.x-code/config.json` 中的 `mcpServers` 结构一致，校验也复用 MCP 现有 schema。 */
export type InlineMcpServers = Record<string, unknown>

export interface MarketplaceOwner {
  name?: string // marketplace 所有者名称
  url?: string // marketplace 所有者主页
}

export interface PluginEngines {
  'x-code'?: string // 插件声明兼容的 x-code 版本范围
}

/** 从磁盘解析出来的插件 manifest。
 *  所有路径字段都先保留原始值，真正相对插件根目录的解析由 [[loader]] 完成。
 *  源 JSON 中的未知字段会按 zod 默认行为静默剥离，这样即便未来 Claude Code
 *  manifest 新增了我们暂不认识的字段，也依然能正常加载。 */
export interface PluginManifest {
  schemaVersion: string // manifest schema 版本；缺失时默认是 "1"
  name: string // 插件名称
  version: string // 插件版本号
  description?: string // 插件简介
  author?: PluginAuthor // 作者信息
  keywords?: string[] // 关键词列表，便于搜索与分类
  homepage?: string // 插件主页
  license?: string // 许可证标识

  // ── 插件贡献内容（全部可选，且都相对插件根目录） ────────────────────
  skills?: string // skills 目录路径，或单个 skill 文件路径
  agents?: string // sub-agent `.md` 文件目录路径
  commands?: string // slash command `.md` 文件目录路径
  mcpServers?: string | InlineMcpServers // MCP servers 配置，可为 JSON 文件路径或内联对象
  hooks?: string | InlineHookConfig // hooks 配置，可为 hooks.json 路径或内联对象

  // ── 插件作者暴露给用户、由安装过程填写的配置项 ─────────────────────
  userConfig?: UserConfigItem[] // 需要在安装时向用户采集的配置列表

  // ── 插件间依赖与运行时兼容性 ────────────────────────────────────────
  dependencies?: string[] // 依赖插件列表；支持 `name@marketplace`，裸 `name` 默认解析到同 marketplace
  engines?: PluginEngines // 对 x-code 版本的兼容范围声明
}

// ── 已加载插件（运行时注册表真正持有的结构） ──────────────────────────

/** 表示最终加载的是哪种 manifest 形式。
 *  `'gemini'` 在正常加载路径中不会真正进入运行时；Gemini 扩展会在安装阶段就被拒绝。
 *  保留这个值只是为了错误提示时能明确告诉用户“这看起来是 Gemini 扩展，当前不支持”。 */
export type ManifestFormat = 'native' | 'claude' | 'bare' | 'gemini'

export interface LoadedPlugin {
  id: string // 组合 id，格式为 `name@marketplace`；本地插件的 marketplace 为 `"local"`
  manifest: PluginManifest // 解析后的插件 manifest
  rootDir: string // 插件根目录的绝对路径
  manifestPath: string // 实际加载到的 manifest 文件绝对路径
  manifestFormat: ManifestFormat // manifest 的来源格式
  source: PluginSource | undefined // 插件最初安装来源；手工塞入缓存且无元数据时可能为空
  marketplace: string // 所属 marketplace 名称；本地插件为 `"local"`
  scope: PluginScope // 安装或启用所处的作用域
  enabled: boolean // 合并各层设置后的最终启用状态
}

/** 非致命插件加载错误。
 *  这类错误会被 loader 收集，并通过 `/plugin doctor` 暴露出来。
 *  单个坏插件绝不能拖垮整个 CLI。 */
export interface PluginLoadError {
  id?: string // 如果已经解析到足够信息，则填入 `name@marketplace`
  path: string // 触发错误的文件系统路径，即使 manifest 尚未成功解析也会保留
  message: string // 面向诊断输出的错误信息
}

// ── Marketplace（索引 / 目录格式） ────────────────────────────────────

/** marketplace 中的一条插件目录项。
 *  其中 `source` 告诉 installer 应该去哪里拉取插件。 */
export interface MarketplaceEntry {
  name: string // 插件名称
  description?: string // 插件简介
  category?: string // 插件分类
  verified?: boolean // marketplace 维护者标记的“已审核”状态；仅用于展示，不代表额外信任
  source: PluginSource // 插件安装来源
  version?: string // 若 marketplace 已钉死版本则写在这里，否则由拉取后的 manifest 决定
  homepage?: string // 插件主页
  keywords?: string[] // 用于搜索和分类的关键词
}

export interface Marketplace {
  schemaVersion: string // marketplace schema 版本
  name: string // 用户侧的规范身份，即订阅别名；存储路径、安装 id、查找逻辑都以它为准
  upstreamName?: string // 上游 marketplace.json 自报的名称，仅用于展示差异，不参与查找身份
  displayName?: string // 更友好的展示名称
  description?: string // marketplace 简介
  owner?: MarketplaceOwner // marketplace 所有者信息
  plugins: MarketplaceEntry[] // 收录的插件条目列表
}

/** `~/.x-code/plugins/known_marketplaces.json` 中的一条记录，
 *  表示用户订阅的一个 marketplace。 */
export interface KnownMarketplace {
  name: string // marketplace 订阅名称或别名
  source: string // 来源字符串，可以是 git URL，也可以是直接指向 marketplace.json 的 HTTPS 地址
  reservedName?: boolean // 是否属于保留名称；保留名称只允许绑定到其官方来源
  officialSource?: string // 保留名称期望绑定的官方 GitHub 组织名
}

export interface KnownMarketplaces {
  marketplaces: KnownMarketplace[] // 已订阅 marketplace 列表
  strictKnownMarketplaces?: boolean // 为 true 时，只允许从已订阅 marketplace 安装插件
  blockedPlugins?: string[] // 被强制禁用的插件 id 列表，不受普通用户设置影响
}

// ── 已安装插件注册表（~/.x-code/plugins/installed_plugins.json） ────────

/** 已安装插件注册表中的一条记录。
 *  它保存每个缓存安装的台账信息，便于更新、卸载、切换作用域时无需重新扫描所有 manifest。 */
export interface InstalledPluginRecord {
  id: string // 插件组合 id，格式为 `name@marketplace`
  name: string // 插件名称
  marketplace: string // 所属 marketplace
  version: string // 已安装版本
  source: PluginSource // 实际安装来源
  installedAt: string // 安装时间，通常为 ISO 字符串
  installScope: PluginScope // 触发本次安装的作用域，也决定启用状态该记到哪份 settings 中
}

export interface InstalledPlugins {
  schemaVersion: string // 已安装插件注册表的 schema 版本
  plugins: InstalledPluginRecord[] // 已安装插件记录列表
}
