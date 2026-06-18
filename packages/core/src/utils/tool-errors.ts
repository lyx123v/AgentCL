// @x-code-cli/core — 统一工具错误格式
//
// 各个 `tool({ execute })` 的执行体基本都遵循同一套模式：
// 捕获 unknown、提取字符串消息，再返回 `Error <action>: <msg>`。
// 把这段逻辑集中到这里，既能保持措辞一致，也能避免到处复制
// `err instanceof Error ? err.message : String(err)` 这段样板代码。

/** 把任意异常值收敛为可展示的字符串消息。 */
export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 把工具失败格式化成返回给模型的字符串结果。
 *  `action` 是简短的动作短语，例如 `reading file`、`searching`。
 *  这里刻意保留 `Error ` 前缀，因为外部逻辑会依赖这个格式识别工具错误。 */
export function formatToolError(action: string, err: unknown): string {
  return `Error ${action}: ${toErrorMessage(err)}`
}
