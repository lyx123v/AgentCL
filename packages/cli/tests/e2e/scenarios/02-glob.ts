import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '02-glob',
  name: 'glob 工具按通配符找到 .md 文件',
  // 执行 glob 场景，验证模型能递归找到所有 Markdown 文件。
  async run(ctx) {
    await ctx.writeFile('a.md', '# a')
    await ctx.writeFile('b.md', '# b')
    await ctx.writeFile('c.txt', 'plain')
    await ctx.writeFile('nested/d.md', '# d')

    const r = await ctx.runCli(
      '请使用 glob 工具列出当前目录树中的所有 Markdown 文件（*.md）。列出后，再总结一共找到了多少个。',
    )
    ctx.expect.exitCode(r, 0)
    const globCall = ctx.expect.toolCalled(r, 'glob')
    // 直接验证 glob 工具自己的输出 — 不依赖模型怎么"总结"。
    // 旧版只看 assistant 文本是否提到 ≥2 个 md 文件名 — 漏了：
    //  (1) 没验证 c.txt 是否被错误返回（glob pattern 写挂回退到 ** 就会带上）
    //  (2) 没验证 nested/d.md 真的被递归找到
    const result = globCall.resultText ?? ''
    ctx.expect.truthy(
      /a\.md/.test(result) && /b\.md/.test(result) && /d\.md/.test(result),
      `glob 应该返回 3 个 .md 文件（a.md、b.md、nested/d.md）；实际 resultText 为：\n${result.slice(0, 400)}`,
    )
    ctx.expect.truthy(!/c\.txt/.test(result), `glob 不应该包含 c.txt；实际 resultText 为：\n${result.slice(0, 400)}`)
    // 守住"模型能消费 glob 输出"这条：至少在答案里提到 .md
    ctx.expect.assistantMentions(r, /\.md/)
    ctx.expect.noToolErrors(r)
  },
}

export default scenario
