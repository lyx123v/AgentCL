// @x-code-cli/cli - CLI 入口文件。
import { Chalk } from 'chalk'
import { hideBin } from 'yargs/helpers'

import fs from 'node:fs'
import path from 'node:path'

import {
  McpPermissionStore,
  PROVIDER_DETECTION_ORDER,
  buildPluginIntegration,
  createCommandRegistry,
  createModelRegistry,
  createOAuthProviderFactory,
  createSkillRegistry,
  createSubAgentRegistry,
  debugLog,
  debugLogIntegrationDiagnostics,
  emptyHookBus,
  ensureDefaultMarketplaces,
  getAvailableProviders,
  getEnvVarName,
  getTokenStorage,
  listSessions,
  loadAllPlugins,
  loadMcpFromDisk,
  loadSession,
  loadUserConfig,
  pickLatestSession,
  resolveModelId,
  setPluginDebugMirror,
} from '@x-code-cli/core'
import type { AgentOptions, HookBus, LoadedSession, McpRegistry } from '@x-code-cli/core'

import { getCleanupFn, startApp } from './app.js'
import { parseCliArgs } from './cli-args.js'
import { runPluginCli } from './plugin-cli.js'
import { checkForUpdate, printNoApiKeyMessage, printNoWebSearchKeyHint, printResumeHint } from './startup-prints.js'
import { setSyntaxTheme } from './ui/syntax-highlight.js'
import { getThemeColors, parseThemeName, setTheme } from './ui/theme.js'

// 把 AI SDK 的 warning 重定向到 debugLog，而不是直接打到 stderr。
// 默认的 `console.warn` 会绕过 ChatInput 的 cell-buffer 渲染，
// 每条 warning 都会抢占一行，把输入框分隔线挤乱，还会把“僵尸文本”
// 带进 scrollback。常见来源包括：
// `responseFormat JSON schema is used in a compatibility mode`
// （例如 DeepSeek + structured-output 组合）、provider 能力降级等。
// 开启 DEBUG_STDOUT 时会写入 `~/.x-code/logs/debug.log`，不开启则静默丢弃。
//
// 这一段必须在任何 AI SDK 调用之前执行，所以放在模块顶层，
// 甚至要早于 yargs 解析 argv。

;(globalThis as { AI_SDK_LOG_WARNINGS?: unknown }).AI_SDK_LOG_WARNINGS = (options: {
  warnings: unknown[]
  provider?: string
  model?: string
}) => {
  for (const warning of options.warnings) {
    debugLog('ai-sdk.warning', `${options.provider ?? '?'}/${options.model ?? '?'}: ${JSON.stringify(warning)}`)
  }
}

const chalk = new Chalk({ level: process.stderr.isTTY ? 3 : 0 })

const MIN_NODE_VERSION = [20, 19, 0]

function checkNodeVersion(): void {
  const [major, minor, patch] = process.versions.node.split('.').map((v) => parseInt(v, 10))
  const [reqMajor, reqMinor, reqPatch] = MIN_NODE_VERSION
  if (
    major < reqMajor ||
    (major === reqMajor && minor < reqMinor) ||
    (major === reqMajor && minor === reqMinor && patch < reqPatch)
  ) {
    console.error(
      `Error: X-Code CLI requires Node.js >= ${MIN_NODE_VERSION.join('.')}, but you are running ${process.versions.node}.\n` +
        'Please upgrade Node.js: https://nodejs.org/',
    )
    process.exit(1)
  }
}

// ── 优雅退出 ───────────────────────────────────────────────────────────
//
// 单次 Ctrl+C 的标准退出路径：
//   waitUntilExit() → gracefulShutdown() → resetTerminal → process.exit(0)
//
// 会话保存采用 fire-and-forget，不等待完成，以免阻塞退出。
// 退出时不打印 token 用量汇总，因为我们对比过的几个 CLI
//（claude-code、codex、gemini-cli、opencode）都没有这么做；
// 而且 stdout 的延迟刷新容易让这类信息跑到 shell prompt 后面，
// 反而会让用户困惑。
let shutdownInProgress = false
/** 启动时捕获，方便 `gracefulShutdown` 在退出前关闭 MCP server。
 *  这里包括结束 stdio 子进程、终止 HTTP transport 等。
 *  如果不做这一步，stdio server 会一直挂到它自己发现父进程 stdin
 *  已经关闭为止。那通常也能工作，但显式关闭更快，也更符合预期。 */
let mcpRegistryForShutdown: McpRegistry | null = null
/** 启动时保存 plugin hook bus，方便 `gracefulShutdown` 在进程退出前
 *  触发 `SessionEnd` 给插件 hook。
 *  同样采用 fire-and-forget，1 秒的退出宽限时间就是慢 hook 和硬杀进程之间
 *  的缓冲带。 */
let hookBusForShutdown: HookBus | null = null

// 双保险式的终端恢复。这里会在退出前同步执行，所以即使 Ink 的卸载
// 过程有部分异常（比如 useEffect cleanup 抛错，或者长会话里 raw-mode
// 计数泄漏），终端也能回到可用状态。多次调用是安全的，每条 escape 都是幂等的。
function resetTerminal(): void {
  if (!process.stdout.isTTY) return
  try {
    fs.writeSync(1, '\x1b[0m') // 重置 SGR（颜色、粗体、反显等），避免 shell prompt 继承样式。
    fs.writeSync(1, '\x1b[?2004l') // 关闭 bracketed paste。
    fs.writeSync(1, '\x1b[?25h') // 显示光标。
    fs.writeSync(1, '\x1b[?1049l') // 退出 alt screen（如果曾进入过）。
    fs.writeSync(1, '\r\n') // 让 shell prompt 落到新的一行。
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
  } catch {
    // 终端可能已经关闭（SIGHUP、SSH 断开），这里直接忽略即可。
  }
}

async function gracefulShutdown(exitCode: number): Promise<never> {
  if (shutdownInProgress) return undefined as never
  shutdownInProgress = true

  // 在后台尽力做清理，但不要让退出等待这些清理完成。
  // `saveSession` 内部会调用模型生成摘要，这一步可能要花好几秒，
  // 这就是之前“按 Ctrl+C 后还得等 2-5 秒”的体验问题。
  // 我们参考的几个 CLI（claude-code、gemini-cli、opencode、codex）都不会
  // 让用户在退出时等待，所以这里也对齐这个策略。
  //
  // 代价是：如果进程在 `saveSession` 的写文件动作落盘前就退出了，这次会话就不会保存。
  // 这个权衡是可以接受的，因为用户显然更在意退出速度，而不是每次都保住会话摘要。
  // 后续可以考虑像 opencode 那样，在会话过程中做增量保存。
  const cleanup = getCleanupFn()
  if (cleanup) cleanup().catch(() => undefined)

  // MCP 关闭也采用 fire-and-forget。stdio server 在 stdin 关闭时也会自行收尾，
  // 所以即便 `process.exit` 抢在这个 promise 前面，操作系统也会回收子进程；
  // 这里只是把这个过程显式化并尽量加快。
  if (mcpRegistryForShutdown) {
    mcpRegistryForShutdown.shutdown().catch(() => undefined)
  }

  // 插件的 SessionEnd hook 也不等待完成。因为慢 hook 会阻塞 shell prompt 返回，
  // 而退出阶段的宽限窗口本来就很小。需要更可靠交付的 hook 应该同时订阅
  // TurnComplete。
  if (hookBusForShutdown?.has('SessionEnd')) {
    hookBusForShutdown.emit({ name: 'SessionEnd', session: { cwd: process.cwd(), modelId: '' } }).catch(() => undefined)
  }

  resetTerminal()
  // 一定要在 `resetTerminal` 之后再打印，这样提示行才能干净地落在 shell prompt 之上。
  // 此时颜色已重置、raw mode 已关闭、光标也可见。
  // 这个提示读取的是同步捕获的快照（由 App 通过 `onSessionInfoReady` 注册），
  // 所以不会依赖仍在后台跑的异步清理。
  printResumeHint()
  process.exit(exitCode)
}

async function main() {
  checkNodeVersion()
  loadEnvFile()

  // 更新检查也采用 fire-and-forget：查询 npm registry（带 24 小时磁盘缓存），
  // 如果发现新版本就打印一行提示。它永远不会阻塞启动，也不会向外抛错。
  // 在 `--print` 和非 TTY 场景下会被抑制。
  void checkForUpdate().catch(() => undefined)

  // 非交互式插件管理子命令。这里必须在 yargs 解析剩余 argv 之前先分流，
  // 否则 `xc plugin install ./foo` 会被当成 agent 需要响应的 prompt。
  // 这个分支不会挂载 Ink，执行完就直接退出。
  const rawArgs = hideBin(process.argv)
  if (rawArgs[0] === 'plugin') {
    const exitCode = await runPluginCli(rawArgs.slice(1))
    process.exit(exitCode)
  }

  // 解析 CLI 参数。
  const argv = await parseCliArgs()

  const prompt = (argv._ as string[]).join(' ') || undefined

  // 检查 stdin 是否有管道输入。
  let stdinContent = ''
  if (!process.stdin.isTTY) {
    stdinContent = await readStdin()
  }

  const availableProviders = getAvailableProviders()

  // 如果没有配置任何 provider，就显示帮助信息并退出。
  if (availableProviders.length === 0) {
    printNoApiKeyMessage()
    // 这里要以 0 退出：这是一个用户配置提示，不是崩溃。
    // 如果返回非 0，`pnpm dev` 会额外堆出 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL / ELIFECYCLE 噪音。
    process.exit(0)
  }

  // 解析模型。
  let modelId = resolveModelId(argv.model)
  if (!modelId) {
    // 用户指定了一个 provider 没有 key 的模型。
    const requested = argv.model
    if (requested) {
      const provider = requested.split(':')[0]
      const envVar = getEnvVarName(provider) ?? `${provider.toUpperCase()}_API_KEY`
      console.error(`Error: ${envVar} is not set. Please set this environment variable to use ${requested}.`)
      process.exit(1)
    } else {
      printNoApiKeyMessage()
      process.exit(0)
    }
  }

  // 防止使用过期的 model id，而这个 id 对应的 provider 在本次启动里并没有注册。
  // 这种情况很常见：比如用户删掉了某个 env key，但 config.json 仍然指向它；
  // 又或者某个 provider 在构建里被彻底移除了（例如特性回退后）。
  // 否则 registry 会在 `languageModel()` 处抛出 NoSuchProviderError，
  // 甚至在 UI 挂载前就直接 fatal exit。
  // 对显式传入的 `--model` 我们仍然硬失败，因为用户意图很明确；
  // 对持久化 / 智能默认值则回退到第一个可用 provider，保证 CLI 还能继续用。
  const requestedProvider = modelId.split(':')[0]
  if (!availableProviders.includes(requestedProvider)) {
    const envVar = getEnvVarName(requestedProvider) ?? `${requestedProvider.toUpperCase()}_API_KEY`
    if (argv.model) {
      console.error(`Error: ${envVar} is not set. Please set this environment variable to use ${argv.model}.`)
      process.exit(1)
    }
    const fallback = PROVIDER_DETECTION_ORDER.find(({ envKey }) => process.env[envKey])
    if (!fallback) {
      // 防御性分支：上面明明已经确认 availableProviders 非空，
      // 还能走到这里说明配置状态有点异常。这里把问题暴露出来，然后干净退出。
      printNoApiKeyMessage()
      process.exit(0)
    }
    console.error(
      chalk.yellow(
        `Note: saved model '${modelId}' needs ${envVar}, which is not set. ` +
          `Falling back to '${fallback.defaultModel}'. Use /model to pick a different default.`,
      ),
    )
    modelId = fallback.defaultModel
  }

  // 尽早应用持久化 UI 主题（在 `startApp` 之前），这样第一行 scrollback
  // 就能直接按照用户选择的主题绘制。这里包括从恢复会话里注入的历史消息，
  // 比如 edit / write 工具调用，也会一开始就落在正确的 diff 背景和语法色板下。
  // 不认识的值（过期配置、手工编辑错误）会静默回退到默认主题。
  // 这个主题同时会影响两处：一是 `render-diff.ts` 渲染时读取的 diff 背景色，
  // 二是全局 `syntax-highlight` 模块使用的语法高亮色板。
  {
    const t = parseThemeName(loadUserConfig().theme)
    if (t !== null) {
      setTheme(t)
      setSyntaxTheme(getThemeColors(t).syntaxPalette)
    }
  }

  // 创建各类 registry，并拿到模型实例。
  const providerRegistry = createModelRegistry()
  const model = providerRegistry.languageModel(modelId as `${string}:${string}`)

  // `--plugin-debug` / `XC_PLUGIN_DEBUG=1`：把 plugin / hook / marketplace 的
  // debugLog 足迹镜像到 stderr，这样不必 tail `~/.x-code/logs/debug.log`
  // 也能实时看到。这个开关要在 `ensureDefaultMarketplaces` 之前安装，
  // 这样首次运行的订阅提示也能显示出来。
  // 这里选择给 debugLog 加全局 hook，而不是新建一个 logger，
  // 这样现有调用点就不用改，也不会出现两条并行日志路径。
  if (argv['plugin-debug'] || process.env.XC_PLUGIN_DEBUG === '1') {
    setPluginDebugMirror(true)
  }

  // 首次运行种子：如果还没有订阅文件，就把默认的 `anthropic-marketplace`
  // 订阅写入 `known_marketplaces.json`。这一步是幂等的，
  // 用户如果明确删掉了这个订阅，不会被自动加回来。
  // 要在 `loadAllPlugins` 之前做，这样第一次运行时就能看到一个有内容的 marketplace 列表。
  if (argv.plugins !== false) {
    await ensureDefaultMarketplaces().catch((err) => debugLog('plugins.ensure-defaults-failed', String(err)))
  }

  // 插件必须先于 skill / sub-agent / mcp registry 加载，这样它们的贡献才能被折叠进去。
  // `--no-plugins` 会直接跳过整条链路。
  // 这里把非致命加载错误以 stderr 的形式暴露出来，风格和下面的
  // `[mcp] config error in ...` 保持一致：一个坏插件不能挡住其他插件。
  // 更详细的诊断信息（冲突、不支持的命令、hook 错误）会写入 debug.log，
  // 供 `/plugin doctor` 再来展开。
  const pluginLoad = await loadAllPlugins({ cwd: process.cwd(), disabled: argv.plugins === false })
  for (const e of pluginLoad.registry.loadErrors()) {
    console.error(chalk.yellow(`[plugin] ${e.id ?? e.path}: ${e.message}`))
  }
  const pluginIntegration = await buildPluginIntegration(pluginLoad)
  debugLogIntegrationDiagnostics(pluginIntegration)
  if (pluginIntegration.mcpErrors.length > 0) {
    for (const e of pluginIntegration.mcpErrors) {
      console.error(chalk.yellow(`[plugin] ${e.pluginId}: ${e.message}`))
    }
  }

  const subAgentRegistry = await createSubAgentRegistry({ extraDirs: pluginIntegration.agentsDirs })
  const skillRegistry = await createSkillRegistry({ extraDirs: pluginIntegration.skillsDirs })
  const commandRegistry = await createCommandRegistry({ extraDirs: pluginIntegration.commandsDirs })

  // MCP：加载服务器，如果项目级配置不熟悉，就运行信任对话框。
  // 这一步要在 Ink 挂载之前完成，这样基于 readline 的信任提示才能拿到一个干净的终端。
  // MCP 机制是按需启用的：如果用户配置里没有 mcpServers，
  // 只会付出一次 fs.stat 的成本（用户配置一次、项目配置一次）就结束。
  const tokenStorage = getTokenStorage()
  const mcpPermissionStore = new McpPermissionStore()
  const mcpLoadResult = await loadMcpFromDisk({
    cwd: process.cwd(),
    extraServers: pluginIntegration.mcpServers,
    askUser: (question, opts) => askInTerminal(question, opts),
    // browser-open hook 只会在 `/mcp auth` 期间触发；被动启动模式不会调用
    // `redirectToAuthorization`，见 `McpOAuthProvider.redirectToAuthorization`。
    // `App.tsx` 里的 `/mcp auth` 处理器已经通过 `addCommandResult` 把 URL 展示出来了；
    // 如果这里再用 `console.error` 打一份，会直接落进 stderr，破坏 ChatInput 的 cell frame。
    // 这里把它写进 debug log，既能保留排障线索，又不会污染界面。
    oauthProviderFor: createOAuthProviderFactory(tokenStorage, (server, url) => {
      debugLog('mcp.open-browser', `${server}: ${url}`)
    }),
    onExitRequested: () => process.exit(0),
  })
  mcpRegistryForShutdown = mcpLoadResult.registry
  // 当设置了 `--no-hooks` 时，不触发 SessionEnd hook。
  // 这是用户在本次会话里明确选择了退出所有 hook 执行。
  hookBusForShutdown = argv.hooks === false ? null : pluginIntegration.hookBus

  if (mcpLoadResult.configErrors.length > 0) {
    for (const e of mcpLoadResult.configErrors) {
      console.error(chalk.yellow(`[mcp] config error in ${e.name}: ${e.message}`))
    }
  }
  if (mcpLoadResult.projectSkipped) {
    console.error(chalk.yellow(`[mcp] Project-level MCP servers skipped (not trusted).`))
  }
  // 预加载 always-allow 列表，避免第一次工具调用时再承受一次文件读取延迟。
  await mcpPermissionStore.preload()

  const options: AgentOptions = {
    modelId,
    trustMode: argv.trust,
    printMode: argv.print,
    maxTurns: argv['max-turns'],
    // 从磁盘读取持久化的 `/thinking` 开关。默认值设为 false，
    // 这样在没有配置文件的机器上启动时，行为就和这个功能上线前保持一致
    //（使用 provider 默认的 thinking 行为，不会突然出现额外的延迟 / 成本）。
    // `App.tsx` 里的 `/thinking` 命令会通过 `useAgent` 的 `setThinking`
    // 在不重启的情况下热切换这个标记。
    thinking: loadUserConfig().thinking ?? false,
    // Plan 模式是“会话级”的（和 Claude Code 一致）——只有启动时传入
    // `--plan` 才算显式开启。会话中途通过 `/plan` 切换不会持久化，
    // 所以下一次启动仍然会回到 `default`，除非用户再次明确指定。
    permissionMode: argv.plan ? 'plan' : 'default',
    modelRegistry: providerRegistry,
    subAgentRegistry,
    skillRegistry,
    mcpRegistry: mcpLoadResult.registry,
    mcpPermissionStore,
    // `--no-plugins`：把 pluginRegistry 留空，这样 `/plugin` slash 命令
    // 才能渲染“Plugin system is disabled...”之类的专门提示，
    // 而不是退回到通用空状态（`No plugins installed`）。
    // `loadAllPlugins` 即便传了 `disabled:true` 也还是会返回一个非空的空 registry，
    // 所以这里必须在接线处把它丢掉，不能只依赖 load 的结果。
    pluginRegistry: argv.plugins === false ? undefined : pluginLoad.registry,
    commandRegistry,
    // `--no-hooks`：换成一个空 bus，让所有 emit 位置都变成 no-op，
    // 但不影响插件加载的其余部分（skills / agents / mcp 仍然会注册，
    // 只是没有东西监听生命周期事件）。
    hookBus: argv.hooks === false ? emptyHookBus() : pluginIntegration.hookBus,
  }

  // 插件的 SessionStart hook 在 CLI 启动时就触发，这样 hook 就能在用户开始交互之前
  // 先做初始化（环境校验、上下文预热等）。
  // 以前这段逻辑放在 `agentLoop` 的首次调用分支里，结果就是：
  // 1. 如果一个会话只执行 slash 命令然后退出，没有任何用户消息，SessionStart 根本不会触发；
  // 2. 就算触发了，也会落后于第一条 prompt。
  // 现在它和 `gracefulShutdown` 里的 SessionEnd 是对称的。
  // 同样采用 fire-and-forget，慢 hook 绝不能阻塞启动。
  if (options.hookBus?.has('SessionStart')) {
    options.hookBus
      .emit({ name: 'SessionStart', session: { cwd: process.cwd(), modelId } })
      .catch((err) => debugLog('agent.hook-session-start-error', String(err)))
  }

  // Resume / continue。这里有三个入口：
  //   1. `--continue` (-c)：同步加载最近一次会话，不走选择器，适合肌肉记忆式继续。
  //   2. `--resume <id>`：按 id / slug / 文件名前缀查找会话并直接加载。
  //      我们退出后打印的提示（`Resume: xc --resume <id>`）就是反向引导到这里。
  //   3. `--resume`（不带值）：把选择权交给 Ink 内部 picker，通过 `resumeIntent='pick'`
  //      让用户自己浏览。
  // 如果 `--continue` 和 `--resume` 同时出现，优先使用 `--continue`，和 CC 保持一致。
  let initialSession: LoadedSession | null = null
  let resumeIntent: 'pick' | null = null
  if (argv.continue) {
    const latest = await pickLatestSession()
    if (!latest) {
      console.error('Note: --continue specified but no past sessions found in this project. Starting a fresh session.')
    } else {
      const loaded = await loadSession(latest.filePath)
      if (loaded) initialSession = loaded
    }
  } else if (typeof argv.resume === 'string') {
    if (argv.resume === '') {
      resumeIntent = 'pick'
    } else {
      const filePath = await findSessionFile(argv.resume)
      if (!filePath) {
        console.error(
          `Error: no session found matching "${argv.resume}". Run \`xc --resume\` to pick from the list, or \`xc -c\` for the most recent.`,
        )
        process.exit(1)
      }
      const loaded = await loadSession(filePath)
      if (!loaded) {
        console.error(`Error: failed to load session at ${filePath}. The file may be corrupted.`)
        process.exit(1)
      }
      initialSession = loaded
    }
  }

  // 把 stdin 内容和命令行 prompt 合并起来。
  const fullPrompt = [stdinContent, prompt].filter(Boolean).join('\n\n')

  // Print 模式：完全绕过 Ink。只要挂载 TUI，就会让 raw stdin 把 Node 事件循环拖住，
  // 直到 queued unmount 之后还不退出，这就是以前 `-p` 会卡到必须按键的原因。
  // 细节见 `packages/cli/src/print.ts`。
  if (argv.print) {
    if (!fullPrompt) {
      console.error('Error: -p / --print requires a prompt (as an argument or via stdin).')
      process.exit(1)
    }
    const { runPrintMode } = await import('./print.js')
    const code = await runPrintMode(model, options, fullPrompt, initialSession)
    resetTerminal()
    process.exit(code)
  }

  // 提前提醒：WebSearch 需要 key。这里在 Ink 接管之前先打印一次，
  // 这样提示会落在 TUI 上方的 scrollback 里。
  // 这不是致命错误：WebFetch 仍然可以在没有 key 的情况下工作，
  // 而且工具本身在缺少 key 时也会返回更详细的错误。
  if (!process.env.TAVILY_API_KEY && !process.env.BRAVE_API_KEY) {
    printNoWebSearchKeyHint()
  }

  // 启动应用。`waitUntilExit` 会在 Ink 卸载时 resolve（包括 Ctrl+C 的情况）。
  const waitUntilExit = startApp(model, options, fullPrompt || undefined, {
    initialSession,
    resumeIntent,
  })
  await waitUntilExit()

  // 正常退出路径（包括 Ctrl+C，因为它会先让 Ink 卸载）。
  await gracefulShutdown(0)
}

/** 把用户提供的会话查找 key 解析成 session jsonl 文件路径。
 *  支持的输入格式和我们退出后打印的提示一致：
 *    - 纯 sessionId（`20260101-120000-000`）
 *    - slug（`fix-login`）
 *    - 完整文件名前缀（`fix-login-20260101-120000-000`）
 *  优先精确匹配；如果没有精确命中，就退回到对 sessionId 的前缀匹配
 *  （前缀长度足够区分时才会命中）。
 *  返回 newest first 排序下第一条匹配项的文件路径，找不到则返回 null。 */
async function findSessionFile(input: string): Promise<string | null> {
  const sessions = await listSessions()
  for (const s of sessions) {
    if (s.sessionId === input) return s.filePath
    if (s.taskSlug && s.taskSlug === input) return s.filePath
    if (s.taskSlug && `${s.taskSlug}-${s.sessionId}` === input) return s.filePath
  }
  if (input.length >= 8) {
    for (const s of sessions) {
      if (s.sessionId.startsWith(input)) return s.filePath
    }
  }
  return null
}

/** 从 cwd 开始向上查找并加载 `.env` 文件，行为和 dotenv 的常见约定一致。 */
function loadEnvFile(): void {
  let dir = process.cwd()
  while (true) {
    const envPath = path.join(dir, '.env')
    if (fs.existsSync(envPath)) {
      try {
        process.loadEnvFile(envPath)
      } catch {
        // 解析失败就忽略，继续走后续启动流程。
      }
      return
    }
    const parent = path.dirname(dir)
    if (parent === dir) break // 已经到根目录了。
    dir = parent
  }
}

/** 在启动期间、Ink 还没挂载之前使用的纯终端提示。
 *  目前唯一的调用方是 MCP 的项目级信任对话框：
 *  `loader.ts` 会把一个可选项列表交给这里的 `askUser` 回调，
 *  并期望我们返回其中一个选项标签。
 *
 *  当 stdin 不是 TTY（管道输入、CI、`--print` 模式）时会优雅降级：
 *  如果存在看起来像 `skip` 的选项，就返回它；否则返回第二个选项
 *  （loader 的约定是索引 1 对应安全默认项）。这样就能避免我们阻塞在
 *  一个永远不会到来的输入上。 */
async function askInTerminal(
  question: string,
  options: Array<{ label: string; description: string }>,
): Promise<string> {
  const safeDefault = options.find((o) => /skip/i.test(o.label))?.label ?? options[1]?.label ?? options[0]?.label ?? ''

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return safeDefault
  }

  const readline = await import('node:readline/promises')

  // 把提示渲染到 stderr，这样提示正文会和其他 CLI 状态消息落在同一条流里；
  // 如果有人正在捕获 stdout，这样还能保持 stdout 干净（交互启动时比较少见，
  // 但这样更稳妥）。
  process.stderr.write('\n' + chalk.yellow(question) + '\n')
  for (let i = 0; i < options.length; i++) {
    const o = options[i]
    process.stderr.write(`  ${chalk.bold(`${i + 1}.`)} ${o.label} — ${chalk.gray(o.description)}\n`)
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await rl.question(`\nChoose [1-${options.length}]: `)
    const idx = parseInt(answer.trim(), 10) - 1
    if (Number.isFinite(idx) && idx >= 0 && idx < options.length) {
      return options[idx].label
    }
    return safeDefault
  } finally {
    rl.close()
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf-8')

    const onData = (chunk: string): void => {
      data += chunk
    }
    const onEnd = (): void => {
      cleanup()
      resolve(data)
    }
    const cleanup = (): void => {
      process.stdin.off('data', onData)
      process.stdin.off('end', onEnd)
      clearTimeout(timer)
    }

    process.stdin.on('data', onData)
    process.stdin.on('end', onEnd)
    // stdin 超时保护，避免永远挂住。
    const timer = setTimeout(() => {
      cleanup()
      resolve(data)
    }, 1000)
  })
}

// ── 失败保护网 ────────────────────────────────────────────────────────
// Node 15+ 默认会在未处理的 rejection 上直接终止进程。
// AI SDK 会创建若干个彼此独立的 promise（response、usage、finishReason、
// toolCalls、流内部 flush 等），请求失败时它们都可能单独 reject。
// 我们虽然会在 `loop.ts` 里尽量把它们都收干净，但时序竞争或者 SDK 新路径
// 仍然可能漏掉一个。如果没有这个处理器，provider 侧错误（余额不足、max_tokens
// 配错、上游 5xx）就可能在会话中途直接把 REPL 砍掉。
// 这里吞掉 rejection，让 loop 的 onError 路径去显示更友好的消息。
process.on('unhandledRejection', (reason) => {
  if (process.env.DEBUG_STDOUT) {
    console.error('[unhandledRejection]', reason)
  }
})
process.on('uncaughtException', (err) => {
  if (process.env.DEBUG_STDOUT) {
    console.error('[uncaughtException]', err)
  }
})

// ── SIGINT 处理器 ──────────────────────────────────────────────────────
// 这里只是安全兜底：先把 exitCode 设成 0，这样即使进程在 `gracefulShutdown()`
// 之前就退出，退出码也还是 0。双击 Ctrl+C 时则立即强制退出。
let sigintCount = 0
process.on('SIGINT', () => {
  sigintCount++
  process.exitCode = 0
  if (sigintCount >= 2) {
    // 双击 Ctrl+C → 用户就是要立刻退出。这里跳过异步清理（第一次按键时
    // `gracefulShutdown` 很可能已经在跑了），但一定要恢复终端，不然 shell prompt
    // 就可能不可用。没有这个重置，raw mode / 隐藏光标 / bracketed paste
    // 可能会泄漏到 shell 里。
    resetTerminal()
    printResumeHint()
    process.exit(0)
  }
})

main().catch((err) => {
  // 如果当前正在关机（Ctrl+C 已经让 Ink 卸载，`waitUntilExit` 也因此 reject），
  // 不要把它当成致命错误处理，`gracefulShutdown` 已经负责收尾了。
  if (sigintCount > 0 || shutdownInProgress) {
    return
  }
  console.error('Fatal error:', err)
  process.exit(1)
})
