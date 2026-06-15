// ChatInput 的公开类型 + 内部类型。

/** slash 补全菜单里的单行条目。
 *  顶层命令行和子命令行都会通过这个结构渲染。
 *  显示列使用 `name` / `description`，但真正回填输入框时用的是 `applyText`，
 *  这样子命令行（例如 `{ name: 'auth', applyText: '/mcp auth' }`）才能
 *  正确替换整段输入。 */
export interface MenuItem {
  name: string
  description: string
  applyText: string
  /** 菜单里显示在 `name` 后面的灰色后缀。
   *  例如 `/thinking` 会显示 `[on|off]`。
   *  只在一级命令行里填；子命令行不需要，因为描述列已经说明了参数形状。 */
  argumentHint?: string
}

export interface SlashCommand {
  name: string
  description: string
  /** slash 菜单里跟在命令名后面的灰色占位提示。
   *  例如 `argumentHint: '[on|off]'` 会让菜单行显示成
   *  `/thinking [on|off]  Toggle extended thinking ...`。
   *  适用于带参数但没有固定可枚举子命令的命令
   *  （例如 `/model <model-id>`、`/review [PR]`）。 */
  argumentHint?: string
  /** 固定可枚举的子命令。
   *  一旦存在，输入 `/cmd `（带尾随空格）或 `/cmd <前缀>` 就会弹出第二级模糊菜单，
   *  再对 `subcommands` 筛一遍，UI 和顶层命令菜单一致。
   *  适合第二个 token 很多、又很容易忘的命令（比如 `/mcp` 有 8 个）。 */
  subcommands?: ReadonlyArray<{ name: string; description: string }>
}

export interface SpinnerState {
  label: string
  mode: 'requesting' | 'responding' | 'thinking' | 'tool-use'
}

export interface PermissionRequest {
  toolName: string
  input: Record<string, unknown>
  onResolve: (decision: 'yes' | 'always' | 'no') => void
  /** 由 use-agent 在工具解析到 MCP registry 条目时设置。
   *  决定对话框里 MCP 风格的标题 / 预览 / always-allow 标签。
   *  内建工具（shell/edit/writeFile/…）没有这个字段。 */
  mcp?: { serverName: string; rawName: string }
}

export interface SelectRequest {
  question: string
  /** `freeform: true` 表示自动追加的 “Other” 行。
   *  这一行会打开一个内联文本输入框，而不是把字面标签当作答案返回。
   *  它对齐 Claude Code 的 `__other__` 哨兵值，这里保留成一个标记位，
   *  这样 resolver 就能直接返回用户输入的文本，不需要经过哨兵往返。
   *
   *  `preview` 保存预先渲染好的 ANSI 行；当这个选项被聚焦时，
   *  对话框会把它们画在选项列表下面。
   *  `/syntax` 选择器会用它来显示每个主题的实时颜色样例，用户用方向键切换时
   *  就能直接看到效果。每一行都应该已经是完整的 ANSI 样式字符串，
   *  对话框会把它当作类似 `RawAnsi` 的单元行直接绘制，不再额外加工。 */
  options: { label: string; description: string; freeform?: boolean; preview?: string[] }[]
  onResolve: (answer: string) => void
  /** 对用户主动发起的选择器为 true
   *  （例如 `/syntax`、`/model` 这类 slash 命令）。
   *  这时 Esc 会关闭对话框并返回空答案。
   *  AI 触发的对话框（askUser 工具、plan 审批）会保持 falsy：
   *  Esc 会被吞掉，避免模型被悄悄喂入一个空答案。 */
  dismissible?: boolean
  /** 控制带描述的选项如何渲染：
   *  - `compact`（默认）：label 和 description 显示在同一行，
   *    右侧补齐成两个对齐列，适合短标签。
   *  - `compact-vertical`：description 单独放到下一行并缩进，
   *    适合长描述（比如 askUser）。 */
  layout?: 'compact' | 'compact-vertical'
}
