// @x-code-cli/cli - /skill 斜杠命令处理器。
//
// 这个处理器是从 App.tsx 里抽出来的工厂函数，闭包捕获了各个子命令需要的依赖：
// registry 访问（读取 + 重新加载）、设置写入、prompt cache 失效处理，以及
// pending-skill 引用。最后返回给 App.tsx 里的分发器调用。
//
// 支持的子命令：install / list / refresh / disable / enable / uninstall。
// 不认识的子命令会输出使用提示。
import fs from 'node:fs/promises'
import path from 'node:path'

import {
  USER_XCODE_DIR,
  getScopedDisabledSkills,
  reloadSkillRegistry,
  setSkillDisabled,
  skillSettingsPath,
} from '@x-code-cli/core'
import type { AgentOptions, SkillDefinition, SkillSettingsScope } from '@x-code-cli/core'

export interface SkillCommandDeps {
  options: AgentOptions
  addCommandMessage: (text: string, content: string) => void
  invalidateSystemPromptCache: () => void
  pendingSkillRef: { current: SkillDefinition | null }
  bumpSkillRegistryVersion: () => void
}

/** SKILL.md frontmatter 的最小 YAML 名称提取器。
 *  这里只需要找到 `name: <value>`，完整解析交给加载器。 */
function extractSkillName(content: string): string | null {
  const match = content.match(/^---\r?\n[\s\S]*?^name:\s*["']?([^"'\r\n]+)["']?\s*$/m)
  return match ? match[1].trim() : null
}

/** 把 skill 参数拆成 `(name, scope)`，支持识别
 *  `--scope=user` / `--scope=project` / `-s=user` 等写法。
 *  如果只有裸参数、没有 scope 标记，就返回 `scope: undefined`，
 *  让调用方根据 skill 的来源自己决定默认范围。
 *  不认识的 scope 字符串会被忽略（scope 继续保持 undefined）——
 *  这样解析器会更宽松。 */
function parseSkillScopeFlag(arg: string): { name: string; scope?: SkillSettingsScope } {
  const tokens = arg.split(/\s+/).filter(Boolean)
  let scope: SkillSettingsScope | undefined
  const remaining: string[] = []
  for (const tok of tokens) {
    const m = tok.match(/^(?:--scope|-s)(?:=(.+))?$/)
    if (m) {
      const value = m[1]?.toLowerCase()
      if (value === 'user' || value === 'project') scope = value
      continue
    }
    remaining.push(tok)
  }
  return { name: remaining.join(' '), scope }
}

export function createSkillCommandHandler(deps: SkillCommandDeps) {
  const { options, addCommandMessage, invalidateSystemPromptCache, pendingSkillRef, bumpSkillRegistryVersion } = deps

  async function handleSkill(text: string, arg: string): Promise<void> {
    const parts = arg.trim().split(/\s+/)
    const sub = parts[0]?.toLowerCase()
    const subArg = parts.slice(1).join(' ').trim()

    if (sub === 'install') {
      if (!subArg) {
        addCommandMessage(text, 'Usage: `/skill install <url>`')
        return
      }
      let content: string
      try {
        const res = await fetch(subArg)
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
        content = await res.text()
      } catch (err) {
        addCommandMessage(text, `Failed to fetch \`${subArg}\`: ${err instanceof Error ? err.message : String(err)}`)
        return
      }

      const name = extractSkillName(content)
      if (!name) {
        addCommandMessage(text, 'Invalid SKILL.md: missing `name` in frontmatter.')
        return
      }

      const skillDir = path.join(USER_XCODE_DIR, 'skills', name)
      const skillFile = path.join(skillDir, 'SKILL.md')
      try {
        await fs.mkdir(skillDir, { recursive: true })
        await fs.writeFile(skillFile, content, 'utf-8')
      } catch (err) {
        addCommandMessage(text, `Failed to save skill: ${err instanceof Error ? err.message : String(err)}`)
        return
      }

      addCommandMessage(
        text,
        `Skill **${name}** installed to \`${skillFile}\`\nRun \`/skill refresh\` to use \`/${name}\` now, or restart xc.`,
      )
      return
    }

    if (sub === 'list') {
      const skills = options.skillRegistry?.listAll() ?? []
      if (skills.length === 0) {
        const skillsPath = path.join(USER_XCODE_DIR, 'skills', '<name>', 'SKILL.md')
        addCommandMessage(
          text,
          `No skills loaded. Place SKILL.md files in \`${skillsPath}\` then run \`/skill refresh\` (or restart).`,
        )
        return
      }
      const lines = skills.map((s) => {
        const tag = s.disabled ? '[off]' : '[on] '
        return `- ${tag} **${s.name}** (${s.source}): ${s.description}`
      })
      addCommandMessage(text, `**Loaded skills** (${skills.length}):\n${lines.join('\n')}`)
      return
    }

    if (sub === 'refresh') {
      if (!options.skillRegistry) {
        addCommandMessage(text, 'No skill registry to refresh.')
        return
      }
      let summary
      try {
        summary = await reloadSkillRegistry(options.skillRegistry)
      } catch (err) {
        addCommandMessage(text, `Failed to reload skills: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
      // 失效 prompt cache：系统 prompt 里的 `## Available Skills` 区块
      // 和 activateSkill 工具描述都嵌入了 skill 列表。宁可让缓存 miss 一次，
      // 也不要把过期的 skill 面暴露给模型。/mcp refresh 也是同样的权衡。
      invalidateSystemPromptCache()
      // 如果用户刚刚触发的 `/<skillname>` 对应的 skill 已经被移除或禁用，
      // 就把 pending skill 清掉。否则下一条普通用户消息会注入一段孤儿 skill 内容。
      const pending = pendingSkillRef.current
      if (pending && !options.skillRegistry.get(pending.name)) {
        pendingSkillRef.current = null
      }
      // 强制斜杠命令的 tab completion 和 /help 列表重新基于新的 skill 集合做 memo。
      // registry 对象本身的身份是稳定的（reload() 是原地修改），所以这里需要一个
      // version counter 来告诉 React 该重新计算缓存列表了。
      bumpSkillRegistryVersion()

      const summaryParts: string[] = []
      if (summary.added.length) summaryParts.push(`added: ${summary.added.join(', ')}`)
      if (summary.removed.length) summaryParts.push(`removed: ${summary.removed.join(', ')}`)
      if (summary.changed.length) summaryParts.push(`changed: ${summary.changed.join(', ')}`)
      if (summary.unchanged.length) summaryParts.push(`unchanged: ${summary.unchanged.join(', ')}`)
      if (summaryParts.length === 0) summaryParts.push('no skills found')
      const lines = [`Reloaded skills — ${summaryParts.join('; ')}.`]
      // 主结果和提示说明之间只留一个紧凑的 `\n`，和 /mcp refresh 以及
      // /skill install / disable / enable / remove 的输出风格保持一致。
      // 单个命令结果块内部不额外空一行。
      lines.push('Note: next message rebuilds the system prompt, so prompt-cache will miss once.')
      addCommandMessage(text, lines.join('\n'))
      return
    }

    if (sub === 'disable' || sub === 'enable') {
      const name = subArg.trim()
      if (!name) {
        addCommandMessage(text, `Usage: \`/skill ${sub} <name> [--scope=user|project]\``)
        return
      }
      const { name: bareName, scope } = parseSkillScopeFlag(name)
      const entry = options.skillRegistry?.getEntry(bareName)
      if (!entry) {
        addCommandMessage(
          text,
          `No skill named \`${bareName}\` is loaded. Run \`/skill list\` to see available skills.`,
        )
        return
      }
      // 默认把 disable 的 scope 设成 skill 自己的来源，这样用户输入
      // “禁用 project skill yansu” 时不用额外写 `--scope`。
      // enable 的逻辑是对称的：先把来源 scope 里的禁用项清掉；如果 skill
      // 仍然处于有效禁用状态，那就说明另一个 scope 里也列了它，
      // 我们会把这个情况提示出来。
      const effectiveScope: SkillSettingsScope = scope ?? entry.source
      const disable = sub === 'disable'
      let result: 'changed' | 'noop'
      try {
        result = await setSkillDisabled(bareName, effectiveScope, disable)
      } catch (err) {
        addCommandMessage(text, `Failed to update settings: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
      const settingsFile = skillSettingsPath(effectiveScope)
      if (result === 'noop') {
        addCommandMessage(
          text,
          disable
            ? `Skill **${bareName}** is already disabled in ${effectiveScope} settings (\`${settingsFile}\`).`
            : `Skill **${bareName}** is not disabled in ${effectiveScope} settings (\`${settingsFile}\`).`,
        )
        return
      }
      // re-enable 之后，检查另一个 scope 是否还在隐藏它。
      // 这是个常见坑：用户先在 user scope 禁用，再期待 project scope 的 enable
      // 能把它救回来，但如果另一个 scope 里也列着，这样其实不会生效。
      let otherScopeNote = ''
      if (!disable) {
        const other: SkillSettingsScope = effectiveScope === 'user' ? 'project' : 'user'
        try {
          const stillDisabled = (await getScopedDisabledSkills(other)).includes(bareName)
          if (stillDisabled) {
            otherScopeNote = `\n_Note: \`${bareName}\` is also listed in ${other} settings (\`${skillSettingsPath(other)}\`). Run \`/skill enable ${bareName} --scope=${other}\` to fully re-enable._`
          }
        } catch {
          // 尽力给提示即可，失败就静默忽略
        }
      }
      const verb = disable ? 'Disabled' : 'Enabled'
      addCommandMessage(
        text,
        `${verb} skill **${bareName}** in ${effectiveScope} settings (\`${settingsFile}\`).${otherScopeNote}\nRun \`/skill refresh\` to apply now, or restart xc.`,
      )
      return
    }

    if (sub === 'uninstall') {
      const name = subArg.trim()
      if (!name) {
        addCommandMessage(text, 'Usage: `/skill uninstall <name>`')
        return
      }
      const entry = options.skillRegistry?.getEntry(name)
      if (!entry) {
        addCommandMessage(text, `No skill named \`${name}\` is loaded. Run \`/skill list\` to see available skills.`)
        return
      }
      // 插件贡献的 skill 实际放在插件自己的 cache 目录里，而不是
      // <baseDir>/skills/。这里直接跑 `/skill uninstall` 会算错路径，
      // 要么静默无操作，要么误删别的目录，所以要把用户导向
      // `/plugin uninstall`。
      if (entry.pluginId) {
        addCommandMessage(
          text,
          `Skill **${name}** comes from plugin \`${entry.pluginId}\` — uninstall it with \`/plugin uninstall ${entry.pluginId}\` instead of \`/skill uninstall\`.`,
        )
        return
      }
      const baseDir = entry.source === 'user' ? USER_XCODE_DIR : path.join(process.cwd(), '.x-code')
      const skillDir = path.join(baseDir, 'skills', name)
      try {
        await fs.rm(skillDir, { recursive: true, force: true })
      } catch (err) {
        addCommandMessage(text, `Failed to remove \`${skillDir}\`: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
      // 同时清掉所有 disable 记录。
      // 不然这些指向已卸载 skill 的旧条目会把未来同名重装悄悄吞掉，
      // 导致它“装回来了但还是被禁用”。
      try {
        await setSkillDisabled(name, 'user', false)
        await setSkillDisabled(name, 'project', false)
      } catch {
        // 尽力而为即可 - 主要的 rm 已经成功了
      }
      addCommandMessage(
        text,
        `Uninstalled skill **${name}** from \`${skillDir}\`.\nRun \`/skill refresh\` to apply now, or restart xc.`,
      )
      return
    }

    addCommandMessage(
      text,
      'Usage: `/skill install <url>` · `/skill list` · `/skill refresh` · `/skill disable <name>` · `/skill enable <name>` · `/skill uninstall <name>`',
    )
  }

  return { handleSkill }
}
