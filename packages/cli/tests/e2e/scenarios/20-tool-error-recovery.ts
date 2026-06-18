import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '20-tool-error-recovery',
  name: 'readFile 失败：loop 不崩，模型在 final text 中报告文件不存在',
  // 执行工具报错恢复场景：确认 readFile 失败后模型会收敛到自然语言说明，而不是无限重试。
  async run(ctx) {
    const r = await ctx.runCli(
      '请使用 readFile 工具读取当前目录下的 `does-not-exist.txt`。如果读取失败，请在最终回答中明确说明文件不存在，不要无休止重试。',
      { args: ['--max-turns', '4'] },
    )
    ctx.expect.exitCode(r, 0)
    ctx.expect.toolCalled(r, 'readFile', { filePath: /does-not-exist\.txt$/ })
    ctx.expect.assistantMentions(r, /(not exist|no such|cannot find|doesn't exist|missing|unable|不存在|找不到|未找到|缺失|无法)/i)
  },
}

export default scenario
