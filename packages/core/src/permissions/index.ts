// @x-code-cli/core — 权限系统（三层模型）
import path from 'node:path'

import { isDestructive, isReadOnly, splitShellCommands } from '../tools/shell-utils.js'
import type { PermissionLevel, PermissionMode } from '../types/index.js'
import { addSessionAllowRule, buildAllowRule, persistRule, sessionRulesMatch } from './session-store.js'

type PermissionInput = Record<string, unknown>

/**
 * shell 权限级别缓存，键为完整命令字符串。
 * “是否破坏性 / 是否只读”的模式在进程生命周期内是稳定的，
 * 因此直接用 Map 就够了，不需要 TTL。
 * 同时设置一个上限，避免长时间运行的 agent 不断积累新命令导致缓存无限增长。
 */
const SHELL_PERMISSION_CACHE_MAX = 256
const shellPermissionCache = new Map<string, PermissionLevel>()

/** 根据命令中各子命令的特征，计算 shell 工具的权限级别。 */
function evaluateShellPermission(command: string): PermissionLevel {
  const subCommands = splitShellCommands(command)
  // 只要任一子命令具有破坏性，就拒绝整条命令。
  if (subCommands.some(isDestructive)) return 'deny'
  // 只有当所有子命令都是只读操作时，才自动允许。
  if (subCommands.every(isReadOnly)) return 'always-allow'
  // 其他情况统一进入询问。
  return 'ask'
}

/** 结合缓存解析 shell 工具的权限级别。 */
function resolveShellPermission(input: PermissionInput): PermissionLevel {
  const cmd = (input.command as string) ?? ''
  const cached = shellPermissionCache.get(cmd)
  if (cached) return cached

  const level = evaluateShellPermission(cmd)

  if (shellPermissionCache.size >= SHELL_PERMISSION_CACHE_MAX) {
    // 淘汰最早插入的条目（Map 会保留插入顺序）。
    const oldest = shellPermissionCache.keys().next().value
    if (oldest !== undefined) shellPermissionCache.delete(oldest)
  }
  shellPermissionCache.set(cmd, level)
  return level
}

/** 各工具对应的默认权限规则。 */
const rules: Record<string, (input: PermissionInput) => PermissionLevel> = {
  readFile: () => 'always-allow',
  glob: () => 'always-allow',
  grep: () => 'always-allow',
  listDir: () => 'always-allow',
  webSearch: () => 'always-allow',
  webFetch: () => 'always-allow',
  askUser: () => 'always-allow',
  edit: () => 'ask',
  writeFile: () => 'ask',
  shell: resolveShellPermission,
}

/** 根据工具名和输入内容，获取这次调用应使用的权限级别。 */
export function getPermissionLevel(toolName: string, input: PermissionInput): PermissionLevel {
  const rule = rules[toolName]
  if (!rule) return 'ask' // 未知工具默认走询问
  return rule(input)
}

// ── 写工具的路径安全控制 ─────────────────────────────────────────────────
// 这些敏感 dotfile / 配置路径即使在 acceptEdits 模式下也不应自动放行。
// 语义上对应 Claude Code 的 isDangerousFilePathToAutoEdit。
const SENSITIVE_PATH_PATTERNS = [
  /[\\/]\.bashrc$/,
  /[\\/]\.bash_profile$/,
  /[\\/]\.profile$/,
  /[\\/]\.zshrc$/,
  /[\\/]\.zprofile$/,
  /[\\/]\.gitconfig$/,
  /[\\/]\.ssh[\\/]/,
  /[\\/]\.env$/,
  /[\\/]\.git[\\/]/,
  /[\\/]\.vscode[\\/]/,
  /[\\/]\.idea[\\/]/,
]

/** 判断 `filePath` 是否位于 `projectDir` 内部（或与其本身相等）。
 *  两边都会规范成小写的正斜杠路径，避免 Windows 盘符大小写和尾部分隔符造成误判。 */
export function isPathWithinProject(filePath: string, projectDir: string): boolean {
  const normalize = (p: string) => path.resolve(p).replace(/\\/g, '/').toLowerCase()
  const file = normalize(filePath)
  const dir = normalize(projectDir)
  return file === dir || file.startsWith(dir + '/')
}

/** 判断目标路径是否命中敏感文件规则。 */
function isSensitivePath(filePath: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some((re) => re.test(filePath))
}

/** 在 trust mode 与 permission mode 的共同影响下判断是否允许这次工具调用。
 *
 *  `permissionMode` 的语义如下：
 *    - `default`：与原行为一致，`ask` 级别的工具会弹窗询问。
 *    - `acceptEdits`：仅当 `writeFile` / `edit` 的目标路径位于项目目录内，
 *      且不是敏感 dotfile 时，才自动允许。路径若在 cwd 外部，或命中 .bashrc/.git 等
 *      敏感位置，则会退回 `ask`，要求用户明确同意。shell 仍按原有分类逻辑处理，
 *      所以破坏性命令仍会被拦截，`deny` 结果也仍然生效。
 *    - `plan`：纯提示词层面的约束（与 Claude Code 一致），权限层本身不做额外改动。
 *      system prompt 会提醒模型不要写入；若模型无视提醒，常规的 `ask` 询问仍会触发。
 *
 *  trust mode 是全局覆盖项，除显式 `deny` 外优先级最高。 */
export async function checkPermission(
  toolCall: { toolCallId: string; toolName: string; input: PermissionInput },
  trustMode: boolean,
  onAskPermission: (toolCall: {
    toolCallId: string
    toolName: string
    input: PermissionInput
  }) => Promise<'yes' | 'always' | 'no'>,
  permissionMode: PermissionMode = 'default',
  cwd?: string,
): Promise<boolean> {
  const level = getPermissionLevel(toolCall.toolName, toolCall.input)
  if (level === 'always-allow' || trustMode) return true
  if (permissionMode === 'acceptEdits' && (toolCall.toolName === 'writeFile' || toolCall.toolName === 'edit')) {
    const filePath = (toolCall.input.filePath as string) ?? ''
    const projectDir = cwd ?? process.cwd()
    if (filePath && isPathWithinProject(filePath, projectDir) && !isSensitivePath(filePath)) {
      return true
    }
    // 路径位于项目外部，或命中了敏感文件时，继续走询问流程。
  }
  if (sessionRulesMatch(toolCall.toolName, toolCall.input)) return true

  const decision = await onAskPermission(toolCall)
  if (decision === 'always') {
    const result = buildAllowRule(toolCall.toolName, toolCall.input)
    if (result) {
      // buildAllowRule 可能为复合 shell 命令返回多条规则，
      // 例如 `git commit && git push`。用户界面上的标签会展示成
      // `git commit:*, git push:*`，这里也会把两条规则都保存下来，
      // 以便下次遇到同类复合命令时直接自动放行。
      for (const rule of result.rules) {
        addSessionAllowRule(rule)
        if (result.persist && cwd) persistRule(cwd, rule)
      }
    }
    return true
  }
  return decision === 'yes'
}

export { addSessionAllowRule, clearSessionRules, buildAllowRule } from './session-store.js'
export {
  extractCommandPrefix,
  extractCompoundPrefixes,
  extractCompoundRules,
  suggestRuleLabel,
} from './session-store.js'
export { loadPersistedRules, persistRule } from './session-store.js'
