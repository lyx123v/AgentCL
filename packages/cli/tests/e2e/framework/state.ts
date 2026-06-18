// 持久化运行状态（已被 gitignore 忽略），用于让 `--resume` 跳过已通过的场景。
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { RunState, ScenarioResult } from './types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 状态文件与 scenarios/ 目录相邻，位于当前文件的上一级目录中。
const STATE_DIR = path.resolve(__dirname, '..', '.state')
const STATE_FILE = path.join(STATE_DIR, 'last-run.json')

// 读取上一次运行保存的状态，如果不存在则返回 null。
export async function loadState(): Promise<RunState | null> {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf-8')
    return JSON.parse(raw) as RunState
  } catch {
    return null
  }
}

// 将当前运行状态写回磁盘，供下次继续执行时复用。
export async function saveState(state: RunState): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true })
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf-8')
}

// 更新单个场景结果，并立即持久化整个状态。
export async function updateScenarioResult(state: RunState, result: ScenarioResult): Promise<void> {
  state.results[result.id] = result
  await saveState(state)
}

// 返回所有失败场景的 ID 列表。
export function failedIds(state: RunState): string[] {
  return Object.values(state.results)
    .filter((r) => r.status === 'failed')
    .map((r) => r.id)
}

// 返回所有通过场景的 ID 列表。
export function passedIds(state: RunState): string[] {
  return Object.values(state.results)
    .filter((r) => r.status === 'passed')
    .map((r) => r.id)
}

// 汇总当前状态中的通过、失败、跳过和总数统计。
export function summarize(state: RunState): { passed: number; failed: number; skipped: number; total: number } {
  let passed = 0,
    failed = 0,
    skipped = 0
  for (const r of Object.values(state.results)) {
    if (r.status === 'passed') passed++
    else if (r.status === 'failed') failed++
    else skipped++
  }
  return { passed, failed, skipped, total: passed + failed + skipped }
}
