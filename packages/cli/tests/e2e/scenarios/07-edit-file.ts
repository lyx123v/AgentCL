import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '07-edit-file',
  name: 'edit 工具替换文件中的字符串（--trust 自动放行）',
  // 执行编辑场景，验证模型会用 edit 做局部替换而不是整文件重写。
  async run(ctx) {
    await ctx.writeFile('greeting.txt', 'hello world\n')

    const r = await ctx.runCli(
      '请先读取 greeting.txt，然后使用 edit 工具把其中的 `world` 改成 `universe`。不要重写整个文件，必须使用 edit 工具的 oldString/newString 方式修改。',
      { args: ['--trust'] },
    )
    ctx.expect.exitCode(r, 0)
    ctx.expect.toolCalled(r, 'edit', { filePath: /greeting\.txt$/ })
    await ctx.expect.fileContent('greeting.txt', /hello universe/)
    ctx.expect.noToolErrors(r)
  },
}

export default scenario
