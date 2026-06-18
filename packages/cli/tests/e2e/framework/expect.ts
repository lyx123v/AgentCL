// 通过 ctx.expect 暴露的断言辅助方法。
import fs from 'node:fs/promises'
import path from 'node:path'

import { ScenarioAssertionError } from './types.js'
import type { RunResult, ScenarioExpect, ToolCall } from './types.js'

// 递归匹配实际值与断言条件，支持正则、函数和局部对象匹配。
function valueMatches(actual: unknown, matcher: unknown | RegExp | ((v: unknown) => boolean)): boolean {
  if (matcher instanceof RegExp) {
    if (typeof actual !== 'string') return false
    return matcher.test(actual)
  }
  if (typeof matcher === 'function') {
    return Boolean((matcher as (v: unknown) => boolean)(actual))
  }
  if (matcher && typeof matcher === 'object' && actual && typeof actual === 'object') {
    for (const [k, v] of Object.entries(matcher as Record<string, unknown>)) {
      if (!valueMatches((actual as Record<string, unknown>)[k], v)) return false
    }
    return true
  }
  return actual === matcher
}

// 将工具输入格式化成便于报错展示的短字符串。
function fmtInput(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input).slice(0, 200)
  } catch {
    return String(input)
  }
}

// 为场景上下文创建一组统一的断言方法。
export function makeExpect(tmpDir: string): ScenarioExpect {
  return {
    // 断言某个工具至少被调用过一次，并可继续匹配输入参数。
    toolCalled(result: RunResult, toolName: string, inputMatcher) {
      const candidates = result.toolCalls.filter((tc) => tc.toolName === toolName)
      if (candidates.length === 0) {
        const all = result.toolCalls.map((tc) => tc.toolName).join(', ') || '无'
        throw new ScenarioAssertionError(`期望工具 '${toolName}' 被调用，但实际得到: [${all}]`)
      }
      if (!inputMatcher) return candidates[0]!
      for (const c of candidates) {
        if (valueMatches(c.input, inputMatcher)) return c
      }
      const dump = candidates.map((c) => `\n    ${fmtInput(c.input)}`).join('')
      throw new ScenarioAssertionError(
        `工具 '${toolName}' 已被调用，但没有任何一次调用匹配 ${JSON.stringify(inputMatcher)}；实际看到:${dump}`,
      )
    },

    // 断言某个工具没有被调用。
    toolNotCalled(result: RunResult, toolName: string) {
      const hit = result.toolCalls.find((tc) => tc.toolName === toolName)
      if (hit) {
        throw new ScenarioAssertionError(`期望 '${toolName}' 不被调用，但实际输入为: ${fmtInput(hit.input)}`)
      }
    },

    // 断言助手输出中包含指定文本或匹配指定正则。
    assistantMentions(result: RunResult, needle: string | RegExp) {
      const text = result.assistantText
      const ok = needle instanceof RegExp ? needle.test(text) : text.includes(needle)
      if (!ok) {
        const head = text.slice(0, 400)
        throw new ScenarioAssertionError(`助手输出未匹配 ${needle}；实际内容（前 400 个字符）为:\n    ${head}`)
      }
    },

    // 断言 CLI 进程的退出码符合预期。
    exitCode(result: RunResult, code: number) {
      if (result.exitCode !== code) {
        throw new ScenarioAssertionError(
          `期望退出码为 ${code}，实际为 ${result.exitCode}；stderr 末尾内容:\n    ${result.stderr.slice(-400)}`,
        )
      }
    },

    // 断言临时目录中的文件存在。
    async fileExists(relPath: string) {
      const abs = path.join(tmpDir, relPath)
      try {
        await fs.access(abs)
      } catch {
        throw new ScenarioAssertionError(`期望文件 '${relPath}' 存在（检查路径: ${abs}）`)
      }
    },

    // 断言文件内容包含指定文本或匹配指定正则。
    async fileContent(relPath: string, matcher: string | RegExp) {
      const abs = path.join(tmpDir, relPath)
      let content: string
      try {
        content = await fs.readFile(abs, 'utf-8')
      } catch {
        throw new ScenarioAssertionError(`期望文件 '${relPath}' 存在（检查路径: ${abs}）`)
      }
      const ok = matcher instanceof RegExp ? matcher.test(content) : content.includes(matcher)
      if (!ok) {
        throw new ScenarioAssertionError(
          `文件 '${relPath}' 的内容未匹配 ${matcher}；实际内容为:\n    ${content.slice(0, 400)}`,
        )
      }
    },

    // 断言所有工具调用都没有错误结果。
    noToolErrors(result: RunResult) {
      const errs = result.toolCalls.filter((tc) => tc.isError)
      if (errs.length > 0) {
        const dump = errs.map((tc) => `  - ${tc.toolName}: ${(tc.resultText ?? '').slice(0, 200)}`).join('\n')
        throw new ScenarioAssertionError(`期望不存在工具错误，但实际得到:\n${dump}`)
      }
    },

    // 通用真值断言，便于在场景中表达自定义检查。
    truthy(condition: unknown, message: string) {
      if (!condition) throw new ScenarioAssertionError(message)
    },
  } satisfies ScenarioExpect & {
    toolCalled: (result: RunResult, name: string, matcher?: Record<string, unknown>) => ToolCall
  }
}
