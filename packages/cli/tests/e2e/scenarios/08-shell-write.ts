import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '08-shell-write',
  name: 'shell 写命令（mkdir / echo > file）在 --trust 下放行',
  // 执行写入型 shell 场景，验证受信任模式下允许真正落盘的命令。
  async run(ctx) {
    const r = await ctx.runCli(
      '请使用 shell 工具执行一条命令，在当前目录创建一个名为 `build` 的目录。成功后用一句简短的话确认。',
      { args: ['--trust'] },
    )
    ctx.expect.exitCode(r, 0)
    ctx.expect.toolCalled(r, 'shell')
    await ctx.expect.fileExists('build')
    ctx.expect.noToolErrors(r)
  },
}

export default scenario
