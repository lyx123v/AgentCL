import path from 'node:path'

import type { Scenario } from '../framework/types.js'

const ROOT_MARKER = 'MAGENTA_FOX_8821'
const LEAF_MARKER = 'AZURE_OWL_4242'

const scenario: Scenario = {
  id: '19-knowledge-monorepo',
  name: 'AGENTS.md monorepo 链：root + leaf 都注入 system prompt',
  // 执行 monorepo 知识注入场景：验证根目录与子包的 AGENTS.md 都会进入 system prompt。
  async run(ctx) {
    // 根目录的 `.git` 用来限定 AGENTS.md 搜索范围；没有它的话，
    // walker 可能会继续向 tmpDir 之外爬升，意外捡到开发者机器上的
    // 其他 CLAUDE.md / AGENTS.md，导致测试结果变得不稳定。
    await ctx.mkdir('.git')
    await ctx.writeFile('.git/HEAD', 'ref: refs/heads/main\n')

    await ctx.writeFile('AGENTS.md', [`# 仓库根目录`, '', `仓库根目录的唯一标记是 ${ROOT_MARKER}。`].join('\n'))
    await ctx.writeFile(
      'packages/widget/AGENTS.md',
      [`# Widget 包`, '', `widget 包的唯一标记是 ${LEAF_MARKER}。`].join('\n'),
    )
    await ctx.writeFile('packages/widget/package.json', '{"name":"widget"}\n')

    const widgetDir = path.join(ctx.tmpDir, 'packages', 'widget')
    const r = await ctx.runCli(
      '这个项目里，仓库根目录和当前包目录各自都有一个 AGENTS.md，且各自包含一个唯一标记。请把这两个标记字符串逐字回复给我。',
      { args: ['--max-turns', '4'], cwd: widgetDir },
    )
    ctx.expect.exitCode(r, 0)
    ctx.expect.assistantMentions(r, ROOT_MARKER)
    ctx.expect.assistantMentions(r, LEAF_MARKER)
  },
}

export default scenario
