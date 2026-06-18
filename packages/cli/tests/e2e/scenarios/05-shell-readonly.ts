import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '05-shell-readonly',
  name: '只读 shell（ls / pwd）自动放行，不需 --trust',
  // 执行只读 shell 场景，验证白名单命令会在无 trust 时自动放行。
  async run(ctx) {
    // 不传 --trust。`echo` 在 shell-utils 的 READ_ONLY_COMMANDS 白名单里，
    // 走 always-allow，应当自动通过。命令选 echo 是因为：
    //   1. 在白名单里 (vs node --version 走的是 ask)
    //   2. listDir / readFile 替代不了 (vs `ls` 会被模型挑去用 listDir)
    // 所以模型只能落在 shell 工具上 — 这才真正测到 shell 的只读自动放行路径。
    const MARKER = 'SHELL_READONLY_MARKER_7777'
    const r = await ctx.runCli(
      `请使用 shell 工具执行命令 \`echo ${MARKER}\`，然后把它打印出的内容原样引用给我。`,
    )
    ctx.expect.exitCode(r, 0)
    ctx.expect.toolCalled(r, 'shell')
    // 没有 trust 时 deny 类工具会得到 permission denied — 这里期望它不返回 denied
    const shellCall = r.toolCalls.find((tc) => tc.toolName === 'shell')
    ctx.expect.truthy(
      shellCall != null && !(shellCall.resultText ?? '').toLowerCase().includes('permission denied'),
      `shell 调用应该自动放行只读命令，实际 resultText 为：${shellCall?.resultText?.slice(0, 200)}`,
    )
    ctx.expect.assistantMentions(r, MARKER)
  },
}

export default scenario
