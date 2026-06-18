// 文件型 slash command 子系统测试，覆盖 loader / registry / body 展开。
// 这里最容易回归的是 `$ARGUMENTS`、`${CLAUDE_PLUGIN_ROOT}` 的替换逻辑，
// 以及 Claude Code 使用的 `allowed-tools:` frontmatter 解析形式：
// 它通常很长、以逗号分隔，而且经常换行折叠。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { CommandRegistry, expandCommandBody, loadPluginCommands } from '../src/commands/index.js'

// 写入一个测试命令文件，复现插件命令的真实磁盘结构。
async function writeCommand(dir: string, name: string, frontmatter: string, body: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${name}.md`), `---\n${frontmatter}\n---\n${body}`, 'utf-8')
}

/** loadPluginCommands 现在还会扫描 `${X_CODE_HOME}/commands` 和
 *  `<cwd>/.x-code/commands`，因此每个测试都要隔离到新的空目录里，
 *  避免开发者真实的 `~/.x-code/commands/` 混进断言。 */
let prevHome: string | undefined
let prevCwd: string
let isolatedHome: string
let isolatedCwd: string

beforeEach(async () => {
  prevHome = process.env.X_CODE_HOME
  prevCwd = process.cwd()
  isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-cmds-home-'))
  isolatedCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-cmds-cwd-'))
  process.env.X_CODE_HOME = isolatedHome
  process.chdir(isolatedCwd)
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env.X_CODE_HOME
  else process.env.X_CODE_HOME = prevHome
  process.chdir(prevCwd)
  await fs.rm(isolatedHome, { recursive: true, force: true }).catch(() => {})
  await fs.rm(isolatedCwd, { recursive: true, force: true }).catch(() => {})
})

describe('loadPluginCommands', () => {
  it('会把每个 commands/<name>.md 加载成 CommandDefinition，名称取文件名', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-cmds-'))
    await writeCommand(dir, 'code-review', 'description: Review code', 'Body of code-review')
    await writeCommand(dir, 'commit', 'description: Make a commit', 'Body of commit')

    const out = await loadPluginCommands({
      extraDirs: [{ dir, pluginId: 'demo@local', pluginRoot: '/abs/root' }],
    })

    expect(out.map((c) => c.name).sort()).toEqual(['code-review', 'commit'])
    const cr = out.find((c) => c.name === 'code-review')!
    expect(cr.description).toBe('Review code')
    expect(cr.body).toBe('Body of code-review')
    expect(cr.pluginId).toBe('demo@local')
    expect(cr.pluginRoot).toBe('/abs/root')
  })

  it('能处理真实 Claude Code 的多行 allowed-tools frontmatter，而不会崩溃', async () => {
    // 这就是 anthropics/claude-code 的 code-review 插件里真实出现的格式：
    // `allowed-tools` 用逗号分隔，而且经常长到需要视觉换行。
    // 我们的最小 YAML 解析器会把缩进行续行折叠起来；
    // 虽然当前读到的 `allowed-tools` 值还不会参与权限校验，
    // 但解析阶段绝不能因此拒绝整份文件。
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-cmds-allowed-'))
    await writeCommand(
      dir,
      'real-shape',
      'allowed-tools: Bash(gh issue view:*), Bash(gh search:*), mcp__github_inline_comment__create_inline_comment\ndescription: Code review',
      'Body',
    )

    const out = await loadPluginCommands({
      extraDirs: [{ dir, pluginId: 'demo@local', pluginRoot: '/r' }],
    })
    expect(out).toHaveLength(1)
    expect(out[0]!.description).toBe('Code review')
    expect(out[0]!.body).toBe('Body')
  })

  it('会把没有 frontmatter 的文件当成仅含 body 的命令', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-cmds-nofm-'))
    await fs.writeFile(path.join(dir, 'bare.md'), 'just the body', 'utf-8')

    const out = await loadPluginCommands({
      extraDirs: [{ dir, pluginId: 'demo@local', pluginRoot: '/r' }],
    })
    expect(out).toHaveLength(1)
    expect(out[0]!.name).toBe('bare')
    expect(out[0]!.description).toBeUndefined()
    expect(out[0]!.body).toBe('just the body')
  })

  it('目录不存在时返回空数组，不让损坏插件拖垮启动流程', async () => {
    const out = await loadPluginCommands({
      extraDirs: [{ dir: '/nonexistent', pluginId: 'ghost@local', pluginRoot: '/r' }],
    })
    expect(out).toEqual([])
  })

  it('会扫描用户级和项目级命令目录', async () => {
    await writeCommand(path.join(isolatedHome, 'commands'), 'usercmd', 'description: from user', 'user body')
    await writeCommand(
      path.join(isolatedCwd, '.x-code', 'commands'),
      'projcmd',
      'description: from project',
      'proj body',
    )

    const out = await loadPluginCommands()

    const byName = new Map(out.map((c) => [c.name, c]))
    expect(byName.get('usercmd')?.source).toBe('user')
    expect(byName.get('usercmd')?.description).toBe('from user')
    expect(byName.get('usercmd')?.pluginId).toBeUndefined()
    expect(byName.get('projcmd')?.source).toBe('project')
    expect(byName.get('projcmd')?.description).toBe('from project')
  })

  it('命名冲突时优先级为 project > plugin > user', async () => {
    // 三个来源都定义了 `dup`，按 registry 的“后写覆盖前写”语义，
    // 最终应暴露项目级版本。
    await writeCommand(path.join(isolatedHome, 'commands'), 'dup', 'description: user', 'user-body')
    const pluginDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-cmds-plugin-'))
    await writeCommand(pluginDir, 'dup', 'description: plugin', 'plugin-body')
    await writeCommand(path.join(isolatedCwd, '.x-code', 'commands'), 'dup', 'description: project', 'project-body')

    const out = await loadPluginCommands({
      extraDirs: [{ dir: pluginDir, pluginId: 'p@m', pluginRoot: '/r' }],
    })
    const reg = new CommandRegistry(out)
    const winner = reg.get('dup')!
    expect(winner.source).toBe('project')
    expect(winner.body).toBe('project-body')

    await fs.rm(pluginDir, { recursive: true, force: true }).catch(() => {})
  })

  it('用户级和项目级命令没有 pluginId，${CLAUDE_PLUGIN_ROOT} 会展开为空', async () => {
    await writeCommand(
      path.join(isolatedHome, 'commands'),
      'echo',
      'description: echo it',
      'cd ${CLAUDE_PLUGIN_ROOT} && say $ARGUMENTS',
    )

    const out = await loadPluginCommands()
    const echo = out.find((c) => c.name === 'echo')!
    expect(echo.source).toBe('user')
    expect(echo.pluginId).toBeUndefined()
    expect(echo.pluginRoot).toBeUndefined()
    expect(expandCommandBody(echo, 'hi')).toBe('cd  && say hi')
  })
})

describe('expandCommandBody', () => {
  // 构造一个带插件上下文的命令定义，方便测试变量替换。
  function cmd(body: string, root = '/abs/plugin'): import('../src/commands/types.js').CommandDefinition {
    return { name: 't', body, source: 'plugin', pluginId: 'demo@local', pluginRoot: root }
  }

  it('会把 $ARGUMENTS 和 ${ARGUMENTS} 替换成用户输入的参数串', () => {
    expect(expandCommandBody(cmd('Run: $ARGUMENTS'), '123')).toBe('Run: 123')
    expect(expandCommandBody(cmd('Run: ${ARGUMENTS}'), 'abc def')).toBe('Run: abc def')
  })

  it('会把 ${CLAUDE_PLUGIN_ROOT} 替换成插件根目录路径', () => {
    const out = expandCommandBody(cmd('cd ${CLAUDE_PLUGIN_ROOT} && ./scripts/x.sh', '/abs/p'), '')
    expect(out).toBe('cd /abs/p && ./scripts/x.sh')
  })

  it('未提供参数时，会把 $ARGUMENTS 替换为空字符串', () => {
    expect(expandCommandBody(cmd('"$ARGUMENTS"'), '')).toBe('""')
  })

  it('会把 ${CLAUDE_PLUGIN_DATA} 替换成插件数据目录，并自动创建目录', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-cmd-data-'))
    const prev = process.env.XC_PLUGINS_DIR
    process.env.XC_PLUGINS_DIR = tmpHome
    try {
      const out = expandCommandBody(cmd('cat ${CLAUDE_PLUGIN_DATA}/notes.md'), '')
      // body 里仍然带着插件身份，因此替换后的路径应落在临时插件根目录下。
      expect(out.startsWith('cat ')).toBe(true)
      const dataPath = out.slice('cat '.length).replace(/\/notes\.md$/, '')
      const stat = await fs.stat(dataPath)
      expect(stat.isDirectory()).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.XC_PLUGINS_DIR
      else process.env.XC_PLUGINS_DIR = prev
      await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('当 body 没有可解析的插件上下文时，${CLAUDE_PLUGIN_DATA} 会表现为空路径', () => {
    // 手工构造一个没有 pluginId 的命令定义：这里不应该 mkdir，也不应该解析出真实目录。
    const c: import('../src/commands/types.js').CommandDefinition = {
      name: 't',
      body: 'echo ${CLAUDE_PLUGIN_DATA}/foo',
      source: 'plugin',
      pluginRoot: '/abs/p',
    }
    expect(expandCommandBody(c, '')).toBe('echo /foo')
  })
})

describe('CommandRegistry', () => {
  it('能按名称查询，未命中时返回 undefined', () => {
    const reg = new CommandRegistry([
      { name: 'foo', body: 'b', source: 'plugin', pluginId: 'demo@local', pluginRoot: '/r' },
    ])
    expect(reg.get('foo')!.name).toBe('foo')
    expect(reg.get('bar')).toBeUndefined()
  })

  it('名称冲突时遵循后写覆盖前写的规则', () => {
    const reg = new CommandRegistry([
      { name: 'foo', body: 'first', source: 'plugin', pluginId: 'a@local', pluginRoot: '/a' },
      { name: 'foo', body: 'second', source: 'plugin', pluginId: 'b@local', pluginRoot: '/b' },
    ])
    expect(reg.get('foo')!.body).toBe('second')
    expect(reg.get('foo')!.pluginId).toBe('b@local')
  })
})
