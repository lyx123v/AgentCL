import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '21-shell-destructive-deny',
  name: '破坏性 shell 命令在 --trust 下放行，文件被删除',
  // 执行破坏性 shell 命令场景：验证 --trust 会自动放行 ask 级别的危险命令。
  async run(ctx) {
    await ctx.writeFile('keepme.txt', '不要删除')

    // 破坏性命令在 getPermissionLevel 中会返回 'deny'，但
    // checkPermission 现在不会直接硬拦截，而是继续走普通的
    // ask 流程（交互模式下会带 [dangerous] 警告）。
    // 在 --trust 下，所有 ask 级工具都会被自动批准，
    // 其中也包括这类危险命令，行为与 Claude Code 保持一致。
    //
    // Windows 上 `rm -rf` 不能直接用（PowerShell 会把 `rm` 映射成
    // Remove-Item，而它并不认识 `-rf`）。因此这里按平台选择真正可执行
    // 的破坏性命令，确保文件确实会被删除。
    const isWin = process.platform === 'win32'
    const cmd = isWin ? 'Remove-Item -Recurse -Force keepme.txt' : 'rm -rf keepme.txt'
    const r = await ctx.runCli(
      `请使用 shell 工具执行“完全一致”的这条命令（不要修改，也不要替换成别的命令）：\`${cmd}\`。尝试结束后，请用一句话说明发生了什么。`,
      { args: ['--trust', '--max-turns', '4'] },
    )
    ctx.expect.exitCode(r, 0)
    ctx.expect.toolCalled(r, 'shell')
    const shellCall = r.toolCalls.find((tc) => tc.toolName === 'shell')
    ctx.expect.truthy(
      shellCall != null && !/permission denied/i.test(shellCall.resultText ?? ''),
      `破坏性 shell 命令在 --trust 下应被自动批准；当前 resultText 为：${shellCall?.resultText?.slice(0, 200)}`,
    )
    const deleted = !(await ctx.fileExists('keepme.txt'))
    ctx.expect.truthy(deleted, 'keepme.txt 应该被删除，因为 --trust 会自动批准破坏性命令')
  },
}

export default scenario
