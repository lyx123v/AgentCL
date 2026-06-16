// @x-code-cli/cli - /mcp slash 命令处理器家族。
//
// 从 App.tsx 中抽出来的工厂函数，会闭包捕获 registry、
// permission store、plugin registry（供 refresh 时合并 plugin-mcp 用）、
// prompt cache 失效器，以及四个 UI 侧 hook（addCommandMessage、
// addCommandResult、askQuestion）。
//
// 子命令包括：list / tools / auth / logout / refresh / add / add-json / remove。
// Add/Remove 支持 `--scope=user|project`；`--scope project` 会自动信任项目，
// 以便下次启动直接通过。
import {
  detectScope,
  getMcpConfigPath,
  getPluginMcpServersFromDisk,
  getTokenStorage,
  loadMergedConfigsFromDisk,
  parseAdd,
  parseAddJson,
  parseRemove,
  readServerConfig,
  removeServerFromConfig,
  serverExists,
  trustProject,
  writeServerToConfig,
} from '@x-code-cli/core'
import type { AgentOptions } from '@x-code-cli/core'

export interface McpCommandDeps {
  options: AgentOptions
  addCommandMessage: (text: string, content: string) => void
  addCommandResult: (content: string) => void
  askQuestion: (
    question: string,
    options: { label: string; description: string }[],
    opts?: { noOther?: boolean },
  ) => Promise<string>
  invalidateSystemPromptCache: () => void
}

export function createMcpCommandHandler(deps: McpCommandDeps) {
  const { options, addCommandMessage, addCommandResult, askQuestion, invalidateSystemPromptCache } = deps

  /** `/mcp add` - 把一个新 server 写入 user（默认）或 project config。
   *
   *  这里不会自动连接：如果在会话中途改变 tool surface，会让 prompt cache 失效，
   *  下一轮就会强制 miss（OpenAI-compatible provider 的 prefix cache 也一样）。
   *  所以会提示用户在准备好时执行 `/mcp refresh` 或者重启，
   *  这和设计文档里“显式 refresh”的理念一致。
   *
   *  `--scope project` 还会自动信任该项目（运行命令的用户本身就是 consent 信号，
   *  没必要让他下一次启动时再确认一遍 trust dialog）。
   *  但克隆了仓库的协作者仍然会正常走对话框。 */
  async function handleMcpAdd(text: string, subArgRaw: string): Promise<void> {
    const res = parseAdd(subArgRaw)
    if (!res.ok) {
      addCommandMessage(text, res.error)
      return
    }
    const { name, scope, config } = res.command

    // 在请求的 scope 内做重复检查。这里刻意使用 `serverExists`，
    // 而不是 `detectScope`：因为允许跨 scope 重名。
    //（user scope 和 project scope 的 server 可以合法共享同一个名字，
    // 例如个人版和团队共享版。）只有同 scope 冲突才会阻止 add。
    if (await serverExists(name, scope, process.cwd())) {
      const existing = await readServerConfig(name, scope, process.cwd())
      const summary =
        existing && typeof existing === 'object'
          ? JSON.stringify(existing, null, 2)
              .split('\n')
              .map((l) => '  ' + l)
              .join('\n')
          : '(unreadable)'
      addCommandMessage(
        text,
        [
          `Server "${name}" already exists in ${scope} scope:`,
          summary,
          '',
          `Run /mcp remove --scope ${scope} ${name} first, or pick a different name.`,
        ].join('\n'),
      )
      return
    }

    let written: { path: string }
    try {
      written = await writeServerToConfig(name, config, scope, process.cwd())
    } catch (err) {
      addCommandMessage(text, `Failed to add "${name}": ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    // 对 project scope 自动信任这个路径，这样用户下次启动时
    // 不会撞上自己的 consent dialog。
    let autoTrusted = false
    if (scope === 'project') {
      try {
        await trustProject(process.cwd())
        autoTrusted = true
      } catch {
        // 非致命错误 —— 用户下次启动时只会再次看到 trust dialog。
      }
    }

    const transport = 'url' in config ? 'http' : 'stdio'
    const lines = [`Added MCP server "${name}" (${transport}) to ${written.path}.`]
    if (autoTrusted) {
      lines.push('Auto-trusted this project for future launches.')
    }
    if (scope === 'project') {
      lines.push('Tip: commit `.x-code/config.json` to share with collaborators.')
    }
    lines.push('Run /mcp refresh to load it now, or restart xc.')
    addCommandMessage(text, lines.join('\n'))
  }

  /** `/mcp add-json` - 与 `/mcp add` 类似，但直接接收一个原始 JSON 对象作为
   *  config body。它是复杂配置的逃生通道，适合命令行 flag 不够用的场景
   *  （嵌套 env、多个 header、自定义 cwd 等）。 */
  async function handleMcpAddJson(text: string, subArgRaw: string): Promise<void> {
    const res = parseAddJson(subArgRaw)
    if (!res.ok) {
      addCommandMessage(text, res.error)
      return
    }
    const { name, scope, config } = res.command

    if (await serverExists(name, scope, process.cwd())) {
      addCommandMessage(
        text,
        `Server "${name}" already exists in ${scope} scope. Run /mcp remove --scope ${scope} ${name} first.`,
      )
      return
    }

    let written: { path: string }
    try {
      written = await writeServerToConfig(name, config, scope, process.cwd())
    } catch (err) {
      addCommandMessage(text, `Failed to add "${name}": ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    let autoTrusted = false
    if (scope === 'project') {
      try {
        await trustProject(process.cwd())
        autoTrusted = true
      } catch {
        // 尽力而为
      }
    }

    const lines = [`Added MCP server "${name}" to ${written.path}.`]
    if (autoTrusted) lines.push('Auto-trusted this project for future launches.')
    if (scope === 'project') lines.push('Tip: commit `.x-code/config.json` to share with collaborators.')
    lines.push('Run /mcp refresh to load it now, or restart xc.')
    addCommandMessage(text, lines.join('\n'))
  }

  /** `/mcp remove` - 从 config.json 里删除一个 server。
   *  在做任何破坏性操作前都会先询问 y/N（其他竞品通常直接删，我们保留这一步，
   *  因为一个手误就可能干掉真实条目，而多按一下键的成本几乎可以忽略）。
   *  当前会话会继续使用它已经加载的内容 —— 中途断开反而更亏
   *  （正在运行的工具调用会变成孤儿），好处却不大
   *  （文件改动只会在下次启动 / refresh 时生效）。 */
  async function handleMcpRemove(text: string, subArgRaw: string): Promise<void> {
    const res = parseRemove(subArgRaw)
    if (!res.ok) {
      addCommandMessage(text, res.error)
      return
    }
    const { name } = res.command
    let scope = res.command.scope

    if (!scope) {
      // 自动检测。歧义场景（两个 scope 都存在）会强制要求显式
      // `--scope`，避免我们悄悄删错对象。
      const detected = await detectScope(name, process.cwd())
      switch (detected.kind) {
        case 'not-found':
          addCommandMessage(text, `Server "${name}" is not in user or project config — nothing to remove.`)
          return
        case 'both':
          addCommandMessage(text, `Server "${name}" exists at both scopes. Specify --scope user or --scope project.`)
          return
        case 'user':
        case 'project':
          scope = detected.kind
          break
      }
    } else {
      // 显式 scope：先确认条目确实存在，再去打扰用户弹确认框。
      if (!(await serverExists(name, scope, process.cwd()))) {
        addCommandMessage(
          text,
          `Server "${name}" is not in ${scope} scope (${getMcpConfigPath(scope, process.cwd())}) — nothing to remove.`,
        )
        return
      }
    }

    const confirmAnswer = await askQuestion(
      `Remove MCP server "${name}" from ${scope} scope?\n  (${getMcpConfigPath(scope, process.cwd())})`,
      [
        { label: 'Remove', description: 'Delete this server entry. Current session unchanged.' },
        { label: 'Cancel', description: 'Keep the config as-is.' },
      ],
      { noOther: true },
    )
    if (confirmAnswer !== 'Remove') {
      addCommandMessage(text, `Cancelled — "${name}" not removed.`)
      return
    }

    let result: { path: string; removed: boolean }
    try {
      result = await removeServerFromConfig(name, scope, process.cwd())
    } catch (err) {
      addCommandMessage(text, `Failed to remove "${name}": ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (!result.removed) {
      // 竞态：有人在检测和删除之间把文件或条目删掉了。
      // 这是幂等路径 —— 直接告诉用户就行。
      addCommandMessage(text, `Server "${name}" was already gone from ${scope} scope.`)
      return
    }

    addCommandMessage(
      text,
      [
        `Removed "${name}" from ${scope} scope (${result.path}).`,
        'Current session unchanged — the running server (if any) keeps working until xc exits.',
        `Stored OAuth tokens (if any) kept — run /mcp logout ${name} to clear them too.`,
      ].join('\n'),
    )
  }

  async function handleMcp(text: string, arg: string): Promise<void> {
    const argTrimmed = arg.trim()
    const sub = (argTrimmed.split(/\s+/)[0] ?? '').toLowerCase()
    const subArg = argTrimmed.slice(sub.length).trim()
    const registry = options.mcpRegistry

    switch (sub) {
      case '':
      case 'list': {
        const statuses = registry?.serverStatus() ?? []
        if (statuses.length === 0) {
          addCommandMessage(text, '没有配置任何 MCP server。把 `mcpServers` 加到 ~/.x-code/config.json 后再重启。')
          return
        }
        const lines = ['MCP servers：']
        const namePad = Math.max(...statuses.map((s) => s.name.length), 8) + 2
        for (const s of statuses) {
          let badge = ''
          switch (s.status.kind) {
            case 'connected':
              badge = `已连接 — ${s.status.toolCount} 个 tool，${s.status.resourceCount} 个 resource`
              break
            case 'disabled':
              badge = '已禁用'
              break
            case 'connecting':
              badge = '连接中…'
              break
            case 'needs_auth':
              badge = `需要认证 — 运行 /mcp auth ${s.name} 登录`
              break
            case 'failed':
              badge = `失败 — ${s.status.error}`
              break
          }
          lines.push(`  ${s.name.padEnd(namePad)} ${badge}`)
        }
        addCommandMessage(text, lines.join('\n'))
        return
      }
      case 'tools': {
        const all = registry?.list() ?? []
        const filtered = subArg ? all.filter((t) => t.serverName === subArg) : all
        if (filtered.length === 0) {
          addCommandMessage(text, subArg ? `服务器 "${subArg}" 上没有 tool。` : '没有可用的 MCP tool。')
          return
        }
        const lines = [subArg ? `服务器 ${subArg} 上的 MCP tool：` : '全部 MCP tool：']
        for (const t of filtered) {
          const desc = t.description ? ` — ${t.description.slice(0, 160).replace(/\s+/g, ' ').trim()}` : ''
          lines.push(`  ${t.callableName}${desc}`)
        }
        addCommandMessage(text, lines.join('\n'))
        return
      }
      case 'auth': {
        if (!subArg) {
          addCommandMessage(text, '用法：/mcp auth <server-name>')
          return
        }
        if (!registry) {
          addCommandMessage(text, '没有配置任何 MCP server。请先把 `mcpServers` 加到 ~/.x-code/config.json。')
          return
        }
        const config = registry.getConfig(subArg)
        if (!config) {
          addCommandMessage(text, `未知的 MCP server：“${subArg}”。运行 /mcp list 查看已配置的 server。`)
          return
        }
        if (!('url' in config) || typeof config.url !== 'string') {
          addCommandMessage(
            text,
            `MCP server “${subArg}” 是 stdio server —— OAuth 只适用于 HTTP server（也就是带 "url" 字段的配置）。`,
          )
          return
        }
        // 先把已存 token 清掉。
        // 如果用户在一个本来就有有效 token 的 server 上跑 `/mcp auth`，
        // 我们希望强制重新认证（这和 Gemini CLI 的语义一致：
        // 再跑一次 auth 表示“让我从头登录”，不是“帮我验证现有会话”）。
        // 如果只是想清理但不想重新认证，单独的 `/mcp logout` 可以用。
        try {
          await getTokenStorage().clear(subArg)
        } catch {
          // 尽力而为；即使 token store 不可写，后续流程也还能继续，
          // 用户会在 `finishAuth` 尝试保存时看到真正的失败原因。
        }
        addCommandMessage(text, `正在认证 “${subArg}”——正在打开浏览器...`)
        try {
          const server = await registry.authenticateServer(subArg, {
            onBrowserOpen: (url) => {
              addCommandResult(`已打开 ${url}\n等待授权重定向...`)
            },
          })
          if (server.status.kind === 'connected') {
            // tool surface 可能变大了 —— 失效缓存，
            // 这样下一轮就会用新可用的工具重新构建 system prompt。
            invalidateSystemPromptCache()
            addCommandResult(
              `✓ Authenticated "${subArg}" — ${server.status.toolCount} tool${
                server.status.toolCount === 1 ? '' : 's'
              }, ${server.status.resourceCount} resource${server.status.resourceCount === 1 ? '' : 's'}`,
            )
          } else if (server.status.kind === 'needs_auth') {
            addCommandResult(`⚠ server 仍然需要认证。浏览器流程可能被取消了。`)
          } else if (server.status.kind === 'failed') {
            addCommandResult(`✗ 认证完成，但 server 连接失败：${server.status.error}`)
          } else {
            addCommandResult(`server 当前状态：${server.status.kind}`)
          }
        } catch (err) {
          addCommandResult(`✗ 认证失败：${err instanceof Error ? err.message : String(err)}`)
        }
        return
      }
      case 'logout': {
        if (!subArg) {
          addCommandMessage(text, '用法：/mcp logout <server-name>')
          return
        }
        try {
          await getTokenStorage().clear(subArg)
          addCommandMessage(
            text,
            `已移除 “${subArg}” 的 OAuth token。运行 /mcp auth ${subArg} 重新登录。`,
          )
        } catch (err) {
          addCommandMessage(text, `清理 token 失败：${err instanceof Error ? err.message : String(err)}`)
        }
        return
      }
      case 'refresh': {
        if (!registry) {
          addCommandMessage(text, '没有可刷新的 MCP registry。')
          return
        }
        addCommandMessage(text, '正在重新读取 MCP 配置并重连 server...')
        try {
          // 把插件贡献的 mcpServers 也纳入合并后的 map。
          // 否则在插件安装之后执行 `/mcp refresh`，会把所有由插件贡献的 server
          // 悄悄丢掉，因为合并结果里只有 user + project 条目。
          // 如果插件扫描失败，这个 helper 会退化成 `{}`（错误会记到 debug.log），
          // 这样一次只刷新 MCP 的操作不会因为无关的插件系统抖动而失败。
          const extraServers = options.pluginRegistry ? await getPluginMcpServersFromDisk(process.cwd()) : undefined
          const { configs, configErrors, projectSkipped } = await loadMergedConfigsFromDisk({
            cwd: process.cwd(),
            askUser: (q, opts) => askQuestion(q, opts, { noOther: true }),
            extraServers,
          })
          const summary = await registry.restartAll(configs)
          invalidateSystemPromptCache()

          const parts: string[] = []
          if (summary.added.length) parts.push(`新增：${summary.added.join(', ')}`)
          if (summary.removed.length) parts.push(`移除：${summary.removed.join(', ')}`)
          if (summary.changed.length) parts.push(`变更：${summary.changed.join(', ')}`)
          if (summary.unchanged.length) parts.push(`重新连接：${summary.unchanged.join(', ')}`)
          if (parts.length === 0) parts.push('没有配置任何 server')
          const lines = [`MCP 已重新加载 — ${parts.join('；')}。`]
          lines.push('注意：下一条消息会重新构建 system prompt，因此 prompt-cache 会失效一次。')
          if (projectSkipped) lines.push('注意：project 级 MCP server 已跳过（未信任）。')
          for (const e of configErrors) lines.push(`配置错误：${e.name}: ${e.message}`)
          addCommandResult(lines.join('\n'))
        } catch (err) {
          addCommandResult(`✗ 刷新失败：${err instanceof Error ? err.message : String(err)}`)
        }
        return
      }
      case 'add':
        await handleMcpAdd(text, subArg)
        return

      case 'add-json':
        await handleMcpAddJson(text, subArg)
        return

      case 'remove':
      case 'rm':
        await handleMcpRemove(text, subArg)
        return

      default: {
        addCommandMessage(text, `未知子命令：/mcp ${sub}。可用：list, tools, add, add-json, remove, auth, logout, refresh。`)
        return
      }
    }
  }

  return { handleMcp }
}
