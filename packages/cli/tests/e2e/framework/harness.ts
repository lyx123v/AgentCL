// 测试驱动器：以 print 模式启动 `xc -p`，并解析生成的 session jsonl。
//
// 之所以解析 jsonl 而不是 stdout，是因为 print 模式下 stdout 只包含模型
// 最终输出的助手文本，不带结构化的工具调用标记。session jsonl 则保留了
// 每一次 assistant tool-call 和 tool-result 事件，格式更适合测试解析，
// 也不会随着 UI 变化而失效。见 packages/core/src/agent/session-store.ts。
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { RunCliOptions, RunResult, ToolCall } from './types.js'

export interface HarnessConfig {
  cliBin: string
  modelId: string
  defaultTimeoutMs: number
}

// 在指定目录中运行 CLI，并尽量还原一次场景执行的结构化结果。
export async function runCliInDir(
  cwd: string,
  prompt: string,
  cfg: HarnessConfig,
  options?: RunCliOptions,
): Promise<RunResult> {
  const args = ['-p', prompt, ...(options?.args ?? [])]
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    X_CODE_HOME: path.join(cwd, '.x-code-home'), // 为每个场景隔离用户级 ~/.x-code 数据
    X_CODE_MODEL: cfg.modelId,
    NODE_ENV: 'test',
    NO_COLOR: '1',
    ...(options?.env ?? {}),
  }
  const startedAt = Date.now()

  const child = spawn(process.execPath, [cfg.cliBin, ...args], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (b: Buffer) => {
    stdout += b.toString('utf-8')
  })
  child.stderr.on('data', (b: Buffer) => {
    stderr += b.toString('utf-8')
  })

  const timeoutMs = options?.timeoutMs ?? cfg.defaultTimeoutMs
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
    setTimeout(() => child.kill('SIGKILL'), 5000).unref()
  }, timeoutMs)

  const exitCode: number = await new Promise<number>((resolve) => {
    child.on('close', (code) => resolve(code ?? -1))
  })
  clearTimeout(timer)

  if (timedOut) {
    stderr += `\n[harness] 运行超过 ${timeoutMs}ms，已终止进程`
  }

  // print.ts 使用 `saveSession().catch()` 触发后即忘的方式保存会话，然后直接 process.exit()。
  // 因此进程退出时，最后一次 jsonl 写入可能尚未真正落盘。这里轮询 sessions 目录，
  // 直到文件大小稳定下来（或最多等待 2 秒）。
  await waitForJsonlStable(path.join(cwd, '.x-code', 'sessions'))

  // 找出 cwd/.x-code/sessions/ 中最新生成的 session jsonl。
  const sessionJsonlPath = await pickLatestSessionJsonl(path.join(cwd, '.x-code', 'sessions'))
  const parsed = sessionJsonlPath
    ? await parseSessionJsonl(sessionJsonlPath)
    : { assistantText: '', toolCalls: [], tokenUsage: undefined as RunResult['tokenUsage'] }

  return {
    assistantText: parsed.assistantText || stdout, // 兜底时直接使用 stdout，它在 print 模式下就是助手文本
    toolCalls: parsed.toolCalls,
    stdout,
    stderr,
    exitCode,
    durationMs: Date.now() - startedAt,
    sessionJsonlPath: sessionJsonlPath ?? '',
    tokenUsage: parsed.tokenUsage,
  }
}

// 等待 session jsonl 文件写入稳定，避免读取到尚未写完的内容。
async function waitForJsonlStable(dir: string, maxWaitMs = 2000, pollMs = 100): Promise<void> {
  const deadline = Date.now() + maxWaitMs
  let lastSize = -1
  let stableTicks = 0
  while (Date.now() < deadline) {
    let size = 0
    try {
      const entries = await fs.readdir(dir)
      for (const name of entries) {
        if (!name.endsWith('.jsonl')) continue
        const s = await fs.stat(path.join(dir, name))
        size += s.size
      }
    } catch {
      // 目录可能还没创建出来，继续轮询即可。
    }
    if (size > 0 && size === lastSize) {
      stableTicks++
      if (stableTicks >= 2) return // 连续两次大小相同，近似视为约 200ms 内无写入
    } else {
      stableTicks = 0
      lastSize = size
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

// 选择目录中最近写入的 session jsonl 文件。
async function pickLatestSessionJsonl(dir: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(dir)
    const jsonls = entries.filter((e) => e.endsWith('.jsonl'))
    if (jsonls.length === 0) return null
    const stats = await Promise.all(
      jsonls.map(async (name) => {
        const full = path.join(dir, name)
        const s = await fs.stat(full)
        return { full, mtime: s.mtimeMs }
      }),
    )
    stats.sort((a, b) => b.mtime - a.mtime)
    return stats[0]!.full
  } catch {
    return null
  }
}

interface ParsedSession {
  assistantText: string
  toolCalls: ToolCall[]
  tokenUsage?: RunResult['tokenUsage']
}

// 解析 session jsonl，提取助手文本、工具调用和 token 使用信息。
async function parseSessionJsonl(filePath: string): Promise<ParsedSession> {
  const raw = await fs.readFile(filePath, 'utf-8')
  const lines = raw.split('\n').filter(Boolean)
  const assistantPieces: string[] = []
  const toolCalls: ToolCall[] = []
  const resultByCallId = new Map<string, { text: string; isError?: boolean }>()
  let tokenUsage: RunResult['tokenUsage'] | undefined

  for (const line of lines) {
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>

    if (e.t === 'meta' && e.kind === 'usage') {
      const usage = e.usage as Record<string, number> | undefined
      if (usage) {
        tokenUsage = {
          input: usage.inputTokens ?? 0,
          output: usage.outputTokens ?? 0,
          cacheRead: usage.cacheReadTokens ?? 0,
          cacheWrite: usage.cacheCreationTokens ?? 0,
        }
      }
      continue
    }

    if (e.t !== 'msg') continue
    const message = e.message as { role?: string; content?: unknown } | undefined
    if (!message) continue

    if (message.role === 'assistant') {
      // content 可能是纯字符串，也可能是由多个片段组成的数组。
      if (typeof message.content === 'string') {
        assistantPieces.push(message.content)
      } else if (Array.isArray(message.content)) {
        for (const part of message.content as Record<string, unknown>[]) {
          if (part.type === 'text' && typeof part.text === 'string') {
            assistantPieces.push(part.text)
          } else if (part.type === 'tool-call') {
            toolCalls.push({
              toolCallId: String(part.toolCallId ?? ''),
              toolName: String(part.toolName ?? ''),
              input: (part.input ?? {}) as Record<string, unknown>,
            })
          }
        }
      }
    } else if (message.role === 'tool' && Array.isArray(message.content)) {
      for (const part of message.content as Record<string, unknown>[]) {
        if (part.type !== 'tool-result') continue
        const callId = String(part.toolCallId ?? '')
        const output = part.output as Record<string, unknown> | undefined
        const text = extractToolResultText(output)
        const isError = (part as { isError?: boolean }).isError === true
        resultByCallId.set(callId, { text, isError })
      }
    }
  }

  // 将 tool-result 合并回对应的 tool-call 上，方便测试直接断言。
  for (const tc of toolCalls) {
    const r = resultByCallId.get(tc.toolCallId)
    if (r) {
      tc.resultText = r.text
      tc.isError = r.isError
    }
  }

  return {
    assistantText: assistantPieces.join('').trim(),
    toolCalls,
    tokenUsage,
  }
}

// 统一提取工具结果中的可读文本，兼容不同输出结构。
function extractToolResultText(output: Record<string, unknown> | undefined): string {
  if (!output) return ''
  // AI SDK v6 的 tool-result 输出结构：{ type: 'content', value: [{ type: 'text', text }, ...] }
  if (output.type === 'content' && Array.isArray(output.value)) {
    const pieces: string[] = []
    for (const part of output.value as Record<string, unknown>[]) {
      if (part.type === 'text' && typeof part.text === 'string') pieces.push(part.text)
    }
    return pieces.join('')
  }
  // 有些工具会直接返回 { type: 'text', value: '...' }。
  if (output.type === 'text' && typeof output.value === 'string') return output.value
  // 兜底：序列化整个对象，至少让测试还能基于文本做匹配。
  try {
    return JSON.stringify(output)
  } catch {
    return ''
  }
}
