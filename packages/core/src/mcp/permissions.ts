// @x-code-cli/core — MCP 工具权限闸门
//
// 这一层与 packages/core/src/permissions/index.ts 并行存在，后者负责
// 内建的 writeFile / edit / shell 权限控制。MCP 工具要单独维护一套权限，
// 原因是：
//   - 工具名是运行时动态发现的，无法预先写进静态规则表；
//   - 用户对“这个 MCP 工具可以，不要再问我”的决定，会按工具单独持久化到
//     ~/.x-code/mcp-permissions.json，与 shell 前缀类放行规则分开保存。
//
// 默认策略：每个 MCP 工具一开始都是 `ask`，除非用户明确选择“始终允许”。
// 这里不做基于名称的启发式判断，因为 MCP 工具差异太大，不能安全地按
// `list_` / `read_` / `search_` 这类命名风格来推断权限级别
// （有些 `list_*` 会修改数据，有些 `create_*` 反而什么都不做）。
import fs from 'node:fs/promises'
import path from 'node:path'

import { debugLog, userXcodeDir } from '../utils.js'

/** 返回 MCP 权限持久化文件路径。 */
function permissionsFile(): string {
  return path.join(userXcodeDir(), 'mcp-permissions.json')
}

interface StoreShape {
  alwaysAllow: string[] // 永久允许的 MCP 工具名列表
}

/** 内存中同时维护持久化结果和“仅本次会话有效”的允许集合。
 *  持久化集合会在首次检查时懒加载；会话集合在实例创建时为空，
 *  并且永远不会写入磁盘。 */
export class McpPermissionStore {
  private persisted: Set<string> | null = null
  private session = new Set<string>()

  /** 预加载磁盘上的权限文件。可选调用，不调用也会在首次检查时懒加载。 */
  async preload(): Promise<void> {
    await this.ensurePersistedLoaded()
  }

  /** 检查某个工具是否已经被用户批准。
   *  只要命中“本次会话允许”或“永久允许”之一，就返回 true。 */
  async isApproved(callableName: string): Promise<boolean> {
    if (this.session.has(callableName)) return true
    await this.ensurePersistedLoaded()
    return this.persisted!.has(callableName)
  }

  /** 将工具标记为“本次会话剩余时间内允许”，不会写入磁盘。 */
  approveForSession(callableName: string): void {
    this.session.add(callableName)
  }

  /** 将工具标记为永久允许，并写入磁盘。
   *  写入失败只记录日志，不向上抛错；最坏情况只是下次会话里用户要再点一次“始终允许”。 */
  async approvePermanently(callableName: string): Promise<void> {
    await this.ensurePersistedLoaded()
    if (this.persisted!.has(callableName)) return
    this.persisted!.add(callableName)
    // 同步加入会话集合，避免下一次调用正好撞上磁盘写入尚未完成的窗口。
    this.session.add(callableName)
    try {
      await this.writePersisted()
    } catch (err) {
      debugLog('mcp.perm-write-failed', String(err))
      // 尽力而为：即使落盘失败，也不要把内存里的许可删掉，
      // 因为用户已经明确同意，本次会话里仍应尊重这个决定。
    }
  }

  /** 确保持久化权限集合已完成加载。 */
  private async ensurePersistedLoaded(): Promise<void> {
    if (this.persisted !== null) return
    this.persisted = await readPersisted()
  }

  /** 将当前永久允许集合原子写回磁盘。 */
  private async writePersisted(): Promise<void> {
    if (!this.persisted) return
    await fs.mkdir(userXcodeDir(), { recursive: true })
    const tmp = permissionsFile() + '.tmp'
    const payload: StoreShape = { alwaysAllow: [...this.persisted].sort() }
    // 0600：仅当前用户可读。安全姿态与 mcp-auth.json 一致。
    // 需要注意 Windows 会忽略 mode 位，但文件位于 ~/.x-code 下，
    // 实际暴露面通常仍局限于同一用户身份下运行的其他程序。
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
    await fs.rename(tmp, permissionsFile())
  }
}

/** 读取已持久化的 MCP 权限集合，失败时退化为空集合。 */
async function readPersisted(): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(permissionsFile(), 'utf-8')
    const parsed = JSON.parse(raw) as StoreShape
    if (parsed && Array.isArray(parsed.alwaysAllow)) {
      return new Set(parsed.alwaysAllow.filter((s): s is string => typeof s === 'string'))
    }
  } catch {
    // 文件缺失或内容损坏时，从空白许可列表启动，整体退化为“全部询问”。
  }
  return new Set<string>()
}

/** 从现有 askPermission 回调的返回值中提取更结构化的权限决定。
 *  原回调只会返回 `yes` / `always` / `no` 三种字符串，这里映射成
 *  更适合 MCP 权限层消费的语义化结果。 */
export type McpPermissionDecision = 'allow-once' | 'allow-always' | 'deny'

/** 将权限弹窗返回值归类为 MCP 权限层内部使用的决策类型。 */
export function classifyDecision(raw: 'yes' | 'always' | 'no'): McpPermissionDecision {
  if (raw === 'always') return 'allow-always'
  if (raw === 'yes') return 'allow-once'
  return 'deny'
}
