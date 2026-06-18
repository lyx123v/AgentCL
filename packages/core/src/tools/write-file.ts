// @x-code-cli/core — writeFile 工具（无 execute，由 agent loop 做权限检查）
import { tool } from 'ai'

import { z } from 'zod'

export const writeFile = tool({
  description: `将内容写入本地文件系统中的文件。

用法说明：
- 如果目标路径已存在文件，这个工具会直接覆盖它。
- 如果目标是已有文件，你必须先用 readFile 读取该文件内容；若未先读取，工具会失败。
- 修改已有文件时优先使用 edit 工具，因为它只传 diff。writeFile 更适合创建新文件或整文件重写。
- 除非用户明确要求，否则绝不要创建文档文件（*.md）或 README 文件。`,
  inputSchema: z.object({
    filePath: z.string().describe('文件的绝对路径'),
    content: z.string().describe('要写入的完整内容'),
  }),
  // 不提供 execute，由 agent loop 手动处理权限检查
})
