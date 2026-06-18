import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '22-glob-gitignore',
  name: 'glob 工具尊重 .gitignore：node_modules/ 被过滤掉',
  // 这是对 commit 605cba1 的回归保护：glob 改为基于 ripgrep 后开始遵守 .gitignore。
  // 在那之前，`**/*.js` 会把所有 vendored 依赖都返回出来，既吵又增加上下文成本。
  // 执行 glob 场景：验证 .gitignore 中的 node_modules/ 会被正确过滤。
  async run(ctx) {
    // ripgrep 只有在检测到 git 仓库时才会遵守 .gitignore（glob 工具按设计
    // 不会传 `--no-require-git`；因为离开 git 树后，.gitignore 在语义上就不该生效）。
    // 所以这里需要一个最小化的 .git/ 标记，才能让测试真正走到 gitignore 分支。
    await ctx.mkdir('.git')
    await ctx.writeFile('.git/HEAD', 'ref: refs/heads/main\n')
    await ctx.writeFile('.gitignore', 'node_modules/\n')
    await ctx.writeFile('src/main.js', '// 应用入口\n')
    await ctx.writeFile('src/util.js', '// 辅助函数\n')
    await ctx.writeFile('node_modules/lodash/index.js', '// 第三方依赖\n')
    await ctx.writeFile('node_modules/react/index.js', '// 第三方依赖\n')

    const r = await ctx.runCli(
      '请使用 glob 工具，并传入模式 `**/*.js`，查找当前目录树中的所有 JavaScript 文件。请把工具返回的路径列出来。',
      { args: ['--max-turns', '4'] },
    )
    ctx.expect.exitCode(r, 0)
    const globCall = ctx.expect.toolCalled(r, 'glob')
    const result = globCall.resultText ?? ''
    ctx.expect.truthy(
      /main\.js/.test(result) && /util\.js/.test(result),
      `glob 应该能找到 src/main.js 和 src/util.js；当前 resultText 为：\n${result.slice(0, 400)}`,
    )
    ctx.expect.truthy(
      !/node_modules/.test(result),
      `glob 结果应该遵守 .gitignore 并排除 node_modules/；当前 resultText 为：\n${result.slice(0, 400)}`,
    )
  },
}

export default scenario
