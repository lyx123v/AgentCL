// @x-code-cli/core — 共享工具函数与常量
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** 项目内本地配置目录名。 */
export const XCODE_DIR = '.x-code'

/** 用户级配置目录（`~/.x-code`）。
 *  这个值在模块加载时就固定下来了；如果你希望应用 `X_CODE_HOME`
 *  覆盖逻辑，请改用 {@link userXcodeDir}。 */
export const USER_XCODE_DIR = path.join(os.homedir(), '.x-code')

/** 在调用时解析用户级配置根目录，并尊重 `X_CODE_HOME`。
 *  代码库里凡是需要拼接 `~/.x-code/` 下路径的地方，都应该优先用它，
 *  这样只靠一个环境变量就能在沙箱测试或用户隔离场景里整体改道。
 *  如果没有覆盖值，就回退到已冻结的 {@link USER_XCODE_DIR}，
 *  保持常规路径零额外分配。 */
export function userXcodeDir(): string {
  return process.env.X_CODE_HOME ?? USER_XCODE_DIR
}

// ── 调试日志（core + cli 共用）──────────────────────────────────────
// 通过 `DEBUG_STDOUT=1` 开启。日志写入 `~/.x-code/logs/debug.log`，
// 这样全局安装的 CLI 不会污染用户项目目录，而且无论从哪个 cwd 启动，
// 都会汇总到同一个便于 `grep` 的文件里。
//
// 这里故意使用同步 I/O：调用点都在热点路径上（每个流分片、每次工具调用），
// 我们希望落盘顺序和真实事件顺序严格一致；异步队列在背压下可能改变顺序。
//
// 性能方面：整个进程生命周期只维持一个打开的文件描述符
//（`writeSync` 大约 10μs），而不是每次都 `appendFileSync`
//（单次大约 100μs，包含打开、写入、关闭）。轮转时再关闭并重开。
// 进程退出时 fd 会交给内核回收，所以不用显式清理。
//
// 限制单行大小：如果读取了大文件，一个 `stream.tool-result`
// 单条日志就可能吃掉几十 KB，很快把预算耗尽。这里对每一条记录强制应用
// `MAX_LINE_BYTES` 上限，这样即使输出很“话痨”，每 MB 也至少还能保留
// 约 250 行可检索上下文。
//
// 轮转策略：双文件方案（`debug.log` + `debug.log.1`）。
// 当前文件达到 `MAX_LOG_BYTES` 时，把它重命名为 `.1` 并重新开始写，
// 从而把总磁盘占用限制在约 `2 × MAX_LOG_BYTES`。这和 pip / Cargo /
// npm 处理小规模缓存日志的思路类似，简单到不需要额外 logrotate 任务。
const DEBUG = process.env.DEBUG_STDOUT === '1'
/** 单文件大小上限。
 *  总磁盘占用约等于它的 2 倍（当前文件 + 轮转文件）。
 *  这里选 10MB，是因为典型多轮 agent 运行（约 85KB/轮 × 50–100 轮）
 *  大多能完整落在当前文件中，日常排查时 `grep` / `tail` 不必跨轮转文件。
 *  两个文件加起来的 20MB 也仍然适合直接附到 bug 报告里。 */
const MAX_LOG_BYTES = 10 * 1024 * 1024
/** 单条日志的截断上限。
 *  用来限制最坏情况下的单行体积，否则一个超大的 tool-result
 *  可能几条就把整个预算吃光。1KB 的上限让单文件最差也能保留约 5k 行
 * （轮转后约 10k 行），同时依然能完整容纳短栈追踪和小型 payload。
 *  典型日志行通常不到 200 字节，所以真实可容纳行数一般会到几万。 */
const MAX_LINE_BYTES = 1024

const LOG_DIR = path.join(USER_XCODE_DIR, 'logs')
const LOG_FILE = path.join(LOG_DIR, 'debug.log')
const LOG_FILE_OLD = path.join(LOG_DIR, 'debug.log.1')

/** 当前活动日志文件的内存字节计数器。
 *  这样 `debugLog` 走热点路径时不需要每次都 `statSync`，
 *  只在初始化或轮转时访问磁盘。 */
let currentLogBytes = -1
let logFd: number | null = null

/** 确保日志目录、文件描述符和当前文件大小计数都已准备好。 */
function ensureLogReady(): void {
  if (logFd !== null) return
  fsSync.mkdirSync(LOG_DIR, { recursive: true })
  if (currentLogBytes < 0) {
    try {
      currentLogBytes = fsSync.statSync(LOG_FILE).size
    } catch {
      // 文件尚不存在，`open()` 使用 `a` 模式时会自动创建。
      currentLogBytes = 0
    }
  }
  logFd = fsSync.openSync(LOG_FILE, 'a')
}

/** 在写入前判断是否需要进行日志轮转。 */
function rotateIfNeeded(nextWriteBytes: number): void {
  if (currentLogBytes + nextWriteBytes < MAX_LOG_BYTES) return
  try {
    if (logFd !== null) {
      fsSync.closeSync(logFd)
      logFd = null
    }
    // POSIX 下 rename 会静默覆盖旧的 `.1`；Windows 下如果目标存在则会失败，
    // 所以先 unlink。若 `.1` 不存在也没关系，说明之前还没轮转过。
    try {
      fsSync.unlinkSync(LOG_FILE_OLD)
    } catch {
      /* 之前没有轮转文件，属于正常情况 */
    }
    fsSync.renameSync(LOG_FILE, LOG_FILE_OLD)
    // rename 成功后，旧活动文件已经被移走；新的活动文件会在 ensureLogReady()
    // 中重新创建并以 0 字节重新计数。
    currentLogBytes = 0
  } catch {
    // 轮转失败时（例如 Windows 文件被占用、磁盘满、权限不足），
    // 活动文件仍然以旧大小留在磁盘上。如果这里强行把
    // `currentLogBytes = 0`，内存计数就会和真实文件大小脱节，
    // 导致下次要等再写入一个完整的 `MAX_LOG_BYTES` 才会再次尝试轮转，
    // 文件体积可能冲到上限的近 2 倍。这里改回 `-1` 哨兵值，
    // 让 `ensureLogReady()` 下次重新 `stat`，恢复准确计数。
    currentLogBytes = -1
  }
}

/** 把字符串 `s` 截断到最多 `maxBytes` 个 UTF-8 字节，并附带一个标记，
 *  说明丢弃了多少字节。前面的 `length * 4` 是廉价上界判断，
 *  能让最常见的 ASCII 场景（大多数调试内容）快速返回，
 *  避免每一行都调用 `Buffer.byteLength`。
 *
 *  这里按“字节”而不是 JS 字符数截断：`s.slice(0, n)` 处理的是 UTF-16
 *  代码单元，对中日韩文字和 emoji 会严重低估真实 UTF-8 大小，
 *  返回内容可能超出预期 3 到 4 倍，最终突破 `MAX_LINE_BYTES`。
 *  所以这里会先编码为字节流，再按字节切片，最后重新解码。
 *  如果恰好切在一个多字节字符中间，`TextDecoder` 会把残缺尾部处理成 U+FFFD，
 *  而这个占位符会被后面的截断标记自然覆盖语义。 */
export function truncateForLog(s: string, maxBytes: number): string {
  if (s.length * 4 <= maxBytes) return s
  const buf = Buffer.from(s, 'utf8')
  if (buf.length <= maxBytes) return s
  const sliceLen = Math.max(0, maxBytes - 64)
  const truncated = new TextDecoder('utf-8').decode(buf.subarray(0, sliceLen))
  const droppedBytes = buf.length - sliceLen
  return `${truncated}…<+${droppedBytes}b truncated>`
}

/** 一个更窄的调试开关：当 CLI 通过 `--plugin-debug`（或
 *  `XC_PLUGIN_DEBUG=1`）开启后，`debugLog` 会把带有插件相关前缀的日志
 *  同步镜像到 stderr。这样用户无需打开 `DEBUG_STDOUT=1` 的全量洪流，
 *  也能实时看到 plugin / hook / marketplace 活动。
 *  这里把它保存在模块状态中，而不是塞进 `debugLog` 参数，
 *  是为了不去改动现有调用点。 */
let pluginDebugMirror = false
const PLUGIN_DEBUG_TAG_PREFIXES = ['plugins.', 'plugin.', 'hooks.', 'marketplace.']

/** 控制是否把插件相关调试日志镜像输出到 stderr。 */
export function setPluginDebugMirror(enabled: boolean): void {
  pluginDebugMirror = enabled
}

/** 判断一个日志标签是否属于插件相关分类。 */
function isPluginRelatedTag(tag: string): boolean {
  for (const p of PLUGIN_DEBUG_TAG_PREFIXES) {
    if (tag.startsWith(p)) return true
  }
  return false
}

/** 写入调试日志，并在需要时把插件相关日志镜像到 stderr。 */
export function debugLog(tag: string, content: string): void {
  const mirrorToStderr = pluginDebugMirror && isPluginRelatedTag(tag)
  if (!DEBUG && !mirrorToStderr) return
  try {
    const safeContent = truncateForLog(content, MAX_LINE_BYTES)
    const ts = new Date().toISOString()
    // `JSON.stringify(content)` 会把换行和制表符转义掉，
    // 这样整段 payload 会稳定地落在同一行里，更方便跨轮次 `grep`，
    // 也避免多行文本和相邻日志在视觉上粘连。
    const line = `[${ts}] ${tag} ${JSON.stringify(safeContent)}\n`
    if (DEBUG) {
      const bytes = Buffer.byteLength(line, 'utf8')
      rotateIfNeeded(bytes)
      ensureLogReady()
      if (logFd !== null) {
        fsSync.writeSync(logFd, line)
        currentLogBytes += bytes
      }
    }
    if (mirrorToStderr) {
      // 直接写入原始 fd，绕过 Node stderr stream 的缓冲，
      // 这样即便 agent loop 正忙，每行日志也能立刻显示出来。
      try {
        fsSync.writeSync(2, line)
      } catch {
        // stderr 镜像失败不应该让 agent 崩掉
      }
    }
  } catch {
    // 尽力而为即可，绝不能因为写日志失败而让 agent 崩溃
  }
}

/** 检查指定文件是否存在。 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

/** 安全读取文件内容；如果失败则返回空字符串。 */
export async function readFileSafe(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch {
    return ''
  }
}

/** 安全读取并解析 JSON 文件；如果失败则返回 `null`。 */
export async function readJsonSafe(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(content) as Record<string, unknown>
  } catch {
    return null
  }
}
