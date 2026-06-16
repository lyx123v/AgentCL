// @x-code-cli/cli — 根 App 组件
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useApp } from 'ink'

import {
  MODEL_ALIASES,
  PROVIDER_MODELS,
  createModelRegistry,
  estimateTokenCount,
  expandCommandBody,
  getAutoMemory,
  getAvailableProviders,
  getContextWindow,
  listSessions,
  loadSession,
  loadUserConfig,
  pickLatestSession,
  resolveModelId,
  saveUserConfig,
  wrapActivatedSkill,
} from '@x-code-cli/core'
import type {
  AgentOptions,
  KnowledgeFact,
  LanguageModel,
  LoadedSession,
  SkillDefinition,
  TokenUsage,
} from '@x-code-cli/core'

import { VERSION } from '../../version.js'
import { createDoctorCommandHandler } from '../commands/doctor.js'
import { createMcpCommandHandler } from '../commands/mcp.js'
import { createPluginCommandHandler } from '../commands/plugin.js'
import { createSkillCommandHandler } from '../commands/skill.js'
import { useAgent } from '../hooks/use-agent.js'
import { buildThemePreview } from '../render-diff.js'
import { setSyntaxTheme } from '../syntax-highlight.js'
import { GLYPH_BULLET } from '../terminal-glyphs.js'
import { DEFAULT_THEME, THEMES, type ThemeName, getTheme, getThemeColors, parseThemeName, setTheme } from '../theme.js'
import { parseBooleanArg } from '../utils.js'
import { getHeaderRowCount } from './AppHeader.js'
import { ChatInput } from './ChatInput.js'

interface AppProps {
  model: LanguageModel
  options: AgentOptions
  initialPrompt?: string
  /** 来自 `xc --continue` 的预加载会话。
   *  首次渲染时直接把 agent 状态灌进去，这样用户还没输入之前，
   *  消息就已经先出现在滚动回溯里。全新启动时这里为 null。 */
  initialSession?: LoadedSession | null
  /** 当值为 `pick` 时，App 会在挂载时弹出 resume 选择器，也就是
   *  `xc --resume` 这条启动参数路径。等 Ink 准备好之后（这样 askQuestion
   *  才能正常渲染），就会走和 `/resume` 完全一样的代码路径。 */
  resumeIntent?: 'pick' | null
  onCleanupReady?: (fn: () => Promise<void>) => void
  /** 把一个实时的会话快照交给 Ink 结束后的 resume 提示。
   *  这在 app.tsx 里接线：注册后的 getter 会在终端重置后由 index.ts
   *  的 gracefulShutdown 调用，这样提示能落在用户 shell 的提示符区域，
   *  方便直接复制 `xc --resume <id>`。 */
  onSessionInfoReady?: (getter: () => { sessionId: string; taskSlug: string; messageCount: number } | null) => void
}

/** 斜杠命令：用于帮助文本和 Tab 补全的内建静态集合。
 *  技能命令会在运行时从技能注册表里动态追加。 */
export const SLASH_COMMANDS = [
  { name: '/help', description: 'Show this help message' },
  {
    name: '/model',
    description: 'Pick a model (no-arg = interactive) — choice is saved',
    argumentHint: '[model-id]',
  },
  {
    name: '/thinking',
    description: 'Toggle extended thinking on/off (no-arg = show status) — saved',
    argumentHint: '[on|off]',
  },
  {
    name: '/theme',
    description: 'Pick UI theme (no-arg = interactive picker) — drives diff colors + syntax palette',
    argumentHint: '[name]',
  },
  {
    name: '/plan',
    description: 'Toggle plan mode on/off (no-arg = show status) — saved',
    argumentHint: '[on|off]',
  },
  { name: '/clear', description: 'Clear conversation history' },
  { name: '/compact', description: 'Manually compress context' },
  { name: '/resume', description: 'Pick a past session in this project to resume', argumentHint: '[id]' },
  {
    name: '/rewind',
    description: 'Roll back files + conversation to a previous user message (no-arg = picker)',
    argumentHint: '[checkpoint-id]',
  },
  { name: '/init', description: 'Initialize project knowledge' },
  { name: '/review', description: 'Review a pull request (no-arg = list open PRs)', argumentHint: '[PR]' },
  { name: '/usage', description: 'Show current-session token usage (input/output/cache)' },
  { name: '/usage-history', description: 'List past sessions in this project' },
  { name: '/memory', description: 'Show auto-memory entries (project + user)' },
  {
    name: '/mcp',
    description: 'Manage MCP servers',
    // 子命令菜单会在输入 `/mcp ` 或 `/mcp <prefix>` 时弹出。
    // 顺序要和本文件里 handleMcp 的 switch 保持一致，这样菜单才能覆盖
    // 所有分支且不漏项。
    subcommands: [
      { name: 'list', description: 'List configured MCP servers' },
      { name: 'tools', description: 'List tools from connected servers (optionally filter by server)' },
      { name: 'add', description: 'Add a new MCP server (stdio or http) to user / project config' },
      { name: 'add-json', description: 'Add an MCP server from a raw JSON config object' },
      { name: 'remove', description: 'Remove an MCP server from config' },
      { name: 'auth', description: 'Authenticate an HTTP MCP server via OAuth' },
      { name: 'logout', description: 'Clear stored OAuth tokens for a server' },
      { name: 'refresh', description: 'Reload mcpServers from disk and reconnect' },
    ],
  },
  {
    name: '/skill',
    description: 'Manage skills',
    subcommands: [
      { name: 'install', description: 'Fetch and install a skill from a URL' },
      { name: 'list', description: 'List installed skills (with on/off state)' },
      { name: 'refresh', description: 'Re-scan skills dirs and apply changes without restart' },
      { name: 'disable', description: 'Disable a skill (kept on disk; run /skill refresh to apply now)' },
      { name: 'enable', description: 'Re-enable a previously disabled skill' },
      { name: 'uninstall', description: 'Delete a skill directory from disk' },
    ],
  },
  {
    name: '/plugin',
    description: 'Manage plugins (bundled skills / agents / mcp / hooks)',
    // 子命令结构要和 handlePlugin 的 switch 保持一致。
    // `marketplace` 本身还是一个子分组，下面还有自己的子命令
    //（add / remove / list / refresh / info）。
    subcommands: [
      { name: 'list', description: 'List installed plugins (with enable state + source)' },
      { name: 'info', description: "Show a plugin's manifest, contributions, and hooks" },
      {
        name: 'install',
        description: 'Install a plugin from <name@marketplace>, git, github:owner/repo, or local path',
      },
      { name: 'uninstall', description: 'Remove a plugin (cache + settings entry; data dir preserved)' },
      {
        name: 'enable',
        description: 'Enable a plugin (writes settings — restart for full effect; --scope=user|project)',
      },
      { name: 'disable', description: 'Disable a plugin without uninstalling (--scope=user|project)' },
      { name: 'search', description: 'Search subscribed marketplaces by keyword' },
      { name: 'update', description: 'Reinstall a plugin from its recorded source' },
      { name: 'refresh', description: 'Live-reload plugins + skills/agents/commands/hooks/MCP servers' },
      { name: 'doctor', description: 'Show plugin load errors and integration warnings' },
      { name: 'marketplace', description: 'Manage marketplace subscriptions (add | remove | list | refresh | info)' },
    ],
  },
  { name: '/doctor', description: 'Diagnose environment, API keys, MCP servers, plugins, and agents' },
  { name: '/exit', description: 'Exit (flushes session)' },
] as const

/** 把 TokenUsage 渲染成 /usage 用的 markdown 块。
 *  cacheReadTokens 是 inputTokens 的子集，所以命中率用
 *  cacheRead / inputTokens 来算，这更符合用户关心的问题：
 *  “我发出去的 prompt 里，有多少被缓存复用了？” */
function formatUsageReport(
  usage: TokenUsage,
  modelId: string,
  source: 'live' | 'snapshot' | 'history',
  sessionName?: string,
): string {
  const fmt = (n: number) => n.toLocaleString('en-US')
  const hitRatio = usage.inputTokens > 0 ? `${((usage.cacheReadTokens / usage.inputTokens) * 100).toFixed(1)}%` : 'n/a'
  const headerMap = {
    live: '**Usage** (current session)',
    snapshot: '**Usage** (last session — no turns yet)',
    history: '**Usage** (history)',
  }
  const header = headerMap[source]
  const lines = [header, '']
  if (sessionName) lines.push(`- Session:         ${sessionName}`)
  lines.push(
    `- Model:           ${modelId}`,
    `- Input tokens:    ${fmt(usage.inputTokens)}`,
    `- Output tokens:   ${fmt(usage.outputTokens)}`,
    `- Cache read:      ${fmt(usage.cacheReadTokens)}  (${hitRatio} of input)`,
    `- Cache creation:  ${fmt(usage.cacheCreationTokens)}`,
    `- Total:           ${fmt(usage.totalTokens)}`,
    '',
    'Cache numbers depend on the provider — DeepSeek/Moonshot/Qwen may report 0 even when prefix caching is active.',
  )
  return lines.join('\n')
}

/** 当恢复的会话里，最近一次已知的输入 token 数（或者字符估算值，
 *  取两者中更大者）超过模型上下文窗口的 60% 时，生成一条
 *  “context X% used，建议 /compact” 的提示；低于阈值则返回 null。
 *
 *  优先使用已加载的 `tokenUsage.inputTokens`，因为那是 provider 在
 *  上一轮真实回报的数据；如果没有 usage 记录（比如第一次 turn 还没
 *  完成就中断了），再退回到基于字符的估算。
 *
 *  这个阈值故意比自动压缩触发点（80%）更低，目的是给用户留出
 *  手动 `/compact` 的时间，避免下一轮不是失败得很难看，就是直接触发
 *  自动压缩而来不及确认。 */
function compactionHintForResume(tokens: number | null, estimatedTokens: number, modelId: string): string | null {
  const window = getContextWindow(modelId)
  const used = Math.max(tokens ?? 0, estimatedTokens)
  if (used === 0) return null
  const pct = (used / window) * 100
  if (pct < 60) return null
  return `\n\n_Context is at **${pct.toFixed(0)}%** of the ${window.toLocaleString('en-US')}-token window — consider \`/compact\` before continuing, or it'll auto-compress on the next turn._`
}

/** 格式化为“5 minutes ago / 2 hours ago / 3 days ago”这类相对时间，
 *  最多显示到天，之后再退回到日期。会话选择器会在每条预览旁边展示它。
 *  相比 ISO 时间戳，这种表达更适合快速扫一眼找“上周改过的那个会话”。 */
function formatRelativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hrs = Math.floor(min / 60)
  if (hrs < 48) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 14) return `${days}d ago`
  return new Date(epochMs).toISOString().slice(0, 10)
}

// formatUsageHistory 已经被组件内部的交互式 handleUsageHistory 选择器替代。
// 参见 handleUsageHistory()。

function buildHelpText(
  skillCommands: readonly { name: string; description: string }[],
  fileCommands: readonly { name: string; description?: string }[],
): string {
  const allCommands = [
    ...SLASH_COMMANDS,
    ...skillCommands.map((s) => ({ name: `/${s.name}`, description: s.description })),
    // 用户 / 项目 / 插件的 markdown 命令。这里 description 是可选项，
    // 因为没有 frontmatter 的命令文件依然是合法的。
    ...fileCommands.map((c) => ({ name: `/${c.name}`, description: c.description ?? '' })),
  ]
  return (
    `X-Code CLI v${VERSION}\n\n` +
    allCommands.map((c) => `  ${c.name.padEnd(16)} ${c.description}`).join('\n') +
    `\n\nModel aliases: ${Object.keys(MODEL_ALIASES).join(', ')}` +
    `\nKeyboard: Esc to interrupt the current turn · ${process.platform === 'darwin' ? '⌃C' : 'Ctrl+C'} (twice) to exit`
  )
}

// `/init` 的提示词正文。它会作为用户消息提交，这样 agent 就会动用
// 全套工具链（Read/Glob/Grep/Edit/Write）扫描代码库，并基于真实证据
// 生成 AGENTS.md，而不是套一个静态模板。
//
// 相比 Claude Code 的 OLD_INIT，这里有几个风格选择：
//   - 目标文件是 AGENTS.md（我们的约定），不是 CLAUDE.md。
//   - 明确提到 AGENTS.local.md 作为个人层，避免模型把用户级偏好
//     （沙箱地址、角色、语气）写进团队共享文件。
//   - 保留 NEW_INIT 的极简原则：如果删掉某一行并不会让 agent 犯错，
//     那这一行就应该删掉。AGENTS.md 每轮都会被读取，冗余会永久消耗 token。
//   - 要求模型在已有 AGENTS.md 上做 Edit-merge，而不是直接覆盖，确保
//     用户手写的内容在重复执行 /init 时还能保留。
const INIT_PROMPT = `Please analyze this codebase and create an AGENTS.md file at the project root. AGENTS.md is loaded into every X-Code CLI (\`xc\`) session, so future agents will read it as their primary project context.

What to include:
1. Common commands the agent should prefer: how to build, lint, run tests, run a single test. Only include what's non-obvious from manifest files.
2. High-level architecture that requires reading multiple files to understand — module boundaries, key data flows, the "big picture" a new contributor needs.
3. Important conventions that DIFFER from language defaults (e.g. "prefer type over interface", "errors live in errors.ts, never inline").
4. Non-obvious gotchas, required env vars, repo etiquette (branch naming, commit style).

Usage notes:
- If AGENTS.md already exists, read it first and use the Edit tool to merge improvements rather than overwriting — preserve the user's hand-written content.
- Apply the minimalism test to every line: "If I removed this line, would the agent make a mistake?" If no, cut it. AGENTS.md is read every turn — bloat costs tokens forever.
- If a README.md exists, mine it for project overview / commands / setup steps. If \`.cursor/rules/\`, \`.cursorrules\`, \`.github/copilot-instructions.md\`, \`.windsurfrules\`, or \`.clinerules\` exist, fold the important parts in.
- Do not list every file or component — those are discoverable via Glob/Grep. Focus on what's NOT discoverable.
- Do not invent sections like "Common Development Tasks", "Tips for Development", or "Support and Documentation" — only write what's expressly grounded in files you've read.
- Do not include generic engineering advice ("write clean code", "add tests"), standard language conventions, or obvious commands ("npm test", "cargo test").
- Personal preferences (the user's role, sandbox URLs, communication style) belong in AGENTS.local.md — gitignored, loaded alongside AGENTS.md. Mention this only if the user has clearly personal context to record; otherwise leave AGENTS.local.md alone.

Prefix the file with:

\`\`\`
# AGENTS.md

This file is loaded into the agent's context at the start of every session. Keep it concise — the agent reads it every turn.
\`\`\`

When you finish, summarize what you wrote (or what you changed if updating an existing file) in a few bullets so the user can review.`

// `/review` 的提示词正文。结构上模仿 Claude Code 的本地 /review：
// 这是一个静态模板，会把 agent 指向 `gh` 并要求输出结构化 review。
// `args` 是命令后面的原始参数字符串（PR 号，或者空）。
//
// 无参数分支被刻意收紧：如果 `gh pr list` 输出为空，就直接视为
// 没有 open PR。原因是我们见过模型在这里多花 8 次以上工具调用去查
// `gh auth`、分支、未提交 diff 等，然后才回头 review 它自己“顺手找到”的
// 东西，既浪费又偏题。
//
// 这里强调“直接用 `gh`，不要包一层 wrapper”，是因为模型有时会在第一轮
// 幻觉出一些通用封装命令（rtk、gh-aux 之类）。
const REVIEW_PROMPT = (args: string) => `You are an expert code reviewer. Use \`gh\` directly — no wrappers.

If no PR number is provided in the args:
1. Run \`gh pr list\` to show open PRs.
2. If the output is empty, reply with exactly: "No open PRs in this repository — re-run \`/review <number>\` to review a specific PR." and stop.
3. Otherwise, list the open PRs and ask the user which to review. Stop and wait.
4. Do NOT investigate further — no \`gh auth\`, no branch / diff / status checks, no reviewing uncommitted changes. The user will re-invoke /review.

If a PR number is provided:
1. Run \`gh pr view <number>\` to get PR details.
2. Run \`gh pr diff <number>\` to get the diff.
3. Write a concise but thorough review with clear sections and bullet points covering:
   - Overview of what the PR does
   - Code correctness
   - Project conventions
   - Performance implications
   - Test coverage
   - Security considerations
   - Specific suggestions and risks

PR number: ${args}`

export function App({
  model,
  options,
  initialPrompt,
  initialSession,
  resumeIntent,
  onCleanupReady,
  onSessionInfoReady,
}: AppProps) {
  const { exit } = useApp()
  const {
    state,
    submit,
    resolvePermission,
    resolveQuestion,
    abort,
    cleanup,
    clear,
    compact,
    resume,
    rewind,
    getCheckpoints,
    getSessionInfo,
    switchModel,
    setThinking,
    getThinking,
    invalidateSystemPromptCache,
    addInfoMessage,
    addUserMessage,
    echoCommand,
    addCommandMessage,
    addCommandResult,
    askQuestion,
    setPermissionMode,
  } = useAgent(model, options, initialSession)

  // 每当 /skill refresh 原地修改注册表时就递增。因为注册表对象的身份在
  // refresh 过程中是稳定的（reload() 只是重写内部 map），所以 React
  // 需要一个显式依赖来感知“可见技能列表已经变了”；否则 memo 化的
  // skillCommands 数组会一直是旧的。
  const [skillRegistryVersion, setSkillRegistryVersion] = useState(0)

  // 从 options.skillRegistry 派生。只有在 registry 版本号变化时才重算，
  // 这样 /skill refresh 之后 Tab 补全和 /help 才能立刻反映新技能，
  // 不需要重启。
  const skillCommands = useMemo(
    () => (options.skillRegistry ? options.skillRegistry.list() : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [skillRegistryVersion],
  )

  // 基于文件的斜杠命令（用户 / 项目 / 插件的 markdown 文件）。
  // 和技能一样也依赖同一个版本号；/plugin refresh 在同时重载两个注册表后
  // 会把它一起递增。
  const fileCommands = useMemo(
    () => (options.commandRegistry ? options.commandRegistry.list() : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [skillRegistryVersion],
  )

  // 合并后的命令列表：内建命令 + 已加载技能 + 文件命令，
  // 供 Tab 补全使用。
  const allCommands = useMemo(
    () => [
      ...SLASH_COMMANDS,
      ...skillCommands.map((s) => ({ name: `/${s.name}`, description: s.description })),
      ...fileCommands.map((c) => ({ name: `/${c.name}`, description: c.description ?? '' })),
    ],
    [skillCommands, fileCommands],
  )

  /** 待注入的技能。
   *  当用户输入 `/skillname` 但不带参数时会设置它，这样就不会为了技能
   *  XML 本身立刻触发一次 AI 响应。技能内容会被前置到“下一条非斜杠命令”
   *  用户消息前面。执行 /clear 时或被消费后会清空。 */
  const pendingSkillRef = useRef<SkillDefinition | null>(null)

  // 输入框下方显示的一行临时提示（位于 ChatInput 的 footer 插槽，
  // 和 plan-mode / accept-edits 指示器并列）。目前只用于“再按一次
  // Ctrl+C 退出”的双击提示。这里刻意把用途收窄，这样未来如果还有
  // 新提示场景，就能共用同一个渲染位置。布局上参考了 Claude Code 的
  // PromptInputFooter。
  const [notice, setNotice] = useState<string | null>(null)
  // 最近一次 Ctrl+C 的时间戳。在“已武装”窗口内，下一次 Ctrl+C 会直接退出；
  // 超出窗口后，Ctrl+C 只会重新武装（如果当前有正在跑的 turn，也会顺便取消）。
  // 这个 2 秒窗口的行为和 Claude Code 的 `useExitOnCtrlCD` 类似。
  const ctrlCArmedAtRef = useRef(0)
  const ctrlCArmWindowMs = 2000
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 在武装窗口过期后自动清掉提示。
  useEffect(() => {
    if (!notice) return
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = setTimeout(() => setNotice(null), ctrlCArmWindowMs)
    return () => {
      if (noticeTimerRef.current) {
        clearTimeout(noticeTimerRef.current)
        noticeTimerRef.current = null
      }
    }
  }, [notice])

  /** Ctrl+C 处理器：双击退出，单击则取消正在进行的 turn（如果有），并
   *  显示退出提示。行为和 Claude Code 类似：
   *
   *    空闲   + 第 1 次按下 → 显示“再按一次 Ctrl+C 退出”，进入 2 秒武装窗口
   *    空闲   + 第 2 次按下 → 退出
   *    加载中 + 第 1 次按下 → 中止当前 turn，显示提示，进入 2 秒武装窗口
   *    加载中 + 第 2 次按下 → 退出
   *
   *  武装窗口会自动过期（提示由上面的 effect 自动清除）。 */
  const handleCtrlC = useCallback(() => {
    const now = Date.now()
    const armed = now - ctrlCArmedAtRef.current < ctrlCArmWindowMs
    if (armed) {
      // 在窗口内再次按下，说明用户确实想退出。这里直接干净退出即可
      //（Ink 卸载 → 通过 onCleanupReady 触发 gracefulShutdown）。
      exit()
      return
    }
    ctrlCArmedAtRef.current = now
    if (state.isLoading) {
      abort()
    }
    setNotice('Press Ctrl+C again to exit')
  }, [exit, abort, state.isLoading])

  // 注册清理函数，供优雅退出（SIGINT）使用。
  useEffect(() => {
    onCleanupReady?.(cleanup)
  }, [cleanup]) // eslint-disable-line react-hooks/exhaustive-deps

  // 注册退出后的 session 信息获取器。index.ts 会在 resetTerminal 之后
  // 调它，往 shell 里打印 "Resume: xc --resume <id>"。
  // 因为 getSessionInfo 直接读取 loopStateRef，所以跨渲染是稳定的；
  // 组件挂载时注册一次就够了。
  useEffect(() => {
    onSessionInfoReady?.(getSessionInfo)
  }, [getSessionInfo]) // eslint-disable-line react-hooks/exhaustive-deps

  /** /resume：列出当前项目里所有历史会话，让用户选择一个加载。
   *  这里复用 askQuestion 选择器（和 /model、askUser tool 用的是同一套
   *  对话框），这样键盘导航、“Other” 作为自由输入逃生口、Esc 取消这些
   *  行为都能天然保持一致。
   *
   *  选项显示格式：`[<短提示>] <相对时间> · N msgs`
   *  每个选项的 description 里都会放绝对文件路径，方便用户确认自己选的是
   *  哪个会话。选中后会调用 `loadSession` 做完整文件读取（不是只读头尾的
   *  enrich 流程），再传给 `useAgent.resume` 热切换 agent 状态。
   *
   *  这里包一层 useCallback，是为了让挂载时的 effect 能直接引用它，
   *  又不会触发 react-hooks 的闭包新鲜度警告（组件体后面定义的函数声明，
   *  即使 JS 语义上可提升，也常被 lint 误判）。 */
  const handleResume = useCallback(async () => {
    const sessions = await listSessions()
    if (sessions.length === 0) {
      addInfoMessage(
        '**No past sessions found in this project.** Sessions are saved automatically — start working and one will appear here next time.',
      )
      return
    }
    const choices = sessions.slice(0, 30).map((s) => {
      const preview = (s.firstPrompt || '(empty)').slice(0, 60).replace(/\s+/g, ' ').trim()
      const ago = formatRelativeTime(s.mtime)
      const totalTokens = s.tokenUsage ? s.tokenUsage.totalTokens.toLocaleString('en-US') : '—'
      return {
        label: `${preview}  ·  ${ago}`,
        description: `${s.modelId}  ·  ${totalTokens} tokens  ·  ${s.sessionId}`,
        filePath: s.filePath,
      }
    })
    const answer = await askQuestion(
      `Pick a session to resume (${sessions.length} total in this project):`,
      choices.map((c) => ({ label: c.label, description: c.description })),
    )
    const picked = choices.find((c) => c.label === answer)
    if (!picked) {
      // User typed a free-form value into "Other". Treat as cancelled —
      // we don't try to fuzzy-match against session ids; the picker is
      // the supported way to pick.
      addInfoMessage('Resume cancelled.')
      return
    }
    const loaded = await loadSession(picked.filePath)
    if (!loaded) {
      addInfoMessage(`Failed to load session at ${picked.filePath}. The file may be corrupted.`)
      return
    }
    resume(loaded)
    const hint =
      compactionHintForResume(
        loaded.tokenUsage.inputTokens || null,
        estimateTokenCount(loaded.messages),
        loaded.modelId,
      ) ?? ''
    addInfoMessage(
      `**Resumed session:** ${loaded.firstPrompt.slice(0, 80) || '(no first prompt)'}\n\nContinuing from ${loaded.messages.length} message${loaded.messages.length === 1 ? '' : 's'}.${hint}`,
    )
  }, [addInfoMessage, askQuestion, resume])

  /** Picker + executor for `/rewind`. With an arg, jumps straight to the
   *  named checkpoint (full or sha1-style prefix). Without, lists every
   *  checkpoint in this session newest-first with the user prompt that
   *  triggered it as the preview. The picker silently no-ops when nothing
   *  has been checkpointed (e.g. on the first turn before any user
   *  message has landed). */
  const handleRewind = useCallback(
    async (arg: string) => {
      const checkpoints = getCheckpoints()
      if (checkpoints.length === 0) {
        addInfoMessage(
          '**No rewind points yet.** A checkpoint is taken at the start of every user message — type something first, then `/rewind` will offer it.',
        )
        return
      }

      // Direct arg: exact ckptId match, then prefix. No fuzzy match —
      // ambiguous prefixes would silently roll back the wrong point.
      let pickedId: string | null = null
      if (arg) {
        const exact = checkpoints.find((c) => c.ckptId === arg)
        if (exact) pickedId = exact.ckptId
        else {
          const prefixed = checkpoints.filter((c) => c.ckptId.startsWith(arg))
          if (prefixed.length === 1) pickedId = prefixed[0]!.ckptId
          else if (prefixed.length > 1) {
            addInfoMessage(
              `Ambiguous checkpoint prefix \`${arg}\` (${prefixed.length} matches). Run \`/rewind\` and pick.`,
            )
            return
          } else {
            addInfoMessage(`No checkpoint matches \`${arg}\`. Run \`/rewind\` and pick.`)
            return
          }
        }
      }

      if (!pickedId) {
        // Newest first matches what users intuit when they think "go back
        // a step or two" — the freshest decision points are at the top.
        const ordered = [...checkpoints].reverse()
        const choices = ordered.slice(0, 30).map((c) => {
          const preview = (c.userPrompt || '(empty prompt)').slice(0, 60).replace(/\s+/g, ' ').trim()
          const ago = formatRelativeTime(new Date(c.ts).getTime())
          return {
            label: `${preview}  ·  ${ago}`,
            description: `${c.ckptId}  ·  message #${c.messageCount}`,
            ckptId: c.ckptId,
          }
        })
        const answer = await askQuestion(
          `Pick a checkpoint to rewind to (${ordered.length} total in this session):`,
          choices.map((c) => ({ label: c.label, description: c.description })),
        )
        const picked = choices.find((c) => c.label === answer)
        if (!picked) {
          addInfoMessage('Rewind cancelled.')
          return
        }
        pickedId = picked.ckptId
      }

      const result = await rewind(pickedId)
      if (!result.ok) {
        addInfoMessage(`**Rewind failed:** ${result.reason}`)
        return
      }
      addInfoMessage(
        `**Rewound to:** ${result.preview || '(empty prompt)'}\n\nFiles and conversation restored. Continue from here.`,
      )
    },
    [addInfoMessage, askQuestion, getCheckpoints, rewind],
  )

  /** Resolve a ThemeName back to its display label. */
  function themeLabel(name: ThemeName): string {
    return THEMES.find((t) => t.name === name)?.label ?? name
  }

  /** Apply a theme: update the active UI-theme state AND switch the
   *  syntax-highlight palette to the one bundled with the theme.
   *  Centralized so /theme, the first-run picker, and the startup
   *  loader all stay in sync — easy to forget one of the two and end
   *  up with bg colors that don't match the code colors. */
  function applyTheme(name: ThemeName) {
    setTheme(name)
    setSyntaxTheme(getThemeColors(name).syntaxPalette)
  }

  /**
   * First-run onboarding picker. Fires once when `config.json` has no
   * `theme` key — i.e. brand-new users on their first interactive
   * launch (resumes / `--print` / inline initial prompts skip it; see
   * the launch-flow effect below). After the user picks (or dismisses)
   * we persist the choice so the next launch never re-asks, even if
   * they bailed without an explicit selection — that's also their
   * answer ("default is fine").
   */
  async function runFirstRunThemePicker() {
    addInfoMessage(
      [
        '**Welcome to X-Code!**',
        '',
        'Choose the theme that looks best with your terminal. You can change it any time with `/theme`.',
      ].join('\n'),
    )

    const cols = Math.max(40, process.stdout.columns ?? 100)
  // 预留对话框左侧外边距（1 个缩进）+ 预览子缩进（2 个缩进）的空间。
  // 预览辅助函数会自己补齐到整列，所以这里把预算稍微放宽一点也没关系。
    const previewWidth = Math.max(40, cols - 4)
    const choices = THEMES.map((t) => ({
      name: t.name,
      label: t.label,
      description: t.description,
      preview: buildThemePreview(t.name, previewWidth),
    }))

    const answer = await askQuestion(
      'Pick a theme:',
      choices.map((c) => ({ label: c.label, description: c.description, preview: c.preview })),
    )

    const picked = choices.find((c) => c.label === answer)
    const parsedFree = parseThemeName(answer ?? '')
    const resolved = picked ? picked.name : (parsedFree ?? DEFAULT_THEME)

    applyTheme(resolved)
    saveUserConfig({ theme: resolved })

    if (picked || parsedFree !== null) {
      addInfoMessage(`Theme set to **${themeLabel(resolved)}**. Type a message to get started.`)
    } else {
      addInfoMessage(`Using default theme **${themeLabel(resolved)}**. Run \`/theme\` any time to switch.`)
    }
  }

  // 挂载时的 resume 处理。CLI 入口会设置三条互斥路径：
  //   - initialSession 有值：`xc -c` 已经同步加载了最近一次会话。
  //     useAgent 也已经把它灌进滚动回溯里；这里只需要补一条 banner，
  //     告诉用户自己是“恢复进来的”，避免看着像消息凭空出现。
  //     这里不做任何异步工作，只是一个视觉提示。
  //   - resumeIntent === 'pick'：`xc -r` 需要弹 picker。这里直接走和
  //     `/resume` 一样的对话框。
  //   - 两者都没有：普通启动，可以选择把 initialPrompt 自动提交。
  // picker 会等待 askQuestion，而 askQuestion 只有等用户做出选择才会 resolve，
  // 所以我们把它封装在 effect 里并忽略返回的 promise。Ink 不关心 effect 里
  // 挂着的异步任务。
  useEffect(() => {
    if (initialSession) {
      const preview = initialSession.firstPrompt.slice(0, 80) || '(no first prompt)'
      const hint =
        compactionHintForResume(
          initialSession.tokenUsage.inputTokens || null,
          estimateTokenCount(initialSession.messages),
          initialSession.modelId,
        ) ?? ''
      addInfoMessage(
        `**Resumed session** — ${preview}\n\nRestored ${initialSession.messages.length} message${initialSession.messages.length === 1 ? '' : 's'}. Continuing the same conversation.${hint}`,
      )
      return
    }
    if (resumeIntent === 'pick') {
      void handleResume()
      return
    }
    // 首次运行的主题选择器，只在纯交互启动时出现（没有 resume，
    // 也没有自动提交的 initialPrompt）。通过磁盘配置里缺少 `theme`
    // 来判断。用户一旦选择了某个主题（或者直接关闭），我们都会持久化
    // 一个值，这样这条分支以后就不会再触发。resume / 内联 prompt 启动
    // 会刻意跳过这一段，因为这些场景更像是“马上干活”，不是“先配置”。
    if (!initialPrompt && loadUserConfig().theme === undefined) {
      void runFirstRunThemePicker()
      return
    }
    if (initialPrompt) {
      void submit(initialPrompt)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // print 模式已经不再走 Ink 这条链路了，见 packages/cli/src/print.ts。
  // 以前这里的 effect 会尝试 `cleanup().then(exit)`，但 usePromptInput
  // 拿到的 raw-stdin 引用会让事件循环在卸载后仍然存活，所以 exit 会一直
  // 卡住，直到用户按键或终端尺寸变化。

  /** 把斜杠命令回显到消息历史里，这样用户能看见自己刚才输入了什么。 */
  /** 处理用户输入（包括斜杠命令）。 */
  async function handleSubmit(text: string) {
    // 斜杠命令分支
    if (text.startsWith('/')) {
      const parts = text.slice(1).trim().split(/\s+/)
      const command = parts[0].toLowerCase()
      const arg = parts.slice(1).join(' ')

      switch (command) {
        case 'help':
          echoCommand(text)
          addInfoMessage(buildHelpText(skillCommands, fileCommands))
          return

        case 'model':
          handleModelSwitch(text, arg)
          return

        case 'thinking':
          handleThinkingToggle(text, arg)
          return

        case 'theme':
          await handleThemeSwitch(text, arg)
          return

        case 'plan':
          handlePlanToggle(text, arg)
          return

        case 'clear':
          // 这里不回显命令，也不追加结果消息。ChatInput 的 shrink-detection
          // 路径会把可见终端和滚动回溯一起清空，让用户看到一个只有输入框的空
          // 视口。如果再插入一条“Conversation cleared.”，清屏后的画面就会立刻
          // 从第 1 行重新开始绘制，破坏用户想要的“像刚启动一样干净”的效果。
          pendingSkillRef.current = null
          clear()
          return

        case 'compact':
          echoCommand(text)
          await handleCompact()
          return

        case 'resume':
          echoCommand(text)
          await handleResume()
          return

        case 'rewind':
          echoCommand(text)
          await handleRewind(arg)
          return

        case 'init':
          echoCommand(text)
          await submit(INIT_PROMPT, { silent: true })
          return

        case 'review':
          echoCommand(text)
          await submit(REVIEW_PROMPT(arg), { silent: true })
          return

        case 'usage':
          echoCommand(text)
          await handleUsage()
          return

        case 'usage-history':
          echoCommand(text)
          await handleUsageHistory()
          return

        case 'memory':
          echoCommand(text)
          handleMemory()
          return

        case 'skill':
          await handleSkill(text, arg)
          return

        case 'mcp':
          await handleMcp(text, arg)
          return

        case 'plugin':
          await handlePlugin(text, arg)
          return

        case 'doctor':
          handleDoctor(text)
          return

        case 'exit':
          await cleanup()
          exit()
          return

        default: {
          // 先检查它是不是已加载的技能命令。
          const skill = options.skillRegistry?.get(command)
          if (skill) {
            if (arg) {
              // 技能 + 立即请求：先回显，再把技能内容和用户请求一起注入并提交，
              // 这样模型会把技能人格应用到这一个具体问题上。submit 设为 silent，
              // 所以可见回显交给 echoCommand 来做。
              // wrapActivatedSkill 会构造和 activateSkill 工具完全一样的
              // <activated_skill> 包装（body + base directory + file list），
              // 所以不管是用户手动触发还是工具触发，模型看到的输入格式是字节级一致的。
              echoCommand(text)
              await submit(`${wrapActivatedSkill(skill)}\n\n${arg}`, {
                silent: true,
              })
            } else {
              // 还没有后续内容时，就先把整个 SkillDefinition 存起来，
              // 这样用户下一条真正的普通消息到来时，我们可以用同样的 wrapper
              // 再格式化一次。回显由 addCommandMessage 处理。
              pendingSkillRef.current = skill
              addCommandMessage(text, `Skill **${skill.name}** loaded. Type your request.`)
            }
            return
          }

          // 然后检查插件贡献的斜杠命令。它们会把任意已安装插件里的
          // `commands/<name>.md` 映射成 `/<name>`。命令正文会作为模型提示词发送，
          // 并先做 $ARGUMENTS / ${CLAUDE_PLUGIN_ROOT} 替换。
          const cmd = options.commandRegistry?.get(command)
          if (cmd) {
            echoCommand(text)
            const expanded = expandCommandBody(cmd, arg)
            await submit(expanded, { silent: true })
            return
          }
          addCommandMessage(text, `Unknown command: /${command}. Type /help for available commands.`)
          return
        }
      }
    }

    // 如果有待注入的技能上下文，就先把它前置到用户消息，再清空引用。
    const pendingSkill = pendingSkillRef.current
    if (pendingSkill) {
      pendingSkillRef.current = null
      await submit(`${wrapActivatedSkill(pendingSkill)}\n\n${text}`, { silent: true })
      return
    }
    await submit(text)
  }

  /** 把 model id 转成更适合人看的标签；找不到就退回原始 id。 */
  function renderModelLabel(modelId: string): string {
    for (const models of Object.values(PROVIDER_MODELS)) {
      for (const m of models) if (m.id === modelId) return m.label
    }
    return modelId
  }

  /**
   * 提交一次模型切换：重建 provider registry（让新 provider 的环境变量 API key
   * 能被读到）、替换当前在线的 language-model 引用、持久化到用户配置，
   * 再回显一条确认消息。
   */
  function commitModelChange(commandText: string, newModelId: string) {
    try {
      const registry = createModelRegistry()
      const newModel = registry.languageModel(newModelId as `${string}:${string}`)
      switchModel(newModelId, newModel)
      saveUserConfig({ model: newModelId })
      addCommandMessage(commandText, `Set model to ${renderModelLabel(newModelId)}`)
    } catch (err) {
      addCommandMessage(commandText, `Failed to switch model: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function handleModelSwitch(commandText: string, arg: string) {
    // 有显式参数时：保留原来的可脚本化路径（别名或完整 id）。
    if (arg) {
      const newModelId = resolveModelId(arg)
      if (!newModelId) {
        addCommandMessage(commandText, `Could not resolve model: ${arg}`)
        return
      }
      commitModelChange(commandText, newModelId)
      return
    }

    // 没有参数时 → 进入交互式选择器。只枚举那些 provider 已经配置好 API key
    // 的模型，这样列表是“真的能用”的，而不是“理论上存在”的。
    const providers = new Set(getAvailableProviders())
    const choices: { id: string; label: string; description: string }[] = []
    for (const [provider, models] of Object.entries(PROVIDER_MODELS)) {
      if (!providers.has(provider)) continue
      for (const m of models) {
        const marker = m.id === state.modelId ? `${GLYPH_BULLET} ` : '  '
        choices.push({ id: m.id, label: `${marker}${m.label}`, description: `${m.id} — ${m.description}` })
      }
    }

    if (choices.length === 0) {
      addCommandMessage(
        commandText,
        'No models available — set an API key (e.g. `ANTHROPIC_API_KEY`, `ALIBABA_API_KEY`) and restart.',
      )
      return
    }

    // askQuestion 返回的是被选中的选项 LABEL（不是 id）。
    // SelectOptions 对话框就是为人类可读选项设计的，所以我们要通过刚才塞进去的
    // label 再把 id 反查回来。
    const answer = await askQuestion(
      `Current: ${state.modelId}\nPick a model (${GLYPH_BULLET} = current):`,
      choices.map((c) => ({ label: c.label, description: c.description })),
      { noOther: true },
    )
    const picked = choices.find((c) => c.label === answer)
    if (!picked) {
      // 空答案 = 按 Esc 关闭了对话框。这里静默取消，不要把空字符串再丢给
      // resolveModelId，否则会打印出一个空 id 的 “Could not resolve model: ”。
      if (!answer) {
        addCommandMessage(commandText, `Cancelled — model stays **${renderModelLabel(state.modelId)}**.`)
        return
      }
      // 用户选择了 “Other” 或者自己输入了自由文本。这里把它当成直接的 model id / alias，
      // 这样高级用户仍然能跳到 picker 没列出的冷门模型。
      const resolved = resolveModelId(answer)
      if (!resolved) {
        addCommandMessage(commandText, `Could not resolve model: ${answer}`)
        return
      }
      commitModelChange(commandText, resolved)
      return
    }
    if (picked.id === state.modelId) {
      addCommandMessage(commandText, `Already on ${renderModelLabel(picked.id)} — no change.`)
      return
    }
    commitModelChange(commandText, picked.id)
  }

  /** 提交 thinking 模式切换：更新实时 ref，让下一轮 agent turn 直接使用；
   *  持久化到磁盘；再回显一个 Claude 风格的两行命令块。 */
  function commitThinkingChange(commandText: string, next: boolean) {
    setThinking(next)
    saveUserConfig({ thinking: next })
    addCommandMessage(commandText, `Extended thinking → **${next ? 'on' : 'off'}**. Takes effect on the next message.`)
  }

  /**
   * `/thinking` — flip the extended-thinking toggle.
   *
   * No arg → interactive picker. Same UX as `/model` no-arg: shows the
   *   current state (`●` on the active option) and lets the user pick
   *   the other one with arrow keys + Enter. Cancelling / picking the
   *   already-active option results in no change.
   * `on` / `off` (and aliases like `true`/`false`/`enable`/`disable`)
   *   → direct switch, useful for scripting and muscle memory.
   * Any other arg → reject with a hint, don't silently swallow.
   *
   * The toggle is uniform across providers (see providers/thinking.ts):
   *   ON  applies the maximum reasoning each provider supports;
   *   OFF asks for minimum / disabled where exposed (Gemini 2.5 Pro
   *       can't be fully disabled — it gets clamped to its 128-token
   *       minimum).
   *
   * Persisted to ~/.x-code/config.json so the choice survives restarts.
   * The agent loop reads it on every turn via thinkingRef in useAgent,
   * so the next message after toggling already uses the new mode (no
   * model rebuild required, unlike /model).
   */
  async function handleThinkingToggle(commandText: string, arg: string) {
    const current = getThinking()
    const trimmed = arg.trim().toLowerCase()

    // 直接切换的快捷路径。
    if (trimmed) {
      const next = parseBooleanArg(trimmed)
      if (next === null) {
        addCommandMessage(
          commandText,
          `Unknown value: \`${arg}\`. Use \`/thinking\`, \`/thinking on\`, or \`/thinking off\`.`,
        )
        return
      }

      if (next === current) {
        addCommandMessage(commandText, `Extended thinking is already **${next ? 'on' : 'off'}** — no change.`)
        return
      }

      commitThinkingChange(commandText, next)
      return
    }

    // 没有参数时 → 交互式选择器。这里始终展示两个选项，让用户看见完整状态空间，
    // 用 `● ` 标记当前项（和 `/model` 的渲染方式一致）。
    const onMarker = current ? `${GLYPH_BULLET} ` : '  '
    const offMarker = current ? '  ' : `${GLYPH_BULLET} `
    const choices = [
      {
        label: `${onMarker}On`,
        description: 'Opt every supported provider into max reasoning. Slower, costs more, better on hard problems.',
      },
      {
        label: `${offMarker}Off`,
        description: 'Each provider runs its non-thinking default. Faster, cheaper, sufficient for most chat.',
      },
    ]
    const answer = await askQuestion(
      `Extended thinking is currently **${current ? 'on' : 'off'}**. Pick a mode (${GLYPH_BULLET} = current):`,
      choices,
      { noOther: true },
    )
    const wantOn = answer === choices[0].label
    const wantOff = answer === choices[1].label
    if (!wantOn && !wantOff) {
      // 用户在 picker 里输入了自由文本。先尊重标准别名；否则就当作 no-op
      //（大概率只是想退出）。
      const free = (answer ?? '').trim().toLowerCase()
      if (free === 'on' || free === 'true' || free === '1' || free === 'enable' || free === 'enabled') {
        if (current) {
          addCommandMessage(commandText, 'Extended thinking is already **on** — no change.')
          return
        }
        commitThinkingChange(commandText, true)
        return
      }
      if (free === 'off' || free === 'false' || free === '0' || free === 'disable' || free === 'disabled') {
        if (!current) {
          addCommandMessage(commandText, 'Extended thinking is already **off** — no change.')
          return
        }
        commitThinkingChange(commandText, false)
        return
      }
      addCommandMessage(commandText, `Cancelled — extended thinking stays **${current ? 'on' : 'off'}**.`)
      return
    }
    const next = wantOn
    if (next === current) {
      addCommandMessage(commandText, `Already **${next ? 'on' : 'off'}** — no change.`)
      return
    }
    commitThinkingChange(commandText, next)
  }

  // themeLabel + applyTheme + runFirstRunThemePicker 放在启动 useEffect
  //（大约第 350 行附近那个）上面，是因为那个 effect 就是负责触发首次运行
  // 主题选择器的。`react-compiler` 会对 `[]` 依赖的 effect 里“先引用、后声明”
  // 的写法报警，所以我们把这些 helper 提前 hoist 到上面。
  // /theme 的处理函数（commitThemeChange、handleThemeSwitch）仍然放在其它斜杠
  // 命令处理函数附近，因为它们是从常规的 handleSubmit 路径调用的，
  // 对 hoist 的要求更宽松。

  /** 应用主题切换：同时切换当前 UI 主题和它绑定的语法高亮调色板，
   *  这样下一次 diff 渲染就会用新颜色；再写入用户配置并回显确认。
   *  agent loop / 滚动回溯写入器都不缓存颜色，所以下一次工具结果出来时
   *  就能立刻看到变化，不需要重启。 */
  function commitThemeChange(commandText: string, name: ThemeName) {
    applyTheme(name)
    saveUserConfig({ theme: name })
    addCommandMessage(commandText, `Set theme to **${themeLabel(name)}**.`)
  }

  /**
   * `/theme` — pick the UI theme. Drives diff bg colors AND the
   * associated syntax-highlight palette.
   *
   * 没有参数 → 进入交互式选择器，展示全部六套主题，当前项用 `●` 标记，
   *   并提供实时预览，用户按方向键时会同步换色。交互体验和 `/model`、
   *   `/thinking` 一致。
   * `<theme-name>` → 直接切换。支持标准 kebab-case 名称
   *  （`dark`、`light`、`dark-daltonized`、`light-daltonized`、
   *   `dark-ansi`、`light-ansi`）以及别名（`colorblind`、`ansi` 等），
   *   具体见 `parseThemeName`。
   *
   * 会持久化到 ~/.x-code/config.json，所以重启后仍然生效。
   */
  async function handleThemeSwitch(commandText: string, arg: string) {
    const current = getTheme()

    if (arg.trim()) {
      const next = parseThemeName(arg)
      if (next === null) {
        const names = THEMES.map((t) => t.name).join(', ')
        addCommandMessage(commandText, `Unknown theme: \`${arg}\`. Available: ${names}.`)
        return
      }
      if (next === current) {
        addCommandMessage(commandText, `Theme is already **${themeLabel(next)}** — no change.`)
        return
      }
      commitThemeChange(commandText, next)
      return
    }

    // 没有参数 → 交互式选择器。把所有主题都展示出来，用 `●` 标记当前项。
    // 和 model 选择器共用同一个对话框组件，再加一个会随着方向键移动而实时变色的
    // 预览面板。
    const cols = Math.max(40, process.stdout.columns ?? 100)
    const previewWidth = Math.max(40, cols - 4)
    const choices = THEMES.map((t) => ({
      name: t.name,
      label: `${t.name === current ? `${GLYPH_BULLET} ` : '  '}${t.label}`,
      description: t.description,
      preview: buildThemePreview(t.name, previewWidth),
    }))
    const answer = await askQuestion(
      `Current: **${themeLabel(current)}**. Choose the text style that looks best with your terminal (${GLYPH_BULLET} = current):`,
      choices.map((c) => ({ label: c.label, description: c.description, preview: c.preview })),
    )
    const picked = choices.find((c) => c.label === answer)
    if (!picked) {
      const free = parseThemeName(answer ?? '')
      if (free === null) {
        addCommandMessage(commandText, `Cancelled — theme stays **${themeLabel(current)}**.`)
        return
      }
      if (free === current) {
        addCommandMessage(commandText, `Theme is already **${themeLabel(free)}** — no change.`)
        return
      }
      commitThemeChange(commandText, free)
      return
    }
    if (picked.name === current) {
      addCommandMessage(commandText, `Theme is already **${themeLabel(current)}** — no change.`)
      return
    }
    commitThemeChange(commandText, picked.name)
  }

  /** 通过 /plan 切换 plan mode。这里直接进出，不给 picker：
   *  用户既然明确敲了 `/plan`，那就是在直接要 plan mode，所以我们不绕弯。
   *  `/plan` 会在 plan ↔ 之前的状态之间切换；`/plan on` / `/plan off`
   *  则是给脚本流程用的幂等设置。输出格式和 Claude Code 的 `/plan`
   *  单行确认一致。 */
  function handlePlanToggle(commandText: string, arg: string) {
    const current = state.permissionMode === 'plan'
    const trimmed = arg.trim().toLowerCase()

    let next: boolean
    if (!trimmed) {
      next = !current
    } else {
      const parsed = parseBooleanArg(trimmed)
      if (parsed === null) {
        addCommandMessage(commandText, `Unknown value: \`${arg}\`. Use \`/plan\`, \`/plan on\`, or \`/plan off\`.`)
        return
      }
      next = parsed
    }

    if (next === current) {
      addCommandMessage(commandText, `Plan mode is already **${current ? 'on' : 'off'}** — no change.`)
      return
    }

    // /plan 会直接在 plan 和 default 之间切换。我们先在 loopState 上应用这个
    // 模式，再让已有的 onPlanModeChange 回调链路通过 setPermissionMode 去同步
    // React 状态和 UI。
    setPermissionMode(next ? 'plan' : 'default')
    addCommandMessage(commandText, next ? 'Enabled plan mode' : 'Disabled plan mode')
  }

  async function handleCompact() {
    const result = await compact()
    if (!result) {
      addCommandResult('Nothing to compress — conversation is too short.')
      return
    }
    const beforeK = Math.round(result.beforeTokens / 1000)
    const afterK = Math.round(result.afterTokens / 1000)
    addCommandResult(`Context compressed: ~${beforeK}k → ~${afterK}k tokens.`)
  }

  async function handleUsage() {
    let usage: TokenUsage = state.usage
    let modelId = state.modelId
    let source: 'live' | 'snapshot' = 'live'
    let sessionName: string | undefined
    const info = getSessionInfo()
    if (info?.firstPrompt) {
      sessionName = info.firstPrompt
    }
    if (usage.totalTokens === 0) {
      const latest = await pickLatestSession()
      if (latest && latest.tokenUsage) {
        usage = latest.tokenUsage
        modelId = latest.modelId
        source = 'snapshot'
        sessionName = latest.firstPrompt.slice(0, 80) || undefined
      }
    }
    addInfoMessage(formatUsageReport(usage, modelId, source, sessionName))
  }

  async function handleUsageHistory() {
    const sessions = await listSessions()
    if (sessions.length === 0) {
      addInfoMessage('**Usage history** — no past sessions found in this project.')
      return
    }

    const fmt = (n: number) => n.toLocaleString('en-US')
    const choices = sessions.map((s) => {
      const preview = (s.firstPrompt || '(empty)').slice(0, 50).replace(/\s+/g, ' ').trim()
      const ago = formatRelativeTime(s.mtime)
      const total = s.tokenUsage ? fmt(s.tokenUsage.totalTokens) : '—'
      return {
        label: `${preview}  ·  ${ago}`,
        description: `${s.modelId}  ·  ${total} tokens`,
        session: s,
      }
    })

    const BACK_LABEL = '← Back to list'
    const tick = () => new Promise<void>((r) => setTimeout(r, 50))

    while (true) {
      const answer = await askQuestion(
        `**Usage history** — ${sessions.length} session${sessions.length === 1 ? '' : 's'}. Pick one to view details:`,
        choices.map((c) => ({ label: c.label, description: c.description })),
        { noOther: true },
      )

      const picked = choices.find((c) => c.label === answer)
      if (!picked) break

      const s = picked.session
      const usage = s.tokenUsage
      if (!usage) {
        addInfoMessage(
          `**${(s.firstPrompt || '(empty)').slice(0, 60)}**\n\nNo usage data recorded (interrupted before first turn).`,
        )
      } else {
        addInfoMessage(formatUsageReport(usage, s.modelId, 'history', s.firstPrompt.slice(0, 80) || undefined))
      }

      await tick()

      const back = await askQuestion(
        'Press Enter to return, or Esc to exit.',
        [{ label: BACK_LABEL, description: 'Go back to the session list.' }],
        { noOther: true },
      )

      if (!back) break
    }
  }

  /** 把 memory fact 列表格式化后显示到滚动回溯中。 */
  function formatMemoryList(scope: 'project' | 'user', facts: KnowledgeFact[]): string {
    if (facts.length === 0) {
      return `**Auto memory (${scope})** — empty.`
    }
    const byCategory = new Map<string, KnowledgeFact[]>()
    for (const f of facts) {
      const list = byCategory.get(f.category) ?? []
      list.push(f)
      byCategory.set(f.category, list)
    }
    const lines: string[] = [`**Auto memory (${scope})** — ${facts.length} fact${facts.length === 1 ? '' : 's'}.`, '']
    for (const [category, items] of byCategory) {
      lines.push(`### ${category}`)
      for (const f of items) {
        lines.push(`- \`${f.key}\` — ${f.fact} _(${f.date})_`)
      }
      lines.push('')
    }
    return lines.join('\n').trimEnd()
  }

  /** /memory：显示所有 auto-memory 条目（项目 + 用户）。
   *  提取器会在后台写底层文件；如果用户想删改条目，直接打开 `auto.md` 就行。 */
  function handleMemory() {
    const sections: string[] = []
    sections.push(formatMemoryList('project', getAutoMemory('project').getAll()))
    sections.push('')
    sections.push(formatMemoryList('user', getAutoMemory('user').getAll()))
    addInfoMessage(sections.join('\n'))
  }

  // 斜杠命令处理器放在 ../commands/{skill,plugin,mcp}.ts 里。每个 factory
  // 都会闭包捕获 App 渲染时的依赖，然后返回给上面的 dispatcher 调用。
  // 这和它们以前直接写成内联函数声明时的“每次渲染一个新身份”的行为一致。
  const { handleSkill } = createSkillCommandHandler({
    options,
    addCommandMessage,
    invalidateSystemPromptCache,
    pendingSkillRef,
    bumpSkillRegistryVersion: () => setSkillRegistryVersion((v) => v + 1),
  })

  const { handlePlugin } = createPluginCommandHandler({
    options,
    addCommandMessage,
    askQuestion,
    invalidateSystemPromptCache,
    bumpSkillRegistryVersion: () => setSkillRegistryVersion((v) => v + 1),
  })

  const { handleMcp } = createMcpCommandHandler({
    options,
    addCommandMessage,
    addCommandResult,
    askQuestion,
    invalidateSystemPromptCache,
  })

  const handleDoctor = createDoctorCommandHandler({
    options,
    modelId: state.modelId,
    addInfoMessage,
    echoCommand,
  })

  // 渲染架构
  //
  // `ChatInput` 独占初始 header 下面的整个终端区域：
  //   - 滚动回溯消息通过直接写 stdout 的方式提交
  //   - spinner / input / 分隔线 / 补全 / 错误 / Permission 对话框 /
  //     SelectOptions 对话框，全部画进同一个 cell 级 diff buffer
  //
  // Ink 的动态区域始终保持为空——我们不会往它自己的子树里渲染任何子节点。
  // 如果 Ink 在那里写东西，它内部使用的 `\x1b7` / `\x1b8` 会把我们的光标锚点
  // 覆盖掉，留下“僵尸帧”。
  // 以前 SelectOptions 是直接作为 Ink 子节点渲染的，但当对话框高度比
  // ChatInput 还大时，它会触发终端自动滚屏，导致对话框关闭后回溯里留下一整排
  // 永久空白行，所以现在也搬进 ChatInput 的 cell buffer 里了。
  const permissionRequest = state.permissionQueue[0]
  const selectActive = !!state.pendingQuestion

  return (
    <ChatInput
      messages={state.messages}
      initialContentRows={getHeaderRowCount(state.modelId)}
      onSubmit={handleSubmit}
      onInterrupt={handleCtrlC}
      onEscapeCancel={abort}
      permissionMode={state.permissionMode}
      isLoading={state.isLoading}
      notice={notice}
      // 当选择对话框打开时，隐藏 spinner 里的 “Thinking” 行，但 ChatInput 本身
      // 仍然保持可见——因为对话框现在是画在它自己的 cell buffer 里，
      // 不是 Ink 顶层子树里。
      //
      // Permission 对话框不能隐藏 spinner：正在运行的工具列表是画在 ChatInput 里
      // `if (spinner)` 这段内部的，所以把 spinner 设成 null 会把那些 Running 指示器
      // 一起隐藏掉，用户就会看到一个“像卡死了一样”的屏幕，而且还看不到权限提示。
      spinner={
        state.isLoading && !selectActive
          ? {
              // 当一串可折叠的 read 工具正在执行时，会隐藏每个工具自己的实时
              // 指示器（否则快速读会一闪而过：出现 → 消失）。同时通用的
              // “Thinking…” 标签会让长时间的 read 链看起来像卡住了。
              // `bufferingReads` 会在连续 read 之间 50-200ms 的空档里保持为真，
              // 否则标签会在每个工具之间来回抖成 Reading-Thinking-Reading。
              // 这个状态由 useAgent 在 tool-call / text-delta / loop-end / abort
              // 时更新。
              label: state.compressionLabel
                ? `Compressing — ${state.compressionLabel}`
                : state.bufferingReads
                  ? 'Reading'
                  : 'Thinking',
              mode: state.activeToolCalls.length > 0 ? 'tool-use' : 'requesting',
            }
          : null
      }
      contextUsage={
        // Footer 指示器（`6.6k / 200k · 3%`）使用的是最近一次 API 响应里的快照，
        // 不是累计整个 session 的计数。
        // 累计值会在每轮里重复计算消息历史（即使是 cache 命中的输入也仍然会显示在
        // `inputTokens` 里），所以数字会远远膨胀到超出实际计费。首轮还没落地前这里
        // 会保持隐藏。
        state.usage.currentContextTokens > 0
          ? { used: state.usage.currentContextTokens, window: getContextWindow(state.modelId) }
          : null
      }
      activeToolCalls={state.activeToolCalls}
      todos={state.todos}
      errorMessage={state.error}
      permission={
        permissionRequest
          ? {
              toolName: permissionRequest.toolName,
              input: permissionRequest.input,
              mcp: permissionRequest.mcp,
              onResolve: resolvePermission,
            }
          : null
      }
      selectRequest={
        state.pendingQuestion
          ? {
              question: state.pendingQuestion.question,
              options: state.pendingQuestion.options,
              onResolve: resolveQuestion,
              dismissible: state.pendingQuestion.dismissible,
              layout: state.pendingQuestion.layout,
            }
          : null
      }
      commands={allCommands}
    />
  )
}
