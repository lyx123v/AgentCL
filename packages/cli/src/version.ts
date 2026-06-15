// @x-code-cli/cli - CLI 版本号。
//
// 版本在构建期通过 esbuild 的 `define` 注入。
// 全局变量 `__CLI_VERSION__` 由 esbuild.config.js 从 package.json 读取后写入，
// 因此正式构建时不会产生任何运行时读取成本。
// 在 `tsx src/index.ts` 这种开发模式下，则回退到读取本地 package.json，
// 保证源码直跑时也能拿到正确版本。
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

declare const __CLI_VERSION__: string | undefined

function resolveVersion(): string {
  // 优先使用构建期注入值，避免任何运行时开销。
  if (typeof __CLI_VERSION__ === 'string' && __CLI_VERSION__) {
    return __CLI_VERSION__
  }
  // 开发模式回退：逐级向上查找 package.json。
  try {
    let dir = dirname(fileURLToPath(import.meta.url))
    for (let i = 0; i < 6; i++) {
      const pkgPath = join(dir, 'package.json')
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string; version?: string }
        if (pkg.name === '@x-code-cli/cli' && pkg.version) {
          return pkg.version
        }
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    // 读取失败时直接走兜底版本。
  }
  return '0.0.0-dev'
}

export const VERSION = resolveVersion()
