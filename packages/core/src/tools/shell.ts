// @x-code-cli/core — shell 工具（跨平台命令执行；不直接实现 execute，由外层做权限检查）
import { tool } from 'ai'

import { z } from 'zod'

export const shell = tool({
  description: `执行 shell 命令并返回 stdout/stderr。工作目录会在多次命令之间持续保留。

重要说明：尽量不要用这个工具执行 grep、rg、cat、head、tail、sed、awk 之类命令，而应优先使用对应的专用工具，因为那样的体验更好：
- 搜索文件：用 glob（不要用 find 或 ls）
- 搜索内容：用 grep 工具（不要直接跑 grep/rg 命令）
- 读取文件：用 readFile（不要用 cat/head/tail）
- 编辑文件：用 edit（不要用 sed/awk）
- 写入文件：用 writeFile（不要用 echo >/cat <<EOF）

使用说明：
- 如果命令会创建新目录或新文件，先运行 ls 确认父目录存在且位置正确。
- 路径里只要有空格，一律用双引号包裹。
- 一次需要执行多条命令时：彼此独立就拆成同一条消息里的多个 shell 工具调用并行执行；彼此依赖就用 `&&` 串联；只有在你明确不关心前面失败时才用 `;`。不要用换行分隔命令。
- 执行 git 命令时，优先新建 commit 而不是 amend。除非用户明确要求，否则不要跳过 hooks（`--no-verify`）。执行破坏性操作（如 `git reset --hard`、`git push --force`）前，先考虑更安全的替代方案。
- 对于本可立即执行的命令，不要额外 sleep。`,
  inputSchema: z.object({
    command: z.string().describe('要执行的命令'),
    timeout: z.number().optional().describe('超时时间，单位毫秒（默认 30000）'),
  }),
  // 不提供 execute，由 agent loop 手动处理权限检查、跨平台 shell 选择和流式输出
})
