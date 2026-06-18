import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '06-write-file',
  name: 'writeFile 创建新文件（--trust 自动放行）',
  // 执行写文件场景，验证模型会调用 writeFile 并写入预期内容。
  async run(ctx) {
    const r = await ctx.runCli(
      '请使用 writeFile 工具，在当前目录创建一个名为 hello.txt 的文件，文件内容必须精确为 `hello e2e`。完成后用一句简短的话确认文件已写入。',
      { args: ['--trust'] },
    )
    ctx.expect.exitCode(r, 0)
    ctx.expect.toolCalled(r, 'writeFile', { filePath: /hello\.txt$/ })
    await ctx.expect.fileExists('hello.txt')
    await ctx.expect.fileContent('hello.txt', /hello e2e/)
    ctx.expect.noToolErrors(r)
  },
}

export default scenario
