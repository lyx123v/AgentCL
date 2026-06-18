// @x-code-cli/core — exitPlanMode 工具（用户审批关口，不提供 execute，由 agent loop 处理）
import { tool } from 'ai'

import { z } from 'zod'

/** 将计划展示给用户审批。用户会看到一个内嵌计划正文的“是/否”对话框；
 *  如果选择“是”，当前会话会退出计划模式，下一轮即可开始写代码；
 *  如果选择“否”，会话会继续停留在计划模式，并通知模型继续修改方案。
 *
 *  这里不提供 `execute` 字段。`processToolCalls` 中的分发逻辑会读取计划文件，
 *  调用 `callbacks.onPlanApprovalRequest(planText)`，再把审批结果作为一个
 *  合成的 tool result 回传给模型，让模型知道应该继续实现还是继续迭代。 */
export const exitPlanMode = tool({
  description:
    '当你处于计划模式、已经把计划写入计划文件，并且准备提交给用户审批时，请使用这个工具。它会默认从你在规划阶段写入的计划文件中读取计划内容；只有在你确实想覆盖文件中的内容时，才传入可选的 `plan` 参数。用户会在审批对话框中看到计划正文，并选择“是”或“否”。没有用户批准，模型不能离开计划模式；如果被拒绝，请修改计划文件（用 `edit`）后再次调用本工具。不要把它用于研究 / 问答任务；只有在用户要求你实现某件事，并且你已经完成一份完整计划写入计划文件时，才应使用它。不要用 `askUser` 去问“这个计划可以吗？”——请求计划审批的正确方式只有 `exitPlanMode`。',
  inputSchema: z.object({
    plan: z
      .string()
      .optional()
      .describe(
        '可选，用于覆盖计划正文。默认会读取你在规划阶段写入的计划文件内容；只有在你想使用不同内容时才传入这个参数（较少见）。',
      ),
  }),
})
