// @x-code-cli/core — MCP 工具名称改写规则
//
// 我们会把 MCP 工具暴露成带命名空间的名称，避免与内建工具
// （readFile、shell 等）冲突，也让模型能一眼看出“这个工具来自哪个服务”：
//
//     <server>__<tool>
//
// server 和 tool 两部分都会先做清洗：
//   - 任何不在 [A-Za-z0-9_] 范围内的字符都会变成 `_`
//   - 分隔符选择 `__`，是为了和工具名内部常见的单下划线区分开
//
// 不使用 `mcp__` 统一前缀。Claude Code 会生成
// `mcp__<server>__<tool>`，但这会给每个工具平白增加 token，
// 却没有带来额外信息；Codex 和 Gemini CLI 也都没有这个前缀。
//
// 面向模型的工具名硬限制为 64 个字符。
// 超长时会截断并拼上 6 位内容哈希，避免不同长名称被截成同一个值。
//
// 跨服务的同名碰撞虽然少见，但并非不可能。
// 如果出现冲突，我们会给后加入的条目追加基于 serverName 的短哈希后缀。
import { createHash } from 'node:crypto'

export const MCP_MAX_NAME_LEN = 64

/** 清洗服务名或工具名，使其满足模型侧工具命名要求。 */
function sanitize(part: string): string {
  // 把连续非法字符压成一个 `_`，并去掉首尾多余下划线，
  // 避免出现 `_server__tool_` 这类难看的结果。
  const cleaned = part.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  // 如果清洗后为空（例如全是中文字符），则退回稳定短哈希，
  // 这样仍然能生成合法且稳定的标识符。
  if (cleaned === '') {
    return shortHash(part, 6)
  }
  return cleaned
}

/** 计算固定长度的十六进制短哈希。 */
function shortHash(input: string, len: number): string {
  return createHash('sha256').update(input).digest('hex').slice(0, len)
}

/** 为一个 MCP 工具生成面向模型的最终可调用名称。
 *
 *  `existing` 是当前 registry 中已经占用的名称集合。
 *  如果新名字发生碰撞，就追加基于 serverName 的短哈希后缀做区分。
 *  这里特意对 server 而不是 tool 做哈希，是因为 tool 名更承载语义，
 *  server 名则是用户自己选的，更适合作为冲突消歧的信息来源。 */
export function buildCallableName(serverName: string, rawToolName: string, existing: ReadonlySet<string>): string {
  const s = sanitize(serverName)
  const t = sanitize(rawToolName)

  let name = `${s}__${t}`

  // 超长时截断，但保留内容哈希，确保两个不同的长名称不会被截成同一个值。
  if (name.length > MCP_MAX_NAME_LEN) {
    const hash = shortHash(`${serverName}::${rawToolName}`, 6)
    const room = MCP_MAX_NAME_LEN - 1 - hash.length
    name = `${(s + '__' + t).slice(0, room)}_${hash}`
  }

  // 名称碰撞时，追加 4 到 12 位 server 哈希；
  // 如果仍然撞上，就逐步增加长度，直到唯一为止。
  if (existing.has(name)) {
    for (let extra = 4; extra <= 12; extra++) {
      const suffix = '_' + shortHash(serverName, extra)
      const candidate =
        name.length + suffix.length <= MCP_MAX_NAME_LEN
          ? name + suffix
          : name.slice(0, MCP_MAX_NAME_LEN - suffix.length) + suffix
      if (!existing.has(candidate)) {
        return candidate
      }
    }
    // 极端情况下兜底：再拼一个带时间因素的短后缀。
    return name.slice(0, MCP_MAX_NAME_LEN - 9) + '_' + shortHash(name + Date.now(), 8)
  }

  return name
}
