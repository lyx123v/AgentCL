// @x-code-cli/core — 用于 /mcp add/add-json/remove 的斜杠命令参数解析器
//
// 斜杠命令只会交给我们一个原始字符串（即 `/mcp <sub>` 后面的文本），
// 我们需要把它整理成结构化的 McpServerConfig。这个解析器刻意保持很窄：
//   - 每个子命令一个入口（parseAdd / parseAddJson / parseRemove）
//   - 返回带标签的 ParseResult，这样 App.tsx 调用方只分支一次，
//     就能拿到可执行命令或一条单行错误信息
//
// 我们支持的引号规则刻意保持极简：
//   - "双引号" 和 '单引号' 会保留内部空白
//   - 反斜杠只转义空白、引号字符以及它自身
//     `\ ` 表示字面量空格，`\"` 表示字面量引号，`\\` 表示字面量反斜杠
//     如果反斜杠后面不是这些字符，就按原样透传
//     这一点对 Windows 很关键，因为用户经常直接粘贴
//     `D:\res\x-code-cli\tmp` 这样的路径；如果按完整 POSIX 转义规则处理，
//     这些反斜杠会被吞掉，路径会被悄悄改坏
//   - 其他情况：按空白拆分 token
//
// 为什么不依赖 shell-words 之类的 npm 包：
// 这里的能力面很小，50 行左右的 tokenizer 更容易保持完全可预测，
// 便于测试，也不会引入跨平台 shell 转义差异。
import type { McpHttpServerConfig, McpServerConfig, McpStdioServerConfig } from './types.js'

export type ConfigScope = 'user' | 'project'

export interface AddCommand {
  /** 命令种类：添加 MCP 服务 */
  kind: 'add'
  /** 要写入配置的服务名 */
  name: string
  /** 配置作用域：用户级或项目级 */
  scope: ConfigScope
  /** 解析完成后的服务配置 */
  config: McpServerConfig
}

export interface AddJsonCommand {
  /** 命令种类：以 JSON 形式添加 MCP 服务 */
  kind: 'add-json'
  /** 要写入配置的服务名 */
  name: string
  /** 配置作用域：用户级或项目级 */
  scope: ConfigScope
  /** 解析完成后的服务配置 */
  config: McpServerConfig
}

export interface RemoveCommand {
  /** 命令种类：移除 MCP 服务 */
  kind: 'remove'
  /** 要移除的服务名 */
  name: string
  /** 配置作用域；未传 --scope 时为 undefined，由调用方自动判断 */
  scope?: ConfigScope
}

export type ParsedCommand = AddCommand | AddJsonCommand | RemoveCommand

export type ParseResult<T extends ParsedCommand = ParsedCommand> =
  | { ok: true; command: T }
  | { ok: false; error: string }

/** `mcpServers.<name>` 允许使用的名称。
 *  这里比运行时的 name-mangling 清洗规则更严格，因为在“配置入口”
 *  直接拒绝奇怪名称，比“添加后悄悄改名”更不让人困惑。
 *  长度限制 32，是为了给 `{server}__{tool}` 这种格式留余量，
 *  让模型侧工具名能稳定落在 64 字符限制内。 */
const NAME_RE = /^[a-zA-Z0-9_-]{1,32}$/

// ── 顶层入口 ───────────────────────────────────────────────────────────────

/** 解析 `/mcp add [...flags] <name> <command-or-url> [args...]` 的参数。 */
export function parseAdd(rawArg: string): ParseResult<AddCommand> {
  const tokRes = tokenize(rawArg)
  if (!tokRes.ok) return tokRes
  const tokens = tokRes.tokens

  // 第一轮：只从前面剥离 flag。遇到第一个非 flag token 就停止，
  // 它会被当作服务名；如果出现 `--`，则强制结束 flag 解析，
  // 并把它本身丢弃，后面的内容全部按位置参数处理。
  let isHttp = false
  let scope: ConfigScope = 'user'
  let timeout: number | undefined
  const envEntries: Array<[string, string]> = []
  const headerEntries: Array<[string, string]> = []

  let i = 0
  let sawDoubleDash = false
  while (i < tokens.length) {
    const t = tokens[i]!
    if (!t.startsWith('-')) break
    if (t === '--') {
      sawDoubleDash = true
      i++
      break
    }
    if (t === '--http' || t === '--transport') {
      // --http 是我们自己的简写；--transport <name> 是 Claude/Gemini 风格语法。
      // 这里只接受 http；根据设计文档，sse 在 MCP 2025-03 已废弃。
      if (t === '--transport') {
        const next = tokens[i + 1]
        if (next !== 'http') {
          return err(
            `--transport 只支持 "http"（当前是 ${next ?? '缺失'}）；请直接用 --http，或省略以使用 stdio`,
          )
        }
        i += 2
      } else {
        i++
      }
      isHttp = true
      continue
    }
    if (t === '--scope') {
      const v = tokens[i + 1]
      if (v !== 'user' && v !== 'project') {
        return err(`--scope 只能是 "user" 或 "project"（当前是 ${v ?? '缺失'}）`)
      }
      scope = v
      i += 2
      continue
    }
    if (t === '--env') {
      const v = tokens[i + 1]
      if (typeof v !== 'string') return err('--env 需要一个 KEY=VALUE 参数')
      const eq = v.indexOf('=')
      if (eq <= 0) return err(`--env 需要 KEY=VALUE 格式（当前是 ${v}）`)
      envEntries.push([v.slice(0, eq), v.slice(eq + 1)])
      i += 2
      continue
    }
    if (t === '--header') {
      const v = tokens[i + 1]
      if (typeof v !== 'string') return err('--header 需要一个 "Key: value" 参数')
      // Header 格式为 "Key: Value"。为贴近用户习惯，冒号两侧空白尽量宽容处理。
      const colon = v.indexOf(':')
      if (colon <= 0) return err(`--header 需要 "Key: Value" 格式（当前是 ${v}）`)
      headerEntries.push([v.slice(0, colon).trim(), v.slice(colon + 1).trim()])
      i += 2
      continue
    }
    if (t === '--timeout') {
      const v = tokens[i + 1]
      if (typeof v !== 'string') return err('--timeout 需要一个数字（毫秒）')
      const n = Number(v)
      if (!Number.isInteger(n) || n <= 0) return err(`--timeout 需要一个正整数（当前是 ${v}）`)
      timeout = n
      i += 2
      continue
    }
    return err(`未知参数：${t}`)
  }

  // 位置参数。处理完可选 `--` 后，剩余参数就是 name + command/url + 其余内容。
  // stdio: tokens[i] = name, tokens[i+1] = command, tokens[i+2..] = args
  // HTTP:  tokens[i] = name, tokens[i+1] = url，后面不应再有内容
  //
  // 一些熟悉 Claude Code 的用户会写 `add <name> -- <cmd>`，
  // 也就是把分隔符放到名字后面。上面的 flag 解析在遇到第一个非 flag
  // （也就是 name）时就停了，所以这个 `--` 会落在 positional[1]。
  // 我们这里把它去掉即可，它只是装饰性的，真正的命令在后面。
  let positional = tokens.slice(i)
  if (positional[1] === '--') {
    positional = [positional[0]!, ...positional.slice(2)]
  }
  if (positional.length < 2) {
    return err(
      isHttp
        ? '用法：/mcp add --http [--scope user|project] [--header "K: V"]... [--timeout N] <name> <url>'
        : '用法：/mcp add [--scope user|project] [--env K=V]... [--timeout N] <name> <command> [args...]',
    )
  }
  const name = positional[0]!
  if (!NAME_RE.test(name)) {
    return err(`无效的服务名 "${name}"。必须匹配 ${NAME_RE.source}。`)
  }

  if (isHttp) {
    if (positional.length > 2) {
      return err('HTTP 服务只能接收 <name> <url>，不能带额外的位置参数')
    }
    if (envEntries.length > 0) return err('--env 仅适用于 stdio 服务')
    const url = positional[1]!
    if (!isValidUrl(url)) return err(`无效的 URL：${url}`)
    const config: McpHttpServerConfig = {
      url,
      ...(headerEntries.length > 0 ? { headers: Object.fromEntries(headerEntries) } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
    }
    return ok({ kind: 'add', name, scope, config })
  }

  // stdio 情况下 `--` 可写可不写。
  // 比如 `/mcp add fs npx -y @pkg/foo /tmp` 与
  // `/mcp add fs -- npx -y @pkg/foo /tmp` 都会走到这里，
  // 因为前面已经把 `--` 剥掉了。
  void sawDoubleDash
  if (headerEntries.length > 0) return err('--header 仅适用于 HTTP 服务（--http）')
  const command = positional[1]!
  const args = positional.slice(2)
  const config: McpStdioServerConfig = {
    command,
    ...(args.length > 0 ? { args } : {}),
    ...(envEntries.length > 0 ? { env: Object.fromEntries(envEntries) } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
  }
  return ok({ kind: 'add', name, scope, config })
}

/** 解析 `/mcp add-json [--scope ...] <name> '<json>'` 的参数。
 *  JSON 内容只要符合 schema 即可；加载阶段会走同一套校验，
 *  因而这里沿用同样的格式约束，能让“命令行写入”和“手改配置文件”
 *  的报错风格保持一致。 */
export function parseAddJson(rawArg: string): ParseResult<AddJsonCommand> {
  // add-json 最大的特点是必须尽量保留 JSON 字面量原样，
  // 不能把它先喂给 shell tokenizer，否则嵌套引号很容易被弄坏。
  // 这里的策略是：先用 tokenizer 只拆出前缀里的 flag 和 name，
  // 剩余部分再作为 JSON 原文处理。

  const trimmed = rawArg.trim()
  if (!trimmed) {
    return err("用法：/mcp add-json [--scope user|project] <name> '<json>'")
  }

  // 逐个 token 往后走，直到 flag/name 结束或者遇到 JSON 起始。
  // 如果 JSON 是用单引号包起来输入的，tokenizer 会去掉最外层引号，
  // 我们就能直接拿到完整对象字符串；如果没加引号，通常也不该有复杂空白，
  // 单个 token 一般就够用了。
  const tokRes = tokenize(trimmed)
  if (!tokRes.ok) return tokRes
  const tokens = tokRes.tokens

  let scope: ConfigScope = 'user'
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]!
    if (t === '--scope') {
      const v = tokens[i + 1]
      if (v !== 'user' && v !== 'project') {
        return err(`--scope 只能是 "user" 或 "project"（当前是 ${v ?? '缺失'}）`)
      }
      scope = v
      i += 2
      continue
    }
    if (!t.startsWith('-')) break
    return err(`add-json 的未知参数：${t}`)
  }

  if (i >= tokens.length) {
    return err("用法：/mcp add-json [--scope user|project] <name> '<json>'")
  }
  const name = tokens[i]!
  if (!NAME_RE.test(name)) {
    return err(`无效的服务名 "${name}"。必须匹配 ${NAME_RE.source}。`)
  }
  i++

  // 如果用户没有给 JSON 加引号，它可能会被拆成多个 token。
  // 这里用单空格重新拼回去；JSON 对 token 之间的空白本来就宽容，
  // 在实践中足以回放成功。
  if (i >= tokens.length) {
    return err(`缺少 "${name}" 的 JSON 内容。建议用单引号包起来：'{...}'`)
  }
  const jsonBlob = tokens.slice(i).join(' ').trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonBlob)
  } catch (e) {
    return err(`JSON 无效：${e instanceof Error ? e.message : String(e)}`)
  }

  // 真正的 schema 校验仍由 loader / writer 那一层统一处理，
  // 这里先只保证它是对象，避免在本文件中引入循环依赖。
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return err('JSON 内容必须是对象')
  }
  return ok({ kind: 'add-json', name, scope, config: parsed as McpServerConfig })
}

/** 解析 `/mcp remove [--scope ...] <name>` 的参数。 */
export function parseRemove(rawArg: string): ParseResult<RemoveCommand> {
  const tokRes = tokenize(rawArg)
  if (!tokRes.ok) return tokRes
  const tokens = tokRes.tokens
  if (tokens.length === 0) {
    return err('用法：/mcp remove [--scope user|project] <name>')
  }

  let scope: ConfigScope | undefined
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]!
    if (t === '--scope') {
      const v = tokens[i + 1]
      if (v !== 'user' && v !== 'project') {
        return err(`--scope 只能是 "user" 或 "project"（当前是 ${v ?? '缺失'}）`)
      }
      scope = v
      i += 2
      continue
    }
    if (!t.startsWith('-')) break
    return err(`remove 的未知参数：${t}`)
  }

  if (i >= tokens.length) {
    return err('用法：/mcp remove [--scope user|project] <name>')
  }
  if (i + 1 < tokens.length) {
    return err(`/mcp remove 只能接收一个名称（多余参数：${tokens.slice(i + 1).join(' ')}）`)
  }
  const name = tokens[i]!
  if (!NAME_RE.test(name)) {
    return err(`无效的服务名 "${name}"。必须匹配 ${NAME_RE.source}。`)
  }
  return ok({ kind: 'remove', name, scope })
}

// ── 内部实现 ───────────────────────────────────────────────────────────────

/** 构造成功的解析结果。 */
function ok<T extends ParsedCommand>(command: T): ParseResult<T> {
  return { ok: true, command }
}

/** 构造失败的解析结果。 */
function err(message: string): { ok: false; error: string } {
  return { ok: false, error: message }
}

/** 极简 POSIX 风格 tokenizer。
 *  支持 "..."/'...' 引号，以及单字符级别的反斜杠转义。
 *  输出中会去掉引号，转义符前面的反斜杠也会移除。
 *  使用带标签的返回值而不是直接抛错，方便调用方把
 *  “引号未闭合” 这种问题直接展示给用户。 */
export function tokenize(input: string): { ok: true; tokens: string[] } | { ok: false; error: string } {
  const tokens: string[] = []
  let i = 0
  const n = input.length

  while (i < n) {
    // 跳过 token 之间的空白。
    while (i < n && /\s/.test(input[i]!)) i++
    if (i >= n) break

    let token = ''
    let quote: '"' | "'" | null = null
    let inToken = true

    while (i < n && inToken) {
      const c = input[i]!
      if (quote) {
        if (c === '\\' && quote === '"' && i + 1 < n) {
          // 在双引号内部，只允许转义 " 和 \。
          const next = input[i + 1]!
          if (next === '"' || next === '\\') {
            token += next
            i += 2
            continue
          }
          // 其他情况保留反斜杠字面量，符合 POSIX 风格。
          token += c
          i++
          continue
        }
        if (c === quote) {
          quote = null
          i++
          continue
        }
        token += c
        i++
        continue
      }
      // 不在引号中。
      if (c === '"' || c === "'") {
        quote = c
        i++
        continue
      }
      if (c === '\\' && i + 1 < n) {
        // 只转义空白、引号和反斜杠自身。
        // 其他情况保留原样，确保 Windows 路径如
        // `D:\res\x-code-cli\tmp` 不会因为吞掉反斜杠而被悄悄改坏。
        const next = input[i + 1]!
        if (next === ' ' || next === '\t' || next === '"' || next === "'" || next === '\\') {
          token += next
          i += 2
          continue
        }
        token += c
        i++
        continue
      }
      if (/\s/.test(c)) {
        inToken = false
        break
      }
      token += c
      i++
    }
    if (quote) {
      return { ok: false, error: `${quote} 引号未闭合` }
    }
    tokens.push(token)
  }
  return { ok: true, tokens }
}

/** 校验字符串是否是合法的 http/https URL。 */
function isValidUrl(s: string): boolean {
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}
