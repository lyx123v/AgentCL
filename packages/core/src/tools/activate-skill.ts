// @x-code-cli/core — activateSkill 工具
//
// 只有在存在 SkillRegistry 时才会注入到工具注册表中
// （也就是至少发现了一个 SKILL.md）。当模型判断当前任务与某个技能
// 的描述匹配时，就会调用这个工具；工具会返回包裹在 XML 标签里的
// 技能 Markdown 正文，模型会把它当作 tool-result 继续读取并遵循其指令。
//
// 这与 Gemini CLI 的 activate_skill 工具、Claude Code 的内联 SkillTool
// 属于同一种设计模式，也是主流同类产品里的常见做法。
import { tool } from 'ai'

import { z } from 'zod'

import type { SkillRegistry } from '../skills/registry.js'
import { wrapActivatedSkill } from '../skills/registry.js'

/** 创建技能激活工具，用于把指定技能的内容注入当前对话上下文。 */
export function createActivateSkillTool(registry: SkillRegistry) {
  const nameList = registry.names().join(', ')

  return tool({
    description: `激活一个技能，将它的说明注入当前对话。可用技能：${nameList}。当当前任务明显符合某个技能描述时，请调用此工具。`,
    inputSchema: z.object({
      name: z.string().describe('要激活的技能名称'),
    }),
    execute: async ({ name }) => {
      const skill = registry.get(name)
      if (!skill) {
        const available = registry.names()
        return available.length > 0
          ? `未找到技能“${name}”。当前可用技能：${available.join(', ')}`
          : `未找到技能“${name}”。当前没有已加载的技能。`
      }
      return wrapActivatedSkill(skill)
    },
  })
}
