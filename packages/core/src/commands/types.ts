// @x-code-cli/core — 基于文件的斜杠命令类型
//
// 这里的“command”指的是由插件携带的 markdown 文件（未来也可能直接放在
// ~/.x-code/commands/ 下），在启动时被注册成一个 slash command。
// 真正的 Claude Code 插件会把它们放在 plugin.json 同级的
// `commands/<name>.md` 中，例如 `code-review` 插件里的
// `commands/code-review.md` 会注册成 `/code-review`。
//
// 文件格式（基于 anthropics/claude-code 的真实插件内容验证，与
// Claude Code 规范一致）：
//
//     ---
//     description: Code review a pull request
//     allowed-tools: Bash(gh pr view:*), …      # 目前我们会忽略这个字段
//     ---
//
//     <body —— 供模型执行的提示词模板>
//
//     发送给模型前，会对 body 做以下占位符替换：
//       $ARGUMENTS                —— 命令名后面输入的文本参数
//       ${ARGUMENTS}              —— 同上，只是花括号写法
//       ${CLAUDE_PLUGIN_ROOT}     —— 插件根目录绝对路径
//                                   （让命令体可以通过 shell
//                                   引用插件内打包脚本）

export interface CommandDefinition {
  /** 命令调用名，不含前导 `/`。由文件名推导而来（`code-review.md` → `code-review`）。 */
  name: string
  /** frontmatter 中 `description` 字段提供的一行简要说明，用于 `/help` 和 `/plugin info` 展示。 */
  description?: string
  /** 命令提示词模板，也就是 frontmatter 之后的全部正文，并已做 trim。 */
  body: string
  /** 命令来源。`'user'` 表示 `~/.x-code/commands/*.md`，
   *  `'project'` 表示 `<repo-root>/.x-code/commands/*.md`，
   *  `'plugin'` 表示插件贡献的 `commands/*.md`。与 SkillDefinition / SubAgentDefinition 保持一致。 */
  source: 'user' | 'project' | 'plugin'
  /** 当 source === 'plugin' 时，表示所属插件的 id（`name@marketplace`）。
   *  用于 `/plugin info` 展示，也用于正确替换 `${CLAUDE_PLUGIN_ROOT}`。 */
  pluginId?: string
  /** 插件根目录的绝对路径。会替换到 body 中的 `${CLAUDE_PLUGIN_ROOT}`，
   *  从而让命令体里引用插件自带脚本时能正确解析路径。 */
  pluginRoot?: string
}
