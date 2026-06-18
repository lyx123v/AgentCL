// @x-code-cli/core — task 工具（子代理分发）
//
// 这个工具定义里没有 `execute`，分发逻辑在 tool-execution.ts 的
// handleToolCall 里手动处理，并最终调用 runSubAgent。
// 这是刻意设计的：task 工具需要访问 LoopState、AgentOptions 和回调，
// 而这些都拿不到常规工具 execute 上下文里。
import { tool } from 'ai'

import { z } from 'zod'

import type { SubAgentRegistry } from '../agent/sub-agents/registry.js'

/** 根据 registry 动态构建 task 工具描述。
 *  这个函数会在构造 system prompt cache 时每个会话调用一次。
 *  可用 agent 列表会直接嵌入描述里，让模型知道 subagent_type 的合法取值。 */
export function buildTaskToolDescription(registry: SubAgentRegistry): string {
  const agents = registry.list()
  const agentList = agents.map((a) => `  - ${a.name}: ${a.description}`).join('\n')

  return `启动一个子代理，处理那些确实需要较多步骤和较大工作量的任务。

子代理会带着自己独立的消息历史运行，并且只返回最终结论，中间的工具调用不会进入你的上下文窗口，因此主对话会更轻。但每次调用子代理都有明显开销：全新上下文、独立缓存、额外 system prompt token。凡是 2-3 次直接工具调用就能解决的任务，通常都比委派更快、更省。

可用子代理：
${agentList}

使用 task 工具时，必须通过 subagent_type 参数指定要调用哪一种子代理。

## 什么时候不要用 task
- 3 次或更少工具调用就能完成的任务，直接自己做
- 读取某个具体文件，直接用 readFile
- 搜索已知符号，例如 "class Foo"，直接用 grep
- 只需在 1-3 个已知文件里搜索，直接用 readFile
- 当前对话里已经读过文件、足以回答的问题
- 你凭自身知识就能直接回答的问题
- 单文件编辑、微小修复，或任何一眼就有直接路径的任务

## 什么时候适合用 task
- 需要跨很多目录做 4 次以上搜索的大范围代码探索，且直接搜索已经证明不够
- 对待提交改动做代码审查（需要结构化审查输出）
- 需要阅读 5 个以上文件的实现规划
- 多步骤调查类任务，而且你只关心最终结论

## 使用注意事项
- 总是提供一个 3-5 个词的简短 description，概括子代理要做什么
- 当多个任务彼此真正独立时，可以并发启动多个子代理；请在同一条消息里发出多个工具调用
- 子代理结果用户看不到，你必须在文本回复里再概括给用户
- 每次 task 调用都是从零开始，必须给出完整任务描述
- 一般情况下可以信任子代理输出
- 明确告诉子代理，你希望它写代码还是只做调研
- 如果用户明确要求“并行运行代理”，你必须在同一条消息里发送多个 task 工具调用内容块
- 如果多个子代理可能修改同一批文件或资源，绝对不要在同一轮里同时启动它们

## 如何写 prompt

像向一个刚进会议室、很聪明但完全没看过当前对话的同事交代任务一样去写。它不知道你已经试过什么，也不明白这件事为什么重要。
- 说明你要达成什么目标，以及为什么要做。
- 说明你已经掌握了什么、排除了什么。
- 提供足够的上下文，让子代理可以自己做判断，而不是只能机械执行窄指令。
- 如果你需要短回复，要明确写出来，例如“200 字内汇报”。
- 查找类任务：直接给出精确命令。调查类任务：直接给出问题本身，不要硬塞预设步骤，否则一旦前提错了，步骤只会变成负担。

过于简短、命令式的 prompt 往往只会产出浅层、模板化结果。

**不要把“理解问题”这件事也委派出去。** 不要写“根据你的发现修复 bug”或“根据调研结果实现它”。这种说法其实是在把综合判断责任推给子代理。应该写出能证明你已经理解问题的 prompt：给出文件路径、行号、要改什么、为什么改。

示例：

<example>
user: "你能看看 auth 模块有没有安全问题吗？"
assistant: 我让代码审查代理检查一下 auth 模块。
task({
  description: "审查 auth 安全",
  subagent_type: "code-reviewer",
  prompt: "请审查认证模块中的安全问题。主要代码位于 src/auth/。重点关注：src/auth/jwt.ts 中的 JWT 处理、src/auth/session.ts 中的会话管理，以及 src/routes/login.ts 中的登录接口。请检查 token 过期处理、密钥存储、注入风险，以及是否缺少输入校验。输出请使用编号清单，并附带严重级别和 file:line 引用。"
})
</example>

<example>
user: "数据库连接配置在哪里？"
<commentary>不要用 task，直接 grep "database" 或 "connection" 基本就能找到。</commentary>
</example>

<example>
user: "修一下 README 里的错别字"
<commentary>不要用 task，这只是单步编辑，直接用 edit 工具。</commentary>
</example>

<example>
user: "glob 工具是干什么的？"
<commentary>不要用 task，这是直接问答，你自己就能回答。</commentary>
</example>`
}

/** 创建 task 工具定义。必须传入 registry，这样描述里才能包含可用 agent 列表。 */
export function createTaskTool(registry: SubAgentRegistry) {
  return tool({
    description: buildTaskToolDescription(registry),
    inputSchema: z.object({
      description: z.string().describe('任务的简短描述，建议 3-5 个词'),
      subagent_type: z.string().describe(`要使用的子代理类型。可选值：${registry.names().join(', ')}`),
      prompt: z
        .string()
        .describe('发给子代理的完整任务说明。请尽量具体，因为子代理没有任何先验上下文。'),
    }),
    // 不提供 execute，由 tool-execution.ts 手动处理
  })
}
