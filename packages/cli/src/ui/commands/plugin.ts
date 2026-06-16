// @x-code-cli/cli - /plugin slash 命令处理器家族。
//
// 从 App.tsx 中抽出来的单一工厂函数，会闭包捕获 plugin 子命令需要的依赖：
// 四个子 registry（plugin / skill / sub-agent / command）、MCP registry
//（用于同一轮内的 refresh）、hook bus、prompt cache 失效器，以及
// skill-registry 版本计数器（让 /help 和 tab completion 重新计算）。
//
// 子命令包括：list / info / install / uninstall / enable / disable /
// search / update / refresh / doctor / marketplace（它还有自己的
// add / remove / list / refresh / info 子树）。未知子命令会打印用法提示。
import {
  addKnownMarketplace,
  clearPluginEntry,
  fetchMarketplace,
  installPlugin,
  listInstalledPlugins,
  lookupPlugin,
  readAllCachedMarketplaces,
  readKnownMarketplaces,
  refreshPluginContributions,
  removeKnownMarketplace,
  resolveContributions,
  setPluginEnabled,
  uninstallPlugin,
} from '@x-code-cli/core'
import type { AgentOptions, PluginScope, PluginSource } from '@x-code-cli/core'

export interface PluginCommandDeps {
  options: AgentOptions
  addCommandMessage: (text: string, content: string) => void
  askQuestion: (
    question: string,
    options: { label: string; description: string }[],
    opts?: { noOther?: boolean },
  ) => Promise<string>
  invalidateSystemPromptCache: () => void
  bumpSkillRegistryVersion: () => void
}

function formatPluginSource(s: PluginSource | undefined): string {
  if (!s) return '(unknown)'
  if (s.kind === 'local') return `local: ${s.path}`
  if (s.kind === 'git') return `git: ${s.url}${s.ref ? `#${s.ref}` : ''}`
  return `github:${s.owner}/${s.repo}${s.ref ? `#${s.ref}` : ''}`
}

/** 解析 `/plugin enable|disable` 的参数字符串，并识别共享的
 *  `--scope=user|project` / `-s=user|project` 标志。
 *  解析形状和 `parseSkillScopeFlag` 相同。
 *  默认 scope = 'user'，这样短命令还是短命令。 */
function parsePluginScopeFlag(arg: string): { id: string; scope: PluginScope } {
  const tokens = arg.split(/\s+/).filter(Boolean)
  let scope: PluginScope = 'user'
  const remaining: string[] = []
  for (const tok of tokens) {
    const m = tok.match(/^(?:--scope|-s)(?:=(.+))?$/)
    if (m) {
      const value = m[1]?.toLowerCase()
      if (value === 'user' || value === 'project') scope = value
      continue
    }
    remaining.push(tok)
  }
  return { id: remaining.join(' '), scope }
}

export function createPluginCommandHandler(deps: PluginCommandDeps) {
  const { options, addCommandMessage, askQuestion, invalidateSystemPromptCache, bumpSkillRegistryVersion } = deps

  function pluginList(text: string, raw: string): void {
    const reg = options.pluginRegistry
    if (!reg) {
      addCommandMessage(text, 'Plugin system is disabled for this session (`--no-plugins`).')
      return
    }
    // 可选过滤器：`--enabled` 只看开启的、`--disabled` 只看关闭的，
    // 不传则看全部。
    const tokens = raw.trim().split(/\s+/).filter(Boolean)
    let filter: 'all' | 'enabled' | 'disabled' = 'all'
    for (const t of tokens) {
      // 如果子命令词本身（`list`）也出现在参数里，就跳过它。
      if (t === 'list') continue
      if (t === '--enabled') filter = 'enabled'
      else if (t === '--disabled') filter = 'disabled'
    }
    const all = reg.listAll()
    if (all.length === 0) {
      addCommandMessage(text, 'No plugins installed. Install one with `/plugin install <source>`.')
      return
    }
    const filtered =
      filter === 'enabled' ? all.filter((p) => p.enabled) : filter === 'disabled' ? all.filter((p) => !p.enabled) : all
    if (filtered.length === 0) {
      addCommandMessage(text, `No ${filter} plugins.`)
      return
    }
    const header =
      filter === 'all'
        ? `**Installed plugins** (${filtered.length}):`
        : `**Installed plugins** (${filter}, ${filtered.length} of ${all.length}):`
    const lines = [header]
    const namePad = Math.max(...filtered.map((p) => p.id.length), 8) + 2
    for (const p of filtered) {
      const badge = p.enabled ? '[on] ' : '[off]'
      const src = p.marketplace === 'local' ? '(local)' : `(${p.marketplace})`
      lines.push(`  ${badge} ${p.id.padEnd(namePad)} v${p.manifest.version}  ${src}`)
    }
    const errors = reg.loadErrors()
    if (errors.length > 0) {
      lines.push('', `${errors.length} load error${errors.length === 1 ? '' : 's'} — run \`/plugin doctor\`.`)
    }
    addCommandMessage(text, lines.join('\n'))
  }

  async function pluginInfo(text: string, raw: string): Promise<void> {
    const id = raw.trim()
    if (!id) {
      addCommandMessage(text, 'Usage: `/plugin info <id>`  (id = `name@marketplace`)')
      return
    }
    const plugin = options.pluginRegistry?.getEntry(id)
    if (!plugin) {
      addCommandMessage(text, `No plugin \`${id}\` loaded. Check \`/plugin list\`.`)
      return
    }
    const c = await resolveContributions(plugin)
    const lines: string[] = [
      `**${plugin.id}** v${plugin.manifest.version}`,
      plugin.manifest.description ?? '_(no description)_',
      '',
      `- Enabled:     ${plugin.enabled ? 'yes' : 'no'}`,
      `- Source:      ${formatPluginSource(plugin.source)}`,
      `- Marketplace: ${plugin.marketplace}`,
      `- Root dir:    ${plugin.rootDir}`,
      `- Manifest:    ${plugin.manifestPath} (${plugin.manifestFormat})`,
    ]
    if (plugin.manifest.author?.name) lines.push(`- Author:      ${plugin.manifest.author.name}`)
    if (plugin.manifest.homepage) lines.push(`- Homepage:    ${plugin.manifest.homepage}`)
    if (plugin.manifest.license) lines.push(`- License:     ${plugin.manifest.license}`)

    lines.push('', '**Contributions:**')
    let any = false
    if (c.skillsDir) {
      lines.push(`- skills:     ${c.skillsDir}`)
      any = true
    }
    if (c.agentsDir) {
      lines.push(`- agents:     ${c.agentsDir}`)
      any = true
    }
    if (c.commandsDir) {
      lines.push(`- commands:   ${c.commandsDir}`)
      any = true
    }
    if (c.mcpServers) {
      lines.push(`- mcpServers: ${c.mcpServers.kind === 'inline' ? '(inline)' : c.mcpServers.path}`)
      any = true
    }
    if (c.hooks) {
      lines.push(`- hooks:      ${c.hooks.kind === 'inline' ? '(inline)' : c.hooks.path}`)
      any = true
    }
    if (!any) lines.push('- _(none)_')

    addCommandMessage(text, lines.join('\n'))
  }

  async function pluginInstall(text: string, raw: string): Promise<void> {
    if (!raw) {
      addCommandMessage(
        text,
        'Usage: `/plugin install <source>`\n' +
          '  Sources:\n' +
          '    `<name>@<marketplace>` — look up + install from subscribed marketplace\n' +
          '    `github:owner/repo[#ref]` — install from a GitHub repo\n' +
          '    `https://...` or `git@...` — 从任意 git URL 安装\n' +
          '    `/abs/path` or `./relative/path` — install from a local directory',
      )
      return
    }

    const tokens = raw.trim().split(/\s+/)
    const source_str = tokens[0]!
    const extras = tokens.slice(1).filter((t) => t !== '--yes' && t !== '-y')
    if (extras.length > 0) {
      addCommandMessage(
        text,
        `Unrecognised arguments to \`/plugin install\`: ${extras.map((e) => `\`${e}\``).join(', ')}`,
      )
      return
    }
    raw = source_str

    let source: PluginSource
    let marketplace: string
    let expectedName: string | undefined

    const isPath = raw.startsWith('./') || raw.startsWith('../') || raw.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(raw)
    const isGitUrl = /^https?:\/\//i.test(raw) || raw.startsWith('git@')
    const isGhShort = raw.startsWith('github:')
    const atIdx = raw.lastIndexOf('@')
    const isMarketplaceRef = atIdx > 0 && !isPath && !isGitUrl && !isGhShort

    if (isMarketplaceRef) {
      const name = raw.slice(0, atIdx)
      const mpName = raw.slice(atIdx + 1)
      const found = await lookupPlugin(`${name}@${mpName}`)
      if (!found) {
        addCommandMessage(
          text,
          `Plugin \`${name}\` not found in marketplace \`${mpName}\`. ` +
            `Run \`/plugin marketplace refresh ${mpName}\` or check the spelling.`,
        )
        return
      }
      source = found.entry.source
      marketplace = mpName
      expectedName = name
    } else if (isGhShort) {
      const m = raw.match(/^github:([^/]+)\/(.+?)(?:#(.+))?$/i)
      if (!m) {
        addCommandMessage(text, 'Invalid github source. Expected `github:owner/repo` or `github:owner/repo#ref`.')
        return
      }
      source = { kind: 'github', owner: m[1]!, repo: m[2]!, ref: m[3] }
      marketplace = 'local'
    } else if (isGitUrl) {
      source = { kind: 'git', url: raw }
      marketplace = 'local'
    } else if (isPath) {
      source = { kind: 'local', path: raw }
      marketplace = 'local'
    } else {
      addCommandMessage(
        text,
        `Unrecognised source: \`${raw}\`. Use \`name@marketplace\`, \`github:owner/repo\`, an https/git URL, or a path.`,
      )
      return
    }

    addCommandMessage(text, `Installing from ${formatPluginSource(source)} …`)
    try {
      const result = await installPlugin({ source, marketplace, expectedName })
      addCommandMessage(
        text,
        `Installed **${result.pluginId}** v${result.manifest.version}\n` +
          `Cache: \`${result.rootDir}\`\n` +
          `Run \`/plugin refresh\` to load this plugin's contributions now (skills / agents / commands / hooks). ` +
          `MCP servers need \`/mcp refresh\` separately.`,
      )
    } catch (err) {
      addCommandMessage(text, `Install failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function pluginUninstall(text: string, raw: string): Promise<void> {
    const id = raw.trim()
    if (!id) {
      addCommandMessage(text, 'Usage: `/plugin uninstall <id>` (id = `name@marketplace`)')
      return
    }
    try {
      const result = await uninstallPlugin(id)
      if (!result.removedRecord && result.removedVersions.length === 0) {
        addCommandMessage(text, `No plugin \`${id}\` installed.`)
        return
      }
      for (const scope of ['user', 'project'] as PluginScope[]) {
        await clearPluginEntry(id, scope).catch(() => undefined)
      }
      const verCount = result.removedVersions.length
      addCommandMessage(
        text,
        `Uninstalled **${id}** (removed ${verCount} cached version${verCount === 1 ? '' : 's'}).\n` +
          `Plugin data dir preserved — reinstall will keep user state.\n` +
          `Run \`/plugin refresh\` to drop its contributions from active registries.`,
      )
    } catch (err) {
      addCommandMessage(text, `Uninstall failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function pluginToggle(text: string, raw: string, enable: boolean): Promise<void> {
    const { id, scope } = parsePluginScopeFlag(raw)
    if (!id) {
      addCommandMessage(text, `Usage: \`/plugin ${enable ? 'enable' : 'disable'} <id> [--scope=user|project]\``)
      return
    }
    try {
      const result = await setPluginEnabled(id, scope, enable)
      const verb = enable ? 'enabled' : 'disabled'
      if (result === 'noop') {
        addCommandMessage(text, `Plugin \`${id}\` already ${verb} (${scope} scope).`)
      } else {
        addCommandMessage(text, `Plugin **${id}** ${verb} in ${scope} scope. Run \`/plugin refresh\` to apply now.`)
      }
    } catch (err) {
      addCommandMessage(text, `Failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function pluginSearch(text: string, raw: string): Promise<void> {
    const kw = raw.trim().toLowerCase()
    if (!kw) {
      addCommandMessage(text, 'Usage: `/plugin search <keyword>`')
      return
    }
    const marketplaces = await readAllCachedMarketplaces()
    if (marketplaces.length === 0) {
      const km = await readKnownMarketplaces()
      if (km.marketplaces.length === 0) {
        addCommandMessage(
          text,
          'No subscribed marketplaces. Add one with `/plugin marketplace add <name> <source>` and `refresh` it.',
        )
      } else {
        const names = km.marketplaces.map((m) => m.name).join(', ')
        addCommandMessage(
          text,
          `No cached marketplace index. You're subscribed to ${names} but the cache is empty — run \`/plugin marketplace refresh\` to fetch.`,
        )
      }
      return
    }
    const matches: Array<{ marketplace: string; name: string; description?: string; verified?: boolean }> = []
    for (const m of marketplaces) {
      for (const entry of m.plugins) {
        const hay = [entry.name, entry.description ?? '', ...(entry.keywords ?? [])].join(' ').toLowerCase()
        if (hay.includes(kw)) {
          matches.push({
            marketplace: m.name,
            name: entry.name,
            description: entry.description,
            verified: entry.verified,
          })
        }
      }
    }
    if (matches.length === 0) {
      addCommandMessage(
        text,
        `No plugins matching \`${kw}\` in ${marketplaces.length} subscribed marketplace${marketplaces.length === 1 ? '' : 's'}. ` +
          `Run \`/plugin marketplace refresh\` to pull latest indexes.`,
      )
      return
    }
    const lines = [`Found ${matches.length} match${matches.length === 1 ? '' : 'es'}:`]
    for (const m of matches) {
      const tag = m.verified ? ' [verified]' : ''
      lines.push(`  ${m.name}@${m.marketplace}${tag}`)
      if (m.description) lines.push(`    ${m.description}`)
    }
    lines.push('', 'Install with `/plugin install <name>@<marketplace>`.')
    addCommandMessage(text, lines.join('\n'))
  }

  async function pluginUpdate(text: string, raw: string): Promise<void> {
    const tokens = raw.trim().split(/\s+/).filter(Boolean)
    const all = tokens.includes('--all') || tokens.includes('-a')
    const positional = tokens.filter((t) => t !== '--all' && t !== '-a')

    if (all && positional.length > 0) {
      addCommandMessage(text, '`/plugin update`: pass either `--all` or a plugin id, not both.')
      return
    }
    if (!all && positional.length === 0) {
      addCommandMessage(
        text,
        '用法：`/plugin update <id>` · `/plugin update --all`\n' +
          '  `<id>`：来自 `/plugin list` 的 `name@marketplace`\n' +
          '  `--all`：更新所有已安装插件（顺序执行，出错则跳过）',
      )
      return
    }

    if (all) {
      const records = await listInstalledPlugins()
      if (records.length === 0) {
        addCommandMessage(text, '没有已安装的插件。')
        return
      }
      addCommandMessage(text, `正在更新 ${records.length} 个插件…`)
      const lines: string[] = []
      let updated = 0
      let unchanged = 0
      let failed = 0
      for (const rec of records) {
        try {
          const result = await installPlugin({
            source: rec.source,
            marketplace: rec.marketplace,
            expectedName: rec.name,
          })
          if (result.manifest.version === rec.version) {
            lines.push(`  ${rec.id}: 已按 ${rec.version} 重新安装`)
            unchanged++
          } else {
            lines.push(`  ${rec.id}: ${rec.version} → ${result.manifest.version}`)
            updated++
          }
        } catch (err) {
          lines.push(`  ${rec.id}: failed — ${err instanceof Error ? err.message : String(err)}`)
          failed++
        }
      }
      lines.push('', `总结：${updated} 个已更新，${unchanged} 个未变化，${failed} 个失败。`)
      if (updated > 0) lines.push('运行 `/plugin refresh` 以加载新版本。')
      addCommandMessage(text, lines.join('\n'))
      return
    }

    const id = positional[0]!
    const records = await listInstalledPlugins()
    const rec = records.find((r) => r.id === id)
    if (!rec) {
      addCommandMessage(text, `Plugin \`${id}\` not installed.`)
      return
    }
    addCommandMessage(text, `正在从 ${formatPluginSource(rec.source)} 重新安装 **${id}**…`)
    try {
      const result = await installPlugin({
        source: rec.source,
        marketplace: rec.marketplace,
        expectedName: rec.name,
      })
      const versionMsg =
        result.manifest.version === rec.version
          ? `已按相同版本重新安装（${rec.version}）。`
          : `已从 ${rec.version} 更新到 ${result.manifest.version}。`
      addCommandMessage(text, `${versionMsg} 运行 \`/plugin refresh\` 以加载新版本。`)
    } catch (err) {
      addCommandMessage(text, `Update failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function pluginRefresh(text: string): Promise<void> {
    if (!options.pluginRegistry) {
      addCommandMessage(text, 'Plugin system is disabled for this session (`--no-plugins`).')
      return
    }
    let summary
    try {
      summary = await refreshPluginContributions({
        pluginRegistry: options.pluginRegistry,
        skillRegistry: options.skillRegistry,
        subAgentRegistry: options.subAgentRegistry,
        commandRegistry: options.commandRegistry,
        hookBus: options.hookBus,
        mcpRegistry: options.mcpRegistry,
        askUser: (q, opts) => askQuestion(q, opts, { noOther: true }),
        cwd: process.cwd(),
      })
    } catch (err) {
      addCommandMessage(text, `Failed to reload plugins: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    invalidateSystemPromptCache()
    bumpSkillRegistryVersion()

    const parts: string[] = []
    const p = summary.plugins
    if (p.added.length) parts.push(`新增：${p.added.join(', ')}`)
    if (p.removed.length) parts.push(`移除：${p.removed.join(', ')}`)
    if (p.changed.length) parts.push(`变更：${p.changed.join(', ')}`)
    if (parts.length === 0) parts.push(`没有插件变更（${p.unchanged.length} 个保持不变）`)
    const lines = [`已重新加载插件 — ${parts.join('；')}。`]
    const subBits: string[] = []
    if (summary.skills && (summary.skills.added.length || summary.skills.removed.length))
      subBits.push(`${summary.skills.added.length + summary.skills.removed.length} 个 skill 变更`)
    if (summary.subAgents && (summary.subAgents.added.length || summary.subAgents.removed.length))
      subBits.push(`${summary.subAgents.added.length + summary.subAgents.removed.length} 个子代理变更`)
    if (summary.commands && (summary.commands.added.length || summary.commands.removed.length))
      subBits.push(`${summary.commands.added.length + summary.commands.removed.length} 个命令变更`)
    if (subBits.length) lines.push(`下游影响：${subBits.join('，')}。`)
    if (summary.mcp) {
      const m = summary.mcp
      const mcpBits: string[] = []
      if (m.added.length) mcpBits.push(`新增：${m.added.join(', ')}`)
      if (m.removed.length) mcpBits.push(`移除：${m.removed.join(', ')}`)
      if (m.changed.length) mcpBits.push(`变更：${m.changed.join(', ')}`)
      if (mcpBits.length) lines.push(`MCP：${mcpBits.join('；')}。`)
      else if (m.unchanged.length) lines.push(`MCP：${m.unchanged.length} 个 server 重新连接。`)
    }
    if (summary.mcpProjectSkipped) {
      lines.push('注意：project 级 MCP server 被跳过了（未信任该项目）。')
    }
    for (const e of summary.mcpConfigErrors ?? []) {
      lines.push(`MCP 配置错误：${e.name}: ${e.message}`)
    }
    lines.push('注意：下一条消息会重新构建 system prompt，因此 prompt-cache 会失效一次。')
    addCommandMessage(text, lines.join('\n'))
  }

  function pluginDoctor(text: string): void {
    const reg = options.pluginRegistry
    if (!reg) {
      addCommandMessage(text, 'Plugin system is disabled for this session (`--no-plugins`).')
      return
    }
    const errors = reg.loadErrors()
    const all = reg.listAll()
    const lines: string[] = ['**插件诊断**']
    lines.push(`- 已加载总数：${all.length}`)
    lines.push(`- 已启用：      ${all.filter((p) => p.enabled).length}`)
    lines.push(`- 已禁用：      ${all.filter((p) => !p.enabled).length}`)
    lines.push(`- 加载错误：    ${errors.length}`)
    if (errors.length > 0) {
      lines.push('', '**错误：**')
      for (const e of errors) {
        lines.push(`- ${e.id ?? '(unknown)'} at \`${e.path}\``)
        lines.push(`  ${e.message}`)
      }
    }
    lines.push(
      '',
      '_如需更深入的诊断（mcp 冲突、hook 错误、不支持的 `commands` 贡献），请设置 `DEBUG_STDOUT=1` 并查看 `~/.x-code/logs/debug.log`。_',
    )
    addCommandMessage(text, lines.join('\n'))
  }

  async function handlePluginMarketplace(text: string, arg: string): Promise<void> {
    const parts = arg.trim().split(/\s+/)
    const sub = (parts[0] ?? '').toLowerCase()
    const rest = parts.slice(1).join(' ').trim()

    if (sub === '' || sub === 'list') {
      const km = await readKnownMarketplaces()
      if (km.marketplaces.length === 0) {
        addCommandMessage(text, '没有已订阅的 marketplace。可用 `/plugin marketplace add <name> <source>` 添加。')
        return
      }
      const lines = [`**已订阅的 marketplace**（${km.marketplaces.length} 个）：`]
      const namePad = Math.max(...km.marketplaces.map((m) => m.name.length), 8) + 2
      for (const m of km.marketplaces) {
        const tag = m.reservedName ? ' [official]' : ''
        lines.push(`  ${m.name.padEnd(namePad)} ${m.source}${tag}`)
      }
      addCommandMessage(text, lines.join('\n'))
      return
    }

      if (sub === 'add') {
      const argParts = rest.split(/\s+/)
      if (argParts.length < 2 || !argParts[0] || !argParts[1]) {
        addCommandMessage(
          text,
          '用法：`/plugin marketplace add <name> <source>`（source 可以是 `github:owner/repo`，也可以是指向 marketplace.json 的 https URL）',
        )
        return
      }
      const [name, ...sourceParts] = argParts
      const source = sourceParts.join(' ')
      try {
        await addKnownMarketplace({ name, source })
        addCommandMessage(
          text,
          `已订阅 **${name}**（\`${source}\`）。运行 \`/plugin marketplace refresh ${name}\` 以拉取索引。`,
        )
      } catch (err) {
        addCommandMessage(text, `Failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      return
    }

    if (sub === 'remove') {
      if (!rest) {
        addCommandMessage(text, '用法：`/plugin marketplace remove <name>`')
        return
      }
      const result = await removeKnownMarketplace(rest)
      if (result === 'noop') addCommandMessage(text, `没有订阅 marketplace \`${rest}\`。`)
      else addCommandMessage(text, `已取消订阅 **${rest}**。`)
      return
    }

    if (sub === 'refresh') {
      const km = await readKnownMarketplaces()
      const targets = rest ? km.marketplaces.filter((m) => m.name === rest) : km.marketplaces
      if (targets.length === 0) {
        addCommandMessage(text, rest ? `没有订阅 marketplace \`${rest}\`。` : '没有已订阅的 marketplace。')
        return
      }
      const lines: string[] = [`正在刷新 ${targets.length} 个 marketplace…`]
      for (const t of targets) {
        try {
          const m = await fetchMarketplace(t)
          lines.push(`  ✓ ${t.name} — ${m.plugins.length} 个插件`)
        } catch (err) {
          lines.push(`  ✗ ${t.name} — ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      addCommandMessage(text, lines.join('\n'))
      return
    }

    if (sub === 'info') {
      if (!rest) {
        addCommandMessage(text, '用法：`/plugin marketplace info <name>`')
        return
      }
      const all = await readAllCachedMarketplaces()
      const m = all.find((x) => x.name === rest)
      if (!m) {
        addCommandMessage(
          text,
          `没有 marketplace \`${rest}\` 的缓存索引。请先运行 \`/plugin marketplace refresh ${rest}\`。`,
        )
        return
      }
      const lines: string[] = [`**${m.displayName ?? m.name}** (${m.name})`]
      if (m.upstreamName) lines.push(`Upstream name: ${m.upstreamName}`)
      if (m.description) lines.push(m.description)
      if (m.owner?.name) lines.push(`Owner: ${m.owner.name}${m.owner.url ? ` (${m.owner.url})` : ''}`)
      lines.push('', `${m.plugins.length} 个插件：`)
      for (const p of m.plugins) {
        const ver = p.verified ? ' [verified]' : ''
        const cat = p.category ? ` (${p.category})` : ''
        lines.push(`  ${p.name}${ver}${cat}`)
        if (p.description) lines.push(`    ${p.description}`)
      }
      addCommandMessage(text, lines.join('\n'))
      return
    }

    addCommandMessage(text, '用法：`/plugin marketplace <list|add|remove|refresh|info>`')
  }

  async function handlePlugin(text: string, arg: string): Promise<void> {
    const trimmed = arg.trim()
    const parts = trimmed.split(/\s+/)
    const sub = (parts[0] ?? '').toLowerCase()
    const rest = parts.slice(1).join(' ').trim()

    if (sub === 'marketplace') return handlePluginMarketplace(text, rest)
    if (sub === '' || sub === 'list') return pluginList(text, arg)
    if (sub === 'info') return pluginInfo(text, rest)
    if (sub === 'install') return pluginInstall(text, rest)
    if (sub === 'uninstall') return pluginUninstall(text, rest)
    if (sub === 'enable') return pluginToggle(text, rest, true)
    if (sub === 'disable') return pluginToggle(text, rest, false)
    if (sub === 'search') return pluginSearch(text, rest)
    if (sub === 'update') return pluginUpdate(text, rest)
    if (sub === 'refresh') return void pluginRefresh(text)
    if (sub === 'doctor') return pluginDoctor(text)

    addCommandMessage(
      text,
      'Usage: `/plugin <list|info|install|uninstall|enable|disable|search|update|refresh|doctor|marketplace>`',
    )
  }

  return { handlePlugin }
}
