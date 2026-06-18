// @x-code-cli/core — Hook 命令变量展开
//
// 负责替换 hook 命令字符串中的 `${name}` 和 `${env:NAME}` 模式。
// 未知变量会保留成字面量 `${name}`，这样一旦写错，错误会在最终 shell
// 命令的报错里显式暴露出来，而不是悄悄展开为空字符串，制造难以定位的
// “command not found” 之类问题。
//
// 支持的变量（参见 [[plugin-marketplace-design]] §8.4）：
//
//    ${pluginDir}      所属插件安装目录的绝对路径
//                      （带版本的缓存目录；重装 / 升级时会被清空）
//    ${pluginDataDir}  插件持久化数据目录的绝对路径
//                      （~/.x-code/plugins/data/<sanitised-plugin-id>/）；
//                      即使卸载后重装、或进行版本升级，也会保留下来。
//                      由调用方在展开前按需创建；本模块只负责字符串替换。
//    ${cwd}            当前工作目录
//    ${homedir}        用户主目录
//    ${sep}            操作系统路径分隔符（Windows 为 `\`，其他平台为 `/`）
//    ${env:NAME}       进程环境变量 `NAME`（未设置时为空字符串）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { pluginDataDir as pluginDataDirPath } from '../plugins/paths.js'

export interface VariableContext {
  /** 插件根目录的绝对路径。 */
  pluginDir: string
  /** 插件的持久化数据目录；当传入 `pluginId` 时，会由 [[buildVariableContext]] 预先创建。 */
  pluginDataDir?: string
  /** 当前工作目录。 */
  cwd: string
  /** 用户主目录。 */
  homedir?: string
  /** 当前系统的路径分隔符。 */
  sep?: string
}

/** 基于当前进程环境和调用方上下文构建默认变量。传入 `pluginId` 后会启用 `${pluginDataDir}`，同时解析出对应的插件数据目录并执行 `mkdir -p`，让插件可以立刻往里面写。若目录已存在，mkdirSync 会是一个廉价的空操作。 */
export function buildVariableContext(input: { pluginDir: string; cwd: string; pluginId?: string }): VariableContext {
  let dataDir: string | undefined
  if (input.pluginId) {
    dataDir = pluginDataDirPath(input.pluginId)
    try {
      fs.mkdirSync(dataDir, { recursive: true })
    } catch {
      // 如果 mkdir 失败（权限不足、磁盘满等），目录就保持缺失状态；
      // 插件脚本稍后尝试写入时会收到一个合理的 shell 报错。
      // 这比在这里直接抛错并卡住 hook 更可取。
    }
  }
  return {
    pluginDir: input.pluginDir,
    pluginDataDir: dataDir,
    cwd: input.cwd,
    homedir: os.homedir(),
    sep: path.sep,
  }
}

/** 展开 `${pluginDir}` / `${pluginDataDir}` / `${cwd}` / `${homedir}` / `${sep}` / `${env:NAME}` 引用。未知模式会原样保留。 */
export function expandVariables(source: string, ctx: VariableContext): string {
  return source.replace(/\$\{([^}]+)\}/g, (whole, expr: string) => {
    const colonIdx = expr.indexOf(':')
    if (colonIdx > 0) {
      const ns = expr.slice(0, colonIdx)
      const key = expr.slice(colonIdx + 1)
      if (ns === 'env') return process.env[key] ?? ''
      // 未知命名空间，原样保留
      return whole
    }
    switch (expr) {
      case 'pluginDir':
        return ctx.pluginDir
      case 'pluginDataDir':
        return ctx.pluginDataDir ?? whole
      case 'cwd':
        return ctx.cwd
      case 'homedir':
        return ctx.homedir ?? ''
      case 'sep':
        return ctx.sep ?? path.sep
      default:
        return whole
    }
  })
}
