import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '16-edit-replace-all',
  name: 'edit 工具 replaceAll：单次调用批量替换标识符',
  // 执行批量替换场景：验证模型会用一次 edit 调用完成所有标识符替换。
  async run(ctx) {
    await ctx.writeFile(
      'config.ts',
      [
        'const oldName = 1',
        'export { oldName }',
        'function useOldName() { return oldName }',
        'export const sum = oldName + oldName',
        '',
      ].join('\n'),
    )

    const r = await ctx.runCli(
      '请先读取 config.ts，然后使用 edit 工具并设置 replaceAll=true，把文件中标识符 `oldName` 的每一处出现都改成 `newName`。只允许使用一次 edit 调用，不能拆成多次。',
      { args: ['--trust', '--max-turns', '6'] },
    )
    ctx.expect.exitCode(r, 0)
    ctx.expect.toolCalled(r, 'edit', {
      filePath: /config\.ts$/,
      oldString: /oldName/,
      replaceAll: true,
    })
    const content = await ctx.readFile('config.ts')
    ctx.expect.truthy(
      !content.includes('oldName'),
      `期望 replaceAll 之后文件中不再出现 'oldName'，但当前内容仍包含它：\n${content}`,
    )
    const newOccurrences = (content.match(/newName/g) ?? []).length
    ctx.expect.truthy(newOccurrences >= 4, `期望 'newName' 至少出现 4 次，实际为 ${newOccurrences}：\n${content}`)
    ctx.expect.noToolErrors(r)
  },
}

export default scenario
