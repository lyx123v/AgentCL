// @x-code-cli/core — shell 命令语义辅助函数（与具体 shell 无关）
//
// 这里会把复合命令拆成多个子命令，并判断它们是只读还是破坏性命令。
// 这些判断只用于权限检查；真正执行 shell 进程的逻辑在 shell-provider.ts。
export type { ShellType } from './shell-provider.js'

/** 按管道或链式运算符拆分复合 shell 命令，用于权限检查。 */
export function splitShellCommands(cmd: string): string[] {
  // 按 |、&&、;、|| 拆分，但如果这些符号出现在引号或花括号内部则不拆。
  //
  // 跟踪花括号深度是为了保住 PowerShell 的哈希字面量 / script block：
  // `Select-Object @{N='Directory';E={$_.Name}},Count` 里的 `;` 是字段分隔符，
  // 不是语句边界。如果不追踪深度，拆分器会把字面量一刀切开，后半段会被误判成
  // 独立命令，触发只读检查误报。POSIX 的 `{ … ; }` 分组也会被同样保护，
  // 这是可以接受的，因为 isDestructive 仍会扫描整段内容。
  const parts: string[] = []
  let current = ''
  let inSingleQuote = false
  let inDoubleQuote = false
  let braceDepth = 0

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    const next = cmd[i + 1]

    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      current += ch
    } else if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      current += ch
    } else if (!inSingleQuote && !inDoubleQuote) {
      if (ch === '{') {
        braceDepth++
        current += ch
      } else if (ch === '}' && braceDepth > 0) {
        braceDepth--
        current += ch
      } else if (braceDepth > 0) {
        current += ch
      } else if (ch === '|' && next === '|') {
        parts.push(current)
        current = ''
        i++ // 跳过下一个 |
      } else if (ch === '&' && next === '&') {
        parts.push(current)
        current = ''
        i++ // 跳过下一个 &
      } else if (ch === '|') {
        parts.push(current)
        current = ''
      } else if (ch === ';') {
        parts.push(current)
        current = ''
      } else {
        current += ch
      }
    } else {
      current += ch
    }
  }
  if (current.trim()) parts.push(current)

  return parts.map((p) => p.trim()).filter(Boolean)
}

/** Unix / PowerShell 中可安全自动放行的只读命令。 */
const READ_ONLY_COMMANDS = [
  // POSIX shell 只读工具
  'cd',
  'ls',
  'dir',
  'pwd',
  'cat',
  'head',
  'tail',
  'wc',
  'echo',
  'which',
  'type',
  'file',
  'stat',
  'du',
  'df',
  'env',
  'printenv',
  'find',
  'tree',
  'sort',
  'uniq',
  'grep',
  'cut',
  'nl',
  'basename',
  'dirname',
  'realpath',
  // PowerShell 只读 cmdlet，下面会做不区分大小写匹配。
  // 这里参考 codex/opencode 的安全白名单：只保留读取数据或改造对象管道的命令。
  // 任何可能写文件、启动进程或执行用户代码的命令（如 `Invoke-Expression`、
  // `Set-*`、`New-*`、`Remove-*`、`Start-Process`、`Set-Content`、
  // `Out-File` 等）都刻意排除。
  'Get-ChildItem',
  'Get-Location',
  'Set-Location',
  'Push-Location',
  'Pop-Location',
  'Get-Content',
  'Get-Item',
  'Get-ItemProperty',
  'Get-Date',
  'Get-Process',
  'Get-Service',
  'Get-Command',
  'Get-Help',
  'Get-Member',
  'Get-Variable',
  'Get-Alias',
  'Get-PSDrive',
  'Get-Module',
  'Get-History',
  'Get-CimInstance',
  'Select-String',
  'Select-Object',
  'Sort-Object',
  'Group-Object',
  'Where-Object',
  'ForEach-Object',
  'Measure-Object',
  'Compare-Object',
  'Tee-Object',
  'Format-Table',
  'Format-List',
  'Format-Wide',
  'Format-Custom',
  'Out-String',
  'Out-Default',
  'Out-Host',
  'Write-Output',
  'Write-Host',
  'Write-Verbose',
  'Write-Debug',
  'Write-Information',
  'ConvertTo-Json',
  'ConvertFrom-Json',
  'ConvertTo-Csv',
  'ConvertFrom-Csv',
  'ConvertTo-Xml',
  'ConvertFrom-Xml',
  'ConvertTo-Html',
  'Resolve-Path',
  'Split-Path',
  'Join-Path',
  'Convert-Path',
  'Test-Path',
]

/** 只读型 Git 子命令。 */
const READ_ONLY_GIT_SUBCOMMANDS = ['status', 'log', 'diff', 'branch', 'show', 'remote', 'tag', 'stash list', 'reflog']

// 预编译正则以提升性能。`/i` 让匹配不区分大小写，所以
// `Get-ChildItem` / `get-childitem` / `GET-CHILDITEM` 都能命中。
// 这也符合 PowerShell 本身大小写不敏感的特性，另外 Windows 下 `dir` / `DIR`
// 也都应被视为可放行。
const READ_ONLY_REGEX = new RegExp(
  `^\\s*(${READ_ONLY_COMMANDS.join('|')}|git\\s+(${READ_ONLY_GIT_SUBCOMMANDS.join('|')}))\\b`,
  'i',
)

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  // ── 文件系统破坏操作 ──
  /\brm\s+(-[a-z]*f|-[a-z]*r|--force|--recursive)/,
  /\brm\s+-rf\b/,
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\b(chmod|chown)\s+.*\//,
  />\s*\/dev\/sd/,
  /\bformat\b/,
  /\bRemove-Item\s+.*-Recurse/i,
  /\bRemove-Item\s+.*-Force/i,
  /\bdel\s+\/[sS]/,
  /\brmdir\s+\/[sS]/,

  // ── Git 破坏性操作 ──
  /\bgit\s+push\s+.*--force\b/,
  /\bgit\s+push\s+-f\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-z]*f/,
  /\bgit\s+checkout\s+--\s*\./,
  /\bgit\s+rebase\b/,
  /\bgit\s+filter-branch\b/,
  /\bgit\s+reflog\s+expire\b/,
  /\bgit\s+gc\s+--prune\b/,

  // ── 远程代码执行 / 下载即执行 ──
  /\bcurl\s.*\|\s*(ba)?sh\b/,
  /\bwget\s.*\|\s*(ba)?sh\b/,
  /\bcurl\s.*\|\s*python/,
  /\bwget\s.*\|\s*python/,

  // ── 系统控制类操作 ──
  /\bshutdown\b/,
  /\breboot\b/,
  /\binit\s+[06]\b/,
  /\bsystemctl\s+(stop|disable|mask|halt|poweroff)\b/,
  /\bkillall\b/,
  /\bpkill\s+-9\b/,
  /\bStop-Computer\b/i,
  /\bRestart-Computer\b/i,

  // ── 数据库破坏操作 ──
  /\bDROP\s+(DATABASE|TABLE|SCHEMA)\b/i,
  /\bTRUNCATE\s+TABLE\b/i,
  /\bDELETE\s+FROM\s+\S+\s*;?\s*$/im,

  // ── 容器 / 基础设施破坏操作 ──
  /\bdocker\s+(rm|rmi|system\s+prune|volume\s+rm)\b/,
  /\bkubectl\s+delete\b/,

  // ── 环境污染类操作 ──
  /\bnpm\s+publish\b/,
  /\bpnpm\s+publish\b/,
  /\byarn\s+publish\b/,

  // ── 磁盘 / 分区操作 ──
  /\bfdisk\b/,
  /\bparted\b/,
]

// 从 READ_ONLY_COMMANDS 中预先提取小写化的 Verb-Noun 命令集合，供
// isReadOnlyControlFlow 以 O(1) 复杂度判断。没有 `-` 的项是 POSIX 命令，
// 与 PowerShell 控制流启发式无关。
const READ_ONLY_CMDLET_SET = new Set(READ_ONLY_COMMANDS.filter((c) => c.includes('-')).map((c) => c.toLowerCase()))

// PowerShell 控制流关键字会包裹一个 `{ … }` 代码块。当片段以这些关键字
// 开头时，现有 READ_ONLY_REGEX 只看首个 token，就会误判，因为 `if`、
// `foreach`、`try` 等本身不是命令，真正执行的内容在花括号内部。
// codex / gemini-cli 的做法是借助真正的 PowerShell AST 解析器拆开分析；
// 这里没有 AST，所以改用受限的 Verb-Noun 扫描，并结合下面的“显式执行”
// 模式进行保守判断。
const PS_CONTROL_FLOW_RE = /^\s*(?:if|elseif|else|for|foreach|while|switch|try|catch|finally|do)\b/i

// 如果控制流片段中出现下列模式，就直接关闭“只读启发式”判断：
//
//   `& "C:\bin\foo.exe" arg`  — 调用运算符 + 路径/字符串/变量
//   `& $cmd`                  — 同上，只是来自变量
//   `. .\script.ps1`          — dot sourcing
//   `. $script`               — 变量形式的 dot sourcing
//
// 这几种情况都可能执行 Verb-Noun 扫描看不出来的任意代码。
// dot-sourcing 模式要求点号后面必须跟空白，以避免把 `.Property` 属性访问
// 或 `Get-Content .\file` 误判进去。
const PS_CALL_OP_RE = /&\s*["'$./\\]/
const PS_DOT_SOURCING_RE = /(?:^|[\s;{(])\.\s+\S/

// Verb-Noun 令牌的两阶段判断：先宽松 find，再严格校验。
// FIND 会匹配所有带 `-` 的词，包括 `x-code-cli` 这类路径片段；
// STRICT 则要求其符合 PowerShell Verb-Noun 的首字母大写结构，路径因此会被排除。
const VERB_NOUN_FIND_RE = /\b[A-Za-z]+(?:-[A-Za-z0-9]+)+\b/g
const VERB_NOUN_STRICT_RE = /^[A-Z][a-z]+(?:-[A-Z][A-Za-z0-9]*)+$/

/**
 * 针对 PowerShell 控制流片段，只有在其中所有 cmdlet 都属于只读集合，
 * 且没有出现疑似任意代码调用（`&` 调用运算符、dot-sourcing）时才返回 true。
 *
 * `if (Test-Path X) { Get-Content X }`     → true  （都是只读命令）
 * `if (Test-Path X) { Set-Content X foo }` → false （Set-Content 非只读）
 * `if (Test-Path X) { & "evil.exe" }`      → false （调用运算符）
 * `if (Test-Path X) { . .\\evil.ps1 }`     → false （dot sourcing）
 * `if ($x -gt 0) { }`                      → false （没找到 cmdlet，保守处理）
 *
 * 对所有非控制流片段都返回 false，让调用方继续走“需要询问”的路径；
 * 也就是原先的“首 token 只读检查”仍是主判据。
 */
function isReadOnlyControlFlow(cmd: string): boolean {
  if (!PS_CONTROL_FLOW_RE.test(cmd)) return false
  if (PS_CALL_OP_RE.test(cmd)) return false
  if (PS_DOT_SOURCING_RE.test(cmd)) return false

  let found = 0
  for (const match of cmd.matchAll(VERB_NOUN_FIND_RE)) {
    const name = match[0]
    if (!VERB_NOUN_STRICT_RE.test(name)) continue
    found++
    if (!READ_ONLY_CMDLET_SET.has(name.toLowerCase())) return false
  }
  return found > 0
}

/** 判断子命令是否为只读命令，可安全自动放行。 */
export function isReadOnly(cmd: string): boolean {
  const c = cmd.trim()
  if (READ_ONLY_REGEX.test(c)) return true
  return isReadOnlyControlFlow(c)
}

/** 判断子命令是否具破坏性，若命中通常应拒绝执行。 */
export function isDestructive(cmd: string): boolean {
  const c = cmd.trim()
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(c))
}
