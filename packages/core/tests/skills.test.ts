// 技能加载器与注册表测试
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { loadSkills } from '../src/skills/loader.js'
import { SkillRegistry } from '../src/skills/registry.js'

/**
 * 创建一个临时技能目录，把各个 skill 子目录写进去，并返回根目录路径。
 */
async function makeTempSkillsDir(skills: { dir: string; frontmatter: string; body: string }[]): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-skills-test-'))
  for (const s of skills) {
    const skillDir = path.join(root, s.dir)
    await fs.mkdir(skillDir, { recursive: true })
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), `---\n${s.frontmatter}\n---\n${s.body}`, 'utf-8')
  }
  return root
}

let originalSkillsDir: string | undefined

beforeEach(() => {
  originalSkillsDir = process.env.XC_SKILLS_DIR
})

afterEach(async () => {
  if (originalSkillsDir === undefined) {
    delete process.env.XC_SKILLS_DIR
  } else {
    process.env.XC_SKILLS_DIR = originalSkillsDir
  }
})

// ── loadSkills ────────────────────────────────────────────────────────────────

describe('loadSkills', () => {
  it('目录不存在时返回空数组', async () => {
    process.env.XC_SKILLS_DIR = path.join(os.tmpdir(), 'xc-skills-nonexistent-' + Date.now())
    const skills = await loadSkills()
    expect(skills).toEqual([])
  })

  it('可以加载一个有效的 skill', async () => {
    const dir = await makeTempSkillsDir([
      {
        dir: 'code-review',
        frontmatter: 'name: code-review\ndescription: Review code for quality',
        body: 'Review the code carefully.',
      },
    ])
    process.env.XC_SKILLS_DIR = dir

    const skills = await loadSkills()
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({
      name: 'code-review',
      description: 'Review code for quality',
      content: 'Review the code carefully.',
    })
  })

  it('可以加载多个 skill', async () => {
    const dir = await makeTempSkillsDir([
      {
        dir: 'skill-a',
        frontmatter: 'name: skill-a\ndescription: Skill A',
        body: 'Body A',
      },
      {
        dir: 'skill-b',
        frontmatter: 'name: skill-b\ndescription: Skill B',
        body: 'Body B',
      },
    ])
    process.env.XC_SKILLS_DIR = dir

    const skills = await loadSkills()
    expect(skills).toHaveLength(2)
    const names = skills.map((s) => s.name).sort()
    expect(names).toEqual(['skill-a', 'skill-b'])
  })

  it('会跳过没有 SKILL.md 的 skill 目录', async () => {
    const dir = await makeTempSkillsDir([
      {
        dir: 'valid-skill',
        frontmatter: 'name: valid-skill\ndescription: Valid',
        body: 'Body',
      },
    ])
    // 额外放一个没有 SKILL.md 的目录。
    await fs.mkdir(path.join(dir, 'empty-dir'), { recursive: true })
    process.env.XC_SKILLS_DIR = dir

    const skills = await loadSkills()
    expect(skills).toHaveLength(1)
    expect(skills[0].name).toBe('valid-skill')
  })

  it('会跳过没有 frontmatter 的 SKILL.md', async () => {
    const dir = path.join(os.tmpdir(), 'xc-skills-nofm-' + Date.now())
    await fs.mkdir(path.join(dir, 'bad-skill'), { recursive: true })
    await fs.writeFile(path.join(dir, 'bad-skill', 'SKILL.md'), 'No frontmatter here.', 'utf-8')
    process.env.XC_SKILLS_DIR = dir

    const skills = await loadSkills()
    expect(skills).toHaveLength(0)
  })

  it('会跳过缺少必填 frontmatter 字段的 SKILL.md', async () => {
    const dir = await makeTempSkillsDir([
      {
        dir: 'no-desc',
        frontmatter: 'name: no-desc', // 缺少 description
        body: 'Body',
      },
    ])
    process.env.XC_SKILLS_DIR = dir

    const skills = await loadSkills()
    expect(skills).toHaveLength(0)
  })

  it('会去掉 frontmatter 值外围的引号', async () => {
    const dir = await makeTempSkillsDir([
      {
        dir: 'quoted',
        frontmatter: 'name: "quoted-skill"\ndescription: "A quoted description"',
        body: 'Body',
      },
    ])
    process.env.XC_SKILLS_DIR = dir

    const skills = await loadSkills()
    expect(skills[0].name).toBe('quoted-skill')
    expect(skills[0].description).toBe('A quoted description')
  })

  it('会裁掉正文首尾的空白', async () => {
    const dir = await makeTempSkillsDir([
      {
        dir: 'trim-test',
        frontmatter: 'name: trim-test\ndescription: Trim test',
        body: '\n\n  Body content  \n\n',
      },
    ])
    process.env.XC_SKILLS_DIR = dir

    const skills = await loadSkills()
    expect(skills[0].content).toBe('Body content')
  })
})

// ── loadSkills：dir 与 files 填充 ───────────────────────────────────────

describe('loadSkills bundled-resources support', () => {
  it('会把绝对技能目录路径填充到 `dir` 字段', async () => {
    const dir = await makeTempSkillsDir([
      {
        dir: 'with-dir',
        frontmatter: 'name: with-dir\ndescription: Skill that has a dir',
        body: 'Body',
      },
    ])
    process.env.XC_SKILLS_DIR = dir

    const skills = await loadSkills()
    expect(skills).toHaveLength(1)
    expect(skills[0].dir).toBe(path.join(dir, 'with-dir'))
  })

  it('会列出随 skill 打包的文件（不包含 SKILL.md 本身）', async () => {
    const dir = await makeTempSkillsDir([
      {
        dir: 'with-files',
        frontmatter: 'name: with-files\ndescription: Has bundled files',
        body: 'Body',
      },
    ])
    // 在 SKILL.md 同级新增 scripts 与 references 目录。
    const skillRoot = path.join(dir, 'with-files')
    await fs.mkdir(path.join(skillRoot, 'scripts'), { recursive: true })
    await fs.writeFile(path.join(skillRoot, 'scripts', 'preflight.sh'), '#!/bin/sh\necho ok\n', 'utf-8')
    await fs.mkdir(path.join(skillRoot, 'references'), { recursive: true })
    await fs.writeFile(path.join(skillRoot, 'references', 'api.md'), '# API\n', 'utf-8')
    process.env.XC_SKILLS_DIR = dir

    const skills = await loadSkills()
    expect(skills).toHaveLength(1)
    expect(skills[0].files.sort()).toEqual(['references/api.md', 'scripts/preflight.sh'])
  })

  it('会跳过隐藏文件和重量级目录（.git、node_modules）', async () => {
    const dir = await makeTempSkillsDir([
      {
        dir: 'with-heavy',
        frontmatter: 'name: with-heavy\ndescription: Has noise',
        body: 'Body',
      },
    ])
    const skillRoot = path.join(dir, 'with-heavy')
    // 根目录隐藏文件，加上嵌套的 .git 与 node_modules 目录。
    await fs.writeFile(path.join(skillRoot, '.DS_Store'), '', 'utf-8')
    await fs.mkdir(path.join(skillRoot, '.git'), { recursive: true })
    await fs.writeFile(path.join(skillRoot, '.git', 'HEAD'), 'ref: ...', 'utf-8')
    await fs.mkdir(path.join(skillRoot, 'node_modules', 'foo'), { recursive: true })
    await fs.writeFile(path.join(skillRoot, 'node_modules', 'foo', 'package.json'), '{}', 'utf-8')
    // 一个真实存在且应该被列出的文件。
    await fs.writeFile(path.join(skillRoot, 'real.txt'), 'real content', 'utf-8')
    process.env.XC_SKILLS_DIR = dir

    const skills = await loadSkills()
    expect(skills).toHaveLength(1)
    expect(skills[0].files).toEqual(['real.txt'])
  })
})

// ── wrapActivatedSkill / formatSkillActivationBody ───────────────────────────

describe('wrapActivatedSkill', () => {
  it('会用 <activated_skill> 包裹正文，并附带基础目录与文件列表尾注', async () => {
    const { wrapActivatedSkill } = await import('../src/skills/registry.js')
    const skill = {
      name: 'demo',
      description: 'desc',
      content: 'Do the thing.',
      source: 'user' as const,
      dir: '/abs/path/to/skills/demo',
      files: ['scripts/run.sh', 'references/notes.md'],
    }
    const out = wrapActivatedSkill(skill)
    expect(out).toContain('<activated_skill name="demo">')
    expect(out).toContain('</activated_skill>')
    expect(out).toContain('Do the thing.')
    expect(out).toContain('Base directory for this skill: /abs/path/to/skills/demo')
    expect(out).toContain('- scripts/run.sh')
    expect(out).toContain('- references/notes.md')
  })

  it('当 skill 没有打包文件时，会省略文件列表部分', async () => {
    const { wrapActivatedSkill } = await import('../src/skills/registry.js')
    const skill = {
      name: 'pure',
      description: 'desc',
      content: 'Plain prompt.',
      source: 'user' as const,
      dir: '/abs/pure',
      files: [],
    }
    const out = wrapActivatedSkill(skill)
    expect(out).toContain('Base directory for this skill: /abs/pure')
    expect(out).not.toContain('Files in this skill directory:')
  })

  it('面对很长的文件列表时，会用“... N more”标记做截断', async () => {
    const { wrapActivatedSkill } = await import('../src/skills/registry.js')
    const files = Array.from({ length: 55 }, (_, i) => `file${i}.txt`)
    const skill = {
      name: 'big',
      description: 'desc',
      content: 'Body',
      source: 'user' as const,
      dir: '/abs/big',
      files,
    }
    const out = wrapActivatedSkill(skill)
    expect(out).toContain('- file0.txt')
    expect(out).toContain('- file49.txt')
    expect(out).not.toContain('- file50.txt')
    expect(out).toContain('and 5 more file(s) not shown')
  })
})

// ── SkillRegistry ─────────────────────────────────────────────────────────────

describe('SkillRegistry', () => {
  it('get 会按名称返回对应 skill', () => {
    const registry = new SkillRegistry([
      {
        name: 'review',
        description: 'Code review',
        content: 'Review...',
        source: 'user',
        dir: '/skills/review',
        files: [],
      },
    ])
    const skill = registry.get('review')
    expect(skill).toBeDefined()
    expect(skill!.name).toBe('review')
    expect(skill!.content).toBe('Review...')
  })

  it('list 会返回全部可见 skill', () => {
    const defs = [
      { name: 'a', description: 'A', content: 'Body A', source: 'user' as const, dir: '/skills/a', files: [] },
      { name: 'b', description: 'B', content: 'Body B', source: 'project' as const, dir: '/skills/b', files: [] },
    ]
    const registry = new SkillRegistry(defs)
    expect(registry.list()).toHaveLength(2)
  })

  it('names 会返回全部 skill 名称', () => {
    const defs = [
      { name: 'alpha', description: 'Alpha', content: '', source: 'user' as const, dir: '/skills/alpha', files: [] },
      { name: 'beta', description: 'Beta', content: '', source: 'user' as const, dir: '/skills/beta', files: [] },
    ]
    const registry = new SkillRegistry(defs)
    expect(registry.names().sort()).toEqual(['alpha', 'beta'])
  })

  it('同名情况下，project skill 会覆盖 user scope skill', () => {
    // loadSkills 会先返回 user-scope，再返回 project-scope；
    // registry 采用后写覆盖，因此 project 应当获胜。
    const defs = [
      {
        name: 'review',
        description: 'User review',
        content: 'User body',
        source: 'user' as const,
        dir: '/user/skills/review',
        files: [],
      },
      {
        name: 'review',
        description: 'Project review',
        content: 'Project body',
        source: 'project' as const,
        dir: '/project/skills/review',
        files: [],
      },
    ]
    const registry = new SkillRegistry(defs)
    expect(registry.list()).toHaveLength(1)
    expect(registry.get('review')!.description).toBe('Project review')
    expect(registry.get('review')!.source).toBe('project')
  })

  it('不同名称的 skill 不会被去重', () => {
    const defs = [
      { name: 'a', description: 'A', content: '', source: 'user' as const, dir: '/skills/a', files: [] },
      { name: 'b', description: 'B', content: '', source: 'project' as const, dir: '/skills/b', files: [] },
    ]
    const registry = new SkillRegistry(defs)
    expect(registry.list()).toHaveLength(2)
  })

  it('被禁用的 skill 会从 list/names/get 隐藏，但仍出现在 listAll 中', () => {
    const defs = [
      { name: 'on-skill', description: 'On', content: '', source: 'user' as const, dir: '/skills/on', files: [] },
      {
        name: 'off-skill',
        description: 'Off',
        content: '',
        source: 'user' as const,
        dir: '/skills/off',
        files: [],
      },
    ]
    const registry = new SkillRegistry(defs, new Set(['off-skill']))
    expect(registry.list().map((s) => s.name)).toEqual(['on-skill'])
    expect(registry.names()).toEqual(['on-skill'])
    expect(registry.get('off-skill')).toBeUndefined()
    expect(registry.get('on-skill')).toBeDefined()
    expect(registry.listAll()).toHaveLength(2)
    expect(registry.listAll().find((s) => s.name === 'off-skill')!.disabled).toBe(true)
    expect(registry.listAll().find((s) => s.name === 'on-skill')!.disabled).toBe(false)
    expect(registry.getEntry('off-skill')!.disabled).toBe(true)
  })

  it('description 中的 YAML 折叠标量会把续行拼接起来', async () => {
    const dir = await makeTempSkillsDir([
      {
        dir: 'folded',
        frontmatter:
          'name: folded\ndescription: First chunk of the description\n  continues on the next line\n  and a third line',
        body: 'Body',
      },
    ])
    process.env.XC_SKILLS_DIR = dir

    const skills = await loadSkills()
    expect(skills).toHaveLength(1)
    expect(skills[0].description).toBe('First chunk of the description continues on the next line and a third line')
  })

  it('reload() 会原地替换条目，并返回与旧状态相比的 diff', () => {
    const v1 = [
      {
        name: 'alpha',
        description: 'A v1',
        content: 'body A v1',
        source: 'user' as const,
        dir: '/skills/alpha',
        files: [],
      },
      {
        name: 'beta',
        description: 'B v1',
        content: 'body B v1',
        source: 'user' as const,
        dir: '/skills/beta',
        files: [],
      },
    ]
    const registry = new SkillRegistry(v1)
    const refBefore = registry

    // alpha 不变，beta 的 description 变化，gamma 新增，delta 缺失。
    const v2 = [
      {
        name: 'alpha',
        description: 'A v1',
        content: 'body A v1',
        source: 'user' as const,
        dir: '/skills/alpha',
        files: [],
      },
      {
        name: 'beta',
        description: 'B v2',
        content: 'body B v1',
        source: 'user' as const,
        dir: '/skills/beta',
        files: [],
      },
      {
        name: 'gamma',
        description: 'G',
        content: 'body G',
        source: 'user' as const,
        dir: '/skills/gamma',
        files: [],
      },
    ]
    const summary = registry.reload(v2, new Set())

    expect(summary.added).toEqual(['gamma'])
    expect(summary.changed).toEqual(['beta'])
    expect(summary.unchanged).toEqual(['alpha'])
    expect(summary.removed).toEqual([])

    // 对象身份必须保持不变，避免外部缓存 registry 的调用方失去引用。
    expect(registry).toBe(refBefore)

    // 最终可见状态应与 v2 一致。
    expect(registry.names().sort()).toEqual(['alpha', 'beta', 'gamma'])
    expect(registry.get('beta')!.description).toBe('B v2')
  })

  it('reload() 会报告被移除的 skill，并从 list/get 中清掉它们', () => {
    const v1 = [
      {
        name: 'alpha',
        description: 'A',
        content: 'body A',
        source: 'user' as const,
        dir: '/skills/alpha',
        files: [],
      },
      { name: 'beta', description: 'B', content: 'body B', source: 'user' as const, dir: '/skills/beta', files: [] },
    ]
    const registry = new SkillRegistry(v1)

    const summary = registry.reload(
      [
        {
          name: 'alpha',
          description: 'A',
          content: 'body A',
          source: 'user' as const,
          dir: '/skills/alpha',
          files: [],
        },
      ],
      new Set(),
    )

    expect(summary.removed).toEqual(['beta'])
    expect(registry.get('beta')).toBeUndefined()
    expect(registry.names()).toEqual(['alpha'])
  })

  it('reload() 会把禁用开关变化视为 changed', () => {
    const defs = [
      { name: 'alpha', description: 'A', content: 'body', source: 'user' as const, dir: '/skills/alpha', files: [] },
    ]
    const registry = new SkillRegistry(defs)
    expect(registry.get('alpha')).toBeDefined()

    const summary = registry.reload(defs, new Set(['alpha']))
    expect(summary.changed).toEqual(['alpha'])
    // 被禁用后，会从 list/get 隐藏，但依旧可在 listAll 中看到。
    expect(registry.get('alpha')).toBeUndefined()
    expect(registry.listAll()).toHaveLength(1)
    expect(registry.listAll()[0].disabled).toBe(true)
  })
})

// ── reloadSkillRegistry（集成测试） ────────────────────────────────────────

describe('reloadSkillRegistry', () => {
  let originalCwd: string

  beforeEach(() => {
    originalCwd = process.cwd()
  })

  afterEach(() => {
    process.chdir(originalCwd)
  })

  it('会重新扫描磁盘与设置，并原地修改现有 registry', async () => {
    const { createSkillRegistry, reloadSkillRegistry } = await import('../src/skills/registry.js')

    // 初始状态：磁盘上只有一个 skill，且没有 disabledSkills 设置。
    const skillsDir = await makeTempSkillsDir([
      {
        dir: 'initial',
        frontmatter: 'name: initial\ndescription: First skill',
        body: 'initial body',
      },
    ])
    process.env.XC_SKILLS_DIR = skillsDir
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-refresh-int-'))
    process.chdir(projectDir)

    const registry = await createSkillRegistry()
    expect(registry.names()).toEqual(['initial'])

    // 模拟用户在磁盘上新增一个 skill。
    await fs.mkdir(path.join(skillsDir, 'added'), { recursive: true })
    await fs.writeFile(
      path.join(skillsDir, 'added', 'SKILL.md'),
      `---\nname: added\ndescription: Second skill\n---\nadded body`,
      'utf-8',
    )

    const summary = await reloadSkillRegistry(registry)
    expect(summary.added).toEqual(['added'])
    expect(summary.unchanged).toEqual(['initial'])
    expect(registry.names().sort()).toEqual(['added', 'initial'])
  })
})

// ── settings（disabledSkills） ─────────────────────────────────────────────────

describe('skill settings', () => {
  let originalHome: string | undefined
  let originalCwd: string

  beforeEach(() => {
    originalHome = process.env.X_CODE_HOME
    originalCwd = process.cwd()
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.X_CODE_HOME
    else process.env.X_CODE_HOME = originalHome
    process.chdir(originalCwd)
  })

  it('会合并 user 与 project 两侧的 disabled 列表', async () => {
    const { setSkillDisabled, loadDisabledSkillsSet } = await import('../src/skills/settings.js')
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-settings-test-home-'))
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-settings-test-proj-'))
    // utils.ts 会在模块求值时缓存 USER_XCODE_DIR，因此这里单独设置
    // X_CODE_HOME 并不足以重定向 user-scope 路径。我们通过 chdir 到临时
    // project 目录来让 project-scope 指向一块全新位置；而 user-scope
    // 路径则仍停留在 utils.ts 首次 import 时解析到的位置。
    process.chdir(projectDir)

    await setSkillDisabled('alpha', 'project', true)
    await setSkillDisabled('beta', 'project', true)
    const disabled = await loadDisabledSkillsSet()
    expect(disabled.has('alpha')).toBe(true)
    expect(disabled.has('beta')).toBe(true)
  })

  it('当目标状态本就一致时，setSkillDisabled 会返回 noop', async () => {
    const { setSkillDisabled } = await import('../src/skills/settings.js')
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-settings-noop-'))
    process.chdir(projectDir)

    expect(await setSkillDisabled('gamma', 'project', true)).toBe('changed')
    expect(await setSkillDisabled('gamma', 'project', true)).toBe('noop')
    expect(await setSkillDisabled('gamma', 'project', false)).toBe('changed')
    expect(await setSkillDisabled('gamma', 'project', false)).toBe('noop')
  })

  it('会保留 settings.json 中的无关字段', async () => {
    const { setSkillDisabled, skillSettingsPath } = await import('../src/skills/settings.js')
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-settings-merge-'))
    process.chdir(projectDir)

    const file = skillSettingsPath('project')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ keepMe: 'yes', other: 42 }), 'utf-8')

    await setSkillDisabled('delta', 'project', true)
    const raw = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(raw)
    expect(parsed.keepMe).toBe('yes')
    expect(parsed.other).toBe(42)
    expect(parsed.disabledSkills).toEqual(['delta'])
  })
})

// ── createSkillRegistry 集成测试 ───────────────────────────────────────────
// 这里走的是 loader + settings + registry filter 的端到端路径。
// 上面的单元测试分别覆盖了单层逻辑，而这里要防的是未来重构把这些层
// 无意拆散，导致被禁用的 skill 悄悄重新流入 agent loop。
// 具体故障形态会是：settings.json 里明明写了禁用项，但 registry 不再遵守。

describe('createSkillRegistry', () => {
  let originalCwd: string

  beforeEach(() => {
    originalCwd = process.cwd()
  })

  afterEach(() => {
    process.chdir(originalCwd)
  })

  it('会从磁盘读取 skill，应用 project-scope 禁用规则，并过滤 list/names/get', async () => {
    const { createSkillRegistry } = await import('../src/skills/registry.js')
    const { skillSettingsPath } = await import('../src/skills/settings.js')

    const skillsDir = await makeTempSkillsDir([
      {
        dir: 'skill-on',
        frontmatter: 'name: skill-on\ndescription: Stays enabled',
        body: 'On body',
      },
      {
        dir: 'skill-off',
        frontmatter: 'name: skill-off\ndescription: Should be disabled',
        body: 'Off body',
      },
    ])
    process.env.XC_SKILLS_DIR = skillsDir

    // Project-scope 设置存放在 cwd/.x-code/settings.local.json。
    // 这里切到一个新的临时目录，避免污染真实仓库或用户目录。
    // （utils.ts 会在 import 时缓存 USER_XCODE_DIR，所以这里没法再重定向
    // user-scope，但 project-scope 已足够，因为 XC_SKILLS_DIR 加载出的
    // skill 也会被标记为 source='project'。）
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-registry-int-'))
    process.chdir(projectDir)
    const settingsFile = skillSettingsPath('project')
    await fs.mkdir(path.dirname(settingsFile), { recursive: true })
    await fs.writeFile(settingsFile, JSON.stringify({ disabledSkills: ['skill-off'] }), 'utf-8')

    const registry = await createSkillRegistry()

    // listAll 应展示两个条目，并正确标注 disabled 状态。
    const all = registry.listAll()
    expect(all).toHaveLength(2)
    const onEntry = all.find((s) => s.name === 'skill-on')!
    const offEntry = all.find((s) => s.name === 'skill-off')!
    expect(onEntry.disabled).toBe(false)
    expect(offEntry.disabled).toBe(true)

    // list / names / get 都应隐藏被禁用的那个。
    // 这是 agent loop 与 system-prompt builder 所依赖的契约。
    expect(registry.list().map((s) => s.name)).toEqual(['skill-on'])
    expect(registry.names()).toEqual(['skill-on'])
    expect(registry.get('skill-off')).toBeUndefined()
    expect(registry.get('skill-on')).toBeDefined()

    // getEntry 是唯一仍会返回 disabled skill 的访问器，
    // 供 /skill list 与 /skill enable 这类命令继续操作它们。
    expect(registry.getEntry('skill-off')?.disabled).toBe(true)
  })
})
