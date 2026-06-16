// @x-code-cli/cli — 输入历史（上下键回忆）存储层。
//
// 持久化格式：`.x-code/history.jsonl`，一行一个 JSON 对象，只追加不修改。
// 这是按项目隔离的，所以两个不同项目不会互相污染历史记录，也和我们现有
// 的 `.x-code/sessions/`、`.x-code/plans/`、`.x-code/memory/` 约定一致。
//
// Claude Code 用的是一个全局文件，再用 `project:` 字段区分项目；这里我们
// 选择更简单的“每项目一个文件”，原因有两个：
// 1. 不需要处理跨进程 flush 队列和 lockfile 的复杂协调；
// 2. 体验上也更贴近 `.x-code/` 的其它内容，都是 gitignored、项目范围内、
//    跟着项目一起丢弃的临时数据。
//
// 读取时我们直接把整个文件读进来，再只保留最后 HISTORY_MAX 条。
// 由于这个文件天然很小（每次提交一行，而且是项目范围内），这里没必要
// 上流式反向读取；只有当真实用户把单项目文件撑到几 MB 以上时，再考虑
// 像 Claude Code 的 `readLinesReverse` 那样做流式优化。
//
// 写入采用“尽力而为”的 `fs.appendFile`。POSIX 保证不超过 PIPE_BUF
//（4096 字节）的追加是原子的，Windows 的追加句柄（`O_APPEND` →
// FILE_APPEND_DATA）也会按单次写调用保持原子性，而单行历史记录远小于这个
// 上限。所以这里刻意不加 lockfile：按项目隔离 + 罕见的并发 xc 实例 + 每次
// 原子追加，已经足够，lockfile 的成本反而更高。
import fs from 'node:fs/promises'
import path from 'node:path'

import type { PastedContents } from './paste-refs.js'

const HISTORY_FILE = '.x-code/history.jsonl'

/** 对齐 Claude Code 的 `MAX_HISTORY_ITEMS`。这里只限制“读取侧”：
 *  磁盘上的文件可以持续增长，但用户按上键时只会看到最近 100 条。
 *  超出的部分只在内存里切掉，不会回写裁剪磁盘文件。 */
export const HISTORY_MAX = 100

export interface InputHistoryEntry {
  /** 这里保存的是“展开前”的文本，也就是仍保留 `[Pasted text #N]`
   *  占位符的形态。回放历史时保留这种形式，可以让输入框保持紧凑，
   *  而不是把整个大段粘贴内容重新摊回可编辑区域。 */
  text: string
  pasted: PastedContents
  ts: number
}

function historyPath(cwd: string): string {
  return path.join(cwd, HISTORY_FILE)
}

/** 读取最近的 HISTORY_MAX 条记录。
 *  返回顺序是“最旧在前”，这样调用方可以继续把新提交 `push` 到尾部，
 *  也可以用 `arr[arr.length - 1 - i]` 这种方式倒着回看，和内存里的
 *  `historyRef` 结构保持一致。 */
export async function loadInputHistory(cwd: string = process.cwd()): Promise<InputHistoryEntry[]> {
  let raw: string
  try {
    raw = await fs.readFile(historyPath(cwd), 'utf-8')
  } catch {
    // 首次运行时常见的是 ENOENT，表示历史文件还不存在，直接视为空历史。
    // 其它错误也一律降级为空历史：输入历史只是体验加成，不能阻塞启动。
    return []
  }
  // 末尾换行是正常情况（每次追加都会以 `\n` 结尾）；这里顺手把空行和
  // 可能由半写入留下的脏行过滤掉。
  const lines = raw.split('\n').filter((l) => l.length > 0)
  const tail = lines.length > HISTORY_MAX ? lines.slice(lines.length - HISTORY_MAX) : lines
  const out: InputHistoryEntry[] = []
  for (const line of tail) {
    try {
      const parsed = JSON.parse(line) as Partial<InputHistoryEntry>
      if (typeof parsed.text !== 'string' || !parsed.text) continue
      out.push({
        text: parsed.text,
        pasted: (parsed.pasted as PastedContents | undefined) ?? {},
        ts: typeof parsed.ts === 'number' ? parsed.ts : 0,
      })
    } catch {
      // 单行损坏（写入中断、手工编辑、半截落盘）。直接跳过，
      // 宁可丢一条记录，也不要让启动流程被这类脏数据拖死。
    }
  }
  return out
}

/** 追加一条历史记录。
 *  这里是“尽力写入”模式：函数返回 promise 方便测试等待，但调用方可以忽略。
 *  任何写入错误都吞掉，因为输入历史只是体验优化，不是系统关键路径；
 *  比起在用户输入过程中直接报错，丢一条历史记录要更可接受。 */
export async function appendInputHistory(entry: InputHistoryEntry, cwd: string = process.cwd()): Promise<void> {
  const file = historyPath(cwd)
  const line = JSON.stringify(entry) + '\n'
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.appendFile(file, line, { encoding: 'utf-8' })
  } catch {
    /* 尽力而为 */
  }
}
