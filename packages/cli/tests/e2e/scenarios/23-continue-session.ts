import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '23-continue-session',
  name: '--continue 加载上轮会话：模型记得前一轮告诉过它的数字',
  // 执行连续会话场景：验证 --continue 会把上一轮会话内容恢复到新的 print 模式中。
  async run(ctx) {
    // 这里会在同一个 tmpDir 中连续运行两次 `xc -p`。第二次使用 --continue，
    // main() 会从 <tmpDir>/.x-code/sessions/ 中取最新的 jsonl，作为
    // initialSession 交给 runPrintMode；后者再通过 hydrateLoopState
    // 把会话内容注入 agentLoop 的 LoopState。若这条链路缺失，第二轮只会看到
    // 一段全新的对话，自然也就不知道 4242 是什么。
    const r1 = await ctx.runCli(
      '这轮会话里请记住一个特定事实：神奇数字是 4242。只用一句简短的话确认收到即可，不需要调用工具。',
      { args: ['--max-turns', '2'] },
    )
    ctx.expect.exitCode(r1, 0)
    ctx.expect.assistantMentions(r1, '4242')

    const r2 = await ctx.runCli(
      '我刚才让你记住的神奇数字是什么？只回答这个数字本身。',
      { args: ['--continue', '--max-turns', '2'] },
    )
    ctx.expect.exitCode(r2, 0)
    ctx.expect.assistantMentions(r2, '4242')
  },
}

export default scenario
