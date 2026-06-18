// @x-code-cli/core — 斜杠命令注册表
//
// 注册表在 CLI 启动时根据插件提供的 command 文件构建一次。
// 当用户输入 `/<name>` 且它既不是内建命令也不是 skill 时，
// App.tsx 中默认的 slash-dispatcher 就会来这里查找。
// 整体遵循与 SkillRegistry 相同的“启动期冻结 / 字节稳定”模型。
import fs from 'node:fs'

import { pluginDataDir } from '../plugins/paths.js'
import { type LoadCommandsOptions, loadPluginCommands } from './loader.js'
import type { CommandDefinition } from './types.js'

/** reload 后返回的差异摘要，供 `/plugin refresh` 生成提示信息。 */
export interface CommandReloadSummary {
  /** 本次重载新增的命令名列表。 */
  added: string[]
  /** 本次重载移除的命令名列表。 */
  removed: string[]
  /** 本次重载发生变化的命令名列表。 */
  changed: string[]
  /** 本次重载保持不变的命令名列表。 */
  unchanged: string[]
}

export class CommandRegistry {
  private byName: Map<string, CommandDefinition>

  /** 使用给定命令列表创建内存注册表；命名冲突时后写入者覆盖前者。 */
  constructor(commands: ReadonlyArray<CommandDefinition> = []) {
    this.byName = new Map()
    // 名称冲突时以后写入者为准，与 SkillRegistry 合并
    // user → plugin → project 的策略保持一致。
    for (const c of commands) this.byName.set(c.name, c)
  }

  /** 按命令名获取对应定义。 */
  get(name: string): CommandDefinition | undefined {
    return this.byName.get(name)
  }

  /** 返回当前注册表中的全部命令定义。 */
  list(): CommandDefinition[] {
    return [...this.byName.values()]
  }

  /** 返回当前注册表中的全部命令名。 */
  names(): string[] {
    return [...this.byName.keys()]
  }

  /** 用新加载出的命令集替换当前内存注册表。
   *  主要供 `/plugin refresh` 使用，这样既能刷新内容，
   *  又能保持 registry 实例本身不变，避免已捕获的
   *  `options.commandRegistry` 引用失效。 */
  reload(commands: ReadonlyArray<CommandDefinition>): CommandReloadSummary {
    const previous = this.byName
    const next = new Map<string, CommandDefinition>()
    for (const c of commands) next.set(c.name, c)
    const summary: CommandReloadSummary = { added: [], removed: [], changed: [], unchanged: [] }
    for (const [name, cmd] of next) {
      const prev = previous.get(name)
      if (!prev) summary.added.push(name)
      else if (prev.body !== cmd.body || prev.pluginId !== cmd.pluginId || prev.pluginRoot !== cmd.pluginRoot)
        summary.changed.push(name)
      else summary.unchanged.push(name)
    }
    for (const name of previous.keys()) {
      if (!next.has(name)) summary.removed.push(name)
    }
    this.byName = next
    return summary
  }
}

/** 创建命令注册表，内部会先加载可用命令。 */
export async function createCommandRegistry(opts: LoadCommandsOptions = {}): Promise<CommandRegistry> {
  const commands = await loadPluginCommands(opts)
  return new CommandRegistry(commands)
}

/** 重新扫描插件命令目录，并在原地重建注册表内容。
 *  调用方需要自行传入最新的插件目录 `extraDirs`。 */
export async function reloadCommandRegistry(
  registry: CommandRegistry,
  opts: LoadCommandsOptions = {},
): Promise<CommandReloadSummary> {
  const commands = await loadPluginCommands(opts)
  return registry.reload(commands)
}

/** 在把命令 body 发送给模型之前，按 Claude Code 风格替换占位符。
 *  支持的占位符与真实 Claude Code 插件命令文件一致（已对照
 *  `anthropics/claude-code/plugins/<plugin>/commands/<cmd>.md` 验证）：
 *
 *    $ARGUMENTS  /  ${ARGUMENTS}    —— 用户在命令名后输入的参数文本
 *                                     （如 `/code-review 123` → `123`）。
 *                                     没有参数时替换为空字符串。
 *    ${CLAUDE_PLUGIN_ROOT}          —— 所属插件安装目录的绝对路径
 *                                     （带版本号，重装时会被清空）。
 *    ${CLAUDE_PLUGIN_DATA}          —— 插件级持久化数据目录
 *                                     （`~/.x-code/plugins/data/<id>/`），
 *                                     可跨重装和升级保留。首次替换时会自动创建。
 *                                     如果命令没有插件上下文，则保留为空字符串。 */
export function expandCommandBody(cmd: CommandDefinition, args: string): string {
  const root = cmd.pluginRoot ?? ''
  let dataDir = ''
  if (cmd.pluginId && cmd.body.includes('${CLAUDE_PLUGIN_DATA}')) {
    dataDir = pluginDataDir(cmd.pluginId)
    try {
      fs.mkdirSync(dataDir, { recursive: true })
    } catch {
      // 即便 mkdir 失败，也保留 dataDir 这个路径字符串；
      // 如果用户的 shell 脚本真的尝试写入，届时会暴露出更明确的错误。
    }
  }
  return cmd.body
    .replaceAll('${CLAUDE_PLUGIN_ROOT}', root)
    .replaceAll('${CLAUDE_PLUGIN_DATA}', dataDir)
    .replaceAll('${ARGUMENTS}', args)
    .replaceAll('$ARGUMENTS', args)
}
