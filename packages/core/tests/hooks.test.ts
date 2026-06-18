// hooks 子系统测试，覆盖变量展开、配置 schema、注册表、事件总线，
// 以及执行器（通过真实 node 子进程可移植地验证 stdin/stdout 协议）。
import { describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  HookBus,
  HookConfigParseError,
  HookRegistry,
  aggregatePostToolUse,
  aggregatePreToolUse,
  aggregateUserPromptSubmit,
  buildHookRegistry,
  buildVariableContext,
  executeHook,
  expandVariables,
  parseHookConfig,
} from '../src/hooks/index.js'
import type { HookEvent, RegisteredHook } from '../src/hooks/index.js'

// ── 变量 ───────────────────────────────────────────────────────────

describe('expandVariables', () => {
  const ctx = buildVariableContext({ pluginDir: '/abs/plugin', cwd: '/abs/cwd' })

  it('会展开四个内建变量名', () => {
    expect(expandVariables('${pluginDir}/run', ctx)).toBe('/abs/plugin/run')
    expect(expandVariables('cd ${cwd}', ctx)).toBe('cd /abs/cwd')
    expect(expandVariables('home=${homedir}', ctx)).toContain('home=')
    expect(expandVariables('s${sep}', ctx)).toBe(`s${path.sep}`)
  })

  it('会从 process.env 读取 ${env:NAME}', () => {
    process.env.XC_HOOK_TEST_VAR = 'hello'
    try {
      expect(expandVariables('echo ${env:XC_HOOK_TEST_VAR}', ctx)).toBe('echo hello')
    } finally {
      delete process.env.XC_HOOK_TEST_VAR
    }
  })

  it('未知变量会原样保留，避免静默展开掩盖拼写错误', () => {
    expect(expandVariables('${nope}', ctx)).toBe('${nope}')
    expect(expandVariables('${unknown:foo}', ctx)).toBe('${unknown:foo}')
  })

  it('提供 pluginId 时，${pluginDataDir} 会展开并自动创建目录', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-data-ctx-'))
    const prev = process.env.XC_PLUGINS_DIR
    process.env.XC_PLUGINS_DIR = tmpHome
    try {
      const c = buildVariableContext({
        pluginDir: '/abs/plugin',
        cwd: '/abs/cwd',
        pluginId: 'demo@local',
      })
      const expanded = expandVariables('write ${pluginDataDir}/state.json', c)
      // 展开后的路径必须落在临时插件根目录下。
      expect(expanded.startsWith('write ')).toBe(true)
      const dataPath = expanded.slice('write '.length).replace(/\/state\.json$/, '')
      const stat = await fs.stat(dataPath)
      expect(stat.isDirectory()).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.XC_PLUGINS_DIR
      else process.env.XC_PLUGINS_DIR = prev
      await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('未提供 pluginId 时，${pluginDataDir} 会保持原样', () => {
    const c = buildVariableContext({ pluginDir: '/abs/plugin', cwd: '/abs/cwd' })
    expect(expandVariables('${pluginDataDir}/state', c)).toBe('${pluginDataDir}/state')
  })
})

// ── 配置结构 ──────────────────────────────────────────────────────

describe('parseHookConfig', () => {
  it('会剔除未知事件名，以支持前向兼容', () => {
    const c = parseHookConfig({ PreToolUse: [{ command: 'a' }], SomeFutureEvent: [{ command: 'b' }] }, 'demo')
    expect(c.PreToolUse).toBeDefined()
    expect((c as Record<string, unknown>).SomeFutureEvent).toBeUndefined()
  })

  it('缺少 command 的条目会被拒绝', () => {
    expect(() => parseHookConfig({ PreToolUse: [{ matcher: 'edit_file' }] }, 'demo')).toThrow(HookConfigParseError)
  })

  it('会把 timeout 上限限制在 30 秒内', () => {
    expect(() => parseHookConfig({ PreToolUse: [{ command: 'x', timeout: 60_000 }] }, 'demo')).toThrow(
      HookConfigParseError,
    )
  })

  it('支持 4 个新增事件名（PreCompact / PostCompact / SubagentStart / SubagentStop）', () => {
    const c = parseHookConfig(
      {
        PreCompact: [{ command: 'echo pre' }],
        PostCompact: [{ command: 'echo post' }],
        SubagentStart: [{ command: 'echo start' }],
        SubagentStop: [{ command: 'echo stop' }],
      },
      'demo',
    )
    expect(c.PreCompact?.[0]?.command).toBe('echo pre')
    expect(c.PostCompact?.[0]?.command).toBe('echo post')
    expect(c.SubagentStart?.[0]?.command).toBe('echo start')
    expect(c.SubagentStop?.[0]?.command).toBe('echo stop')
  })

  it('支持平台特定的命令覆盖字段', () => {
    const c = parseHookConfig(
      {
        PreToolUse: [
          {
            command: 'node script.js',
            commandWindows: 'node "script.js"',
            commandDarwin: 'node script.js',
            commandLinux: 'node script.js',
          },
        ],
      },
      'demo',
    )
    expect(c.PreToolUse?.[0]?.commandWindows).toBe('node "script.js"')
    expect(c.PreToolUse?.[0]?.commandDarwin).toBe('node script.js')
  })
})

// ── 注册表 ───────────────────────────────────────────────────────────

describe('buildHookRegistry', () => {
  it('会按注册顺序把 hook 分组到对应事件下', () => {
    const reg = buildHookRegistry([
      { pluginId: 'a@local', pluginDir: '/a', config: { PreToolUse: [{ command: 'a1' }, { command: 'a2' }] } },
      { pluginId: 'b@local', pluginDir: '/b', config: { PreToolUse: [{ command: 'b1' }] } },
    ])
    const list = reg.get('PreToolUse')
    expect(list.map((h) => h.entry.command)).toEqual(['a1', 'a2', 'b1'])
    expect(list.map((h) => h.pluginId)).toEqual(['a@local', 'a@local', 'b@local'])
  })
})

// ── 聚合器 ────────────────────────────────────────────────────────

describe('聚合辅助逻辑', () => {
  it('aggregatePreToolUse 会在第一个 deny 处停止', () => {
    const eff = aggregatePreToolUse([
      { decision: 'allow' },
      { decision: 'deny', reason: 'no' },
      { decision: 'modify', args: { x: 1 } }, // 会被忽略，因为它出现在 deny 之后。
    ])
    expect(eff.decision).toBe('deny')
    expect(eff.reason).toBe('no')
  })

  it('aggregatePreToolUse 会合并 modify args，后者覆盖前者', () => {
    const eff = aggregatePreToolUse([
      { decision: 'modify', args: { x: 1 } },
      { decision: 'modify', args: { x: 2, y: 3 } },
    ])
    expect(eff.decision).toBe('allow')
    expect(eff.args).toEqual({ x: 2, y: 3 })
  })

  it('aggregatePostToolUse 会采用最后一个 modify.output', () => {
    const eff = aggregatePostToolUse([
      { decision: 'modify', output: 'first' },
      { decision: 'modify', output: 'second' },
    ])
    expect(eff.output).toBe('second')
  })

  it('aggregateUserPromptSubmit 会拼接上下文内容', () => {
    const eff = aggregateUserPromptSubmit([
      { decision: 'allow', context: 'a' },
      { decision: 'modify', context: 'b' },
    ])
    expect(eff.decision).toBe('allow')
    expect(eff.context).toBe('a\n\nb')
  })

  it('aggregateUserPromptSubmit 遇到 deny 时会清空上下文', () => {
    const eff = aggregateUserPromptSubmit([
      { decision: 'allow', context: 'a' },
      { decision: 'deny', reason: 'sensitive' },
    ])
    expect(eff.decision).toBe('deny')
    expect(eff.context).toBe('')
  })
})

// ── 总线匹配器 ────────────────────────────────────────────────────────

describe('HookBus 匹配行为', () => {
  // 构造一个最小 RegisteredHook，方便验证 matcher 过滤行为。
  function makeHook(matcher: string | undefined, command = 'node -e "process.exit(0)"'): RegisteredHook {
    return {
      pluginId: 'demo@local',
      pluginDir: process.cwd(),
      event: 'PreToolUse',
      entry: { command, matcher },
    }
  }

  it('会按 matcher 正则过滤（仅限 PreToolUse）', async () => {
    // 这里在 bus 层验证 matcher 过滤行为。
    // 为了避免拉起复杂 shell 进程，命令统一使用立即 0 退出的形式，
    // 这样只要匹配到了，hook 就能稳定成功执行。
    const reg = new HookRegistry([makeHook('write_file', 'node -e "process.exit(0)"')])
    const bus = new HookBus(reg)

    // 不匹配时，decisions 应为空数组，也就是没有 hook 被执行。
    const noMatch = await bus.emit({
      name: 'PreToolUse',
      session: { cwd: process.cwd(), modelId: 'm' },
      tool: { name: 'edit_file', args: {}, callId: 'c1' },
    })
    expect(noMatch).toEqual([])

    // 匹配时，应执行一个 hook，因此会拿到一条 decision。
    const match = await bus.emit({
      name: 'PreToolUse',
      session: { cwd: process.cwd(), modelId: 'm' },
      tool: { name: 'write_file', args: {}, callId: 'c2' },
    })
    expect(match).toHaveLength(1)
    expect(match[0]!.decision).toBe('allow')
  }, 15_000)

  it('错误的正则 matcher 会退化为“全部匹配”，而不是直接失效', async () => {
    const reg = new HookRegistry([makeHook('(', 'node -e "process.exit(0)"')])
    const bus = new HookBus(reg)
    const decisions = await bus.emit({
      name: 'PreToolUse',
      session: { cwd: process.cwd(), modelId: 'm' },
      tool: { name: 'anything', args: {}, callId: 'c' },
    })
    expect(decisions).toHaveLength(1)
  }, 15_000)
})

// ── 执行器（真实子进程） ─────────────────────────────────────────

describe('executeHook（真实子进程）', () => {
  // 写入一个临时 hook 脚本文件，供 executeHook 真正启动执行。
  async function writeHookScript(contents: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-hook-script-'))
    const file = path.join(dir, 'hook.js')
    await fs.writeFile(file, contents, 'utf-8')
    return file
  }

  // 构造一个指向脚本文件的 RegisteredHook，并允许覆写部分 entry。
  function hookFor(file: string, overrides: Partial<RegisteredHook['entry']> = {}): RegisteredHook {
    return {
      pluginId: 'demo@local',
      pluginDir: process.cwd(),
      event: 'PreToolUse',
      entry: { command: `node "${file}"`, ...overrides },
    }
  }

  // 生成一份最小的 PreToolUse 事件，作为 hook 输入。
  function preEvent(): HookEvent {
    return {
      name: 'PreToolUse',
      session: { cwd: process.cwd(), modelId: 'm' },
      tool: { name: 'write_file', args: { path: 'a.txt' }, callId: 'c1' },
    }
  }

  it('会读取 stdin 事件 JSON，并从 stdout 解析返回 decision JSON', async () => {
    const script = await writeHookScript(`
      let data = ''
      process.stdin.on('data', (c) => { data += c })
      process.stdin.on('end', () => {
        const e = JSON.parse(data)
        if (e.tool && e.tool.name === 'write_file') {
          console.log(JSON.stringify({ decision: 'deny', reason: 'no writes today' }))
        } else {
          console.log(JSON.stringify({ decision: 'allow' }))
        }
      })
    `)
    const d = await executeHook(hookFor(script), preEvent())
    expect(d.decision).toBe('deny')
    if (d.decision === 'deny') expect(d.reason).toBe('no writes today')
  }, 15_000)

  it('stdout 为空时会按默认 allow 处理', async () => {
    const script = await writeHookScript('process.exit(0)')
    const d = await executeHook(hookFor(script), preEvent())
    expect(d.decision).toBe('allow')
  }, 15_000)

  it('failurePolicy:allow 时，非零退出码会转成 allow', async () => {
    const script = await writeHookScript('process.exit(7)')
    const d = await executeHook(hookFor(script), preEvent())
    expect(d.decision).toBe('allow')
  }, 15_000)

  it('failurePolicy:block 时，非零退出码会转成 deny', async () => {
    const script = await writeHookScript('process.exit(7)')
    const d = await executeHook(hookFor(script, { failurePolicy: 'block' }), preEvent())
    expect(d.decision).toBe('deny')
  }, 15_000)

  it('当前操作系统存在匹配覆盖命令时，会优先使用平台特定命令', async () => {
    // 每个候选脚本都输出唯一 reason，方便判断最终到底执行了哪一个。
    // 无论当前 process.platform 是什么，只要存在匹配覆盖项，它就应该胜出。
    const base = await writeHookScript('console.log(JSON.stringify({decision:"deny",reason:"BASE"}))')
    const win = await writeHookScript('console.log(JSON.stringify({decision:"deny",reason:"WIN"}))')
    const mac = await writeHookScript('console.log(JSON.stringify({decision:"deny",reason:"MAC"}))')
    const lin = await writeHookScript('console.log(JSON.stringify({decision:"deny",reason:"NIX"}))')

    const hook: RegisteredHook = {
      pluginId: 'demo@local',
      pluginDir: process.cwd(),
      event: 'PreToolUse',
      entry: {
        command: `node "${base}"`,
        commandWindows: `node "${win}"`,
        commandDarwin: `node "${mac}"`,
        commandLinux: `node "${lin}"`,
      },
    }
    const d = await executeHook(hook, preEvent())
    expect(d.decision).toBe('deny')
    const expected =
      process.platform === 'win32'
        ? 'WIN'
        : process.platform === 'darwin'
          ? 'MAC'
          : process.platform === 'linux'
            ? 'NIX'
            : 'BASE'
    if (d.decision === 'deny') expect(d.reason).toBe(expected)
  }, 15_000)

  it('当前操作系统没有覆盖命令时，会回退到基础命令', async () => {
    const base = await writeHookScript('console.log(JSON.stringify({decision:"deny",reason:"BASE-WINS"}))')
    // 只给“当前平台以外”的系统设置覆盖项。
    const other = await writeHookScript('console.log(JSON.stringify({decision:"deny",reason:"OTHER"}))')
    const hook: RegisteredHook = {
      pluginId: 'demo@local',
      pluginDir: process.cwd(),
      event: 'PreToolUse',
      entry: {
        command: `node "${base}"`,
        commandWindows: process.platform === 'win32' ? undefined : `node "${other}"`,
        commandDarwin: process.platform === 'darwin' ? undefined : `node "${other}"`,
        commandLinux: process.platform === 'linux' ? undefined : `node "${other}"`,
      },
    }
    const d = await executeHook(hook, preEvent())
    expect(d.decision).toBe('deny')
    if (d.decision === 'deny') expect(d.reason).toBe('BASE-WINS')
  }, 15_000)
})
