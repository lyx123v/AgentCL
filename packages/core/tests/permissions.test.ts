// 权限系统测试
import { describe, expect, it, vi } from 'vitest'

import { checkPermission, getPermissionLevel, isPathWithinProject } from '../src/permissions/index.js'
import {
  addSessionAllowRule,
  buildAllowRule,
  clearSessionRules,
  extractCommandPrefix,
  extractCompoundRules,
  sessionRulesMatch,
  suggestRuleLabel,
} from '../src/permissions/session-store.js'

describe('getPermissionLevel', () => {
  it('只读工具返回 always-allow', () => {
    expect(getPermissionLevel('readFile', {})).toBe('always-allow')
    expect(getPermissionLevel('glob', {})).toBe('always-allow')
    expect(getPermissionLevel('grep', {})).toBe('always-allow')
    expect(getPermissionLevel('listDir', {})).toBe('always-allow')
    expect(getPermissionLevel('webSearch', {})).toBe('always-allow')
    expect(getPermissionLevel('webFetch', {})).toBe('always-allow')
  })

  it('写入类工具返回 ask', () => {
    expect(getPermissionLevel('edit', {})).toBe('ask')
    expect(getPermissionLevel('writeFile', {})).toBe('ask')
  })

  it('只读 shell 命令返回 always-allow', () => {
    expect(getPermissionLevel('shell', { command: 'ls -la' })).toBe('always-allow')
    expect(getPermissionLevel('shell', { command: 'pwd' })).toBe('always-allow')
    expect(getPermissionLevel('shell', { command: 'cat file.txt' })).toBe('always-allow')
    expect(getPermissionLevel('shell', { command: 'git status' })).toBe('always-allow')
    expect(getPermissionLevel('shell', { command: 'git log --oneline' })).toBe('always-allow')
  })

  it('写入型 shell 命令返回 ask', () => {
    expect(getPermissionLevel('shell', { command: 'npm install' })).toBe('ask')
    expect(getPermissionLevel('shell', { command: 'mkdir test' })).toBe('ask')
    expect(getPermissionLevel('shell', { command: 'touch file.txt' })).toBe('ask')
  })

  it('破坏性 shell 命令返回 deny', () => {
    expect(getPermissionLevel('shell', { command: 'rm -rf /' })).toBe('deny')
    expect(getPermissionLevel('shell', { command: 'sudo rm file' })).toBe('deny')
  })

  it('可以处理全为只读的复合命令', () => {
    expect(getPermissionLevel('shell', { command: 'ls -la | wc -l' })).toBe('always-allow')
    expect(getPermissionLevel('shell', { command: 'git status && git log' })).toBe('always-allow')
  })

  it('可以处理混合型复合命令', () => {
    expect(getPermissionLevel('shell', { command: 'ls && npm install' })).toBe('ask')
  })

  it('可以处理带破坏性片段的复合命令', () => {
    expect(getPermissionLevel('shell', { command: 'ls && rm -rf /' })).toBe('deny')
  })

  // 针对用户真实反馈做端到端覆盖：
  // 本不该弹权限确认的 PowerShell 只读管道，以及
  // 至少应该能推导出 `npx tsc:*` 规则的 `cd && build` 链式命令。
  it('会自动放行真实的 PowerShell 只读管道', () => {
    expect(
      getPermissionLevel('shell', {
        command:
          "cd D:\\res\\x-code-cli\\packages\\core\\src; Get-ChildItem -Recurse -Filter *.ts | Group-Object Directory | Sort-Object Name | Select-Object @{N='Directory';E={$_.Name}},Count",
      }),
    ).toBe('always-allow')
    expect(
      getPermissionLevel('shell', {
        command:
          "Get-ChildItem -Recurse -Filter *.ts -Path D:\\res\\x-code-cli\\packages\\core\\src | Group-Object Directory | Sort-Object Name | Select-Object @{Name='Directory';Expression={$_.Name}},Count",
      }),
    ).toBe('always-allow')
  })

  it('对 `cd && build | head` 会询问权限，但能推导出稳定前缀', () => {
    const cmd = 'cd d:\\isoform\\something\\wails-gui\\frontend && npx tsc --noEmit --pretty 2>&1 | head -40'
    expect(getPermissionLevel('shell', { command: cmd })).toBe('ask')
    // 关键点在于保存下来的规则应该是 `npx tsc:*`，而不是 `cd:*`
    // 或精确匹配。这样后续 `cd <其他目录> && npx tsc <其他参数>`
    // 就不会反复再次弹窗。
    expect(suggestRuleLabel('shell', { command: cmd })).toBe('npx tsc:*')
  })

  it('会端到端自动放行 `ls X; if (Test-Path X) { Get-Content X }`', () => {
    // 对控制流的识别会接入现有的分段 isReadOnly 判断，
    // 因此这种先 `ls` 再条件性 `Get-Content` 的复合命令
    // 会直接降为 always-allow，而不是继续弹窗。
    expect(
      getPermissionLevel('shell', {
        command:
          'ls -Force D:\\res\\x-code-cli\\.x-code\\local\\permissions.json 2>&1; if (Test-Path D:\\res\\x-code-cli\\.x-code\\local\\permissions.json) { Get-Content D:\\res\\x-code-cli\\.x-code\\local\\permissions.json }',
      }),
    ).toBe('always-allow')
  })
})

describe('checkPermission', () => {
  it('always-allow 工具无需询问，直接返回 true', async () => {
    const askFn = vi.fn()
    const result = await checkPermission({ toolCallId: '1', toolName: 'readFile', input: {} }, false, askFn)
    expect(result).toBe(true)
    expect(askFn).not.toHaveBeenCalled()
  })

  it('对破坏性 shell 命令会询问用户（deny 级别）', async () => {
    const askFn = vi.fn().mockResolvedValue('yes')
    const result = await checkPermission(
      { toolCallId: '2', toolName: 'shell', input: { command: 'rm -rf /' } },
      false,
      askFn,
    )
    expect(result).toBe(true)
    expect(askFn).toHaveBeenCalled()
  })

  it('用户可以拒绝破坏性 shell 命令', async () => {
    const askFn = vi.fn().mockResolvedValue('no')
    const result = await checkPermission(
      { toolCallId: '2b', toolName: 'shell', input: { command: 'rm -rf /' } },
      false,
      askFn,
    )
    expect(result).toBe(false)
    expect(askFn).toHaveBeenCalled()
  })

  it('trust mode 会自动批准破坏性 shell 命令', async () => {
    const askFn = vi.fn()
    const result = await checkPermission(
      { toolCallId: '2c', toolName: 'shell', input: { command: 'rm -rf /' } },
      true,
      askFn,
    )
    expect(result).toBe(true)
    expect(askFn).not.toHaveBeenCalled()
  })

  it('会为 ask 级工具询问用户', async () => {
    const askFn = vi.fn().mockResolvedValue('yes')
    const result = await checkPermission({ toolCallId: '3', toolName: 'writeFile', input: {} }, false, askFn)
    expect(result).toBe(true)
    expect(askFn).toHaveBeenCalled()
  })

  it('trust mode 会自动批准 ask 级工具', async () => {
    const askFn = vi.fn()
    const result = await checkPermission({ toolCallId: '4', toolName: 'writeFile', input: {} }, true, askFn)
    expect(result).toBe(true)
    expect(askFn).not.toHaveBeenCalled()
  })

  it('用户可以拒绝 ask 级工具', async () => {
    const askFn = vi.fn().mockResolvedValue('no')
    const result = await checkPermission({ toolCallId: '5', toolName: 'edit', input: {} }, false, askFn)
    expect(result).toBe(false)
    expect(askFn).toHaveBeenCalled()
  })

  it('acceptEdits 会自动批准项目目录内的写入', async () => {
    const askFn = vi.fn()
    const cwd = process.cwd()
    const result = await checkPermission(
      { toolCallId: '10', toolName: 'writeFile', input: { filePath: `${cwd}/src/foo.ts` } },
      false,
      askFn,
      'acceptEdits',
      cwd,
    )
    expect(result).toBe(true)
    expect(askFn).not.toHaveBeenCalled()
  })

  it('acceptEdits 会拦截项目目录外写入并回退到 ask', async () => {
    const askFn = vi.fn().mockResolvedValue('no')
    const cwd = process.cwd()
    const result = await checkPermission(
      { toolCallId: '11', toolName: 'writeFile', input: { filePath: '/etc/passwd' } },
      false,
      askFn,
      'acceptEdits',
      cwd,
    )
    expect(result).toBe(false)
    expect(askFn).toHaveBeenCalled()
  })

  it('acceptEdits 会拦截敏感点文件写入并回退到 ask', async () => {
    const askFn = vi.fn().mockResolvedValue('no')
    const cwd = process.cwd()
    const result = await checkPermission(
      { toolCallId: '12', toolName: 'edit', input: { filePath: `${cwd}/.env` } },
      false,
      askFn,
      'acceptEdits',
      cwd,
    )
    expect(result).toBe(false)
    expect(askFn).toHaveBeenCalled()
  })

  it('acceptEdits 会拦截写入 .git 目录并回退到 ask', async () => {
    const askFn = vi.fn().mockResolvedValue('no')
    const cwd = process.cwd()
    const result = await checkPermission(
      { toolCallId: '13', toolName: 'writeFile', input: { filePath: `${cwd}/.git/config` } },
      false,
      askFn,
      'acceptEdits',
      cwd,
    )
    expect(result).toBe(false)
    expect(askFn).toHaveBeenCalled()
  })

  it('acceptEdits 会拦截通过 ../ 的路径穿越并回退到 ask', async () => {
    const askFn = vi.fn().mockResolvedValue('no')
    const cwd = process.cwd()
    const result = await checkPermission(
      { toolCallId: '14', toolName: 'writeFile', input: { filePath: `${cwd}/../../etc/passwd` } },
      false,
      askFn,
      'acceptEdits',
      cwd,
    )
    expect(result).toBe(false)
    expect(askFn).toHaveBeenCalled()
  })
})

describe('extractCommandPrefix', () => {
  it('可以为普通命令提取双 token 前缀', () => {
    expect(extractCommandPrefix('git commit -m "fix"')).toBe('git commit')
    expect(extractCommandPrefix('pnpm run build')).toBe('pnpm run')
    expect(extractCommandPrefix('npm install lodash')).toBe('npm install')
  })

  it('会去掉白名单环境变量前缀', () => {
    expect(extractCommandPrefix('NODE_ENV=prod npm run dev')).toBe('npm run')
    expect(extractCommandPrefix('CI=1 DEBUG=foo npm test')).toBe('npm test')
    expect(extractCommandPrefix('LANG=en_US.UTF-8 NODE_ENV=prod git status')).toBe('git status')
  })

  it('遇到不安全的环境变量前缀时返回 null', () => {
    // 不在白名单中的赋值必须阻止前缀提取，否则一条曾经批准过的
    // `npm run dev` 规则就会顺带自动放行 `BACKDOOR=1 npm run dev`。
    // 这里必须强制回退到精确匹配。
    expect(extractCommandPrefix('FOO=1 git status')).toBeNull()
    expect(extractCommandPrefix('PATH=/evil:$PATH npm run dev')).toBeNull()
    expect(extractCommandPrefix('NODE_OPTIONS="--require ./evil.js" npm test')).toBeNull()
    expect(extractCommandPrefix('http_proxy=http://attacker curl example.com')).toBeNull()
  })

  it('对单 token 或无法提取前缀的命令返回 null', () => {
    expect(extractCommandPrefix('')).toBeNull()
    expect(extractCommandPrefix('ls')).toBeNull()
    expect(extractCommandPrefix('ls -la')).toBeNull()
  })

  it('会跳过子命令前的全局 flag', () => {
    // 真实失败案例：`git -C /tmp commit -m fix` 之前提取不到任何前缀，
    // 因为 token[1] 是 `-C`，而不是像子命令的字符串。
    expect(extractCommandPrefix('git -C /tmp commit -m fix')).toBe('git commit')
    expect(extractCommandPrefix('git --no-pager log --oneline')).toBe('git log')
    expect(extractCommandPrefix('git -c user.name=foo commit')).toBe('git commit')
    expect(extractCommandPrefix('git --git-dir=/tmp/.git status')).toBe('git status')
    expect(extractCommandPrefix('docker -H tcp://host:2375 ps')).toBe('docker ps')
    expect(extractCommandPrefix('docker --context default ps -a')).toBe('docker ps')
    expect(extractCommandPrefix('kubectl -n production get pods')).toBe('kubectl get')
    expect(extractCommandPrefix('kubectl --context prod --namespace foo apply -f k.yaml')).toBe('kubectl apply')
    expect(extractCommandPrefix('cargo +nightly build --release')).toBe('cargo build')
    expect(extractCommandPrefix('cargo +stable test')).toBe('cargo test')
  })

  it('对过于宽泛、无法安全锚定规则的包装命令返回 null', () => {
    // 批准 `sudo ls` 绝不能顺带批准 `sudo <任意命令>`。
    // env/time/xargs/bash -c 也是同理，这些都必须回退到精确匹配。
    expect(extractCommandPrefix('sudo npm install')).toBeNull()
    expect(extractCommandPrefix('sudo apt-get update')).toBeNull()
    expect(extractCommandPrefix('bash -c "git push"')).toBeNull()
    expect(extractCommandPrefix('sh -c "rm foo"')).toBeNull()
    expect(extractCommandPrefix('env FOO=bar npm test')).toBeNull()
    expect(extractCommandPrefix('time npm run build')).toBeNull()
    expect(extractCommandPrefix('xargs git add')).toBeNull()
    expect(extractCommandPrefix('timeout 30 npm test')).toBeNull()
    expect(extractCommandPrefix('nohup node server.js')).toBeNull()
  })

  it('可以从带引号的 powershell -Command 形式中提取 cmdlet', () => {
    expect(extractCommandPrefix('powershell -Command "Get-CimInstance Win32_LogicalDisk"')).toBe('Get-CimInstance')
    expect(extractCommandPrefix('powershell -c "Get-Process"')).toBe('Get-Process')
    expect(extractCommandPrefix('powershell.exe -Command "Get-Date"')).toBe('Get-Date')
  })

  it('可以处理在 -Command 之前带前置 flag 的 powershell 命令', () => {
    // a.log 里的真实失败案例：launcher 与 `-Command` 之间的 `-NoProfile`
    // 会让每个子代理 shell 调用都丢失“不再询问”选项。
    expect(extractCommandPrefix('powershell -NoProfile -Command "Get-CimInstance Win32_LogicalDisk"')).toBe(
      'Get-CimInstance',
    )
    expect(extractCommandPrefix('powershell -ExecutionPolicy Bypass -Command "git status"')).toBe('git')
    expect(extractCommandPrefix('powershell -NoLogo -NonInteractive -Command "Get-Process"')).toBe('Get-Process')
    expect(extractCommandPrefix('powershell -NoProfile -ExecutionPolicy Bypass -c "Get-CimInstance"')).toBe(
      'Get-CimInstance',
    )
  })

  it('可以处理未加引号的 powershell 命令参数', () => {
    expect(extractCommandPrefix('powershell -Command Get-Date')).toBe('Get-Date')
    expect(extractCommandPrefix('powershell -NoProfile -Command Get-Process')).toBe('Get-Process')
  })

  it('可以处理 powershell 调用运算符包装的命令', () => {
    expect(extractCommandPrefix('powershell -Command "& { Get-Process }"')).toBe('Get-Process')
    expect(extractCommandPrefix('powershell -NoProfile -Command "& { Get-CimInstance Win32_LogicalDisk }"')).toBe(
      'Get-CimInstance',
    )
  })

  it('可以处理 pwsh 启动器', () => {
    expect(extractCommandPrefix('pwsh -Command "Get-Process"')).toBe('Get-Process')
    expect(extractCommandPrefix('pwsh.exe -NoProfile -Command "git status"')).toBe('git')
  })

  it('对 powershell -File 返回 null（无法推导命令名）', () => {
    expect(extractCommandPrefix('powershell -File ./script.ps1')).toBeNull()
    expect(extractCommandPrefix('powershell -NoProfile -File foo.ps1 arg1')).toBeNull()
  })

  it('当 powershell 只有 flag 没有命令时返回 null', () => {
    expect(extractCommandPrefix('powershell -NoProfile -ExecutionPolicy Bypass')).toBeNull()
  })

  // Verb-Noun 形式的 cmdlet 是旧提取器漏掉的情况。
  // `Get-ChildItem -Recurse …` 之前会返回 null，因为 `-Recurse`
  // 过不了只接受小写的 SUBCOMMAND_RE，导致用户只能使用精确匹配，
  // 于是任何 `-Path` / `-Filter` 变化都会一直重复弹窗。
  it('可以把裸 PowerShell cmdlet 识别为自身前缀', () => {
    expect(extractCommandPrefix('Get-ChildItem -Recurse -Filter *.ts')).toBe('Get-ChildItem')
    expect(extractCommandPrefix('Get-ChildItem -Recurse -Filter *.ts -Path D:\\res\\x-code-cli')).toBe('Get-ChildItem')
    expect(extractCommandPrefix('Sort-Object Name')).toBe('Sort-Object')
    expect(extractCommandPrefix('Invoke-WebRequest -Uri http://example.com')).toBe('Invoke-WebRequest')
    expect(extractCommandPrefix('Set-Content -Path foo.txt -Value bar')).toBe('Set-Content')
  })

  it('不会把带连字符的 Unix 命令误判成 cmdlet', () => {
    // `apt-get` 看起来有点像 cmdlet，但它的 verb 是小写。
    // 仍然必须走 POSIX 路径处理，而不是按 PowerShell cmdlet 处理。
    expect(extractCommandPrefix('apt-get update')).toBe('apt-get update')
    expect(extractCommandPrefix('docker-compose up')).toBe('docker-compose up')
  })

  // 复合命令里，所有非只读、非 cd 类片段必须拥有一致前缀。
  // 如果不一致（例如 `A && B` 中 B 不同），就要返回 null，
  // 避免把 `A:*` 误用于批准 B。
  //
  // 注意：全只读复合命令（如 `cd D:\… ; Get-ChildItem | Sort-Object`）
  // 不会走到这里，因为 evaluateShellPermission 上游已经短路成
  // `always-allow` 了，extractCommandPrefix 根本不会被调用。
  // 这里仅覆盖至少存在一个可作为规则锚点的非只读、非 cd 片段。
  it('在推导前缀前会剥离前置的 cd/Set-Location 片段', () => {
    expect(extractCommandPrefix('cd /tmp && npm test')).toBe('npm test')
    expect(extractCommandPrefix('Set-Location D:\\foo; Set-Content -Path x.txt -Value bar')).toBe('Set-Content')
    expect(extractCommandPrefix('pushd /tmp && cargo build && popd')).toBe('cargo build')
  })

  it('在推导前缀前会剥离只读的管道尾部片段', () => {
    // 用户反馈的真实案例：只有 `npx tsc` 是非只读的；`cd`
    // 和 `head` 都只是只读的准备/展示步骤，因此保存的规则
    // 应该是 `npx tsc:*`，而不是 `cd:*` 或过于具体的精确匹配。
    expect(extractCommandPrefix('cd d:\\isoform\\foo && npx tsc --noEmit --pretty 2>&1 | head -40')).toBe('npx tsc')
    expect(extractCommandPrefix('npm run lint 2>&1 | tail -20')).toBe('npm run')
  })

  it('当复合命令片段前缀不一致时返回 null', () => {
    // 安全闸：`git commit:*` 绝不能顺带自动批准后面的
    // `git push`。片段不同，就不该有共享前缀，必须回退到精确匹配。
    expect(extractCommandPrefix('git commit -m fix && git push')).toBeNull()
    // npm install 加任意 curl 也是同理：即便旧逻辑只能推导出
    // `npm install`，第二段依然是不同命令，必须强制精确匹配。
    expect(extractCommandPrefix('npm install && curl example.com')).toBeNull()
  })

  it('当只有一个非只读片段时仍能推导前缀', () => {
    // 两段只读加一段真正命令时，就应该锚定到真正命令上。
    expect(extractCommandPrefix('cd /tmp && pnpm run build | head -20')).toBe('pnpm run')
  })
})

// extractCompoundRules 的直接测试。这个函数是复合 shell 命令下
// suggestRuleLabel 与 buildAllowRule 的核心引擎，因此这里一旦回归，
// 用户可见的“不再询问”文案以及最终落到
// `.x-code/local/permissions.json` 里的规则都会出问题。
// 下面的 buildAllowRule 测试已经有间接覆盖，但直接把规则形状写出来
// 仍然值得这点冗余。
describe('extractCompoundRules', () => {
  const ruleShape = (r: { type: string; pattern: string }) => `${r.type}:${r.pattern}`

  it('单个可推导命令会生成一条前缀规则', () => {
    const rules = extractCompoundRules('git commit -m fix')
    expect(rules?.map(ruleShape)).toEqual(['prefix:git commit'])
  })

  it('单个 Verb-Noun cmdlet 会生成一条前缀规则（仅使用 cmdlet 名）', () => {
    // 这里必须选择一个不在只读集合里的 cmdlet，否则该片段会在进入
    // 前缀阶段之前就被过滤掉。只读复合命令在上游已经短路到
    // always-allow，不需要规则。Set-Content 会写文件，是个很干净的例子。
    const rules = extractCompoundRules('Set-Content -Path foo.txt -Value bar')
    expect(rules?.map(ruleShape)).toEqual(['prefix:Set-Content'])
  })

  it('单个无法推导前缀的命令会生成一条片段级精确规则', () => {
    const rules = extractCompoundRules('findstr /n "any" file.txt')
    expect(rules?.map(ruleShape)).toEqual(['exact:findstr /n "any" file.txt'])
  })

  it('所有前缀都不同的复合命令会按顺序生成多条前缀规则', () => {
    const rules = extractCompoundRules('git commit -m a && git push origin main')
    expect(rules?.map(ruleShape)).toEqual(['prefix:git commit', 'prefix:git push'])
  })

  it('前缀可推导与不可推导混合时会生成前缀规则加精确规则，并保持顺序', () => {
    const rules = extractCompoundRules('git commit -m a && curl evil.com')
    expect(rules?.map(ruleShape)).toEqual(['prefix:git commit', 'exact:curl evil.com'])
  })

  it('会跳过前置的 cd / Set-Location 片段', () => {
    expect(extractCompoundRules('cd /tmp && npm test')?.map(ruleShape)).toEqual(['prefix:npm test'])
    expect(extractCompoundRules('Set-Location D:\\foo; Set-Content -Path x.txt -Value bar')?.map(ruleShape)).toEqual([
      'prefix:Set-Content',
    ])
    expect(extractCompoundRules('pushd /tmp && cargo build && popd')?.map(ruleShape)).toEqual(['prefix:cargo build'])
  })

  it('会跳过只读片段（如管道尾部、前置准备命令）', () => {
    expect(extractCompoundRules('npm run lint 2>&1 | tail -20')?.map(ruleShape)).toEqual(['prefix:npm run'])
    expect(extractCompoundRules('cd /foo && pnpm run build | head -20')?.map(ruleShape)).toEqual(['prefix:pnpm run'])
  })

  it('会对重复前缀去重', () => {
    const rules = extractCompoundRules('git commit -m a && git commit --amend')
    expect(rules?.map(ruleShape)).toEqual(['prefix:git commit'])
  })

  it('会对重复的片段精确匹配规则去重', () => {
    const rules = extractCompoundRules('curl evil.com && curl evil.com')
    expect(rules?.map(ruleShape)).toEqual(['exact:curl evil.com'])
  })

  it('当前缀规则与精确规则名称重叠时会分别保留两种形式', () => {
    const rules = extractCompoundRules('git commit -m a && curl evil.com && git commit --amend && curl evil.com')
    expect(rules?.map(ruleShape)).toEqual(['prefix:git commit', 'exact:curl evil.com'])
  })

  it('可以处理 PowerShell 启动器路径，并返回内部 cmdlet 的单条前缀规则', () => {
    // POWERSHELL_LAUNCHER_RE 会直接短路到 extractPowershellPrefix。
    // 整个 `powershell -Command "..."` 无论引号里的脚本是什么复合形状，
    // 都只会产出一条规则。
    expect(extractCompoundRules('powershell -Command "Get-CimInstance Win32_LogicalDisk"')?.map(ruleShape)).toEqual([
      'prefix:Get-CimInstance',
    ])
    expect(extractCompoundRules('powershell -NoProfile -Command "& { Get-Process }"')?.map(ruleShape)).toEqual([
      'prefix:Get-Process',
    ])
    expect(extractCompoundRules('powershell -File ./script.ps1')).toBeNull()
  })

  it('当片段带有非白名单环境变量前缀时返回 null', () => {
    // 与 extractSingleCommandPrefix 的防御逻辑相同：`BACKDOOR=1 …`
    // 这种前缀会污染整个片段，不能安全转成规则。调用方会通过
    // buildAllowRule 中 stripSafeEnvVars 的分支回退为整条命令的精确匹配。
    expect(extractCompoundRules('BACKDOOR=1 git status')).toBeNull()
    expect(extractCompoundRules('git commit -m a && PATH=/evil:$PATH something')).toBeNull()
  })

  it('会在片段精确规则中剥离白名单环境变量前缀', () => {
    // `NODE_ENV=prod` 在 SAFE_ENV_VARS 中，因此保存前会被剥离，
    // 这样 matcher 的键值形态才能保持规范一致。
    const rules = extractCompoundRules('NODE_ENV=prod findstr /v foo bar.txt')
    expect(rules?.map(ruleShape)).toEqual(['exact:findstr /v foo bar.txt'])
  })

  it('对空字符串或纯空白输入返回 null', () => {
    expect(extractCompoundRules('')).toBeNull()
    expect(extractCompoundRules('   ')).toBeNull()
  })

  it('对全只读复合命令返回 null（上游已自动放行）', () => {
    // `cd /tmp && ls -la` 完全是只读的。每个片段都会被过滤掉，
    // 最终无规则可推导。实际运行中 evaluateShellPermission 会在到这里前
    // 就短路为 always-allow，因此这里返回 null 是一种防御性的
    // “无需规则”信号。
    expect(extractCompoundRules('cd /tmp && ls -la')).toBeNull()
    expect(extractCompoundRules('Get-ChildItem -Recurse | Sort-Object Name | Select-Object Name')).toBeNull()
  })

  it('会给每条规则都打上 tool=\"shell\" 标记', () => {
    // 磁盘上存储的 AllowRule 能否生效取决于这个字段，
    // 缺失或错误都会导致 matcher 找不到规则。
    const rules = extractCompoundRules('git commit -m a && curl evil.com')
    expect(rules?.every((r) => r.tool === 'shell')).toBe(true)
  })
})

describe('isPathWithinProject', () => {
  const cwd = process.cwd()

  it('项目内路径返回 true', () => {
    expect(isPathWithinProject(`${cwd}/src/index.ts`, cwd)).toBe(true)
    expect(isPathWithinProject(`${cwd}/deep/nested/file.ts`, cwd)).toBe(true)
  })

  it('当文件路径等于项目目录时返回 true', () => {
    expect(isPathWithinProject(cwd, cwd)).toBe(true)
  })

  it('项目外路径返回 false', () => {
    expect(isPathWithinProject('/etc/passwd', cwd)).toBe(false)
    expect(isPathWithinProject('/tmp/evil.ts', cwd)).toBe(false)
  })

  it('路径穿越场景返回 false', () => {
    expect(isPathWithinProject(`${cwd}/../../etc/passwd`, cwd)).toBe(false)
    expect(isPathWithinProject(`${cwd}/../secret`, cwd)).toBe(false)
  })
})

describe('suggestRuleLabel + buildAllowRule fallback for unrecognised shell commands', () => {
  it('会为第二个 token 是 /flag 的 Windows 命令提供精确匹配标签', () => {
    // 真实失败案例：`findstr /n "any\b" "..." 2>nul` 之前只显示 Yes/No，
    // 没有“不再询问”，因为 `/n` 过不了前缀正则。精确匹配回退给了用户出口。
    const input = { command: 'findstr /n "any\\b" "D:\\res\\file.ts" 2>nul' }
    expect(suggestRuleLabel('shell', input)).toBe('this exact command')
    const built = buildAllowRule('shell', input)
    expect(built).not.toBeNull()
    expect(built!.persist).toBe(true)
    expect(built!.rules).toHaveLength(1)
    expect(built!.rules[0]!.type).toBe('exact')
    expect(built!.rules[0]!.pattern).toBe(input.command)
  })

  it('只要能推导前缀，就仍然优先使用前缀规则', () => {
    expect(suggestRuleLabel('shell', { command: 'git commit -m fix' })).toBe('git commit:*')
    const built = buildAllowRule('shell', { command: 'git commit -m fix' })
    expect(built!.rules).toHaveLength(1)
    expect(built!.rules[0]!.type).toBe('prefix')
    expect(built!.rules[0]!.pattern).toBe('git commit')
  })

  it('在存储精确匹配规则前会先剥离环境变量前缀', () => {
    // `NODE_ENV=prod` 属于 SAFE 环境变量前缀；matcher 比较的是
    // `stripEnvVars(cmd)`，因此规则里也必须保存成同样被剥离后的形态。
    const built = buildAllowRule('shell', { command: 'NODE_ENV=prod findstr /v foo bar.txt' })
    expect(built!.rules).toHaveLength(1)
    expect(built!.rules[0]!.type).toBe('exact')
    expect(built!.rules[0]!.pattern).toBe('findstr /v foo bar.txt')
  })

  it('对空 shell 命令返回空标签或空规则', () => {
    expect(suggestRuleLabel('shell', { command: '' })).toBe('this exact command')
    // buildAllowRule 在剥离之后若命令仍为空，依旧会直接放弃构建。
    expect(buildAllowRule('shell', { command: '' })).toBeNull()
  })

  it('会让 writeFile/edit 保持为仅会话级别的工具规则', () => {
    expect(suggestRuleLabel('writeFile', {})).toBe('all edits this session')
    const built = buildAllowRule('writeFile', {})
    expect(built!.rules).toHaveLength(1)
    expect(built!.rules[0]!.type).toBe('tool')
    expect(built!.persist).toBe(false)
  })

  it('会为复合 shell 命令的每个不同前缀分别保存规则', () => {
    // 线上 CLI 的真实投诉案例：`git commit && git push` 以前会显示
    // “this exact command”，因为两个片段前缀不同。现在我们会在标签里
    // 同时展示两个前缀，并一次保存两条规则，这样后续
    // `git commit -m foo && git push origin main` 就不会再反复提示。
    const cmd = 'git commit && git push'
    expect(suggestRuleLabel('shell', { command: cmd })).toBe('git commit:*, git push:*')
    const built = buildAllowRule('shell', { command: cmd })
    expect(built!.persist).toBe(true)
    expect(built!.rules.map((r) => `${r.type}:${r.pattern}`)).toEqual(['prefix:git commit', 'prefix:git push'])
  })

  it('会对复合命令里的重复前缀去重', () => {
    // `git commit -m a && git commit --amend` 本质上是同一个前缀，
    // 保存一条就足够了。
    const built = buildAllowRule('shell', { command: 'git commit -m a && git commit --amend' })
    expect(built!.rules).toHaveLength(1)
    expect(built!.rules[0]!.pattern).toBe('git commit')
  })

  it('当只有部分片段能提取前缀时，会同时混合前缀规则和精确规则', () => {
    // `git commit -m a && curl evil.com` 中，第一段有干净前缀，
    // 第二段没有（`evil.com` 过不了 SUBCOMMAND_RE）。
    // 旧设计会把它塌缩成整条命令的精确规则，丢掉可推导的
    // `git commit:*`。现在两者都会被保留，标签也会同时展示，
    // 让用户知道自己批准了什么。
    const cmd = 'git commit -m a && curl evil.com'
    expect(suggestRuleLabel('shell', { command: cmd })).toBe('git commit:*, curl evil.com')
    const built = buildAllowRule('shell', { command: cmd })
    expect(built!.persist).toBe(true)
    expect(built!.rules.map((r) => `${r.type}:${r.pattern}`)).toEqual(['prefix:git commit', 'exact:curl evil.com'])
  })

  // 端到端测试：对一个复合命令点一次批准会保存多条规则；
  // matcher 随后会自动放行未来的复合变体以及各自单独出现的规则，
  // 但仍会拒绝任何包含未批准命令的新复合命令。
  it('复合命令批准会覆盖未来变体，但不会放行无关新增命令', () => {
    clearSessionRules()
    const built = buildAllowRule('shell', { command: 'git commit && git push' })!
    for (const r of built.rules) addSessionAllowRule(r)

    expect(sessionRulesMatch('shell', { command: 'git commit -m foo && git push' })).toBe(true)
    expect(sessionRulesMatch('shell', { command: 'cd /tmp && git commit -m a && git push origin main' })).toBe(true)
    expect(sessionRulesMatch('shell', { command: 'git commit --amend' })).toBe(true)
    expect(sessionRulesMatch('shell', { command: 'git push -u origin main' })).toBe(true)

    // `npm test` 从未被批准，因此整个复合命令仍应重新提示。
    // （`git tag` 看上去也许更直观，但它的裸形式在 git 只读子命令列表里，
    // 所以不会进入待检查片段集合。）
    expect(sessionRulesMatch('shell', { command: 'git commit -m a && git push && npm test' })).toBe(false)
    // 纵深防御：如果复合命令只批准了一半，而第二段又无法推导前缀，
    // 那也绝不能自动放行。
    expect(sessionRulesMatch('shell', { command: 'git commit -m a && curl evil.com' })).toBe(false)
    clearSessionRules()
  })

  it('对 enterPlanMode 返回 null（没有可复用的重复动作）', () => {
    expect(suggestRuleLabel('enterPlanMode', {})).toBeNull()
  })

  it('当 isMcp 为 true 时，无论工具名是什么都返回 “this MCP tool”', () => {
    // MCP 工具以前会错误落入 writeFile 分支，显示成
    // “all edits this session”，这既是错误文案，也是错误的持久化姿态。
    // MCP 的 always-allow 规则会通过 McpPermissionStore 落盘，而不是仅会话级。
    // 显式的 isMcp 标记会跳过 shell / write 分支，直接返回 MCP 专用标签。
    expect(suggestRuleLabel('filesystem__read_file', { path: '/tmp' }, true)).toBe('this MCP tool')
    expect(suggestRuleLabel('any_name_at_all', {}, true)).toBe('this MCP tool')
  })
})
