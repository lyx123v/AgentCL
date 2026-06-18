import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '18-permission-deny',
  name: 'print 模式无 --trust：writeFile 被拒，文件未创建，loop 不崩',
  // 执行权限拒绝场景：确认未开启 --trust 时写文件会被拒绝，且会话仍能正常结束。
  async run(ctx) {
    const r = await ctx.runCli(
      '请使用 writeFile 工具在当前目录创建一个名为 blocked.txt 的文件，内容写成“不应该出现”。尝试结束后，请告诉我发生了什么。',
      { args: ['--max-turns', '4'] },
    )
    ctx.expect.exitCode(r, 0)
    ctx.expect.toolCalled(r, 'writeFile', { filePath: /blocked\.txt$/ })
    const exists = await ctx.fileExists('blocked.txt')
    ctx.expect.truthy(
      !exists,
      '期望 blocked.txt 不会被写入（未开启 --trust 时 onAskPermission 会返回 no），但文件实际存在',
    )
    // print.ts 在拒绝工具调用时，会把这个标记写入 stderr。
    ctx.expect.truthy(
      /permission denied/i.test(r.stderr),
      `期望 stderr 包含 "permission denied"；实际内容为：\n${r.stderr.slice(0, 300)}`,
    )
  },
}

export default scenario
