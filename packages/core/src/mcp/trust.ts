// @x-code-cli/core — MCP 项目级信任闸门
//
// 一个被提交进 git 仓库的 `.x-code/config.json` 可以声明任意 `command`
// 形式的 MCP 服务。也就是说，用户只要克隆了一个恶意仓库并启动 CLI，
// 就可能在无感知的情况下执行其中声明的命令。
// 因此，在真正采纳项目级 mcpServers 配置前，我们要求用户基于项目绝对路径
// 明确给出一次信任确认。
//
// 持久化文件：~/.x-code/trusted-projects.json（权限 0600）
// 格式：{ trusted: [{ path: <absolute>, trustedAt: <ISO> }, ...] }
//
// 用户级配置（~/.x-code/config.json）不受这个闸门约束，
// 因为那本来就是用户自己写的，默认视为可信。
import fs from 'node:fs/promises'
import path from 'node:path'

import { userXcodeDir } from '../utils.js'

/** 返回项目级信任列表持久化文件路径。 */
function trustedFile(): string {
  return path.join(userXcodeDir(), 'trusted-projects.json')
}

interface TrustedEntry {
  path: string // 被信任项目的绝对路径
  trustedAt: string // 记录信任时间的 ISO 时间戳
}

interface TrustedStore {
  trusted: TrustedEntry[] // 已信任项目列表
}

export interface ServerPreviewConfig {
  command?: string // stdio 服务启动命令
  args?: string[] // stdio 服务命令参数
  url?: string // HTTP 服务地址
}

/** 规范化路径，保证跨平台比较稳定。
 *  会先转绝对路径并 resolve；Windows 上再额外转小写以适配不区分大小写的文件系统，
 *  macOS/Linux 则保留原始大小写。 */
function normalize(p: string): string {
  const resolved = path.resolve(p)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** 读取已持久化的项目可信列表，失败时退化为空列表。 */
async function readStore(): Promise<TrustedStore> {
  try {
    const raw = await fs.readFile(trustedFile(), 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as TrustedStore).trusted)) {
      return parsed as TrustedStore
    }
  } catch {
    // 文件不存在或内容损坏时，直接从空白状态开始。
  }
  return { trusted: [] }
}

/** 将项目可信列表原子写回磁盘。 */
async function writeStore(store: TrustedStore): Promise<void> {
  await fs.mkdir(userXcodeDir(), { recursive: true })
  // 原子写入：先写 tmp，再 rename。
  // 这样即使进程在中途被杀掉，也不会留下半截文件。
  // 虽然信任文件很小，但原则上我们不希望损坏的 JSON 让用户无法继续使用 MCP。
  const tmp = trustedFile() + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
  await fs.rename(tmp, trustedFile())
}

/** 检查给定项目路径是否已经被用户标记为可信。 */
export async function isProjectTrusted(projectPath: string): Promise<boolean> {
  const normalized = normalize(projectPath)
  const store = await readStore()
  return store.trusted.some((e) => normalize(e.path) === normalized)
}

/** 将给定项目路径加入可信列表。 */
export async function trustProject(projectPath: string): Promise<void> {
  const normalized = normalize(projectPath)
  const store = await readStore()
  if (store.trusted.some((e) => normalize(e.path) === normalized)) return
  store.trusted.push({ path: path.resolve(projectPath), trustedAt: new Date().toISOString() })
  await writeStore(store)
}

export type TrustChoice = 'trust' | 'skip' | 'exit'

/** 询问用户是否信任当前项目提供的 MCP 配置。
 *
 *  调用方会传入一个通用 askUser 回调（和 agent loop 里 askUser 工具调用使用的是同一套），
 *  这样信任提示可以与其他 UI 弹窗保持一致的交互样式。
 *  我们会把实际要执行的命令完整展示出来，方便用户自行审查。
 *
 *  返回值说明：
 *    `trust`：用户同意，调用方应继续执行 `trustProject(...)` 持久化
 *    `skip`：本次会话跳过项目级 MCP，仅加载用户级 mcpServers
 *    `exit`：调用方应直接退出 CLI */
export async function promptForTrust(
  projectPath: string,
  serverSummaries: Array<{ name: string; preview: string }>,
  askUser: (question: string, options: Array<{ label: string; description: string }>) => Promise<string>,
): Promise<TrustChoice> {
  const lines = serverSummaries.map((s) => `  • ${s.name}: ${s.preview}`).join('\n')
  const question =
    `当前项目想要加载 ${serverSummaries.length} 个 MCP 服务：\n` +
    lines +
    `\n\n这些命令会在你的机器上执行。只有在你信任这个项目时才应允许。`

  const answer = await askUser(question, [
    { label: '信任此项目', description: '记住这次选择，并加载该项目声明的 MCP 服务。' },
    { label: '跳过项目 MCP', description: '本次会话仅使用用户级 mcpServers，不会写入磁盘。' },
    { label: '退出 X-Code', description: '直接关闭 CLI，不加载任何 MCP 服务。' },
  ])

  const lower = answer.toLowerCase()
  if (answer.includes('信任') || lower.startsWith('trust')) return 'trust'
  if (answer.includes('退出') || lower.startsWith('exit')) return 'exit'
  return 'skip'
}

/** 构造信任弹窗里每个服务对应的一行预览文本。
 *  stdio 服务展示完整命令与参数，HTTP 服务展示 URL。
 *  这里故意不做截断，因为用户需要看到完整信息才能做出可信判断。 */
export function buildServerPreview(config: ServerPreviewConfig): string {
  if (config.url) return config.url
  if (config.command) {
    const parts = [config.command, ...(config.args ?? [])]
    return parts.join(' ')
  }
  return '（无效配置）'
}
