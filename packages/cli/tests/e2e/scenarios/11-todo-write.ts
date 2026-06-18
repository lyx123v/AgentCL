import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '11-todo-write',
  name: 'todoWrite：模型为多步任务建任务清单',
  // 执行待办清单场景，验证模型会先建 todo 再按步骤执行。
  async run(ctx) {
    await ctx.writeFile('a.txt', 'A\n')
    await ctx.writeFile('b.txt', 'B\n')
    await ctx.writeFile('c.txt', 'C\n')

    const r = await ctx.runCli(
      [
        '我希望你按顺序完成这 3 件事：',
        '  (1) 读取 a.txt',
        '  (2) 读取 b.txt',
        '  (3) 读取 c.txt',
        '在读取任何内容之前，请先使用 todoWrite 工具创建一份包含这 3 项的待办清单。然后逐项执行，并在过程中更新 todo 状态。',
      ].join('\n'),
      { args: ['--trust', '--max-turns', '15'] },
    )
    ctx.expect.exitCode(r, 0)
    // todoWrite 调用里 todos 必须含至少 3 项，且分别提到 a/b/c.txt。
    // 旧版 toolCalled(todoWrite) 不查 input — 模型建一份只含 1 项的 todo
    // 也能过；这里用 predicate 把"清单真的是 3 步"作为不变量验证。
    ctx.expect.toolCalled(r, 'todoWrite', {
      todos: (todos: unknown) => {
        if (!Array.isArray(todos) || todos.length < 3) return false
        // 把 todo 内容拼成一段文本，便于统一检查是否覆盖 a/b/c 三个文件。
        const blob = todos
          .map((t: unknown) => {
            if (!t || typeof t !== 'object') return ''
            const o = t as Record<string, unknown>
            return [o.content, o.activeForm].filter((v) => typeof v === 'string').join(' ')
          })
          .join(' | ')
          .toLowerCase()
        return blob.includes('a.txt') && blob.includes('b.txt') && blob.includes('c.txt')
      },
    })
    // 三个文件都必须被 readFile 读过 — "多步执行"才不是空话。
    // 旧版只查 readFile 调用过一次，模型完全可以跳过 b/c。
    ctx.expect.toolCalled(r, 'readFile', { filePath: /a\.txt$/ })
    ctx.expect.toolCalled(r, 'readFile', { filePath: /b\.txt$/ })
    ctx.expect.toolCalled(r, 'readFile', { filePath: /c\.txt$/ })
    ctx.expect.noToolErrors(r)
  },
}

export default scenario
