// @x-code-cli/core — 跨平台 shell provider 抽象
//
// 不同 shell（bash/zsh、PowerShell）在启动子进程时各自带着不同的
// 引号与编码怪癖。把这些差异封装在 provider 接口后，工具执行层就不需要
// 再写平台分支，也不用手搓 PowerShell 的转义逻辑。
import { type ResultPromise, execa } from 'execa'

import os from 'node:os'

export type ShellType = 'bash' | 'zsh' | 'powershell'

// 20 MB：与 Claude Code 的 ripgrep 缓冲区上限保持一致。这个值既足够覆盖
// 常见真实输出，又能避免误跑 `yes` 或 `find /` 之类命令时把内存吃光。
// 超过后，execa 会用 SIGTERM 终止子进程，并抛出 "maxBuffer exceeded" 错误。
export const MAX_SHELL_BUFFER = 20 * 1024 * 1024

export interface ShellSpawnOptions {
  timeout: number // 命令执行超时时间，单位毫秒
  env?: NodeJS.ProcessEnv // 传递给子进程的环境变量
  cwd?: string // 子进程执行时使用的工作目录
  /** 当这个信号触发中止时，execa 会杀掉整个子进程树。
   *  用于响应用户在命令执行途中按 Esc / Ctrl+C，而不是只能等到超时。 */
  signal?: AbortSignal
}

export interface ShellProvider {
  type: ShellType // 当前 provider 对应的 shell 类型
  spawn(command: string, opts: ShellSpawnOptions): ResultPromise // 启动 shell 命令并返回 execa 的结果 promise
}

/** 创建 POSIX 系 shell 的 provider。 */
function createPosixProvider(executable: string, type: 'bash' | 'zsh'): ShellProvider {
  return {
    type,
    spawn(command, opts) {
      return execa(executable, ['-c', command], {
        timeout: opts.timeout,
        maxBuffer: MAX_SHELL_BUFFER,
        cwd: opts.cwd,
        reject: false,
        cancelSignal: opts.signal,
        env: { ...(opts.env ?? process.env), PYTHONIOENCODING: 'utf-8' },
      })
    },
  }
}

// PowerShell 的 -EncodedCommand 接收 base64 编码的 UTF-16LE 文本。
// 其字符集只会落在 [A-Za-z0-9+/=]，可以安全穿过外层引用环境
// （如 cmd.exe、Node 在 Windows 上的 argv 序列化等），因此我们不必
// 再额外处理用户命令中的引号转义。
function encodePowerShellCommand(psCommand: string): string {
  return Buffer.from(psCommand, 'utf16le').toString('base64')
}

/** 创建 PowerShell provider，并统一处理编码、进度噪音和退出码传播。 */
function createPowerShellProvider(executable: string): ShellProvider {
  return {
    type: 'powershell',
    spawn(command, opts) {
      // 前后包装代码会放进同一个 -EncodedCommand 载荷中：
      //   • OutputEncoding = UTF-8：解决 zh-CN Windows 下 PS 5.1 默认用 GBK
      //     输出导致的乱码问题，也省掉 `chcp 65001 >nul && ...` 包装层。
      //   • ProgressPreference = SilentlyContinue：抑制首次模块加载时输出到
      //     stderr 的 CLIXML 进度噪音。
      //   • 末尾显式 `exit`：PowerShell 不会自动把 $LASTEXITCODE 传递成自身
      //     进程退出码。没有这段处理时，像 `git push`、`tsc` 失败都可能被
      //     模糊成 0 或泛化成 1，丢失真实信号。
      const wrapped = [
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        "$ProgressPreference = 'SilentlyContinue'",
        command,
        '$__ec = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }',
        'exit $__ec',
      ].join('\n')
      return execa(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellCommand(wrapped)], {
        timeout: opts.timeout,
        maxBuffer: MAX_SHELL_BUFFER,
        cwd: opts.cwd,
        reject: false,
        cancelSignal: opts.signal,
        env: { ...(opts.env ?? process.env), PYTHONIOENCODING: 'utf-8' },
      })
    },
  }
}

/** 根据当前操作系统与环境变量，选择合适的 shell provider。 */
export function getShellProvider(): ShellProvider {
  if (os.platform() === 'win32') {
    // Git Bash / MSYS2 / Cygwin 会把 SHELL 设成 Unix 风格路径。
    // 如果存在，优先使用它，这样 Unix 工具链能按预期工作。
    const shell = process.env.SHELL
    if (shell && /\b(bash|zsh)$/i.test(shell)) {
      return createPosixProvider(shell, shell.endsWith('zsh') ? 'zsh' : 'bash')
    }
    return createPowerShellProvider('powershell.exe')
  }
  const userShell = process.env.SHELL ?? '/bin/bash'
  return createPosixProvider(userShell, userShell.endsWith('zsh') ? 'zsh' : 'bash')
}
