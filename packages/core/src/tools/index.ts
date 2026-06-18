// @x-code-cli/core — 工具注册表（统一导出）
//
// Memory 写入不会暴露成一个显式工具；它是在 turn 结束后由提取器静默完成的
// （`agent/memory-extractor.ts` → `generateText` + `Output.object` →
// `getAutoMemory().add()`）。这符合 Codex“主代理对记忆只读”的设计理念：
// 如果界面里出现一个可见的 memory-write 工具条目，会让人感觉像 AI 在背着用户做事。
// Claude Code 走的是另一条路（把记忆当作 Markdown 文件，通过通用 Write 工具写入，
// 然后在 UI 里折叠），但那需要额外维护一套折叠路径，这里不打算引入。
import { askUser } from './ask-user.js'
import { edit } from './edit.js'
import { enterPlanMode } from './enter-plan-mode.js'
import { exitPlanMode } from './exit-plan-mode.js'
import { glob } from './glob.js'
import { grep } from './grep.js'
import { listDir } from './list-dir.js'
import { readFile } from './read-file.js'
import { shell } from './shell.js'
import { todoWrite } from './todo-write.js'
import { webFetch } from './web-fetch.js'
import { webSearch } from './web-search.js'
import { writeFile } from './write-file.js'

export const toolRegistry = {
  readFile,
  writeFile,
  edit,
  shell,
  glob,
  grep,
  listDir,
  webSearch,
  webFetch,
  askUser,
  enterPlanMode,
  exitPlanMode,
  todoWrite,
}

export {
  readFile,
  writeFile,
  edit,
  shell,
  glob,
  grep,
  listDir,
  webSearch,
  webFetch,
  askUser,
  enterPlanMode,
  exitPlanMode,
  todoWrite,
}

export { MAX_TOOL_RESULT_LINES, MAX_TOOL_RESULT_BYTES, truncateToolResult } from './truncate.js'
export type { TruncateOptions } from './truncate.js'
