import type { Scenario } from '../framework/types.js'

const UNIQUE_MARKER = 'KIWI_BANANA_7717'

const scenario: Scenario = {
  id: '13-knowledge-injection',
  name: 'AGENTS.md 注入到 system prompt — 模型能引用其中独有的字符串',
  // 执行知识注入场景，验证 AGENTS.md 中的项目约定会进入系统提示。
  async run(ctx) {
    // AGENTS.md 在 cwd（即 tmpDir）下
    await ctx.writeFile(
      'AGENTS.md',
      [
        '# 项目约定',
        '',
        '- 每次代码评审都要以短语 ' + UNIQUE_MARKER + ' 开头。',
        '- 这个项目始终使用 Tab 缩进。',
      ].join('\n'),
    )

    const r = await ctx.runCli(
      '在做任何事情之前，请先告诉我：这个项目里的代码评审是否有一个固定的开场短语？如果有，请把它原样引用出来。',
      { args: ['--max-turns', '4'] },
    )
    ctx.expect.exitCode(r, 0)
    ctx.expect.assistantMentions(r, UNIQUE_MARKER)
  },
}

export default scenario
