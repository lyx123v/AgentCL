import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '12-plan-mode',
  name: '--plan 启动：模型只读探索、不调写工具',
  // 执行计划模式场景，验证模型只做探索和计划，不改业务文件。
  async run(ctx) {
    await ctx.writeFile('src/main.ts', 'export const greet = () => "hello"\n')
    await ctx.writeFile('package.json', '{"name":"demo"}\n')

    const r = await ctx.runCli(
      '我想重构 src/main.ts，让它额外导出一个 `bye` 函数。请先查看当前内容，然后用文字说明你会怎么改。不要真的动手修改文件。',
      { args: ['--plan', '--trust', '--max-turns', '12'] },
    )
    ctx.expect.exitCode(r, 0)

    // 计划模式可以调用 writeFile/edit，但只能写 `.x-code/plans/` 下的计划存储文件。
    // enterPlanMode 的工具返回会明确要求模型用 writeFile 写计划文件来构建计划
    // （见 plan-tools.ts:131）。这里真正要守住的不变量是：
    // 写工具绝不能碰 `.x-code/plans/` 之外的任何路径。
    // 判断某个路径是否属于计划文件目录。
    const isPlanFile = (p: unknown): boolean => typeof p === 'string' && /[\\/]\.x-code[\\/]plans[\\/]/.test(p)
    for (const tc of r.toolCalls) {
      if (tc.toolName !== 'writeFile' && tc.toolName !== 'edit') continue
      const filePath = tc.input.filePath
      ctx.expect.truthy(
        isPlanFile(filePath),
        `计划模式写到了 .x-code/plans/ 之外：${tc.toolName} → ${String(filePath)}`,
      )
    }

    // src/main.ts 完全不应该被改动。
    await ctx.expect.fileContent('src/main.ts', /greet/)
    const content = await ctx.readFile('src/main.ts')
    ctx.expect.truthy(!content.includes('bye'), '计划模式下不应该修改 src/main.ts')
  },
}

export default scenario
