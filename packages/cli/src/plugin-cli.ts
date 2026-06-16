// @x-code-cli/cli - 非交互式 plugin 子命令。
//
// `xc plugin <subcommand> ...` 的入口，不挂载 Ink UI，
// 而是直接向 stdout/stderr 打印，并以适合脚本使用的状态码退出。
// 这里的命令集需要和 `App.tsx` 里的 `handlePlugin` slash 命令族保持一致，
// 这样用户无论走 TUI 入口还是 shell 入口，都能执行同样的操作。
//
// 这里会在 yargs 解析参数之前就从 `index.ts` 的 `main()` 分流出去，
// 这样 `xc plugin install ./foo` 就不会被误判成一段要交给 agent 处理的 prompt。
import { Chalk } from 'chalk'

import {
  addKnownMarketplace,
  clearPluginEntry,
  debugLog,
  ensureDefaultMarketplaces,
  fetchMarketplace,
  installPlugin,
  listInstalledPlugins,
  loadAllPlugins,
  lookupPlugin,
  readAllCachedMarketplaces,
  readKnownMarketplaces,
  removeKnownMarketplace,
  setPluginEnabled,
  uninstallPlugin,
} from '@x-code-cli/core'
import type { ConsentPreview, PluginScope, PluginSource } from '@x-code-cli/core'

const chalk = new Chalk()

export async function runPluginCli(args: string[]): Promise<number> {
  const sub = (args[0] ?? '').toLowerCase()
  const rest = args.slice(1)

  // 首次运行种子：和 packages/cli/src/index.ts 里的主交互入口保持一致。
  // 如果没有这步，新用户在第一次启动交互式 CLI 之前先跑
  // `xc plugin marketplace list`（或 `search`），就会看到空订阅列表；
  // 而产品承诺是“首次运行时就已经准备好 Anthropic marketplace”。
  // 这个承诺必须在每个首次接触面都成立，不能只在 TUI 入口成立。
  // 这一步是幂等的——如果用户明确删掉了默认项，这里不会把它重新加回来。
  await ensureDefaultMarketplaces().catch((err) => debugLog('plugins.ensure-defaults-failed', String(err)))

  try {
    switch (sub) {
      case '':
      case 'list':
        return await cliList(rest)
      case 'info':
        return await cliInfo(rest)
      case 'install':
        return await cliInstall(rest)
      case 'uninstall':
        return await cliUninstall(rest)
      case 'enable':
        return await cliToggle(rest, true)
      case 'disable':
        return await cliToggle(rest, false)
      case 'search':
        return await cliSearch(rest)
      case 'update':
        return await cliUpdate(rest)
      case 'doctor':
        return await cliDoctor()
      case 'marketplace':
        return await cliMarketplace(rest)
      default:
        printUsage()
        return 1
    }
  } catch (err) {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)))
    return 1
  }
}

function printUsage(): void {
  console.error(
    [
      'Usage: xc plugin <subcommand> [args...]',
      '',
      'Subcommands:',
      '  list                      List installed plugins',
      "  info <id>                 Show a plugin's manifest, contributions, hooks",
      '  install <source>          Install from name@marketplace, github:owner/repo, git URL, or local path',
      '  uninstall <id>            Remove a plugin (cache + settings; data dir preserved)',
      '  enable <id>               Enable a plugin (user scope)',
      '  disable <id>              Disable a plugin without uninstalling',
      '  search <keyword>          Search subscribed marketplaces',
      '  update <id>               Reinstall from recorded source',
      '  doctor                    Show plugin load errors',
      '  marketplace <add|remove|list|refresh|info> [args...]',
      '                            Manage marketplace subscriptions',
      '',
      'Example:',
      '  xc plugin marketplace add anthropic-marketplace github:anthropics/marketplace',
      '  xc plugin marketplace refresh anthropic-marketplace',
      '  xc plugin install linear@anthropic-marketplace',
    ].join('\n'),
  )
}

function formatSource(s: PluginSource | undefined): string {
  if (!s) return '(unknown)'
  if (s.kind === 'local') return `local: ${s.path}`
  if (s.kind === 'git') return `git: ${s.url}${s.ref ? `#${s.ref}` : ''}`
  return `github:${s.owner}/${s.repo}${s.ref ? `#${s.ref}` : ''}`
}

// ── list / info ────────────────────────────────────────────────────────

async function cliList(args: string[] = []): Promise<number> {
  // 可选过滤器与 slash 命令一致：--enabled / --disabled。
  // 不带标志时默认列出所有已安装插件。
  let filter: 'all' | 'enabled' | 'disabled' = 'all'
  for (const a of args) {
    if (a === '--enabled') filter = 'enabled'
    else if (a === '--disabled') filter = 'disabled'
  }

  // 对于 'all'，我们可以只读 bookkeeping 文件，成本很低。
  // 过滤视图则需要 enabled 状态，这只有 loadAllPlugins 才会解析
  //（会跨作用域合并 settings.json）。
  if (filter === 'all') {
    const installed = await listInstalledPlugins()
    if (installed.length === 0) {
      console.log('No plugins installed.')
      return 0
    }
    console.log(`Installed plugins (${installed.length}):`)
    const namePad = Math.max(...installed.map((p) => p.id.length), 8) + 2
    for (const p of installed) {
      console.log(`  ${p.id.padEnd(namePad)} v${p.version}  ${formatSource(p.source)}`)
    }
    return 0
  }

  const load = await loadAllPlugins({ cwd: process.cwd() })
  const all = load.registry.listAll()
  const filtered = filter === 'enabled' ? all.filter((p) => p.enabled) : all.filter((p) => !p.enabled)
  if (all.length === 0) {
    console.log('No plugins installed.')
    return 0
  }
  if (filtered.length === 0) {
    console.log(`No ${filter} plugins.`)
    return 0
  }
  console.log(`Installed plugins (${filter}, ${filtered.length} of ${all.length}):`)
  const namePad = Math.max(...filtered.map((p) => p.id.length), 8) + 2
  for (const p of filtered) {
    const badge = p.enabled ? '[on] ' : '[off]'
    console.log(`  ${badge} ${p.id.padEnd(namePad)} v${p.manifest.version}  ${formatSource(p.source)}`)
  }
  return 0
}

async function cliInfo(args: string[]): Promise<number> {
  const id = args[0]
  if (!id) {
    console.error('Usage: xc plugin info <id>')
    return 1
  }
  // 用 loadAllPlugins 拿真实的 manifest + enabled 状态，
  // 而不只是 bookkeeping 记录。
  const load = await loadAllPlugins({ cwd: process.cwd() })
  const plugin = load.registry.getEntry(id)
  if (!plugin) {
    console.error(`No plugin '${id}' loaded.`)
    return 1
  }
  console.log(`${plugin.id} v${plugin.manifest.version}`)
  if (plugin.manifest.description) console.log(plugin.manifest.description)
  console.log()
  console.log(`Enabled:     ${plugin.enabled ? 'yes' : 'no'}`)
  console.log(`Source:      ${formatSource(plugin.source)}`)
  console.log(`Marketplace: ${plugin.marketplace}`)
  console.log(`Root dir:    ${plugin.rootDir}`)
  console.log(`Manifest:    ${plugin.manifestPath} (${plugin.manifestFormat})`)
  const c = load.contributions.get(plugin.id)
  if (c) {
    console.log()
    console.log('Contributions:')
    if (c.skillsDir) console.log(`  skills:     ${c.skillsDir}`)
    if (c.agentsDir) console.log(`  agents:     ${c.agentsDir}`)
    if (c.commandsDir) console.log(`  commands:   ${c.commandsDir}`)
    if (c.mcpServers) console.log(`  mcpServers: ${c.mcpServers.kind === 'inline' ? '(inline)' : c.mcpServers.path}`)
    if (c.hooks) console.log(`  hooks:      ${c.hooks.kind === 'inline' ? '(inline)' : c.hooks.path}`)
  }
  return 0
}

// ── install / uninstall / update ───────────────────────────────────────

async function cliInstall(args: string[]): Promise<number> {
  // 在读取 source 之前先把 --yes / -y 从参数里剥离出来。
  // 这样顺序就无关了，用户既可以写 `--yes <src>`，也可以写 `<src> --yes`。
  const skipConsent = args.includes('--yes') || args.includes('-y')
  const sourceArgs = args.filter((a) => a !== '--yes' && a !== '-y')
  const raw = sourceArgs.join(' ').trim()
  if (!raw) {
    console.error('Usage: xc plugin install [--yes] <source>')
    console.error('  <source>: name@marketplace | github:owner/repo | https://... | /path')
    return 1
  }

  const parsed = await parseInstallSource(raw)
  if (!parsed) return 1

  console.log(`Installing from ${formatSource(parsed.source)} ...`)
  try {
    const result = await installPlugin({
      source: parsed.source,
      marketplace: parsed.marketplace,
      expectedName: parsed.expectedName,
      consent: skipConsent ? undefined : promptConsent,
      // userConfig 提示只会在 manifest 声明了字段，而且又不是 `--yes`
      // 这种非交互模式时才运行（脚本可以通过直接编辑
      // ~/.x-code/plugins/user-config.json 预先写入值，或者将来通过
      // `xc plugin configure` 命令来写）。
      userConfigPrompt: skipConsent ? undefined : promptUserConfig,
    })
    console.log(chalk.green(`Installed ${result.pluginId} v${result.manifest.version}`))
    console.log(`Cache: ${result.rootDir}`)
    // 不要给“重启 xc”的提示——这个子命令是从 shell 一次性执行的，
    // 不是跑在一个活着的会话里。别处如果有正在运行的 xc TUI，
    // 用户可以在那里执行 `/plugin refresh` 来加载这次变更。
    return 0
  } catch (err) {
    console.error(chalk.red(`Install failed: ${err instanceof Error ? err.message : String(err)}`))
    return 1
  }
}

/** 把 consent 预览渲染到 stderr，并从 stdin 读取 y/n。
 *  如果没有 TTY（CI 环境、管道里的安装脚本），默认返回 NO——
 *  这类调用方应该显式传 `--yes`。 */
async function promptConsent(preview: ConsentPreview): Promise<boolean> {
  const lines: string[] = []
  lines.push('')
  lines.push(chalk.bold.yellow(`About to install: ${preview.pluginId} v${preview.version}`))
  if (preview.description) lines.push(`  ${preview.description}`)
  lines.push('')
  lines.push(`  Source:      ${formatSource(preview.source)}`)
  lines.push(
    `  Marketplace: ${preview.marketplace}${preview.fromReservedMarketplace ? ' [reserved/official]' : ''}${preview.verified ? ' [verified]' : ''}`,
  )
  if (preview.author) lines.push(`  Author:      ${preview.author}`)
  if (preview.license) lines.push(`  License:     ${preview.license}`)
  if (preview.homepage) lines.push(`  Homepage:    ${preview.homepage}`)
  lines.push('')
  lines.push('  Will contribute:')
  if (preview.hasSkillsDir) lines.push('    - skills (added to /skill list)')
  if (preview.hasAgentsDir) lines.push('    - sub-agents (callable via the `task` tool)')
  if (preview.hasCommandsDir) lines.push('    - slash commands (each `.md` file becomes a `/<name>` command)')
  if (preview.inlineMcpServerNames.length > 0) {
    lines.push(
      `    - ${chalk.red('MCP servers')} (will be spawned as subprocesses): ${preview.inlineMcpServerNames.join(', ')}`,
    )
  } else if (preview.hasPathMcpServers) {
    lines.push(`    - ${chalk.red('MCP servers')} (from external file — spawned as subprocesses)`)
  }
  if (preview.hookEvents.length > 0) {
    lines.push(`    - ${chalk.red('Lifecycle hooks')} (will run shell commands on: ${preview.hookEvents.join(', ')})`)
  } else if (preview.hasPathHooks) {
    lines.push(`    - ${chalk.red('Lifecycle hooks')} (from external file — will run shell commands)`)
  }
  if (
    !preview.hasSkillsDir &&
    !preview.hasAgentsDir &&
    !preview.hasCommandsDir &&
    preview.inlineMcpServerNames.length === 0 &&
    !preview.hasPathMcpServers &&
    preview.hookEvents.length === 0 &&
    !preview.hasPathHooks
  ) {
    lines.push('    (no contributions declared)')
  }
  lines.push('')

  process.stderr.write(lines.join('\n'))

  // 没有 TTY 时默认拒绝；脚本应显式传 `--yes`。
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(chalk.yellow('No TTY — declining install. Use --yes to skip the prompt in scripts.\n'))
    return false
  }

  const readline = await import('node:readline/promises')
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await rl.question('Proceed with install? [y/N] ')
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

/** Walk the manifest's userConfig list and prompt for each field. Mirrors
 *  the consent prompt's TTY-only stance: scripts piping into install
 *  should pre-seed values or use `--yes` (which skips this entirely).
 *  Sensitive fields are NOT echoed during typing — we toggle the tty
 *  to raw mode for the duration of the question, mirroring how `git`
 *  prompts for credentials. */
async function promptUserConfig(
  fields: Parameters<NonNullable<Parameters<typeof installPlugin>[0]['userConfigPrompt']>>[0],
): Promise<Record<string, string | number | boolean> | null> {
  // 安装器只有在 fields.length > 0 时才会调用这里，但 TypeScript
  // 无法从调用点看出来，所以这里显式保护一下。
  if (!fields) return {}
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      chalk.yellow(
        'No TTY — skipping userConfig prompt. Pre-seed values in ~/.x-code/plugins/user-config.json or use --yes.\n',
      ),
    )
    return {}
  }
  process.stderr.write('\n' + chalk.bold('This plugin needs configuration:') + '\n')

  const collected: Record<string, string | number | boolean> = {}
  const readline = await import('node:readline/promises')
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true })
  try {
    for (const f of fields) {
      const label = f.prompt ?? f.description
      const required = f.required ? ' (required)' : ''
      const defaultNote = f.default !== undefined ? ` [default: ${f.default}]` : ''
      const sensitive = f.sensitive === true
      // 当 manifest 既没有 `prompt` 也没有 `description` 时，
      // 旧代码会退回到 `f.key`，最终出现类似
      // `MY_URL: MY_URL [default: ...]` 的标签，也就是把 key 同时当成
      // 字段名和人类描述，显得重复。这里在这种情况下只显示 key 本身。
      const promptText = label
        ? `  ${chalk.cyan(f.key)}: ${label}${required}${defaultNote}\n  > `
        : `  ${chalk.cyan(f.key)}${required}${defaultNote}\n  > `

      let answer: string
      if (sensitive) {
        // 在读取期间抑制本地回显。Node 的 readline 没有直接暴露这个能力，
        // 所以这里只能临时 monkey-patch 输出流的 write，把内容过滤掉，
        // 只保留每次按键对应的一次性 `*`。inquirer 的 `password` 提示也是类似思路。
        const out = process.stderr
        const originalWrite = out.write.bind(out)
        process.stderr.write(promptText)
        let muted = true
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(out as { write: (...args: any[]) => boolean }).write = (chunk: string | Buffer) => {
          if (!muted) return originalWrite(chunk)
          const s = typeof chunk === 'string' ? chunk : chunk.toString()
          if (s.includes('\n') || s.includes('\r')) return originalWrite(s)
          return true
        }
        try {
          answer = await rl.question('')
        } finally {
          muted = false
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(out as { write: (...args: any[]) => boolean }).write = originalWrite
          process.stderr.write('\n')
        }
      } else {
        answer = await rl.question(promptText)
      }

      const trimmed = answer.trim()
      if (!trimmed) {
        if (f.default !== undefined) {
          collected[f.key] = f.default
        } else if (f.required) {
          process.stderr.write(chalk.red(`  '${f.key}' is required.\n`))
          return null
        }
        continue
      }

      if (f.type === 'number') {
        const n = Number(trimmed)
        if (!Number.isFinite(n)) {
          process.stderr.write(chalk.red(`  '${f.key}' must be a number.\n`))
          return null
        }
        collected[f.key] = n
      } else if (f.type === 'boolean') {
        collected[f.key] = /^(true|y|yes|1)$/i.test(trimmed)
      } else {
        collected[f.key] = trimmed
      }
    }
  } finally {
    rl.close()
  }
  return collected
}

async function parseInstallSource(
  raw: string,
): Promise<{ source: PluginSource; marketplace: string; expectedName?: string } | null> {
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
      console.error(
        `Plugin '${name}' not found in marketplace '${mpName}'. ` +
          `Run 'xc plugin marketplace refresh ${mpName}' or check the spelling.`,
      )
      return null
    }
    return { source: found.entry.source, marketplace: mpName, expectedName: name }
  }
  if (isGhShort) {
    const m = raw.match(/^github:([^/]+)\/(.+?)(?:#(.+))?$/i)
    if (!m) {
      console.error('Invalid github source. Expected github:owner/repo[#ref]')
      return null
    }
    return { source: { kind: 'github', owner: m[1]!, repo: m[2]!, ref: m[3] }, marketplace: 'local' }
  }
  if (isGitUrl) {
    return { source: { kind: 'git', url: raw }, marketplace: 'local' }
  }
  if (isPath) {
    return { source: { kind: 'local', path: raw }, marketplace: 'local' }
  }
  console.error(`Unrecognised source: '${raw}'. Use name@marketplace, github:owner/repo, an https/git URL, or a path.`)
  return null
}

async function cliUninstall(args: string[]): Promise<number> {
  const id = args[0]
  if (!id) {
    console.error('Usage: xc plugin uninstall <id>')
    return 1
  }
  const result = await uninstallPlugin(id)
  if (!result.removedRecord && result.removedVersions.length === 0) {
    console.error(`No plugin '${id}' installed.`)
    return 1
  }
  for (const scope of ['user', 'project'] as PluginScope[]) {
    await clearPluginEntry(id, scope).catch(() => undefined)
  }
  console.log(
    chalk.green(
      `Uninstalled ${id} (removed ${result.removedVersions.length} cached version${result.removedVersions.length === 1 ? '' : 's'})`,
    ),
  )
  console.log('Data dir preserved.')
  return 0
}

async function cliToggle(args: string[], enable: boolean): Promise<number> {
  // 先把可选的 `--scope` 标志从位置参数里剥离出来，和
  // `/skill enable|disable` 的参数形状保持一致。默认作用域是 `user`。
  let scope: PluginScope = 'user'
  const positional: string[] = []
  for (const a of args) {
    const m = a.match(/^(?:--scope|-s)(?:=(.+))?$/)
    if (m) {
      const v = m[1]?.toLowerCase()
      if (v === 'user' || v === 'project') scope = v
      continue
    }
    positional.push(a)
  }
  const id = positional[0]
  if (!id) {
    console.error(`Usage: xc plugin ${enable ? 'enable' : 'disable'} <id> [--scope=user|project]`)
    return 1
  }
  const result = await setPluginEnabled(id, scope, enable)
  const verb = enable ? 'enabled' : 'disabled'
  if (result === 'noop') {
    console.log(`Plugin '${id}' already ${verb} (${scope} scope).`)
  } else {
    console.log(chalk.green(`Plugin ${id} ${verb} in ${scope} scope.`))
  }
  return 0
}

async function cliUpdate(args: string[]): Promise<number> {
  // 这里有两种明确模式：
  //   `xc plugin update <id>`   更新单个插件（现有行为）
  //   `xc plugin update --all`  顺序更新所有已安装插件，出错则跳过继续
  //
  // 故意拒绝裸写 `xc plugin update`。npm 常见的“裸命令 = 更新全部”虽然方便，
  // 但也最容易在误输入或中途试验时伤到用户；Gemini CLI 也采取了同样的保守策略。
  // 错误信息里把两种写法都列出来，方便用户一眼选对。
  const all = args.includes('--all') || args.includes('-a')
  const positional = args.filter((a) => a !== '--all' && a !== '-a')

  if (all && positional.length > 0) {
    console.error('xc plugin update: pass either `--all` or a plugin id, not both.')
    return 1
  }
  if (!all && positional.length === 0) {
    console.error('Usage: xc plugin update <id> | --all')
    console.error('  <id>: a name@marketplace from `xc plugin list`')
    console.error('  --all: update every installed plugin (sequential, skip-on-error)')
    return 1
  }

  if (all) {
    const records = await listInstalledPlugins()
    if (records.length === 0) {
      console.log('No plugins installed.')
      return 0
    }
    console.log(`Updating ${records.length} plugin${records.length === 1 ? '' : 's'} …`)
    let updated = 0
    let unchanged = 0
    let failed = 0
    for (const rec of records) {
      const outcome = await updateOnePlugin(rec)
      if (outcome === 'updated') updated++
      else if (outcome === 'unchanged') unchanged++
      else failed++
    }
    console.log('')
    console.log(
      `Summary: ${chalk.green(updated)} updated, ${unchanged} unchanged, ${failed > 0 ? chalk.red(failed) : failed} failed.`,
    )
    return failed > 0 ? 1 : 0
  }

  const id = positional[0]!
  const records = await listInstalledPlugins()
  const rec = records.find((r) => r.id === id)
  if (!rec) {
    console.error(`Plugin '${id}' not installed.`)
    return 1
  }
  console.log(`Reinstalling ${id} from ${formatSource(rec.source)} ...`)
  const outcome = await updateOnePlugin(rec)
  return outcome === 'failed' ? 1 : 0
}

type UpdateOutcome = 'updated' | 'unchanged' | 'failed'

/** Reinstall one plugin from its recorded source and report what happened.
 *  Designed to be called from both single-id and `--all` paths; per-line
 *  output is concise (just the outcome) so a bulk update reads as a clean
 *  list. Never throws — failures become `'failed'` so the caller's loop
 *  can keep going. */
async function updateOnePlugin(rec: Awaited<ReturnType<typeof listInstalledPlugins>>[number]): Promise<UpdateOutcome> {
  try {
    const result = await installPlugin({
      source: rec.source,
      marketplace: rec.marketplace,
      expectedName: rec.name,
    })
    if (result.manifest.version === rec.version) {
      console.log(`  ${rec.id}: reinstalled at ${rec.version}`)
      return 'unchanged'
    }
    console.log(chalk.green(`  ${rec.id}: ${rec.version} → ${result.manifest.version}`))
    return 'updated'
  } catch (err) {
    console.error(chalk.red(`  ${rec.id}: failed — ${err instanceof Error ? err.message : String(err)}`))
    return 'failed'
  }
}

// ── search / doctor ────────────────────────────────────────────────────

async function cliSearch(args: string[]): Promise<number> {
  const kw = args.join(' ').trim().toLowerCase()
  if (!kw) {
    console.error('Usage: xc plugin search <keyword>')
    return 1
  }
  const marketplaces = await readAllCachedMarketplaces()
  if (marketplaces.length === 0) {
    // 这里要区分两种情况：
    // 1. 还没有订阅任何 marketplace；
    // 2. 已经订阅了，但缓存索引文件缺失或不可读。
    // 这两种情况对应的修复方式不同：前者要 `add`，后者要 `refresh`。
    const km = await readKnownMarketplaces()
    if (km.marketplaces.length === 0) {
      console.error('No subscribed marketplaces. Add one with `xc plugin marketplace add`.')
    } else {
      const names = km.marketplaces.map((m) => m.name).join(', ')
      console.error(
        `No cached marketplace index. You're subscribed to ${names} but the cache is empty — run \`xc plugin marketplace refresh\` to fetch.`,
      )
    }
    return 1
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
    console.log(`No plugins matching '${kw}'.`)
    return 0
  }
  console.log(`Found ${matches.length} match${matches.length === 1 ? '' : 'es'}:`)
  for (const m of matches) {
    const tag = m.verified ? ' [verified]' : ''
    console.log(`  ${m.name}@${m.marketplace}${tag}`)
    if (m.description) console.log(`    ${m.description}`)
  }
  return 0
}

async function cliDoctor(): Promise<number> {
  const load = await loadAllPlugins({ cwd: process.cwd() })
  const all = load.registry.listAll()
  const errors = load.registry.loadErrors()
  console.log('Plugin doctor')
  console.log()
  console.log(`  Total loaded: ${all.length}`)
  console.log(`  Enabled:      ${all.filter((p) => p.enabled).length}`)
  console.log(`  Disabled:     ${all.filter((p) => !p.enabled).length}`)
  console.log(`  Load errors:  ${errors.length}`)
  if (errors.length > 0) {
    console.log()
    console.log('Errors:')
    for (const e of errors) {
      console.log(`  - ${e.id ?? '(unknown)'} at ${e.path}`)
      console.log(`    ${e.message}`)
    }
  }
  console.log()
  console.log('For deeper diagnostics, set DEBUG_STDOUT=1 and check ~/.x-code/logs/debug.log')
  return errors.length > 0 ? 1 : 0
}

// ── marketplace ─────────────────────────────────────────────────────────

async function cliMarketplace(args: string[]): Promise<number> {
  const sub = (args[0] ?? '').toLowerCase()
  const rest = args.slice(1)

  if (sub === '' || sub === 'list') {
    const km = await readKnownMarketplaces()
    if (km.marketplaces.length === 0) {
      console.log('No marketplaces subscribed.')
      return 0
    }
    console.log(`Subscribed marketplaces (${km.marketplaces.length}):`)
    const namePad = Math.max(...km.marketplaces.map((m) => m.name.length), 8) + 2
    for (const m of km.marketplaces) {
      const tag = m.reservedName ? ' [official]' : ''
      console.log(`  ${m.name.padEnd(namePad)} ${m.source}${tag}`)
    }
    return 0
  }
  if (sub === 'add') {
    const name = rest[0]
    const source = rest.slice(1).join(' ')
    if (!name || !source) {
      console.error('Usage: xc plugin marketplace add <name> <source>')
      return 1
    }
    try {
      await addKnownMarketplace({ name, source })
      console.log(chalk.green(`Subscribed to ${name} (${source})`))
      console.log(`Run 'xc plugin marketplace refresh ${name}' to fetch its index.`)
      return 0
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)))
      return 1
    }
  }
  if (sub === 'remove') {
    const name = rest[0]
    if (!name) {
      console.error('Usage: xc plugin marketplace remove <name>')
      return 1
    }
    const result = await removeKnownMarketplace(name)
    if (result === 'noop') {
      console.error(`No marketplace '${name}' subscribed.`)
      return 1
    }
    console.log(chalk.green(`Unsubscribed from ${name}.`))
    return 0
  }
  if (sub === 'refresh') {
    const km = await readKnownMarketplaces()
    const wanted = rest[0]
    const targets = wanted ? km.marketplaces.filter((m) => m.name === wanted) : km.marketplaces
    if (targets.length === 0) {
      console.error(wanted ? `No marketplace '${wanted}' subscribed.` : 'No marketplaces subscribed.')
      return 1
    }
    let hadError = false
    for (const t of targets) {
      try {
        const m = await fetchMarketplace(t)
        console.log(chalk.green(`✓ ${t.name} — ${m.plugins.length} plugin${m.plugins.length === 1 ? '' : 's'}`))
      } catch (err) {
        hadError = true
        console.error(chalk.red(`✗ ${t.name} — ${err instanceof Error ? err.message : String(err)}`))
      }
    }
    return hadError ? 1 : 0
  }
  if (sub === 'info') {
    const name = rest[0]
    if (!name) {
      console.error('Usage: xc plugin marketplace info <name>')
      return 1
    }
    const all = await readAllCachedMarketplaces()
    const m = all.find((x) => x.name === name)
    if (!m) {
      console.error(`No cached index for '${name}'. Run 'xc plugin marketplace refresh ${name}' first.`)
      return 1
    }
    console.log(`${m.displayName ?? m.name} (${m.name})`)
    if (m.upstreamName) console.log(`Upstream name: ${m.upstreamName}`)
    if (m.description) console.log(m.description)
    if (m.owner?.name) console.log(`Owner: ${m.owner.name}${m.owner.url ? ` (${m.owner.url})` : ''}`)
    console.log()
    console.log(`${m.plugins.length} plugin${m.plugins.length === 1 ? '' : 's'}:`)
    for (const p of m.plugins) {
      const ver = p.verified ? ' [verified]' : ''
      const cat = p.category ? ` (${p.category})` : ''
      console.log(`  ${p.name}${ver}${cat}`)
      if (p.description) console.log(`    ${p.description}`)
    }
    return 0
  }
  console.error('Usage: xc plugin marketplace <list|add|remove|refresh|info> [args...]')
  return 1
}
