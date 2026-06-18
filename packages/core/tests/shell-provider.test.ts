// shell-provider.ts 集成测试。
//
// 这些测试会真正拉起子进程（bash / zsh / PowerShell），
// 因此能端到端覆盖编码与引号转义整条链路。
// 如果当前平台解析到的是另一种 shell，对应套件会自动跳过。
//
// 重点覆盖的回归点（见仓库根目录 a.log，其中记录了 zh-CN Windows 上
// 的原始故障）：
//   • 在旧的反斜杠转义方案下，双引号命令会触发 `At line:1 char:N`
//   • PowerShell 不会自动把 $LASTEXITCODE 传播成自身进程退出码，
//     导致原生可执行文件的 exit code 曾经被吞掉
//   • UTF-8 输出以前依赖 `chcp 65001 >nul && ...` 这种 cmd 包装
import { describe, expect, it } from 'vitest'

import { getShellProvider } from '../src/tools/shell-provider.js'

const provider = getShellProvider()
const isPowerShell = provider.type === 'powershell'
const isPosix = provider.type === 'bash' || provider.type === 'zsh'

// 统一执行当前平台解析出的 shell provider，并收集常用结果字段。
async function run(command: string, timeout = 10_000) {
  const r = await provider.spawn(command, { timeout })
  return {
    exitCode: r.exitCode ?? -1,
    stdout: (r.stdout ?? '').toString(),
    stderr: (r.stderr ?? '').toString(),
  }
}

describe.skipIf(!isPowerShell)('PowerShell provider', () => {
  // a.log 第 11 行：曾经精确命中 "At line:1 char:24" 的命令形态。
  it('可以执行带嵌套双引号的命令', async () => {
    const r = await run(`powershell -Command "Write-Host 'nested'"`)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('nested')
  })

  // a.log 第 33 行：包含双引号字面量的复合命令。
  it('可以执行包含双引号字面量的复合命令', async () => {
    const r = await run(`Write-Output "a"; Write-Output "---"; Write-Output "b"`)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('a')
    expect(r.stdout).toContain('---')
    expect(r.stdout).toContain('b')
  })

  // a.log 第 49 行：类似 commit message 的带冒号双引号参数。
  it('可以执行带冒号双引号参数的命令', async () => {
    const r = await run(`Write-Output "feat: use primary accent color"`)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('primary accent color')
  })

  // 过去依赖 `chcp 65001 >nul &&` 这种 cmd 包装；现在则由
  // -EncodedCommand 载荷自行设置 [Console]::OutputEncoding。
  it('可以正确往返 UTF-8（中文 + 长横线 + emoji）', async () => {
    const r = await run(`Write-Output "中文测试 — emoji 🎯"`)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('中文测试')
    expect(r.stdout).toContain('🎯')
  })

  // PS 5.1 不会自动把 $LASTEXITCODE 传播到自身退出码。
  // 如果 provider 末尾没有 `exit $__ec`，这里得到的就会是 0 或 1。
  it('会正确传播原生命令的退出码', async () => {
    const r = await run(`cmd /c exit 3`)
    expect(r.exitCode).toBe(3)
  })

  it('成功时返回退出码 0', async () => {
    const r = await run(`Write-Output hello`)
    expect(r.exitCode).toBe(0)
  })

  it('不会把 CLIXML 进度噪音泄漏到 stderr', async () => {
    const r = await run(`Write-Output ok`)
    expect(r.stderr).not.toMatch(/CLIXML/)
  })
})

describe.skipIf(!isPosix)('POSIX provider (bash/zsh)', () => {
  it('可以执行带转义双引号的命令', async () => {
    const r = await run(`echo "hello \\"world\\""`)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('hello')
    expect(r.stdout).toContain('world')
  })

  it('可以正确往返 UTF-8（中文 + 长横线 + emoji）', async () => {
    const r = await run(`echo "中文测试 — emoji 🎯"`)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('中文测试')
    expect(r.stdout).toContain('🎯')
  })

  it('会正确传播非零退出码', async () => {
    const r = await run(`sh -c 'exit 3'`)
    expect(r.exitCode).toBe(3)
  })

  it('成功时返回退出码 0', async () => {
    const r = await run(`echo hello`)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('hello')
  })
})

describe('getShellProvider', () => {
  it('会返回一个拥有合法 type 与 spawn() 的 provider', () => {
    expect(['bash', 'zsh', 'powershell']).toContain(provider.type)
    expect(typeof provider.spawn).toBe('function')
  })
})
