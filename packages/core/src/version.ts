// @x-code-cli/core — 运行时解析包版本号
//
// Core 通过 `tsc -b` 构建，没有 bundler，因此不能像 CLI 一样
// 在构建时直接注入版本常量。这里改为从 `import.meta.url` 一路向上查找，
// 找到最近的 `@x-code-cli/*` 的 package.json，再读取其中的 `version` 字段。
//
// 这里需要兼容两种场景：
//
// 1. 开发态 / 未打包
//    core 的编译产物位于 `<core>/dist/**/*.js`，向上查找会找到
//    `<core>/package.json`（name = `@x-code-cli/core`）。
// 2. CLI 打包态
//    CLI 会用 esbuild 把 core 源码打进单个 `<cli>/dist/cli.js`。
//    这时 `import.meta.url` 指向 bundle 内部，最近的 package.json
//    会变成 `<cli>/package.json`（name = `@x-code-cli/cli`）。
//
// `core` 和 `cli` 由 `scripts/release.mjs` 同步发布，
// 所以匹配到任何一个都能得到正确版本。
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FALLBACK_VERSION = '0.0.0-dev'

interface VersionPackageJson {
  name?: string // 包名，用于确认是否属于 `@x-code-cli/*`
  version?: string // package.json 中声明的版本号
}

/** 从当前模块路径向上查找 package.json，并解析当前运行时版本号。 */
function resolveVersion(): string {
  try {
    let dir = dirname(fileURLToPath(import.meta.url))
    for (let i = 0; i < 8; i++) {
      const pkgPath = join(dir, 'package.json')
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as VersionPackageJson
        if ((pkg.name === '@x-code-cli/core' || pkg.name === '@x-code-cli/cli') && pkg.version) {
          return pkg.version
        }
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    // 读取失败时继续走回退版本。
  }
  return FALLBACK_VERSION
}

export const VERSION = resolveVersion()
