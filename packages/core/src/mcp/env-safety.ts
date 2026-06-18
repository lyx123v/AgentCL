// @x-code-cli/core — 拒绝会导致运行时代码注入的危险环境变量
//
// MCP stdio 服务会把 `env` 原样透传给 spawn()。这些环境变量可能来自三处：
//   1. 用户执行 `xc mcp add --env KEY=VAL`
//   2. 项目级或用户级 mcp 配置文件
//   3. 插件 manifest 中声明的 mcpServers
//
// 真正需要重点防的是第 3 类。插件在安装时已经获得一定信任，
// 但如果它能塞入 `NODE_OPTIONS=--require ./evil.js` 这种键，
// 就能在下次启动任意 Node 型 MCP 服务时执行任意代码，
// 相当于把“安装 manifest”升级成“以当前用户身份执行代码”。
// Linux 上有 LD_PRELOAD，macOS 上有 DYLD_INSERT_LIBRARIES，
// Python / Perl / Ruby 也各有对应的启动钩子。
//
// 我们把检查放在 spawn 边界（registry.connectOneServer），
// 这样三种来源都能被同一处逻辑覆盖。
//
// 这里使用 denylist，而不是 allowlist：
// 合法 MCP 服务本来就需要接受任意 env key 来传 API token 或业务配置，
// 用 allowlist 根本不可行。denylist 只针对那些“唯一用途几乎就是启动时注入代码”的键名。

/** 会被运行时解释成“启动时加载这段代码”的环境变量名。
 *  比较时不区分大小写，见 {@link assertSafeEnv}。 */
const DANGEROUS_ENV_KEYS = new Set<string>([
  // Node
  'NODE_OPTIONS',
  // Linux 动态链接器
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  // macOS 动态链接器
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH',
  'DYLD_FALLBACK_FRAMEWORK_PATH',
  // Shell 初始化或每次执行的钩子。BASH_ENV 作用于非交互 bash；
  // ENV 作用于 POSIX sh；PROMPT_COMMAND 会在每次交互提示符前执行。
  'BASH_ENV',
  'ENV',
  'PROMPT_COMMAND',
  // Python
  'PYTHONSTARTUP',
  'PYTHONPATH',
  // Perl
  'PERL5OPT',
  'PERL5LIB',
  // Ruby
  'RUBYOPT',
  'RUBYLIB',
])

export class UnsafeEnvError extends Error {
  constructor(public readonly key: string) {
    super(
      `环境变量 "${key}" 被 MCP 环境安全检查拦截：它属于运行时代码加载钩子（如 NODE_OPTIONS / LD_PRELOAD 类），` +
        `会让 MCP 配置或插件 manifest 在服务启动时执行任意代码。若你确实需要它，请在启动 xc 的 shell 中自行导出。`,
    )
    this.name = 'UnsafeEnvError'
  }
}

/** 如果 `env` 中包含 denylist 中的危险键，则抛出 {@link UnsafeEnvError}。
 *
 *  比较过程不区分大小写：Windows 环境变量在操作系统层面本就大小写不敏感，
 *  如果拦 `NODE_OPTIONS` 却放过 `Node_Options`，那只是形式上的安全。 */
export function assertSafeEnv(env: Record<string, string> | undefined): void {
  if (!env) return
  for (const k of Object.keys(env)) {
    if (DANGEROUS_ENV_KEYS.has(k.toUpperCase())) {
      throw new UnsafeEnvError(k)
    }
  }
}
