// @x-code-cli/core — todoWrite 工具（由模型维护的清单；无 execute，由 agent loop 处理）
import { tool } from 'ai'

import { z } from 'zod'

/** 模型通过这个工具维护“进行中的任务清单”。
 *  每次调用都会整表替换（不是 merge，也不是增量更新），因此模型必须每次
 *  都传完整数组，连未变化项也要带上。
 *  当全部条目都完成后，agent loop 会自动清空列表，释放实时 UI 面板。
 *
 *  存储位置：内存中的 `LoopState.todos`，并通过 `callbacks.onTodosUpdate`
 *  镜像到 React state。不会落盘（与 Claude Code 一致），因为这个清单是
 *  会话级工作记忆，不是长期记录。
 *
 *  这里不提供 `execute` 字段，副作用（修改 LoopState.todos 并通知 UI）
 *  在 `processToolCalls` 中手动处理，和 askUser / enterPlanMode 的模式一致。 */
export const todoWrite = tool({
  description: `用这个工具追踪多步骤任务。用户会在 spinner 上方看到一个实时清单（☐ ◼ ✔），这样长任务会更有结构，也能让用户随时知道你的计划推进到哪一步。

## 什么时候该用

- 涉及 3 个及以上逻辑步骤的任务
- exitPlanMode 获批之后，手里已经有一个包含多个文件或阶段的计划，此时应先把计划转成 todos 再开工
- 用户在一条消息里给了多个请求（例如“先做 A，再做 B，最后做 C”）
- 开始某一步时（一定要在真正开工前把它标成 \`in_progress\`）
- 完成某一步时（要立刻标成 \`completed\`，不要等到最后一起更新）

## 什么时候不要用

- 单文件修改、改错别字、微小修复，这些场景加 todo 只会徒增仪式感
- 纯问答或纯调研
- 1-2 步就能完成的明显任务
- 不涉及具体执行工作的普通对话回复

## 硬性规则

1. **status 只能是**：\`pending\` | \`in_progress\` | \`completed\`，且只能是这三个。
2. **任意时刻必须且只能有一个任务是 \`in_progress\`**。不能是 0 个，也不能是 2 个。用户会把它理解成“代理此刻正在做的事”。
3. **做完就立刻标完成**。不要等到整轮结束再批量更新，用户需要实时反馈。
4. **只有真的完成了才能标完成**。如果测试还没过、实现只做了一半、遇到报错，或你打算稍后继续跟进，就保留 \`in_progress\`，并额外新增一个 \`pending\` 项描述未完成部分。
5. **必须同时提供 \`content\` 和 \`activeForm\`**：
   - \`content\` 用祈使句，例如“运行测试”“更新认证处理器”
   - \`activeForm\` 用进行式，例如“正在运行测试”“正在更新认证处理器”
   - live UI 中，\`in_progress\` 条目显示的就是 activeForm
6. **每次都传完整列表**。todoWrite 是整表替换，不是 merge；未变化项也要带上。
7. 当你提交的列表里所有项都是 \`completed\` 时，系统会自动清空清单，不需要手动清。

## 示例

用户："把认证系统重构成 JWT，并更新登录流程"

在探索/规划完成后，第一次进入实现阶段时：
\`\`\`
todoWrite({
  todos: [
    { content: "阅读现有认证实现",  activeForm: "正在阅读认证代码",        status: "in_progress" },
    { content: "新增 JWT 签名与校验工具", activeForm: "正在新增 JWT 工具",     status: "pending" },
    { content: "更新登录处理器",       activeForm: "正在更新登录逻辑",         status: "pending" },
    { content: "更新受保护路由中间件", activeForm: "正在更新中间件",           status: "pending" },
    { content: "为新认证流程补测试",   activeForm: "正在编写认证测试",         status: "pending" }
  ]
})
\`\`\`

读完代码后：
\`\`\`
todoWrite({
  todos: [
    { content: "阅读现有认证实现",  activeForm: "正在阅读认证代码",        status: "completed" },
    { content: "新增 JWT 签名与校验工具", activeForm: "正在新增 JWT 工具",     status: "in_progress" },
    ...其余项保持 pending
  ]
})
\`\`\`

五项全部完成后（下一次会自动清空）：
\`\`\`
todoWrite({ todos: [/* 五项都设成 status: "completed" */] })
\`\`\`

## 错误用法

用户："修一下 README 里的错别字"
你：<不要调用 todoWrite，这是单步编辑，清单没有任何价值>

用户："X 是做什么的？"
你：<不要调用 todoWrite，这是纯问答，没有需要追踪的执行工作>`,
  // SCHEMA 故意放宽：虽然工具描述明确告诉模型每个 todo 都应带齐三个字段，
  // 但 schema 仍把它们设成 optional。原因是一些能力较弱的 provider 模型
  // （如 DeepSeek-flash、GLM、Qwen 等）经常会漏字段，最常见是最后一个
  // “当前任务”缺少 `status`，有时也会在它们认为 `activeForm` 足够时省略
  // `content`。如果这里严格 required，Zod 会直接拒绝整个调用，接着 SDK
  // 会生成 tool-error，assistant 侧留下一个没有结果的 tool_call，最终让下一轮
  // API 因 “tool must be a response to tool_calls” 而失败。相比不断对模型输出
  // 打补丁，宽松校验并在分发处理器中补合理默认值要稳健得多。
  inputSchema: z.object({
    todos: z
      .array(
        z.object({
          content: z.string().optional().describe('任务的祈使句表达，例如“运行测试”。'),
          activeForm: z
            .string()
            .optional()
            .describe('任务的进行式表达，例如“正在运行测试”；当该项为 in_progress 时会显示在实时 UI 中。'),
          status: z
            .enum(['pending', 'in_progress', 'completed'])
            .optional()
            .describe('生命周期状态。任意时刻应当只有一项是 in_progress。若省略，默认按 "pending" 处理。'),
        }),
      )
      .describe('完整的最新 todo 列表。每次调用都会替换现有列表，因此即使未变更的项也必须一并传入。'),
  }),
})
