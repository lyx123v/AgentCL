import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '03-grep',
  name: 'grep 工具按正则查内容并报告命中文件',
  // 执行 grep 场景，验证模型会按指定文本检索并报告命中文件。
  async run(ctx) {
    await ctx.writeFile('src/foo.ts', 'export function uniqueMarkerForGrep(): void {}\n')
    await ctx.writeFile('src/bar.ts', 'export const hello = 1\n')
    await ctx.writeFile('README.md', 'no marker here\n')

    const r = await ctx.runCli(
      '请使用 grep 工具，在这个项目中查找所有包含字面量字符串 "uniqueMarkerForGrep" 的文件，并在回答中列出命中的文件名。',
    )
    ctx.expect.exitCode(r, 0)
    // 必须用 uniqueMarkerForGrep 作为 pattern 调 grep — 否则模型可以 grep
    // 一个无关词、再"猜"到 foo.ts（因为 src/foo.ts 是常见路径）就过。
    const grepCall = ctx.expect.toolCalled(r, 'grep', { pattern: /uniqueMarkerForGrep/ })
    // grep 工具自己的 resultText 必须真的命中 foo.ts —— 直接验证工具行为，
    // 不依赖 assistant 文本（assistant 可能从 prompt/setup 推断 foo.ts）。
    ctx.expect.truthy(
      /foo\.ts/.test(grepCall.resultText ?? ''),
      `grep 的 resultText 应该报告 foo.ts 命中；实际内容为：\n${(grepCall.resultText ?? '').slice(0, 300)}`,
    )
    ctx.expect.assistantMentions(r, /foo\.ts/)
    ctx.expect.noToolErrors(r)
  },
}

export default scenario
