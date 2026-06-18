// @x-code-cli/core — edit 工具（精确字符串替换，不提供 execute，需要权限检查）
import { tool } from 'ai'

import { z } from 'zod'

export const edit = tool({
  description: `在文件中执行精确的字符串替换。

使用说明：
- 在编辑之前，你必须先在当前对话中至少调用一次 `readFile`。如果没有先读取文件就尝试编辑，此工具会报错。
- 如果编辑的是 `readFile` 返回的文本，请严格保留文件中的原始缩进（Tab/空格）。`oldString` 和 `newString` 中都不要包含行号前缀。
- 始终优先修改代码库中已有的文件。除非明确需要，否则不要新建文件。
- 如果 `oldString` 在文件里不是唯一匹配，本次编辑会失败。你可以提供包含更多上下文的更长字符串来确保唯一性，或者使用 `replaceAll` 一次替换全部匹配项。
- 如果你要在整个文件中替换或重命名字符串（例如变量改名），请使用 `replaceAll`。`,
  inputSchema: z.object({
    filePath: z.string().describe('文件的绝对路径'),
    oldString: z.string().describe('要查找并替换的精确文本（在文件中必须唯一，除非使用 replaceAll）'),
    newString: z.string().describe('替换后的文本'),
    replaceAll: z.boolean().optional().describe('是否替换全部匹配项（默认：false）'),
  }),
  // 不提供 execute，由 agent loop 手动处理以完成权限检查
})
