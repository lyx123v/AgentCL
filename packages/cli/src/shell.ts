// @x-code-cli/cli - Shell 检测与环境变量持久化命令工具。
//
// 这里的 shell 检测会被多个启动提示复用，避免 index.ts 里重复写分支。
// formatPersistCommand 负责把“如何把环境变量写进当前 shell 配置”这段逻辑统一收口，
// 这样后续新增提示文案时，就不用再复制一套 switch(shell)。

export type ShellType = 'powershell' | 'cmd' | 'bash' | 'zsh' | 'fish' | 'sh'

export function detectShell(): ShellType {
  if (process.platform === 'win32') {
    if (process.env.PSModulePath) return 'powershell'
    return 'cmd'
  }
  const shellPath = process.env.SHELL ?? ''
  const base = shellPath.split('/').pop() ?? ''
  if (base === 'zsh' || base === 'bash' || base === 'fish' || base === 'sh') return base
  if (process.platform === 'darwin') return 'zsh'
  return 'bash'
}

/**
 * 返回一条可直接复制粘贴的 shell 命令，用于把环境变量持久化保存。
 * 这里只返回命令本体，不带前缀、不带换行；调用方会自行加颜色和说明文字。
 *
 *   envVar       - 例如 "ANTHROPIC_API_KEY"
 *   exampleValue  - 例如 "sk-ant-..."
 *   shell        - detectShell() 的返回值
 */
export function formatPersistCommand(envVar: string, exampleValue: string, shell: ShellType): string {
  switch (shell) {
    case 'powershell':
      return `[Environment]::SetEnvironmentVariable('${envVar}','${exampleValue}','User')`
    case 'cmd':
      return `setx ${envVar} "${exampleValue}"`
    case 'zsh':
      return `echo 'export ${envVar}=${exampleValue}' >> ~/.zshrc && source ~/.zshrc`
    case 'fish':
      return `set -Ux ${envVar} ${exampleValue}`
    case 'bash':
    default:
      return `echo 'export ${envVar}=${exampleValue}' >> ~/.bashrc && source ~/.bashrc`
  }
}
