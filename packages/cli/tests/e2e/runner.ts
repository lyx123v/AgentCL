#!/usr/bin/env tsx
// e2e 运行器入口，通过 `pnpm test:e2e` 调用。
//
// 运行模式（互斥；若都不传则走交互流程）：
//   --resume         仅重跑 last-run.json 中失败或未跑过的场景
//   --all            全量重跑所有场景
//   --filter <glob>  按场景 id 子串匹配（例如 --filter shell）
//   --list           仅列出场景和跳过状态后退出
//   --model <id>     跳过交互式模型选择，直接使用该模型 id（或别名）
//   --keep-tmp       即使成功也不删除临时目录（仅调试时使用）
//   --max-turns N    透传给 CLI
//   --print-jsonl    场景运行后打印对应 jsonl 路径
import * as p from '@clack/prompts'

import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { makeExpect } from './framework/expect.js'
import { runCliInDir } from './framework/harness.js'
import {
  DEFAULT_MODEL,
  availableModels,
  describeDetectedKeys,
  loadDotenv,
  resolveModelArg,
} from './framework/models.js'
import { failedIds, loadState, saveState, summarize, updateScenarioResult } from './framework/state.js'
import { ScenarioAssertionError } from './framework/types.js'
import type { RunCliOptions, RunState, Scenario, ScenarioContext, ScenarioResult } from './framework/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI_BIN = path.resolve(__dirname, '..', '..', 'dist', 'cli.js')
const SCENARIOS_DIR = path.resolve(__dirname, 'scenarios')
const DEFAULT_TIMEOUT_MS = 180_000

// 解析命令行参数，整理出运行器需要的开关配置。
function parseArgs(argv: string[]): {
  resume: boolean
  all: boolean
  filter?: string
  list: boolean
  model?: string
  keepTmp: boolean
  printJsonl: boolean
  maxTurns?: number
} {
  const out = { resume: false, all: false, list: false, keepTmp: false, printJsonl: false } as ReturnType<
    typeof parseArgs
  >
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--resume') out.resume = true
    else if (a === '--all') out.all = true
    else if (a === '--list') out.list = true
    else if (a === '--keep-tmp') out.keepTmp = true
    else if (a === '--print-jsonl') out.printJsonl = true
    else if (a === '--filter') out.filter = argv[++i]
    else if (a === '--model') out.model = argv[++i]
    else if (a === '--max-turns') out.maxTurns = Number(argv[++i])
    else if (a === '--help' || a === '-h') {
      printHelp()
      process.exit(0)
    } else {
      console.error(`Unknown arg: ${a}`)
      process.exit(2)
    }
  }
  return out
}

// 打印帮助信息，方便快速查看支持的运行参数。
function printHelp(): void {
  console.log(`X-Code CLI - e2e 测试运行器

用法：
  pnpm test:e2e [flags]

参数：
  --all                运行所有场景（跳过续跑逻辑）
  --resume             仅运行上次失败或跳过的场景
  --filter <substr>    仅运行 id 中包含该子串的场景
  --model <id|alias>   跳过选择提示，直接使用该模型（默认：${DEFAULT_MODEL}）
  --list               列出场景和上次运行状态后退出
  --keep-tmp           成功后也保留临时目录（失败本来就会保留）
  --print-jsonl        每个场景运行后打印 session jsonl 路径
  --max-turns N        将 --max-turns N 透传给 CLI

默认情况下（未提供模式参数）会进入交互流程，先选择模型，再选择运行范围。
`)
}

// 加载 `scenarios/` 目录下的所有场景模块，并按文件名顺序返回。
async function loadScenarios(): Promise<Scenario[]> {
  const entries = await fs.readdir(SCENARIOS_DIR)
  const tsFiles = entries.filter((e) => e.endsWith('.ts')).sort()
  const scenarios: Scenario[] = []
  for (const file of tsFiles) {
    const mod = (await import(pathToFileURL(path.join(SCENARIOS_DIR, file)).href)) as { default?: Scenario }
    if (mod.default && mod.default.id && typeof mod.default.run === 'function') {
      scenarios.push(mod.default)
    }
  }
  return scenarios
}

// 为单个场景创建独立临时目录，避免场景间互相污染。
async function setupTmpDir(scenarioId: string): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `xc-e2e-${scenarioId}-`))
  return tmp
}

// 尽力清理临时目录，清理失败时不影响主流程继续。
async function cleanupTmpDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true })
  } catch {
    // best-effort
  }
}

// 运行单个场景，构造上下文、收集结果，并在失败时保留调试线索。
async function runOne(
  scenario: Scenario,
  modelId: string,
  env: Record<string, string>,
  globalOpts: ReturnType<typeof parseArgs>,
): Promise<ScenarioResult> {
  if (scenario.requires && !scenario.requires(env)) {
    return {
      id: scenario.id,
      name: scenario.name,
      status: 'skipped',
      durationSec: 0,
      skipReason: scenario.requiresReason ?? 'prerequisite not met',
    }
  }

  const tmpDir = await setupTmpDir(scenario.id)
  const startedAt = Date.now()

  const ctx: ScenarioContext = {
    tmpDir,
    modelId,
    cliBin: CLI_BIN,
    env,
    writeFile: async (rel, content) => {
      const abs = path.join(tmpDir, rel)
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await fs.writeFile(abs, content, 'utf-8')
    },
    readFile: async (rel) => fs.readFile(path.join(tmpDir, rel), 'utf-8'),
    fileExists: async (rel) => {
      try {
        await fs.access(path.join(tmpDir, rel))
        return true
      } catch {
        return false
      }
    },
    mkdir: async (rel) => {
      await fs.mkdir(path.join(tmpDir, rel), { recursive: true })
    },
    runCli: (prompt, options?: RunCliOptions) =>
      runCliInDir(
        // Most scenarios run from tmpDir, but a few need a nested cwd to
        // exercise the AGENTS.md monorepo-chain walker.
        options?.cwd ?? tmpDir,
        prompt,
        {
          cliBin: CLI_BIN,
          modelId,
          defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
        },
        {
          ...options,
          args: [
            ...(globalOpts.maxTurns ? ['--max-turns', String(globalOpts.maxTurns)] : []),
            ...(options?.args ?? []),
          ],
        },
      ),
    expect: makeExpect(tmpDir),
  }

  let lastJsonl = ''
  const runCli = ctx.runCli
  ctx.runCli = async (prompt, options) => {
    const r = await runCli(prompt, options)
    if (r.sessionJsonlPath) lastJsonl = r.sessionJsonlPath
    return r
  }

  let result: ScenarioResult
  try {
    await scenario.run(ctx)
    result = {
      id: scenario.id,
      name: scenario.name,
      status: 'passed',
      durationSec: +((Date.now() - startedAt) / 1000).toFixed(2),
      lastSessionJsonl: lastJsonl,
    }
  } catch (err) {
    const msg = err instanceof ScenarioAssertionError ? err.message : err instanceof Error ? err.message : String(err)
    result = {
      id: scenario.id,
      name: scenario.name,
      status: 'failed',
      durationSec: +((Date.now() - startedAt) / 1000).toFixed(2),
      error: msg,
      lastSessionJsonl: lastJsonl,
      tmpDir,
    }
    if (lastJsonl) {
      // 把失败 jsonl 额外复制出来，避免用户重试时临时目录被删掉后无法排查。
      try {
        const stash = path.join(__dirname, '.state', `failed-${scenario.id}.jsonl`)
        await fs.mkdir(path.dirname(stash), { recursive: true })
        await fs.copyFile(lastJsonl, stash)
        result.lastSessionJsonl = stash
      } catch {}
    }
  }

  if (result.status === 'passed' && !globalOpts.keepTmp) {
    await cleanupTmpDir(tmpDir)
  }
  if (result.status === 'failed') {
    // 失败时显式回传 tmpDir，方便用户自行检查现场。
    result.tmpDir = tmpDir
  }
  return result
}

// 根据筛选条件与续跑状态，挑出本次真正需要执行的场景。
function pickScenarios(
  scenarios: Scenario[],
  filter: string | undefined,
  resume: boolean,
  state: RunState | null,
): Scenario[] {
  let chosen = scenarios
  if (filter) chosen = chosen.filter((s) => s.id.includes(filter) || s.name.includes(filter))
  if (resume && state) {
    const failed = new Set(failedIds(state))
    // 续跑模式 = 上次失败的场景，或者之前从未运行过的场景。
    chosen = chosen.filter((s) => failed.has(s.id) || !state.results[s.id])
  }
  return chosen
}

// 交互式选择模型，并把默认模型放在候选列表最前面。
async function interactiveSelectModel(env: Record<string, string>, defaultModel: string): Promise<string> {
  const opts = availableModels(env)
  if (opts.length === 0) {
    console.error('❌ 未在环境变量或 .env 中检测到 API Key。请设置 DEEPSEEK_API_KEY（或其他可用 key）后重试。')
    process.exit(1)
  }
  const detected = describeDetectedKeys(env)
  if (detected.length > 0) {
    console.log('已检测到以下 API Key：')
    for (const line of detected) console.log(line)
    console.log()
  }

  // 先构建选择项列表，并把默认模型放到最前面。
  const seen = new Set<string>()
  const items: { value: string; label: string; hint?: string }[] = []
  if (opts.some((o) => o.modelId === defaultModel)) {
    items.push({ value: defaultModel, label: defaultModel, hint: '默认' })
    seen.add(defaultModel)
  }
  for (const o of opts) {
    if (seen.has(o.modelId)) continue
    items.push({ value: o.modelId, label: o.modelId })
    seen.add(o.modelId)
  }

  const picked = await p.select({
    message: '请选择用于测试的模型',
    options: items,
    initialValue: items[0]?.value,
  })
  if (p.isCancel(picked)) {
    p.cancel('已取消。')
    process.exit(0)
  }
  return picked as string
}

// 根据上次运行结果，交互式选择全量运行还是仅续跑失败场景。
async function interactiveSelectMode(state: RunState | null): Promise<'all' | 'resume' | 'cancel'> {
  if (!state) return 'all'
  const sum = summarize(state)
  if (sum.failed === 0) {
    console.log(`上次运行结果：${sum.passed} 个通过，0 个失败，${sum.skipped} 个跳过，本次将重新全量执行。`)
    return 'all'
  }
  const picked = await p.select({
    message: `上次运行结果：${sum.passed} 个通过，${sum.failed} 个失败，${sum.skipped} 个跳过。接下来怎么跑？`,
    options: [
      { value: 'resume', label: `续跑失败场景（${sum.failed}）`, hint: '修完代码后推荐使用' },
      { value: 'all', label: `全量运行（${sum.total}）` },
      { value: 'cancel', label: '取消' },
    ],
    initialValue: 'resume',
  })
  if (p.isCancel(picked)) return 'cancel'
  return picked as 'all' | 'resume' | 'cancel'
}

// 统一格式化场景耗时，便于在终端中紧凑展示。
function fmtDuration(sec: number): string {
  return `${sec.toFixed(1)}s`
}

// 打印本轮执行摘要，并在失败时附上排查所需的关键信息。
function printSummary(results: ScenarioResult[]): void {
  console.log()
  console.log('─'.repeat(60))
  const pass = results.filter((r) => r.status === 'passed').length
  const fail = results.filter((r) => r.status === 'failed').length
  const skip = results.filter((r) => r.status === 'skipped').length
  console.log(`汇总：${pass} 个通过，${fail} 个失败，${skip} 个跳过（共 ${results.length} 个）`)

  const failed = results.filter((r) => r.status === 'failed')
  if (failed.length > 0) {
    console.log()
    console.log('失败场景：')
    for (const r of failed) {
      console.log(`  ✗ ${r.id} — ${r.name}`)
      console.log(`    错误：${r.error?.split('\n').slice(0, 3).join('\n           ') ?? '（无错误信息）'}`)
      if (r.tmpDir) console.log(`    临时目录：${r.tmpDir}`)
      if (r.lastSessionJsonl) console.log(`    jsonl:  ${r.lastSessionJsonl}`)
      console.log(`    重跑命令：pnpm test:e2e --filter ${r.id} --keep-tmp`)
    }
  }
  console.log()
}

// 主入口：解析参数、选择模型和范围，并按顺序执行选中的场景。
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (!existsSync(CLI_BIN)) {
    console.error(`❌ 未找到 CLI 二进制文件：${CLI_BIN}`)
    console.error('   请先执行 `pnpm build`。')
    process.exit(1)
  }

  // 加载环境变量（.env + process.env）。
  const env = await loadDotenv()
  const scenarios = await loadScenarios()

  // `--list` 模式只负责展示场景信息，不实际执行。
  if (args.list) {
    const state = await loadState()
    console.log(`共找到 ${scenarios.length} 个场景：`)
    for (const s of scenarios) {
      const last = state?.results[s.id]
      const status = last ? (last.status === 'passed' ? '✓' : last.status === 'failed' ? '✗' : '○') : '·'
      const skipNote = s.requires && !s.requires(env) ? ` [skipped: ${s.requiresReason}]` : ''
      console.log(`  ${status} ${s.id}  ${s.name}${skipNote}`)
    }
    return
  }

  // 确定本次使用的模型。
  let modelId: string
  if (args.model) {
    modelId = resolveModelArg(args.model)
  } else {
    const prevState = await loadState()
    const defaultModel = prevState?.model ?? DEFAULT_MODEL
    modelId = await interactiveSelectModel(env, defaultModel)
  }

  // 确定运行范围（续跑、全量或按过滤器执行）。
  const prevState = await loadState()
  let scope: 'all' | 'resume' | 'cancel'
  if (args.all) scope = 'all'
  else if (args.resume) scope = 'resume'
  else if (args.filter)
    scope = 'all' // 单独传 filter 时，表示“运行所有匹配项”。
  else scope = await interactiveSelectMode(prevState)
  if (scope === 'cancel') {
    console.log('已取消。')
    return
  }

  const chosen = pickScenarios(scenarios, args.filter, scope === 'resume', prevState)
  if (chosen.length === 0) {
    console.log('没有匹配到任何场景。')
    return
  }

  console.log(`\n▶ Model: ${modelId}`)
  console.log(
    `▶ Scope: ${scope === 'resume' ? `resume (${chosen.length} of ${scenarios.length})` : `all (${chosen.length})`}`,
  )
  if (args.filter) console.log(`▶ Filter: ${args.filter}`)
  console.log()

  // 准备运行状态：全量执行时从空状态开始，续跑时合并上次记录。
  const state: RunState =
    scope === 'all' || !prevState
      ? { model: modelId, startedAt: new Date().toISOString(), results: {} }
      : { model: modelId, startedAt: new Date().toISOString(), results: { ...prevState.results } }
  await saveState(state)

  const liveResults: ScenarioResult[] = []
  let counter = 0
  for (const scenario of chosen) {
    counter++
    const marker = `[${counter}/${chosen.length}]`
    process.stdout.write(`${marker} ${scenario.id} — ${scenario.name} ... `)
    const result = await runOne(scenario, modelId, env, args)
    liveResults.push(result)
    if (result.status === 'passed') {
      process.stdout.write(`✓ ${fmtDuration(result.durationSec)}\n`)
    } else if (result.status === 'skipped') {
      process.stdout.write(`○ skipped (${result.skipReason ?? 'n/a'})\n`)
    } else {
      process.stdout.write(`✗ ${fmtDuration(result.durationSec)}\n`)
      const errLine = (result.error ?? '').split('\n')[0]
      process.stdout.write(`    ${errLine}\n`)
    }
    if (args.printJsonl && result.lastSessionJsonl) {
      process.stdout.write(`    jsonl: ${result.lastSessionJsonl}\n`)
    }
    await updateScenarioResult(state, result)
  }

  printSummary(liveResults)

  const fail = liveResults.filter((r) => r.status === 'failed').length
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
