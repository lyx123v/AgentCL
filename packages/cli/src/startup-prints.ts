// @x-code-cli/cli - 启动阶段写到 stderr 的提示文案
// （无 API key、无 WebSearch、恢复会话提示、更新检查）。
// 这些内容从 index.ts 拆出来，是为了让主流程更像“编排逻辑”，
// 而不是被一大段 chalk 格式化文案淹没。
import { Chalk } from 'chalk'

import fs from 'node:fs'
import path from 'node:path'

import { PROVIDER_DETECTION_ORDER, PROVIDER_KEY_URLS, USER_XCODE_DIR } from '@x-code-cli/core'

import { getSessionExitInfo } from './app.js'
import { detectShell, formatPersistCommand } from './shell.js'
import type { ShellType } from './shell.js'
import { VERSION } from './version.js'

const chalk = new Chalk({ level: process.stderr.isTTY ? 3 : 0 })

export function printNoApiKeyMessage(): void {
  const code = (s: string) => chalk.cyan(s)
  const comment = (s: string) => chalk.gray(s)
  const envName = (s: string) => chalk.yellow(s)

  console.error(chalk.red.bold('Error: No API key found.') + '\n')
  console.error('请至少通过环境变量配置一个提供方的 API key：\n')
  for (const { envKey } of PROVIDER_DETECTION_ORDER) {
    const provider = envKey
      .replace(/_API_KEY$/, '')
      .replace('GOOGLE_GENERATIVE_AI', 'google')
      .replace('MOONSHOT', 'moonshotai')
      .toLowerCase()
    const url = PROVIDER_KEY_URLS[provider] ?? ''
    console.error(`  ${envName(envKey.padEnd(32))} ${chalk.dim(url)}`)
  }
  console.error(
    `\n  ${envName('OPENAI_COMPATIBLE_API_KEY'.padEnd(32))} ${chalk.dim('(自定义 OpenAI 兼容端点)')}`,
  )

  const shell = detectShell()
  const restartHint: Record<ShellType, string> = {
    powershell: '# restart PowerShell, then run:',
    cmd: ':: restart CMD, then run:',
    zsh: '',
    bash: '',
    fish: '',
    sh: '',
  }
  console.error(`\n检测到的 shell：${chalk.bold(shell)}`)
  console.error('把它持久化后，就不用每次新开会话都重新设置了：\n')
  console.error(`  ${code(formatPersistCommand('ANTHROPIC_API_KEY', 'sk-ant-...', shell))}`)
  const hint = restartHint[shell]
  if (hint) console.error(`  ${comment(hint)}  ${code('xc')}`)
  console.error(`\n你也可以把 key 写到项目本地的 ${chalk.bold('.env')} 文件里（会从当前目录一路向上查找）。`)
}

export function printNoWebSearchKeyHint(): void {
  const shell = detectShell()
  const yellow = chalk.yellow
  const bold = chalk.bold
  const dim = chalk.gray
  const code = chalk.cyan

  console.error(yellow('提示：') + ' WebSearch 已禁用，因为没有配置搜索 API key。')
  console.error(dim('  （WebFetch 仍然可以不用 key；这里的提示只针对网页搜索。）'))
  console.error('  二选一即可（都免费，只需要注册）：')
  console.error(`    ${bold('TAVILY_API_KEY')}  ${dim('1000/month — https://tavily.com')}`)
  console.error(`    ${bold('BRAVE_API_KEY')}   ${dim('2000/month — https://api.search.brave.com')}`)

  const cmd = formatPersistCommand('TAVILY_API_KEY', 'tvly-...', shell)
  console.error(`  ${dim(`(${shell})`)}  ${code(cmd)}\n`)
}

/** 在 Ink 卸载并且终端已恢复后，打印一条可复制的恢复提示。
 *  这会尽量对齐 Claude Code 的退出体验：用户关掉会话后，
 *  能立刻看到怎么回到同一条线程。
 *  有 slug 时优先用 `slug-sessionId` 形式，因为在 `ls` 输出里更好扫一眼；
 *  没有 slug 的会话则退回纯 sessionId，常见于首条消息是纯 CJK 的场景。
 *
 *  如果会话还没有任何消息（只是启动了但没提交），则不打印，
 *  因为那样会指向一个空的 jsonl 文件。 */
export function printResumeHint(): void {
  const info = getSessionExitInfo()
  if (!info) return
  const key = info.taskSlug ? `${info.taskSlug}-${info.sessionId}` : info.sessionId
  const cmd = chalk.cyan(`xc --resume ${key}`)
  const dim = chalk.gray
  process.stdout.write(`${dim('恢复当前会话：')} ${cmd}\n`)
}

// ── Startup update check ────────────────────────────────────────────────

const UPDATE_CHECK_CACHE = path.join(USER_XCODE_DIR, 'cache', 'update-check.json')
const ONE_DAY_MS = 24 * 60 * 60 * 1000
const NPM_REGISTRY_URL = 'https://registry.npmjs.org/@x-code-cli/cli/latest'

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** 后台式更新检查。
 *  会查询 npm registry，并结合 24 小时磁盘缓存判断是否有新版本；
 *  如果发现更新，只打印一行提示到 stderr。
 *  这里绝不抛错，任何失败都会被静默吞掉，避免影响启动。 */
export async function checkForUpdate(): Promise<void> {
  if (!process.stderr.isTTY) return
  const current = VERSION
  if (current === '0.0.0-dev') return

  // 先查磁盘缓存，避免每次启动都打网络请求。
  try {
    const raw = fs.readFileSync(UPDATE_CHECK_CACHE, 'utf-8')
    const cache = JSON.parse(raw) as { checkedAt: number; latest: string }
    if (Date.now() - cache.checkedAt < ONE_DAY_MS) {
      if (compareVersions(cache.latest, current) > 0) {
        printUpdateHint(current, cache.latest)
      }
      return
    }
  } catch {
    // 缓存不存在或已损坏，直接走网络检查。
  }

  // 从 npm 拉取最新版本。
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3000)
  try {
    const res = await fetch(NPM_REGISTRY_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return
    const data = (await res.json()) as { version?: string }
    const latest = data.version
    if (!latest) return

    // 写回缓存，供下次启动复用。
    fs.mkdirSync(path.dirname(UPDATE_CHECK_CACHE), { recursive: true })
    fs.writeFileSync(UPDATE_CHECK_CACHE, JSON.stringify({ checkedAt: Date.now(), latest }), 'utf-8')

    if (compareVersions(latest, current) > 0) {
      printUpdateHint(current, latest)
    }
  } finally {
    clearTimeout(timeout)
  }
}

function printUpdateHint(current: string, latest: string): void {
  console.error(
    chalk.yellow('Update available:') +
      ` ${chalk.gray(current)} → ${chalk.green(latest)}` +
      chalk.gray('  Run ') +
      chalk.cyan('pnpm add -g @x-code-cli/cli') +
      chalk.gray(' to update.'),
  )
}
