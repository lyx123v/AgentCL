import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '09-multi-turn',
  name: 'agent loop 多轮：读 -> 分析 -> 编辑',
  // 执行多轮场景，验证模型会先读取配置，再编辑目标字段。
  async run(ctx) {
    await ctx.writeFile('config.json', JSON.stringify({ feature: 'old', port: 3000 }, null, 2))

    const r = await ctx.runCli(
      '请在 config.json 中找到 `feature` 字段的值，然后使用 edit 工具把它从 `old` 改成 `new`。最后用一句话确认这次修改。',
      { args: ['--trust', '--max-turns', '10'] },
    )
    ctx.expect.exitCode(r, 0)
    // 必须既调用 readFile 又调用 edit，证明走了多轮
    ctx.expect.toolCalled(r, 'readFile', { filePath: /config\.json$/ })
    ctx.expect.toolCalled(r, 'edit', { filePath: /config\.json$/ })
    await ctx.expect.fileContent('config.json', /"feature":\s*"new"/)
    ctx.expect.noToolErrors(r)
  },
}

export default scenario
