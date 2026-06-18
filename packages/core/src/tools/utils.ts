// @x-code-cli/core — 多个工具共用的小型辅助函数
//
// 这个目录里凡是与某个工具同名的文件（比如 glob.ts、grep.ts、shell.ts）
// 都只负责定义一个工具。更大的共享基础设施则拆到独立模块，例如：
// progress.ts 负责进度上报注册表，shell-provider.ts 负责跨平台 shell 分发，
// truncate.ts 负责工具结果大小限制。这个文件留给那些“多个工具会复用、但又
// 不值得单独建模块”的小函数。
//
// 保持聚焦：如果只是很小的共享函数，优先放这里，而不是继续在 tools/ 下
// 拆出更多碎文件。
import { createRequire } from 'node:module'

// `@x-code-cli/core` 是 ESM 包（`"type": "module"`），运行时没有全局
// `require`。这里通过 `createRequire` 加载纯 CJS 模块，例如
// `@vscode/ripgrep`。它只通过 `module.exports.rgPath` 暴露二进制路径，
// 没有可用的 ESM 版本。
const _require = createRequire(import.meta.url)

/** ripgrep 二进制路径缓存。首次使用时惰性解析，之后整个进程复用。 */
let _rgPath: string | null = null

/** 解析 `glob` 与 `grep` 工具使用的 ripgrep 二进制路径。
 *  优先使用 @vscode/ripgrep（它会为各平台提供预编译二进制）；
 *  如果失败，则回退到 PATH 里的 `rg`，这样即使包的 postinstall 失败，
 *  但开发机装过系统级 ripgrep，也仍然可以正常工作。 */
export function getRipgrepPath(): string {
  if (_rgPath) return _rgPath
  try {
    const rg = _require('@vscode/ripgrep') as { rgPath: string }
    _rgPath = rg.rgPath
  } catch {
    _rgPath = 'rg'
  }
  return _rgPath
}
