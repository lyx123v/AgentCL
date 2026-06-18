// @x-code-cli/core — 为 MCP 配置展开环境变量
//
// 支持在 MCP 服务配置的任意字符串字段中使用两种形式：
//   ${VAR}             — 展开变量；若未设置则抛错
//   ${VAR:-fallback}   — 展开变量；若未设置则使用字面量兜底值
//
// 我们刻意不支持任意 shell 展开：
//   - 不支持无大括号的 `$VAR`
//   - 不支持命令替换
//   - 不支持嵌套 `${${A}}`
// 更复杂的处理应该由用户在启动 X-Code 前自己完成。

/** 当 `${VAR}` 无法解析时抛出的错误。
 *  loader 会捕获该错误并把对应服务标记为 failed，保证 CLI 其他部分仍可继续运行。 */
export class EnvExpansionError extends Error {
  constructor(public varName: string) {
    super(`必需的环境变量未设置：${varName}`)
    this.name = 'EnvExpansionError'
  }
}

const REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

/** 展开单个字符串中的所有 `${VAR}` 引用。 */
export function expandEnvString(input: string, env: NodeJS.ProcessEnv = process.env): string {
  return input.replace(REF_RE, (match, name: string, fallback?: string) => {
    const v = env[name]
    if (v !== undefined && v !== '') return v
    if (fallback !== undefined) return fallback
    throw new EnvExpansionError(name)
  })
}

/** 递归遍历配置值并展开其中的字符串。
 *  会遍历数组和普通对象；number / boolean / null 原样保留。
 *  返回深拷贝，不会修改输入对象，这一点很重要，因为输入可能来自缓存后的配置对象。 */
export function expandEnvDeep<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  if (typeof value === 'string') {
    return expandEnvString(value, env) as unknown as T
  }
  if (Array.isArray(value)) {
    return value.map((v) => expandEnvDeep(v, env)) as unknown as T
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expandEnvDeep(v, env)
    }
    return out as unknown as T
  }
  return value
}
